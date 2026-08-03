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

// helpers
function generateRoomCode() {
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

function connectedPlayers(room) {
  return room.players.filter(p => p.id);
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
    agreements: Array.from(room.agreements).map(id => room.players.find(p => p.id === id)?.name || '').filter(Boolean),
    round: room.currentRound,
    roundStartTime: actualStartTime,
    timeLeft,
    maxRounds: room.settings.cycles * room.players.length
  };
}

function allConnectedAgreed(room) {
  const connected = connectedPlayers(room);
  if (connected.length === 0) return false;
  return connected.every(p => room.agreements.has(p.id));
}

function maybeAdvanceFromAgreements(room, code) {
  if (!room.roundActive || room.roundEnding) return;
  if (!allConnectedAgreed(room)) return;

  room.roundEnding = true;
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }
  io.to(code).emit('roundEnding');
  setTimeout(() => advanceRound(room, code), 10000);
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
      votes: counts[index]
    };
  }).sort((a, b) => {
    if (b.average !== a.average) return b.average - a.average;
    return a.index - b.index;
  }).map((entry, place) => ({ ...entry, place: place + 1 }));

  return {
    ranking,
    winner: ranking[0] || null
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

function maybeCleanupRoom(code, room) {
  if (connectedPlayers(room).length > 0) return;
  if (room.roundTimer) clearTimeout(room.roundTimer);
  rooms.delete(code);
  console.log(`Room ${code} closed`);
}

function startRoundTimer(room, code, startTime) {
  room.roundActive = true;
  room.roundEnding = false;
  room.currentRoundStartTime = startTime;
  room.roundTimer = setTimeout(() => {
    room.roundEnding = true;
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
      connectedPlayers(room).forEach(p => room.agreements.add(p.id));
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
    room.roundActive = false;
    room.roundEnding = false;
    room.ratings = new Map();
    room.submittedRatings = new Set();
    room.ratingsDone = false;
    room.ratingResults = null;
    io.to(code).emit('gameEnd', getEndPayload(room));
    return;
  }

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

          if (room.ended) {
            return socket.emit('rejoinedGame', {
              ...getEndPayload(room),
              myIndex: existingPlayerIndex,
              ended: true,
              ratingsDone: !!room.ratingsDone,
              ratingResults: room.ratingResults,
              submittedRatings: Array.from(room.submittedRatings || [])
            });
          }

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

  socket.on('rejoinRoom', ({ code, name }) => {
    const roomCode = (code || '').toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return;
    name = (name || '').trim();
    const idx = room.players.findIndex(p => p.name === name);
    if (idx === -1) return;
    if (room.players[idx].id && room.players[idx].id !== socket.id) return;

    room.players[idx].id = socket.id;
    socket.join(roomCode);

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

    if (room.started) {
      const state = getFullGameState(room, room.currentRoundStartTime);
      socket.emit('rejoinedGame', {
        ...state,
        myIndex: idx,
        currentReadyState: room.agreements.has(socket.id)
      });
    }
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

  socket.on('sendEmote', ({ code, emote }) => {
    const room = rooms.get(code);
    const player = room?.players.find(p => p.id === socket.id);
    const emoteNumber = Number(emote);
    const now = Date.now();

    if (!room?.started || room.ended || !player) return;
    if (!Number.isInteger(emoteNumber) || emoteNumber < 1 || emoteNumber > 4) return;
    if (now - lastEmoteAt < 700) return;

    lastEmoteAt = now;
    io.to(code).emit('emoteReceived', {
      name: player.name,
      emote: emoteNumber
    });
  });

  socket.on('agreeNext', (code) => {
    const room = rooms.get(code);
    if (!room || !room.roundActive || room.roundEnding) return;
    room.agreements.add(socket.id);
    io.to(code).emit('agreementUpdate', Array.from(room.agreements).map(id => room.players.find(p => p.id === id)?.name || '').filter(Boolean));
    maybeAdvanceFromAgreements(room, code);
  });

  socket.on('unagreeNext', (code) => {
    const room = rooms.get(code);
    if (!room) return;
    room.agreements.delete(socket.id);
    io.to(code).emit('agreementUpdate', Array.from(room.agreements).map(id => room.players.find(p => p.id === id)?.name || '').filter(Boolean));
  });

  socket.on('submitRatings', ({ code, ratings }) => {
    const room = rooms.get(code);
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

    io.to(code).emit('ratingsProgress', {
      submitted: Array.from(room.submittedRatings),
      waitingFor: connectedPlayers(room)
        .map(p => p.name)
        .filter(name => !room.submittedRatings.has(name))
    });

    maybeFinishRatings(room, code);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;

      const playerName = room.players[idx].name;
      room.agreements.delete(socket.id);

      if (room.started) {
        // keep their project slot even if they leave
        room.players[idx].id = null;
        io.to(code).emit('playerListUpdate', room.players.map(p => p.name));

        if (!room.ended) {
          maybeAdvanceFromAgreements(room, code);
        } else if (!room.ratingsDone) {
          maybeFinishRatings(room, code);
          io.to(code).emit('ratingsProgress', {
            submitted: Array.from(room.submittedRatings || []),
            waitingFor: connectedPlayers(room)
              .map(p => p.name)
              .filter(name => !(room.submittedRatings || new Set()).has(name))
          });
        }

        maybeCleanupRoom(code, room);
      } else {
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          rooms.delete(code);
        } else {
          io.to(code).emit('playerListUpdate', room.players.map(p => p.name));
        }
      }

      console.log(`${playerName} left ${code}`);
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
