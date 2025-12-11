const express = require('express');
const multer = require('multer');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 10e6,   // 10MB for .sb3 uploads
  pingTimeout: 60000,        // Important for Vercel
  pingInterval: 25000        // Important for Vercel
});

const upload = multer({ storage: multer.memoryStorage() });

const BLANK_BUFFER = fs.readFileSync(path.join(__dirname, 'public', 'blank.sb3'));

const rooms = new Map();

app.use(express.static('public'));
app.use('/turbowarp', express.static(path.join(__dirname, 'public/turbowarp')));  // Serve TurboWarp editor statically
app.use(express.json());

// Route: Serve project .sb3 for TurboWarp load
app.get('/download/:code/:index', (req, res) => {
  const { code, index } = req.params;
  const room = rooms.get(code);
  if (!room || !room.started) return res.status(404).send('Project not found.');
  const idx = parseInt(index);
  if (isNaN(idx) || idx < 0 || idx >= room.players.length || !room.projects[idx].buffer) {
    return res.status(404).send('Project not available.');
  }
  const project = room.projects[idx];
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.send(project.buffer);
});

// This makes the homepage actually load
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// FINAL FIX: Serve final projects EXACTLY like the in-game /download route
app.get('/final-download/:code/:index', (req, res) => {
  const { code, index } = req.params;
  const room = rooms.get(code);

  if (!room || !room.ended) {
    return res.status(404).send('Project not found');
  }

  const idx = parseInt(index);
  if (isNaN(idx) || idx < 0 || idx >= room.players.length || !room.projects[idx]?.buffer) {
    return res.status(404).send('Project not available');
  }

  const project = room.projects[idx];

  // THESE HEADERS ARE IDENTICAL TO YOUR WORKING /download ROUTE
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  // NO Content-Disposition → allows TurboWarp to load it inline

  res.send(project.buffer);
});

// NEW: Serve final projects for EMBEDDING (no attachment header)
app.get('/final-embed/:code/:index', (req, res) => {
  const { code, index } = req.params;
  const room = rooms.get(code);
  if (!room || !room.started || !room.ended) return res.status(404).send('Not found');

  const idx = parseInt(index);
  if (isNaN(idx) || idx < 0 || idx >= room.players.length || !room.projects[idx]?.buffer) {
    return res.status(404).send('Not found');
  }

  const project = room.projects[idx];

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin', '*');
  // NO Content-Disposition → allows inline loading!
  res.send(project.buffer);
});

// Route: Custom addon JS for auto-save/lock + fixes
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
              // Clear dirty state and disable beforeunload after save
              vm.runtime.emit('projectChanged', false);  // Reset 'dirty' flag
              window.onbeforeunload = null;
              console.log('Project saved and cleaned up');
            };
          } catch (err) {
            e.source.postMessage({ type: 'saveError', error: err.message }, e.origin);
          }
        } else if (e.data.type === 'lockEditor') {
          vm.pause();  // Pause VM to lock editing
          console.log('Editor locked on timeout');
        } else if (e.data.type === 'setProjectName') {
          // Set internal project name from parent
          vm.runtime.projectName = e.data.name;
          console.log('Project name set to:', e.data.name);
        }
      });
      console.log('Auto-save & lock addon loaded');
    }
  `);
});

function generateRoomCode() {
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

function getFullGameState(room, startTime = null) {
  const elapsed = startTime ? Date.now() - startTime : 0;
  const timeLeft = Math.max(0, room.settings.timer - elapsed);
  return {
    players: room.players.map(p => p.name),
    projects: room.projects.map(p => ({ filename: p.filename })),
    owners: room.owners,
    uploaded: room.uploaded.map((u, i) => ({ player: room.players[i].name, uploaded: u })),
    agreements: Array.from(room.agreements).map(id => room.players.find(p => p.id === id)?.name || ''),
    round: room.currentRound,
    roundStartTime: startTime || Date.now(),
    timeLeft,
    maxRounds: room.settings.cycles * room.players.length
  };
}

function startRoundTimer(room, code, startTime) {
  room.roundActive = true;
  room.roundTimer = setTimeout(() => {
    io.to(code).emit('roundTimeout');  // Tell clients: lock UI, auto-save if needed

    // Target only non-uploaded players for auto-save nudge
    const nonUploadedSockets = room.players.filter((p, i) => !room.uploaded[i]).map(p => p.id);
    nonUploadedSockets.forEach(socketId => {
      // Emit to specific socket (Socket.io supports it)
      io.to(socketId).emit('autoSaveNow');
    });

    // Start 5s countdown/grace immediately (covers VM poll + upload)
    io.to(code).emit('roundEnding');

    setTimeout(() => {
      room.roundActive = false;  // Now reject any late manual uploads

      // Fill blanks for anyone who failed to save
      room.projects.forEach((proj, i) => {
        if (!room.uploaded[i] || !proj.buffer || proj.buffer.length === 0) {
          proj.buffer = BLANK_BUFFER;
          proj.filename = 'blank.sb3';
          room.uploaded[i] = true;  // Mark as "saved" (blank)
        }
      });

      // Auto-agree everyone
      room.players.forEach(p => room.agreements.add(p.id));
      io.to(code).emit('agreementUpdate', room.players.map(p => p.name));

      // Advance immediately (no extra wait—countdown covered it)
      advanceRound(room, code);
    }, 5000);  // 5s total grace/countdown
  }, room.settings.timer);
}

function advanceRound(room, code) {
  if (room.roundTimer) clearTimeout(room.roundTimer);
  // Rotate projects: each gets the next player's
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
    const originalOwners = room.players.map(p => p.name);  // Snapshot originals at end
    const finalState = {
      message: `Game over after ${maxRounds} rounds!`,
      projects: room.projects.map(p => ({ filename: p.filename })),
      originalOwners: originalOwners
    };
    io.to(code).emit('gameEnd', finalState);
    // Cleanup after 30s
    setTimeout(() => rooms.delete(code), 30000);
    return;
  }
  const newStartTime = Date.now();
  io.to(code).emit('roundAdvanced', getFullGameState(room, newStartTime));
  startRoundTimer(room, code, newStartTime);
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => {
    let code;
    do {
      code = generateRoomCode();
    } while (rooms.has(code));
    const defaultSettings = {
      cycles: 1,
      timer: 5 * 60 * 1000,
      maxPlayers: 4
    };
    rooms.set(code, {
      players: [{ id: socket.id, name }],
      settings: defaultSettings,
      settingsConfirmed: false,
      started: false,
      roundActive: false
    });
    socket.join(code);
    socket.emit('roomCreated', { code, players: [name], settings: defaultSettings, confirmed: false });
  });

  socket.on('joinRoom', ({ code, name }) => {
    const roomCode = code.toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('error', 'Room not found.');
    if (room.players.find(p => p.name === name)) return socket.emit('error', 'Name taken.');
    if (room.players.length >= room.settings.maxPlayers) return socket.emit('error', 'Room full.');
    if (room.started) return socket.emit('error', 'Game already started.');

    socket.join(roomCode);
    room.players.push({ id: socket.id, name });
    socket.emit('roomJoined', {
      code: roomCode,
      players: room.players.map(p => p.name),
      settings: room.settings,
      confirmed: room.settingsConfirmed,
      started: room.started
    });
    io.to(roomCode).emit('playerListUpdate', room.players.map(p => p.name));  // Broadcast to all, including host
  });

  socket.on('setSettings', ({ code, settings }) => {
    const room = rooms.get(code);
    if (!room || room.players[0]?.id !== socket.id) return;
    const newSettings = {
      ...settings,
      maxPlayers: parseInt(settings.maxPlayers) || 4,
      timer: parseInt(settings.timer) * 60 * 1000 || 300000,
      cycles: parseInt(settings.cycles) || 1
    };
    if (newSettings.cycles < 1 || newSettings.timer < 60000) return socket.emit('error', 'Invalid settings.');
    room.settings = newSettings;
    room.settingsConfirmed = true;
    io.to(code).emit('settingsUpdated', { settings: room.settings, confirmed: true });
    // Re-broadcast player list after settings (in case of race)
    io.to(code).emit('playerListUpdate', room.players.map(p => p.name));
  });

  socket.on('startGame', (code) => {
    const room = rooms.get(code);
    if (!room || room.players[0]?.id !== socket.id || room.players.length < 2 || !room.settingsConfirmed) {
      return socket.emit('error', 'Cannot start: Need 2+ players and confirmed settings.');
    }
    room.started = true;
    room.projects = Array(room.players.length).fill({ buffer: BLANK_BUFFER, filename: 'blank.sb3' });
    room.owners = room.players.map(p => p.name);
    room.uploaded = new Array(room.players.length).fill(false);
    room.agreements = new Set();
    room.currentRound = 1;
    const startTime = Date.now();
    io.to(code).emit('gameStarted', getFullGameState(room, startTime));
    startRoundTimer(room, code, startTime);
  });

  socket.on('uploadFile', ({ code, fileBase64, filename }) => {
    const room = rooms.get(code);
    if (!room || !room.started || !room.roundActive) return socket.emit('error', 'Round not active.');
    const index = room.players.findIndex(p => p.id === socket.id);
    if (index === -1) return socket.emit('error', 'Player not found.');

    // Optional: Still prevent upload after they've agreed
    const playerAgreed = room.agreements.has(socket.id);
    if (playerAgreed) return socket.emit('error', 'You already agreed to pass — no more saves allowed!');

    try {
      const buffer = Buffer.from(fileBase64, 'base64');
      room.projects[index] = { buffer, filename };
      room.uploaded[index] = true;
      const playerName = room.players[index].name;
      io.to(code).emit('playerUploaded', { name: playerName, filename });
      io.to(code).emit('gameState', getFullGameState(room));
      socket.emit('uploadSuccess', { filename });
    } catch (err) {
      console.error('Upload error:', err);
      socket.emit('error', 'Invalid file data: ' + err.message);
    }
  });

  socket.on('agreeNext', (code) => {
    const room = rooms.get(code);
    if (!room || !room.started || room.agreements.has(socket.id)) return socket.emit('error', 'Already agreed.');
    const index = room.players.findIndex(p => p.id === socket.id);
    if (!room.uploaded[index]) return socket.emit('error', 'Must upload first.');

    room.agreements.add(socket.id);
    io.to(code).emit('agreementUpdate', Array.from(room.agreements).map(id => room.players.find(p => p.id === id)?.name || ''));

    if (room.agreements.size === room.players.length) {
      // Start 5s countdown before advance
      io.to(code).emit('roundEnding');
      setTimeout(() => advanceRound(room, code), 5000);
    }
  });

  socket.on('disconnect', () => {
    for (const [c, r] of rooms.entries()) {
      if (r.roundTimer) clearTimeout(r.roundTimer);
      const idx = r.players.findIndex(p => p.id === socket.id);
      if (idx > -1) {
        r.players.splice(idx, 1);
        io.to(c).emit('playerListUpdate', r.players.map(p => p.name));
        if (r.players.length === 0) rooms.delete(c);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = server;