const express = require('express');
const multer = require('multer');
const http = require('http');
const socketIo = require('socket.io');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Existing Socket.io Setup for the Web Game
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 10e6,   // 10MB for .sb3 uploads
  pingTimeout: 60000,
  pingInterval: 25000
});

// --- GODOT MATCHMAKING ROOMS STORE ---
// Room structure:
//   { peers: Map<peerId, ws>, nextPeerId: int, createdAt: timestamp }
// Host is always peerId 1. Joining players get sequential IDs 2, 3, 4...
const godotRooms = new Map();

// Initialize raw WebSocket server for Godot (no bound port — handled via HTTP upgrade)
const wssGodot = new WebSocketServer({ noServer: true });

function generateFiveLetterCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Clean up stale rooms every 10 minutes (max lifetime: 2 hours)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of godotRooms.entries()) {
    if (now - room.createdAt > 2 * 60 * 60 * 1000) {
      godotRooms.delete(code);
      console.log(`[Godot] Cleaned up stale room: ${code}`);
    }
  }
}, 10 * 60 * 1000);

// Helper: send JSON to a ws if it's open
function wsSend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wssGodot.on('connection', (ws, req) => {
  let currentRoomCode = null;
  let myPeerId = null;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[Godot] New WS connection from ${clientIp}`);

  ws.on('message', (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.error('[Godot] Failed to parse message:', e);
      return;
    }

    switch (msg.type) {

      case 'create_room': {
        let roomCode;
        do { roomCode = generateFiveLetterCode(); } while (godotRooms.has(roomCode));

        myPeerId = 1;
        currentRoomCode = roomCode;
        godotRooms.set(roomCode, {
          peers: new Map([[1, ws]]),  // peerId -> ws; host is always 1
          nextPeerId: 2,
          createdAt: Date.now()
        });

        console.log(`[Godot] Room created: ${roomCode}`);
        wsSend(ws, { type: 'room_created', roomCode });
        break;
      }

      case 'join_room': {
        const targetCode = (msg.roomCode || '').toUpperCase();
        if (!godotRooms.has(targetCode)) {
          return wsSend(ws, { type: 'error', message: 'Room not found.' });
        }
        const room = godotRooms.get(targetCode);
        if (room.peers.size >= 10) {
          return wsSend(ws, { type: 'error', message: 'Room is full.' });
        }

        myPeerId = room.nextPeerId++;
        currentRoomCode = targetCode;
        room.peers.set(myPeerId, ws);

        console.log(`[Godot] Peer ${myPeerId} joined room: ${targetCode} (${room.peers.size} total)`);

        // Tell the new peer its assigned ID. It will load its scene and then
        // send client_ready to kick off WebRTC with everyone else.
        wsSend(ws, { type: 'room_joined', peerId: myPeerId });
        break;
      }

      case 'client_ready': {
        // New client has loaded its game scene and is ready for WebRTC.
        // Tell every existing peer (including the host) to open a connection TO this new peer.
        const room = godotRooms.get(currentRoomCode);
        if (!room) return;

        for (const [existingId, existingWs] of room.peers.entries()) {
          if (existingId !== myPeerId) {
            // Tell the existing peer to be the offerer toward the new peer
            wsSend(existingWs, { type: 'open_connection_to', peerId: myPeerId });
          }
        }
        break;
      }

      case 'signal': {
        // Route SDP offer/answer to the specific target peer
        const room = godotRooms.get(currentRoomCode);
        if (!room) return;
        const targetWs = room.peers.get(Number(msg.toId));
        wsSend(targetWs, { type: 'signal', fromId: myPeerId, data: msg.payload });
        break;
      }

      case 'ice_candidate': {
        // Route ICE candidate to the specific target peer
        const room = godotRooms.get(currentRoomCode);
        if (!room) return;
        const targetWs = room.peers.get(Number(msg.toId));
        wsSend(targetWs, { type: 'ice_candidate', fromId: myPeerId, data: msg.payload });
        break;
      }

      default:
        console.warn(`[Godot] Unknown message type: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    console.log(`[Godot] Peer ${myPeerId} disconnected (room: ${currentRoomCode})`);
    if (!currentRoomCode || !godotRooms.has(currentRoomCode)) return;

    const room = godotRooms.get(currentRoomCode);
    room.peers.delete(myPeerId);

    if (room.peers.size === 0) {
      // Last one out, delete the room
      godotRooms.delete(currentRoomCode);
      console.log(`[Godot] Room ${currentRoomCode} deleted (empty)`);
    } else {
      // Notify remaining peers
      for (const peerWs of room.peers.values()) {
        wsSend(peerWs, { type: 'peer_disconnected', peerId: myPeerId });
      }
      // If the host left, delete the room entirely (could also reassign, but keep it simple)
      if (myPeerId === 1) {
        godotRooms.delete(currentRoomCode);
        console.log(`[Godot] Room ${currentRoomCode} deleted (host left)`);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[Godot] WebSocket error for peer ${myPeerId}:`, err);
  });
});

const upload = multer({ storage: multer.memoryStorage() });
const BLANK_BUFFER = fs.readFileSync(path.join(__dirname, 'public', 'blank.sb3'));
const rooms = new Map();

app.use(express.static('public'));
app.use('/turbowarp', express.static(path.join(__dirname, 'public/turbowarp')));
app.use(express.json());

// --- ROUTES ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/download/:code/:index', (req, res) => {
  const { code, index } = req.params;
  const room = rooms.get(code);
  if (!room || !room.started) return res.status(404).send('Project not found.');
  const idx = parseInt(index);
  if (isNaN(idx) || idx < 0 || idx >= room.players.length || !room.projects[idx].buffer) {
    return res.status(404).send('Project not available.');
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(room.projects[idx].buffer);
});

app.get('/final-download/:code/:index', (req, res) => {
  const { code, index } = req.params;
  const room = rooms.get(code);
  if (!room || !room.ended) return res.status(404).send('Project not found');
  const idx = parseInt(index);
  if (isNaN(idx) || idx < 0 || idx >= room.players.length || !room.projects[idx]?.buffer) {
    return res.status(404).send('Project not available');
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(room.projects[idx].buffer);
});

app.get('/addon.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    export default async function ({ vm, renderer }) {
      window.addEventListener('message', async (e) => {
        if (e.origin !== window.parent.location.origin) return;
        if (e.data.type === 'saveAndUpload') {
          try {
            const blob = await vm.saveProjectSb3();
            const reader = new FileReader();
            reader.readAsDataURL(blob);
            reader.onloadend = () => {
              const base64 = reader.result.split(',')[1];
              e.source.postMessage({
                type: 'projectSaved',
                base64: base64,
                filename: vm.runtime.projectName || 'project.sb3'
              }, e.origin);
              vm.runtime.emit('projectChanged', false);
              window.onbeforeunload = null;
            };
          } catch (err) {
            e.source.postMessage({ type: 'saveError', error: err.message }, e.origin);
          }
        } else if (e.data.type === 'lockEditor') {
          vm.pause();
        } else if (e.data.type === 'unlockEditor') {
          vm.resume();
        } else if (e.data.type === 'setProjectName') {
          vm.runtime.projectName = e.data.name;
        }
      });
    }
  `);
});

// --- HELPER FUNCTIONS ---
function generateRoomCode() {
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

function getFullGameState(room, startTime = null) {
  const actualStartTime = startTime || room.currentRoundStartTime || Date.now();
  const elapsed = Date.now() - actualStartTime;
  const timeLeft = Math.max(0, room.settings.timer - elapsed);

  return {
    players: room.players.map(p => p.name),
    projects: room.projects.map(p => ({ filename: p.filename })),
    owners: room.owners,
    uploaded: room.uploaded.map((u, i) => ({ player: room.players[i].name, uploaded: u })),
    agreements: Array.from(room.agreements).map(id => room.players.find(p => p.id === id)?.name || ''),
    round: room.currentRound,
    roundStartTime: actualStartTime,
    timeLeft,
    maxRounds: room.settings.cycles * room.players.length
  };
}

function startRoundTimer(room, code, startTime) {
  room.roundActive = true;
  room.currentRoundStartTime = startTime;
  room.roundTimer = setTimeout(() => {
    io.to(code).emit('roundTimeout');
    room.players.filter((p, i) => !room.uploaded[i] && p.id).forEach(p => {
      io.to(p.id).emit('autoSaveNow');
    });
    io.to(code).emit('roundEnding');

    setTimeout(() => {
      room.roundActive = false;
      room.projects.forEach((proj, i) => {
        if (!room.uploaded[i] || !proj.buffer || proj.buffer.length === 0) {
          proj.buffer = proj.buffer || BLANK_BUFFER;
          proj.filename = proj.filename || 'blank.sb3';
          room.uploaded[i] = true;
        }
      });
      room.players.forEach(p => p.id && room.agreements.add(p.id));
      advanceRound(room, code);
    }, 10000);
  }, room.settings.timer);
}

function advanceRound(room, code) {
  if (room.roundTimer) clearTimeout(room.roundTimer);

  const lastProject = room.projects.pop();
  const lastOwner = room.owners.pop();
  room.projects.unshift(lastProject);
  room.owners.unshift(lastOwner);

  room.uploaded.fill(false);
  room.agreements.clear();
  room.currentRound++;

  const maxRounds = room.settings.cycles * room.players.length;
  if (room.currentRound > maxRounds) {
    room.ended = true;
    io.to(code).emit('gameEnd', {
      projects: room.projects.map(p => ({ filename: p.filename })),
      originalOwners: room.players.map(p => p.name)
    });
    setTimeout(() => rooms.delete(code), 600000);
    return;
  }

  const newStartTime = Date.now();
  room.currentRoundStartTime = newStartTime;
  io.to(code).emit('roundAdvanced', getFullGameState(room, newStartTime));
  startRoundTimer(room, code, newStartTime);
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {

  socket.on('createRoom', ({ name }) => {
    name = (name || '').trim();
    if (name.length < 1 || name.length > 16) return socket.emit('error', 'Invalid name.');
    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));
    const settings = { cycles: 1, timer: 5 * 60 * 1000, maxPlayers: 4 };
    rooms.set(code, {
      players: [{ id: socket.id, name }],
      settings,
      settingsConfirmed: false,
      started: false,
      roundActive: false,
      currentRound: 0,
      uploaded: [],
      agreements: new Set()
    });
    socket.join(code);
    socket.emit('roomCreated', { code, players: [name], settings, confirmed: false });
  });

  socket.on('kickPlayer', ({ code, targetName }) => {
    const room = rooms.get(code);
    if (!room || room.players[0].id !== socket.id || room.started) return;

    const targetIdx = room.players.findIndex(p => p.name === targetName);
    if (targetIdx > -1 && targetIdx !== 0) {
      const kickedSocketId = room.players[targetIdx].id;
      room.players.splice(targetIdx, 1);

      if (kickedSocketId) {
        io.to(kickedSocketId).emit('kicked');
        const kickedSocket = io.sockets.sockets.get(kickedSocketId);
        if (kickedSocket) kickedSocket.leave(code);
      }
      io.to(code).emit('playerListUpdate', room.players.map(p => p.name));
    }
  });

  socket.on('joinRoom', ({ code, name }) => {
    name = (name || '').trim();
    const roomCode = (code || '').toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('error', 'Room not found.');

    const existingPlayerIndex = room.players.findIndex(p => p.name === name);

    if (existingPlayerIndex !== -1) {
      if (room.started) {
        if (room.players[existingPlayerIndex].id === null) {
          room.players[existingPlayerIndex].id = socket.id;
          socket.join(roomCode);
          const state = getFullGameState(room, room.currentRoundStartTime);
          return socket.emit('rejoinedGame', {
            ...state,
            myIndex: existingPlayerIndex,
            currentReadyState: room.agreements.has(socket.id)
          });
        } else {
          return socket.emit('error', 'This player is already connected.');
        }
      } else {
        if (room.players[existingPlayerIndex].id !== socket.id) {
          return socket.emit('error', 'Name taken.');
        }
      }
    }

    if (room.started) return socket.emit('error', 'Game already started.');
    if (room.players.length >= room.settings.maxPlayers) return socket.emit('error', 'Room full.');

    socket.join(roomCode);
    room.players.push({ id: socket.id, name });
    socket.emit('roomJoined', {
      code: roomCode,
      players: room.players.map(p => p.name),
      settings: room.settings,
      confirmed: room.settingsConfirmed
    });
    io.to(roomCode).emit('playerListUpdate', room.players.map(p => p.name));
  });

  socket.on('setSettings', ({ code, settings }) => {
    const room = rooms.get(code);
    if (!room || room.players[0]?.id !== socket.id) return;
    room.settings = {
      cycles: Math.min(10, Math.max(1, parseInt(settings.cycles) || 1)),
      timer: Math.min(120 * 60 * 1000, Math.max(60000, parseInt(settings.timer) * 60 * 1000 || 300000)),
      maxPlayers: Math.min(10, Math.max(2, parseInt(settings.maxPlayers) || 4))
    };
    room.settingsConfirmed = true;
    io.to(code).emit('settingsUpdated', { settings: room.settings, confirmed: true });
  });

  socket.on('startGame', (code) => {
    const room = rooms.get(code);
    if (!room || room.players[0]?.id !== socket.id || room.players.length < 2) return;
    room.started = true;
    room.projects = room.players.map(() => ({ buffer: BLANK_BUFFER, filename: 'blank.sb3' }));
    room.owners = room.players.map(p => p.name);
    room.uploaded = room.players.map(() => false);
    room.currentRound = 1;
    const startTime = Date.now();
    io.to(code).emit('gameStarted', getFullGameState(room, startTime));
    startRoundTimer(room, code, startTime);
  });

  socket.on('uploadFile', ({ code, fileBase64, filename }) => {
    const room = rooms.get(code);
    if (!room || !room.roundActive) return socket.emit('error', 'Round not active.');
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    try {
      room.projects[idx] = { buffer: Buffer.from(fileBase64, 'base64'), filename };
      room.uploaded[idx] = true;
      io.to(code).emit('playerUploaded', { name: room.players[idx].name, filename });
      socket.emit('uploadSuccess', { filename });
    } catch (e) { socket.emit('error', 'Upload failed.'); }
  });

  socket.on('agreeNext', (code) => {
    const room = rooms.get(code);
    if (!room || !room.roundActive) return;
    room.agreements.add(socket.id);
    io.to(code).emit('agreementUpdate', Array.from(room.agreements).map(id => room.players.find(p => p.id === id)?.name || ''));
    if (room.agreements.size === room.players.length) {
      io.to(code).emit('roundEnding');
      setTimeout(() => advanceRound(room, code), 10000);
    }
  });

  socket.on('unagreeNext', (code) => {
    const room = rooms.get(code);
    if (!room) return;
    room.agreements.delete(socket.id);
    io.to(code).emit('agreementUpdate', Array.from(room.agreements).map(id => room.players.find(p => p.id === id)?.name || ''));
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        if (room.started && !room.ended) {
          room.players[idx].id = null;
        } else {
          room.players.splice(idx, 1);
          if (room.players.length === 0) rooms.delete(code);
        }
        io.to(code).emit('playerListUpdate', room.players.map(p => p.name));
      }
    }
  });
});

// --- DUAL-INTERCEPT UPGRADE ENGINE ---
// Routes WebSocket upgrades: Socket.io handles its own path, Godot gets /ws/matchmaking
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname === '/ws/matchmaking') {
    wssGodot.handleUpgrade(request, socket, head, (ws) => {
      wssGodot.emit('connection', ws, request);
    });
  }
  // Socket.io handles its own upgrade internally — don't touch other paths
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));