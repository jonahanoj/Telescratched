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
  maxHttpBufferSize: 10e6,   // upload limit
  pingTimeout: 60000,
  pingInterval: 25000
});

const upload = multer({ storage: multer.memoryStorage() });
const BLANK_BUFFER = fs.readFileSync(path.join(__dirname, 'public', 'blank.sb3'));
const rooms = new Map();

app.use(express.static('public'));
app.use('/turbowarp', express.static(path.join(__dirname, 'public/turbowarp')));
app.use(express.json());

// routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/download/:code/:index', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room || !room.started) return res.status(404).send('Project not found.');
  const idx = parseInt(req.params.index);
  if (isNaN(idx) || idx < 0 || idx >= room.players.length || !room.projects[idx]?.buffer) {
    return res.status(404).send('Project not available.');
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(room.projects[idx].buffer);
});

app.get('/final-download/:code/:index', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room || !room.ended) return res.status(404).send('Project not found');
  const idx = parseInt(req.params.index);
  if (isNaN(idx) || idx < 0 || idx >= room.players.length || !room.projects[idx]?.buffer) {
    return res.status(404).send('Project not available');
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
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

// helpers
function generateRoomCode() {
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

function normalizeCode(code) {
  return (code || '').toString().trim().toUpperCase();
}

function getRoom(code) {
  return rooms.get(normalizeCode(code));
}

function connectedPlayers(room) {
  return room.players.filter(p => p.id);
}

function agreementNames(room) {
  return Array.from(room.agreements)
    .map(id => room.players.find(p => p.id === id)?.name || '')
    .filter(Boolean);
}

function emitAgreements(room, code) {
  io.to(code).emit('agreementUpdate', agreementNames(room));
}

function emitPresence(room, code) {
  io.to(code).emit('playerPresence', room.players.map(p => ({
    name: p.name,
    online: !!p.id
  })));
  io.to(code).emit('playerListUpdate', room.players.map(p => p.name));
}

function getFullGameState(room, startTime = null) {
  const actualStartTime = startTime || room.currentRoundStartTime || Date.now();
  const elapsed = Date.now() - actualStartTime;
  const timeLeft = Math.max(0, room.settings.timer - elapsed);

  return {
    players: room.players.map(p => p.name),
    presence: room.players.map(p => ({ name: p.name, online: !!p.id })),
    projects: room.projects.map(p => ({ filename: p.filename })),
    owners: room.owners,
    uploaded: room.uploaded.map((u, i) => ({ player: room.players[i].name, uploaded: u })),
    agreements: agreementNames(room),
    round: room.currentRound,
    roundStartTime: actualStartTime,
    timeLeft,
    maxRounds: room.settings.cycles * room.players.length,
    settings: room.settings,
    roundActive: !!room.roundActive,
    roundEnding: !!room.roundEnding
  };
}

function softLeaveSeat(room, code, idx, { notifyKick = false } = {}) {
  const player = room.players[idx];
  if (!player) return;

  const oldId = player.id;
  if (oldId) {
    room.agreements.delete(oldId);
    // clear seat before disconnect so the disconnect handler does not soft-leave twice
    player.id = null;
    if (notifyKick) {
      io.to(oldId).emit('softKicked', {
        message: 'You were disconnected from the room. Rejoin with the same name to continue.'
      });
    }
    const sock = io.sockets.sockets.get(oldId);
    if (sock) {
      sock.leave(code);
      // give softKicked a moment to flush before dropping the socket
      const drop = () => { try { sock.disconnect(true); } catch (e) { } };
      if (notifyKick) setTimeout(drop, 300);
      else drop();
    }
  }

  emitPresence(room, code);
  emitAgreements(room, code);

  if (room.started && !room.ended) {
    maybeAdvanceFromAgreements(room, code);
  } else if (room.ended && !room.ratingsDone) {
    maybeFinishRatings(room, code);
    io.to(code).emit('ratingsProgress', {
      submitted: Array.from(room.submittedRatings || []),
      waitingFor: connectedPlayers(room)
        .map(p => p.name)
        .filter(name => !(room.submittedRatings || new Set()).has(name))
    });
  }

  maybeCleanupRoom(code, room);
}

function clearStaleSeat(room, idx) {
  const player = room.players[idx];
  if (!player?.id) return;
  if (!io.sockets.sockets.get(player.id)) {
    room.agreements.delete(player.id);
    player.id = null;
  }
}

function allConnectedAgreed(room) {
  const connected = connectedPlayers(room);
  if (connected.length === 0) return false;
  return connected.every(p => room.agreements.has(p.id));
}

function clearRoundTimers(room) {
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }
  if (room.graceTimer) {
    clearTimeout(room.graceTimer);
    room.graceTimer = null;
  }
}

function beginRoundEnding(room, code, { fromTimeout = false } = {}) {
  if (!room.roundActive || room.roundEnding) return false;

  room.roundEnding = true;
  clearRoundTimers(room);

  if (fromTimeout) {
    io.to(code).emit('roundTimeout');
    room.players.filter((p, i) => !room.uploaded[i] && p.id).forEach(p => {
      io.to(p.id).emit('autoSaveNow');
    });
  }

  io.to(code).emit('roundEnding');

  room.graceTimer = setTimeout(() => {
    room.graceTimer = null;
    room.roundActive = false;
    room.projects.forEach((proj, i) => {
      if (!room.uploaded[i] || !proj.buffer || proj.buffer.length === 0) {
        proj.buffer = proj.buffer && proj.buffer.length ? proj.buffer : Buffer.from(BLANK_BUFFER);
        proj.filename = proj.filename || 'blank.sb3';
        room.uploaded[i] = true;
      }
    });
    connectedPlayers(room).forEach(p => room.agreements.add(p.id));
    advanceRound(room, code);
  }, 10000);

  return true;
}

function endGameNow(room, code) {
  clearRoundTimers(room);
  room.ended = true;
  room.roundActive = false;
  room.roundEnding = false;
  room.ratings = new Map();
  room.submittedRatings = new Set();
  room.ratingsDone = false;
  room.ratingResults = null;
  io.to(code).emit('gameEnd', getEndPayload(room));
}

function getEndPayload(room) {
  return {
    projects: room.projects.map(p => ({ filename: p.filename })),
    originalOwners: room.owners.slice(),
    players: room.players.map(p => p.name)
  };
}

function computeRatingResults(room) {
  const projectCount = room.projects.length;
  const totals = Array(projectCount).fill(0);
  const counts = Array(projectCount).fill(0);

  for (const scores of room.ratings.values()) {
    scores.forEach((stars, i) => {
      if (typeof stars === 'number' && stars >= 1 && stars <= 5) {
        totals[i] += stars;
        counts[i] += 1;
      }
    });
  }

  const ranking = room.projects.map((proj, index) => {
    const average = counts[index] > 0 ? totals[index] / counts[index] : 0;
    return {
      index,
      owner: room.owners[index],
      filename: proj.filename,
      average: Math.round(average * 100) / 100,
      votes: counts[index],
      place: 0
    };
  }).sort((a, b) => {
    if (b.average !== a.average) return b.average - a.average;
    return a.index - b.index;
  });

  // competition ranking (1224): ties share a place, next rank skips
  for (let i = 0; i < ranking.length; i++) {
    if (i === 0) ranking[i].place = 1;
    else if (ranking[i].average === ranking[i - 1].average) {
      ranking[i].place = ranking[i - 1].place;
    } else {
      ranking[i].place = i + 1;
    }
  }

  const winners = ranking.filter(e => e.place === 1);

  return {
    ranking,
    winners,
    winner: winners[0] || null
  };
}

function maybeFinishRatings(room, code) {
  if (!room.ended || room.ratingsDone) return;

  const voters = connectedPlayers(room);
  if (voters.length === 0) return;
  if (!voters.every(p => room.submittedRatings.has(p.name))) return;

  room.ratingsDone = true;
  room.ratingResults = computeRatingResults(room);
  io.to(code).emit('ratingResults', room.ratingResults);
}

function cancelRoomCleanup(room) {
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
}

function maybeCleanupRoom(code, room) {
  if (connectedPlayers(room).length > 0) {
    cancelRoomCleanup(room);
    return;
  }

  // keep empty rooms briefly so refresh / flaky net can reclaim seats
  if (room.cleanupTimer) return;
  const graceMs = room.started ? 10 * 60 * 1000 : 2 * 60 * 1000;
  room.cleanupTimer = setTimeout(() => {
    room.cleanupTimer = null;
    if (connectedPlayers(room).length > 0) return;
    clearRoundTimers(room);
    rooms.delete(code);
    console.log(`Room ${code} closed after empty grace`);
  }, graceMs);
}

// take or reclaim a seat (refresh / same-name rejoin)
function claimSeat(room, code, idx, socket) {
  const player = room.players[idx];
  if (!player) return;

  const oldId = player.id;
  // assign first so old disconnect does not soft-leave this seat
  player.id = socket.id;
  cancelRoomCleanup(room);

  if (oldId && oldId !== socket.id) {
    room.agreements.delete(oldId);
    const oldSock = io.sockets.sockets.get(oldId);
    if (oldSock) {
      try {
        oldSock.leave(code);
        oldSock.disconnect(true);
      } catch (e) { }
    }
  }

  socket.join(code);
}

function sendRejoinedGame(socket, room, idx) {
  if (room.ended) {
    return socket.emit('rejoinedGame', {
      ...getEndPayload(room),
      myIndex: idx,
      ended: true,
      ratingsDone: !!room.ratingsDone,
      ratingResults: room.ratingResults,
      submittedRatings: Array.from(room.submittedRatings || [])
    });
  }

  if (!room.started) return;

  const state = getFullGameState(room, room.currentRoundStartTime);
  socket.emit('rejoinedGame', {
    ...state,
    myIndex: idx,
    currentReadyState: room.agreements.has(socket.id)
  });
}

function maybeAdvanceFromAgreements(room, code) {
  if (!allConnectedAgreed(room)) return;
  beginRoundEnding(room, code, { fromTimeout: false });
}

function startRoundTimer(room, code, startTime) {
  room.roundActive = true;
  room.roundEnding = false;
  room.currentRoundStartTime = startTime;
  clearRoundTimers(room);

  room.roundTimer = setTimeout(() => {
    room.roundTimer = null;
    beginRoundEnding(room, code, { fromTimeout: true });
  }, room.settings.timer);
}

function advanceRound(room, code) {
  // only once per round-ending; prevents double-rotate races
  if (!room.roundEnding) return;
  room.roundEnding = false;
  clearRoundTimers(room);

  const maxRounds = room.settings.cycles * room.players.length;
  // end on the last completed round - do NOT rotate again (that handed people their own project)
  if (room.currentRound >= maxRounds) {
    endGameNow(room, code);
    return;
  }

  const lastProject = room.projects.pop();
  const lastOwner = room.owners.pop();
  room.projects.unshift(lastProject);
  room.owners.unshift(lastOwner);

  room.uploaded.fill(false);
  room.agreements.clear();
  room.currentRound++;

  const newStartTime = Date.now();
  room.currentRoundStartTime = newStartTime;
  io.to(code).emit('roundAdvanced', getFullGameState(room, newStartTime));
  startRoundTimer(room, code, newStartTime);
}

// sockets
io.on('connection', (socket) => {
  let lastEmoteAt = 0;

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
    const roomCode = normalizeCode(code);
    const room = rooms.get(roomCode);
    if (!room || room.players[0]?.id !== socket.id) return;

    const targetIdx = room.players.findIndex(p => p.name === targetName);
    if (targetIdx <= 0) return; // cant kick host / missing

    if (!room.started) {
      const kickedSocketId = room.players[targetIdx].id;
      room.players.splice(targetIdx, 1);
      if (kickedSocketId) {
        io.to(kickedSocketId).emit('kicked');
        const kickedSocket = io.sockets.sockets.get(kickedSocketId);
        if (kickedSocket) kickedSocket.leave(roomCode);
      }
      emitPresence(room, roomCode);
      maybeCleanupRoom(roomCode, room);
      return;
    }

    // mid-game: soft kick, keep their project seat for rejoin
    softLeaveSeat(room, roomCode, targetIdx, { notifyKick: true });
    console.log(`Host soft-kicked ${targetName} from ${roomCode}`);
  });

  socket.on('joinRoom', ({ code, name }) => {
    name = (name || '').trim();
    const roomCode = normalizeCode(code);
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('error', 'Room not found.');

    const existingPlayerIndex = room.players.findIndex(p => p.name === name);

    if (existingPlayerIndex !== -1) {
      const existing = room.players[existingPlayerIndex];
      // lobby: only reclaim offline seats; mid-game refresh may take over
      if (!room.started && existing.id && existing.id !== socket.id && io.sockets.sockets.get(existing.id)) {
        return socket.emit('error', 'Name taken.');
      }

      claimSeat(room, roomCode, existingPlayerIndex, socket);
      emitPresence(room, roomCode);

      if (room.started || room.ended) {
        return sendRejoinedGame(socket, room, existingPlayerIndex);
      }

      return socket.emit('roomJoined', {
        code: roomCode,
        players: room.players.map(p => p.name),
        settings: room.settings,
        confirmed: room.settingsConfirmed
      });
    }

    if (room.started) return socket.emit('error', 'Game already started.');
    if (room.players.length >= room.settings.maxPlayers) return socket.emit('error', 'Room full.');

    socket.join(roomCode);
    room.players.push({ id: socket.id, name });
    cancelRoomCleanup(room);
    socket.emit('roomJoined', {
      code: roomCode,
      players: room.players.map(p => p.name),
      settings: room.settings,
      confirmed: room.settingsConfirmed
    });
    emitPresence(room, roomCode);
  });

  socket.on('rejoinRoom', ({ code, name }) => {
    const roomCode = normalizeCode(code);
    const room = rooms.get(roomCode);
    name = (name || '').trim();
    if (!room || !name) {
      return socket.emit('rejoinFailed', { reason: 'Room not found.' });
    }

    const idx = room.players.findIndex(p => p.name === name);
    if (idx === -1) {
      return socket.emit('rejoinFailed', { reason: 'You are not in this room.' });
    }

    claimSeat(room, roomCode, idx, socket);
    emitPresence(room, roomCode);

    if (room.started || room.ended) {
      return sendRejoinedGame(socket, room, idx);
    }

    socket.emit('roomJoined', {
      code: roomCode,
      players: room.players.map(p => p.name),
      settings: room.settings,
      confirmed: room.settingsConfirmed
    });
  });

  socket.on('setSettings', ({ code, settings }) => {
    const roomCode = normalizeCode(code);
    const room = rooms.get(roomCode);
    if (!room || room.players[0]?.id !== socket.id) return;
    room.settings = {
      cycles: Math.min(10, Math.max(1, parseInt(settings.cycles) || 1)),
      timer: Math.min(120 * 60 * 1000, Math.max(60000, parseInt(settings.timer) * 60 * 1000 || 300000)),
      maxPlayers: Math.min(10, Math.max(2, parseInt(settings.maxPlayers) || 4))
    };
    room.settingsConfirmed = true;
    io.to(roomCode).emit('settingsUpdated', { settings: room.settings, confirmed: true });
  });

  socket.on('startGame', (code) => {
    const roomCode = normalizeCode(code);
    const room = rooms.get(roomCode);
    if (!room || room.players[0]?.id !== socket.id) return;
    if (connectedPlayers(room).length < 2) {
      return socket.emit('error', 'Need at least 2 connected players to start.');
    }
    if (room.players.some(p => !p.id)) {
      return socket.emit('error', 'Some players are offline. Kick them or wait for them to rejoin.');
    }
    room.started = true;
    room.projects = room.players.map(() => ({
      buffer: Buffer.from(BLANK_BUFFER),
      filename: 'blank.sb3'
    }));
    room.owners = room.players.map(p => p.name);
    room.uploaded = room.players.map(() => false);
    room.agreements = new Set();
    room.currentRound = 1;
    const startTime = Date.now();
    io.to(roomCode).emit('gameStarted', getFullGameState(room, startTime));
    startRoundTimer(room, roomCode, startTime);
  });

  socket.on('uploadFile', ({ code, fileBase64, filename, round, seat }) => {
    const roomCode = normalizeCode(code);
    const room = rooms.get(roomCode);
    if (!room || room.ended) return;
    // active round, or still in the 10s ending grace
    if (!room.roundActive && !room.roundEnding) {
      return socket.emit('error', 'Round not active.');
    }

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    // reject late saves from a previous round (would overwrite the newly rotated project)
    const uploadRound = Number(round);
    if (!Number.isInteger(uploadRound) || uploadRound !== room.currentRound) {
      console.log(`Dropped stale upload from ${room.players[idx].name} (round ${uploadRound} vs ${room.currentRound})`);
      return;
    }

    if (seat != null && Number(seat) !== idx) {
      console.log(`Dropped upload with wrong seat from ${room.players[idx].name}`);
      return;
    }

    try {
      room.projects[idx] = { buffer: Buffer.from(fileBase64, 'base64'), filename };
      room.uploaded[idx] = true;
      io.to(roomCode).emit('playerUploaded', { name: room.players[idx].name, filename });
      socket.emit('uploadSuccess', { filename });
    } catch (e) { socket.emit('error', 'Upload failed.'); }
  });

  // host only, round 1 only: force-assign an .sb3 into a player slot
  socket.on('devSetProject', ({ code, index, fileBase64, filename, ownerName }) => {
    const roomCode = normalizeCode(code);
    const room = rooms.get(roomCode);
    if (!room?.started || room.ended) return socket.emit('error', 'Game not active.');
    if (room.players[0]?.id !== socket.id) return socket.emit('error', 'Host only.');
    if (room.currentRound !== 1 || room.roundEnding) {
      return socket.emit('error', 'Handoff only works on round 1.');
    }

    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= room.players.length) {
      return socket.emit('error', 'Bad player index.');
    }
    if (!fileBase64) return socket.emit('error', 'No file data.');

    try {
      const safeName = (filename || `project-${idx}.sb3`).replace(/[^\w.\-]+/g, '_');
      room.projects[idx] = {
        buffer: Buffer.from(fileBase64, 'base64'),
        filename: safeName.endsWith('.sb3') ? safeName : `${safeName}.sb3`
      };
      room.uploaded[idx] = true;
      if (typeof ownerName === 'string' && ownerName.trim()) {
        room.owners[idx] = ownerName.trim().slice(0, 16);
      }

      io.to(roomCode).emit('devProjectUpdated', {
        index: idx,
        filename: room.projects[idx].filename,
        owner: room.owners[idx],
        players: room.players.map(p => p.name),
        owners: room.owners.slice()
      });
      socket.emit('devSetProjectOk', { index: idx, filename: room.projects[idx].filename });
    } catch (e) {
      socket.emit('error', 'Dev assign failed.');
    }
  });

  socket.on('sendEmote', ({ code, emote }) => {
    const roomCode = normalizeCode(code);
    const room = rooms.get(roomCode);
    const player = room?.players.find(p => p.id === socket.id);
    const emoteNumber = Number(emote);
    const now = Date.now();

    if (!room?.started || room.ended || !player) return;
    if (!Number.isInteger(emoteNumber) || emoteNumber < 1 || emoteNumber > 4) return;
    if (now - lastEmoteAt < 700) return;

    lastEmoteAt = now;
    io.to(roomCode).emit('emoteReceived', {
      name: player.name,
      emote: emoteNumber
    });
  });

  socket.on('agreeNext', (code) => {
    const roomCode = normalizeCode(code);
    const room = rooms.get(roomCode);
    if (!room || !room.roundActive || room.roundEnding) return;
    room.agreements.add(socket.id);
    emitAgreements(room, roomCode);
    maybeAdvanceFromAgreements(room, roomCode);
  });

  socket.on('unagreeNext', (code) => {
    const roomCode = normalizeCode(code);
    const room = rooms.get(roomCode);
    if (!room) return;
    room.agreements.delete(socket.id);
    emitAgreements(room, roomCode);
  });

  socket.on('submitRatings', ({ code, ratings }) => {
    const roomCode = normalizeCode(code);
    const room = rooms.get(roomCode);
    if (!room?.ended || room.ratingsDone) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    if (room.submittedRatings.has(player.name)) return;

    if (!Array.isArray(ratings) || ratings.length !== room.projects.length) {
      return socket.emit('error', 'Rate every project first.');
    }

    const scores = ratings.map((stars) => {
      const n = Number(stars);
      if (!Number.isInteger(n) || n < 1 || n > 5) return null;
      return n;
    });

    if (scores.some(s => s === null)) {
      return socket.emit('error', 'Ratings must be 1 to 5 stars.');
    }

    room.ratings.set(player.name, scores);
    room.submittedRatings.add(player.name);

    io.to(roomCode).emit('ratingsProgress', {
      submitted: Array.from(room.submittedRatings),
      waitingFor: connectedPlayers(room)
        .map(p => p.name)
        .filter(name => !room.submittedRatings.has(name))
    });

    maybeFinishRatings(room, roomCode);
  });

  // emergency: jump to end screen with current projects
  socket.on('forceEndGame', ({ code }) => {
    const roomCode = normalizeCode(code);
    const room = rooms.get(roomCode);
    if (!room?.started || room.ended) return;
    if (!room.players.some(p => p.id === socket.id)) return;
    console.log(`Force end requested for ${roomCode}`);
    endGameNow(room, roomCode);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;

      const playerName = room.players[idx].name;

      // keep seat in lobby and mid-game so refresh can reclaim the same name
      softLeaveSeat(room, code, idx, { notifyKick: false });

      console.log(`${playerName} left ${code}`);
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
