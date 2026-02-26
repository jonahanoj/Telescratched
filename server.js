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
              vm.runtime.emit('projectChanged', false);
              window.onbeforeunload = null;
            };
          } catch (err) {
            e.source.postMessage({ type: 'saveError', error: err.message }, e.origin);
          }
        } else if (e.data.type === 'lockEditor') {
          vm.pause();
          console.log('Editor locked');
        } else if (e.data.type === 'unlockEditor') {
          vm.resume();   // ← THIS WAS MISSING
          console.log('Editor unlocked');
        } else if (e.data.type === 'setProjectName') {
          vm.runtime.projectName = e.data.name;
        }
      });
      console.log('Telescratched addon loaded');
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
  room.currentRoundStartTime = startTime;
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
    }, 10000);  // 5s total grace/countdown
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
    // Cleanup after 10mins
    setTimeout(() => rooms.delete(code), 600000);
    return;
  }
  const newStartTime = Date.now();
  room.currentRoundStartTime = newStartTime;
  io.to(code).emit('roundAdvanced', getFullGameState(room, newStartTime));
  startRoundTimer(room, code, newStartTime);
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => {
    name = (name || '').trim();
    if (name.length < 1 || name.length > 16) {
      return socket.emit('error', 'Name must be a max of 16 characters long.');
    }

    let code;
    do {
      code = generateRoomCode();
    } while (rooms.has(code));

    const defaultSettings = {
      cycles: 1,
      timer: 5 * 60 * 1000,
      maxPlayers: 4   // still defaults to 4, but can go up to 10
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
    name = (name || '').trim();
    if (name.length < 1 || name.length > 16) {
      return socket.emit('error', 'Name must be a max of 16 characters long.');
    }

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
    io.to(roomCode).emit('playerListUpdate', room.players.map(p => p.name));
  });

  socket.on('rejoinRoom', ({ code, name }) => {
    name = (name || '').trim();
    if (!name) return;

    const roomCode = code.toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('error', 'Room not found.');

    if (!room.started || room.ended) {
      return socket.emit('error', 'Game is not active.');   // only for real errors
    }

    const idx = room.players.findIndex(p => p.name === name);
    if (idx === -1) return socket.emit('error', 'Player not in this game.');

    const playerSlot = room.players[idx];

    // If this exact socket is already in the slot → just resync (no error)
    if (playerSlot.id === socket.id) {
      console.log(`[REJOIN] ${name} already connected – resyncing state`);
    } else {
      // Re-attach the socket to the stable slot
      playerSlot.id = socket.id;
      socket.join(roomCode);
      console.log(`[REJOIN] ${name} successfully rejoined ${roomCode} at slot ${idx}`);
    }

    const startTime = room.currentRoundStartTime || Date.now();
    const state = getFullGameState(room, startTime);

    socket.emit('rejoinedGame', {
      ...state,
      myIndex: idx,
      currentReadyState: room.agreements.has(socket.id)
    });
  });

  socket.on('setSettings', ({ code, settings }) => {
    const room = rooms.get(code);
    if (!room || room.players[0]?.id !== socket.id) return;

    const newSettings = {
      ...settings,
      maxPlayers: Math.min(10, parseInt(settings.maxPlayers) || 4),
      timer: Math.min(120 * 60 * 1000, parseInt(settings.timer) * 60 * 1000 || 300000),  // max 120 min
      cycles: Math.min(10, parseInt(settings.cycles) || 1)   // max 10 cycles
    };

    if (newSettings.cycles < 1 || newSettings.timer < 60000) {
      return socket.emit('error', 'Invalid settings.');
    }

    room.settings = newSettings;
    room.settingsConfirmed = true;
    io.to(code).emit('settingsUpdated', { settings: room.settings, confirmed: true });
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

    try {
      const buffer = Buffer.from(fileBase64, 'base64');
      room.projects[index] = { buffer, filename };
      room.uploaded[index] = true;
      const playerName = room.players[index].name;
      io.to(code).emit('playerUploaded', { name: playerName, filename });
      socket.emit('uploadSuccess', { filename });
    } catch (err) {
      console.error('Upload error:', err);
      socket.emit('error', 'Invalid file data: ' + err.message);
    }
  });

  // ====================== READY / UN-READY HANDLING ======================
  socket.on('agreeNext', (code) => handleReadyChange(code, true));
  socket.on('unagreeNext', (code) => handleReadyChange(code, false));

  function handleReadyChange(code, becomingReady) {
    const room = rooms.get(code);
    if (!room || !room.started || !room.roundActive) return;

    const playerId = socket.id;
    if (becomingReady) {
      if (room.agreements.has(playerId)) return;           // already ready
      room.agreements.add(playerId);
    } else {
      room.agreements.delete(playerId);                    // un-ready
    }

    // Broadcast updated list so everyone sees checkmarks change
    const names = Array.from(room.agreements)
      .map(id => room.players.find(p => p.id === id)?.name || '')
      .filter(Boolean);
    io.to(code).emit('agreementUpdate', names);

    // Only start grace period if EVERYONE is now ready
    if (becomingReady && room.agreements.size === room.players.length) {
      io.to(code).emit('roundEnding');
      setTimeout(() => advanceRound(room, code), 10000);
    }
  }

  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      // CRITICAL: NEVER clear roundTimer here — this was the #1 cause of "round never ended"
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx > -1) {
        const playerName = room.players[idx].name;

        if (room.started && !room.ended) {
          // Keep the slot forever during active game (prevents index shift + name disappearing)
          room.players[idx].id = null;
          console.log(`[RELIABILITY] ${playerName} temporarily disconnected mid-game in ${code}. Slot preserved for rejoin.`);
        } else {
          // Only remove in lobby or after game ended
          room.players.splice(idx, 1);
          console.log(`Player ${playerName} left lobby ${code}`);
          if (room.players.length === 0 && !room.ended) {
            rooms.delete(code);
            console.log(`Room ${code} deleted (empty lobby)`);
          }
        }

        io.to(code).emit('playerListUpdate', room.players.map(p => p.name));
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = server;