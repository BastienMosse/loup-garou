const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- État en mémoire ---
// rooms[code] = { gmSocketId, phase, players: {name: {name,role,alive,connected,socketId}}, wolfVotes, dayVotes }
const rooms = {};

function generateCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I/O pour éviter confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms[code]);
  return code;
}

function alivePlayers(room) {
  return Object.values(room.players).filter(p => p.alive);
}

function publicRoster(room) {
  return Object.values(room.players).map(p => ({ id: p.name, name: p.name, alive: p.alive, role: p.role, connected: p.connected }));
}

function gmSnapshot(room, roomCode) {
  return {
    roomCode,
    phase: room.phase,
    players: publicRoster(room),
    wolfVotes: room.wolfVotes,
    dayVotes: room.dayVotes,
  };
}

function checkWinner(room) {
  const alive = alivePlayers(room);
  const wolves = alive.filter(p => p.role === 'Loup-Garou').length;
  const others = alive.length - wolves;
  if (wolves === 0) return 'villageois';
  if (wolves >= others) return 'loups';
  return null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function wolfTeamNames(room) {
  return Object.values(room.players).filter(p => p.role === 'Loup-Garou').map(p => p.name);
}

// Envoie à UN joueur (par nom) tout ce dont il a besoin pour reconstruire son écran
function syncPlayer(room, player) {
  if (!player.connected) return;
  const payload = {
    role: player.role,
    alive: player.alive,
    phase: room.phase,
    wolfTeam: player.role === 'Loup-Garou' ? wolfTeamNames(room) : [],
    targets: null,
  };
  if (player.alive) {
    if (room.phase === 'night-wolves' && player.role === 'Loup-Garou') {
      payload.targets = alivePlayers(room).filter(p => p.role !== 'Loup-Garou').map(p => ({ id: p.name, name: p.name }));
    } else if (room.phase === 'night-seer' && player.role === 'Voyante') {
      payload.targets = alivePlayers(room).filter(p => p.name !== player.name).map(p => ({ id: p.name, name: p.name }));
    } else if (room.phase === 'day-vote') {
      payload.targets = alivePlayers(room).filter(p => p.name !== player.name).map(p => ({ id: p.name, name: p.name }));
    }
  }
  io.to(player.socketId).emit('player:sync', payload);
}

io.on('connection', (socket) => {
  // ---------- MJ ----------
  socket.on('gm:createRoom', (cb) => {
    const roomCode = generateCode();
    rooms[roomCode] = {
      gmSocketId: socket.id,
      phase: 'lobby',
      players: {},
      wolfVotes: {},
      dayVotes: {},
      config: { wolvesCount: 1, includeSeer: true },
    };
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.isGM = true;
    cb({ roomCode });
  });

  socket.on('gm:startGame', ({ roomCode, wolvesCount, includeSeer }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ error: 'Partie introuvable' });
    const players = Object.values(room.players);
    if (players.length < 3) return cb({ error: 'Il faut au moins 3 joueurs' });
    if (wolvesCount < 1 || wolvesCount >= players.length) return cb({ error: 'Nombre de loups invalide' });

    const shuffled = shuffle(players);
    let idx = 0;
    for (let i = 0; i < wolvesCount; i++) { shuffled[idx].role = 'Loup-Garou'; idx++; }
    if (includeSeer && idx < shuffled.length) { shuffled[idx].role = 'Voyante'; idx++; }
    while (idx < shuffled.length) { shuffled[idx].role = 'Villageois'; idx++; }

    room.phase = 'night-wolves';
    room.config = { wolvesCount, includeSeer };
    room.wolfVotes = {};
    room.dayVotes = {};

    for (const p of players) syncPlayer(room, p);
    io.to(room.gmSocketId).emit('gm:state', gmSnapshot(room, roomCode));
    cb({ success: true });
  });

  socket.on('gm:setPhase', ({ roomCode, phase }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.gmSocketId) return;
    room.phase = phase;
    if (phase === 'night-wolves') room.wolfVotes = {};
    if (phase === 'day-vote') room.dayVotes = {};
    io.to(roomCode).emit('game:phase', { phase });
    for (const p of alivePlayers(room)) syncPlayer(room, p);
    io.to(room.gmSocketId).emit('gm:state', gmSnapshot(room, roomCode));
  });

  socket.on('gm:eliminate', ({ roomCode, targetName, cause }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.gmSocketId) return;
    const target = room.players[targetName];
    if (!target || !target.alive) return;
    target.alive = false;
    io.to(roomCode).emit('game:eliminated', { name: target.name, role: target.role, cause });
    syncPlayer(room, target);
    const winner = checkWinner(room);
    if (winner) {
      room.phase = 'ended';
      io.to(roomCode).emit('game:over', { winner, roster: publicRoster(room) });
    }
    io.to(room.gmSocketId).emit('gm:state', gmSnapshot(room, roomCode));
  });

  // ---------- Joueurs ----------
  socket.on('player:join', ({ roomCode, name }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ error: 'Code de partie invalide' });
    const trimmed = (name || '').trim().slice(0, 20);
    if (!trimmed) return cb({ error: 'Nom invalide' });
    const existing = room.players[trimmed];

    if (room.phase === 'lobby') {
      if (existing) return cb({ error: 'Ce nom est déjà pris' });
      room.players[trimmed] = { name: trimmed, role: null, alive: true, connected: true, socketId: socket.id };
      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.playerName = trimmed;
      cb({ success: true });
      io.to(room.gmSocketId).emit('gm:state', gmSnapshot(room, roomCode));
      return;
    }

    // Partie déjà lancée : seule une reconnexion sous le même nom est acceptée
    if (!existing) return cb({ error: 'La partie a déjà commencé' });
    if (existing.connected) return cb({ error: 'Ce joueur est déjà connecté ailleurs' });
    existing.connected = true;
    existing.socketId = socket.id;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerName = trimmed;
    cb({ success: true, reconnected: true });
    syncPlayer(room, existing);
    io.to(room.gmSocketId).emit('gm:state', gmSnapshot(room, roomCode));
  });

  socket.on('wolf:vote', ({ roomCode, target }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'night-wolves') return;
    const voter = room.players[socket.data.playerName];
    if (!voter || voter.role !== 'Loup-Garou' || !voter.alive) return;
    room.wolfVotes[voter.name] = target;
    io.to(room.gmSocketId).emit('gm:wolfVotes', tallyByName(room.wolfVotes));
  });

  socket.on('seer:check', ({ roomCode, target }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'night-seer') return;
    const seer = room.players[socket.data.playerName];
    if (!seer || seer.role !== 'Voyante' || !seer.alive) return;
    const t = room.players[target];
    if (!t) return;
    socket.emit('seer:result', { name: t.name, role: t.role });
    io.to(room.gmSocketId).emit('gm:seerChecked', { seer: seer.name, target: t.name, role: t.role });
  });

  socket.on('player:vote', ({ roomCode, target }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'day-vote') return;
    const voter = room.players[socket.data.playerName];
    if (!voter || !voter.alive) return;
    room.dayVotes[voter.name] = target;
    io.to(room.gmSocketId).emit('gm:dayVotes', tallyByName(room.dayVotes));
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (socket.data.isGM) {
      io.to(roomCode).emit('game:gmLeft');
      delete rooms[roomCode];
      return;
    }
    const name = socket.data.playerName;
    const player = room.players[name];
    if (!player || player.socketId !== socket.id) return; // une reconnexion a déjà pris le relai
    if (room.phase === 'lobby') {
      delete room.players[name];
    } else {
      player.connected = false; // on garde le rôle en mémoire pour permettre la reconnexion
    }
    io.to(room.gmSocketId).emit('gm:state', gmSnapshot(room, roomCode));
  });
});

function tallyByName(votes) {
  const counts = {};
  for (const targetName of Object.values(votes)) {
    counts[targetName] = (counts[targetName] || 0) + 1;
  }
  return counts;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Loup-Garou en ligne : http://localhost:${PORT}`));
