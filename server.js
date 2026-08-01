const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- État en mémoire ---
// rooms[code] = { gmSocketId, phase, players: {name: {name,role,alive,connected,socketId}}, wolfVotes, dayVotes, ... }
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
    config: room.config,
    pendingWolfVictim: room.pendingWolfVictim || null,
    witch: room.witch,
    witchAction: room.witchAction || null,
    pendingHunter: room.pendingHunter || null,
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

function tallyByName(votes) {
  const counts = {};
  for (const targetName of Object.values(votes)) {
    counts[targetName] = (counts[targetName] || 0) + 1;
  }
  return counts;
}

// Élimine réellement un joueur, gère la chaîne du Chasseur et vérifie la victoire.
function eliminatePlayer(room, roomCode, targetName, cause) {
  const target = room.players[targetName];
  if (!target || !target.alive) return;
  target.alive = false;
  io.to(roomCode).emit('game:eliminated', { name: target.name, role: target.role, cause });
  syncPlayer(room, target);

  if (target.role === 'Chasseur' && alivePlayers(room).length > 0) {
    // Le Chasseur abat quelqu'un avant que la partie ne continue.
    room.pendingHunter = target.name;
    syncPlayer(room, target);
    io.to(room.gmSocketId).emit('gm:state', gmSnapshot(room, roomCode));
    return; // on attend le tir du Chasseur avant de vérifier la victoire
  }

  finishResolution(room, roomCode);
}

function finishResolution(room, roomCode) {
  const winner = checkWinner(room);
  if (winner) {
    room.phase = 'ended';
    io.to(roomCode).emit('game:over', { winner, roster: publicRoster(room) });
  }
  io.to(room.gmSocketId).emit('gm:state', gmSnapshot(room, roomCode));
}

// Résout les morts en attente de la nuit (victime des loups + éventuelle victime de la Sorcière)
// puis vide les champs "pending". Appelé quand le MJ quitte les phases 'night-wolves' / 'night-witch'.
function resolveNightDeaths(room, roomCode) {
  const wolfVictim = room.pendingWolfVictim;
  const witchVictim = room.pendingWitchVictim;
  const saved = room.witchSavedVictim;
  room.pendingWolfVictim = null;
  room.pendingWitchVictim = null;
  room.witchSavedVictim = false;
  room.witchAction = null;

  if (wolfVictim && !saved) eliminatePlayer(room, roomCode, wolfVictim, 'loups');
  if (witchVictim) eliminatePlayer(room, roomCode, witchVictim, 'poison');
}

// Envoie à UN joueur (par nom) tout ce dont il a besoin pour reconstruire son écran
function syncPlayer(room, player) {
  if (!player.connected) return;
  const payload = {
    role: player.role,
    alive: player.alive,
    phase: room.phase,
    wolfTeam: player.role === 'Loup-Garou' ? wolfTeamNames(room) : [],
    mode: null,
    targets: null,
    extra: null,
  };

  // Le Chasseur tire même s'il vient d'être éliminé, avant l'écran "mort".
  if (room.pendingHunter === player.name) {
    payload.mode = 'hunter-shot';
    payload.targets = alivePlayers(room).filter(p => p.name !== player.name).map(p => ({ id: p.name, name: p.name }));
    io.to(player.socketId).emit('player:sync', payload);
    return;
  }

  if (!player.alive) {
    io.to(player.socketId).emit('player:sync', payload);
    return;
  }

  if (room.phase === 'night-wolves' && player.role === 'Loup-Garou') {
    payload.mode = 'wolf-vote';
    payload.targets = alivePlayers(room).filter(p => p.role !== 'Loup-Garou').map(p => ({ id: p.name, name: p.name }));
  } else if (room.phase === 'night-wolves' && player.role === 'Petite Fille') {
    payload.mode = 'peek';
    payload.extra = { tally: tallyByName(room.wolfVotes) };
  } else if (room.phase === 'night-witch' && player.role === 'Sorcière') {
    payload.mode = 'witch';
    payload.extra = {
      victim: room.pendingWolfVictim || null,
      canHeal: !room.witch.usedHeal,
      canPoison: !room.witch.usedPoison,
    };
    payload.targets = alivePlayers(room).filter(p => p.name !== player.name).map(p => ({ id: p.name, name: p.name }));
  } else if (room.phase === 'night-seer' && player.role === 'Voyante') {
    payload.mode = 'seer-check';
    payload.extra = { used: room.seerUsedThisNight };
    if (!room.seerUsedThisNight) {
      payload.targets = alivePlayers(room).filter(p => p.name !== player.name).map(p => ({ id: p.name, name: p.name }));
    }
  } else if (room.phase === 'day-vote') {
    payload.mode = 'day-vote';
    payload.targets = alivePlayers(room).filter(p => p.name !== player.name).map(p => ({ id: p.name, name: p.name }));
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
      config: { wolvesCount: 1, includeSeer: true, includeWitch: false, includeLittleGirl: false, includeHunter: false },
      witch: { usedHeal: false, usedPoison: false },
      pendingWolfVictim: null,
      pendingWitchVictim: null,
      witchSavedVictim: false,
      witchAction: null,
      pendingHunter: null,
      seerUsedThisNight: false,
    };
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.isGM = true;
    cb({ roomCode });
  });

  socket.on('gm:startGame', ({ roomCode, wolvesCount, includeSeer, includeWitch, includeLittleGirl, includeHunter }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ error: 'Partie introuvable' });
    const players = Object.values(room.players);
    if (players.length < 3) return cb({ error: 'Il faut au moins 3 joueurs' });
    if (wolvesCount < 1 || wolvesCount >= players.length) return cb({ error: 'Nombre de loups invalide' });

    const specialCount = wolvesCount + (includeSeer ? 1 : 0) + (includeWitch ? 1 : 0) + (includeLittleGirl ? 1 : 0) + (includeHunter ? 1 : 0);
    if (specialCount > players.length) return cb({ error: 'Trop de rôles spéciaux pour ce nombre de joueurs' });

    const shuffled = shuffle(players);
    let idx = 0;
    for (let i = 0; i < wolvesCount; i++) { shuffled[idx].role = 'Loup-Garou'; idx++; }
    if (includeSeer && idx < shuffled.length) { shuffled[idx].role = 'Voyante'; idx++; }
    if (includeWitch && idx < shuffled.length) { shuffled[idx].role = 'Sorcière'; idx++; }
    if (includeLittleGirl && idx < shuffled.length) { shuffled[idx].role = 'Petite Fille'; idx++; }
    if (includeHunter && idx < shuffled.length) { shuffled[idx].role = 'Chasseur'; idx++; }
    while (idx < shuffled.length) { shuffled[idx].role = 'Villageois'; idx++; }

    room.phase = 'night-wolves';
    room.config = { wolvesCount, includeSeer, includeWitch, includeLittleGirl, includeHunter };
    room.wolfVotes = {};
    room.dayVotes = {};
    room.witch = { usedHeal: false, usedPoison: false };
    room.pendingWolfVictim = null;
    room.pendingWitchVictim = null;
    room.witchSavedVictim = false;
    room.witchAction = null;
    room.pendingHunter = null;
    room.seerUsedThisNight = false;

    for (const p of players) syncPlayer(room, p);
    io.to(room.gmSocketId).emit('gm:state', gmSnapshot(room, roomCode));
    cb({ success: true });
  });

  socket.on('gm:setPhase', ({ roomCode, phase }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.gmSocketId) return;

    const leavingWolves = room.phase === 'night-wolves' && phase !== 'night-wolves';
    const leavingWitch = room.phase === 'night-witch' && phase !== 'night-witch';

    room.phase = phase;
    if (phase === 'night-wolves') {
      room.wolfVotes = {};
      room.pendingWolfVictim = null;
      room.pendingWitchVictim = null;
      room.witchSavedVictim = false;
      room.witchAction = null;
      room.seerUsedThisNight = false;
    }
    if (phase === 'day-vote') room.dayVotes = {};

    io.to(roomCode).emit('game:phase', { phase });
    for (const p of alivePlayers(room)) syncPlayer(room, p);
    io.to(room.gmSocketId).emit('gm:state', gmSnapshot(room, roomCode));

    // Sans Sorcière, on résout directement en quittant la nuit des loups (comportement historique).
    // Avec Sorcière, on résout en quittant la phase Sorcière (elle a eu sa chance d'agir).
    if (!room.config.includeWitch && leavingWolves && room.pendingWolfVictim) {
      resolveNightDeaths(room, roomCode);
    } else if (room.config.includeWitch && leavingWitch) {
      resolveNightDeaths(room, roomCode);
    }
  });

  // Désigne la victime des loups sans l'éliminer tout de suite (laisse une chance à la Sorcière).
  socket.on('gm:designateWolfVictim', ({ roomCode, targetName }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.gmSocketId) return;
    const target = room.players[targetName];
    if (!target || !target.alive) return;
    room.pendingWolfVictim = targetName;
    io.to(room.gmSocketId).emit('gm:state', gmSnapshot(room, roomCode));
  });

  socket.on('gm:eliminate', ({ roomCode, targetName, cause }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.gmSocketId) return;
    eliminatePlayer(room, roomCode, targetName, cause);
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
    // La Petite Fille espionne en direct : on lui renvoie son état à jour.
    const littleGirl = Object.values(room.players).find(p => p.role === 'Petite Fille' && p.alive);
    if (littleGirl) syncPlayer(room, littleGirl);
  });

  socket.on('seer:check', ({ roomCode, target }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'night-seer') return;
    const seer = room.players[socket.data.playerName];
    if (!seer || seer.role !== 'Voyante' || !seer.alive) return;
    if (room.seerUsedThisNight) return; // une seule vision par nuit
    const t = room.players[target];
    if (!t) return;
    room.seerUsedThisNight = true;
    socket.emit('seer:result', { name: t.name, role: t.role });
    syncPlayer(room, seer); // verrouille la grille côté client (used: true)
    io.to(room.gmSocketId).emit('gm:seerChecked', { seer: seer.name, target: t.name, role: t.role });
  });

  // La Sorcière : sauve la victime des loups et/ou empoisonne quelqu'un (chaque potion, une seule fois par partie).
  socket.on('witch:action', ({ roomCode, type, target }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'night-witch') return;
    const witch = room.players[socket.data.playerName];
    if (!witch || witch.role !== 'Sorcière' || !witch.alive) return;

    if (type === 'heal') {
      if (room.witch.usedHeal || !room.pendingWolfVictim) return;
      room.witch.usedHeal = true;
      room.witchSavedVictim = true;
      room.witchAction = { type: 'heal', target: room.pendingWolfVictim };
    } else if (type === 'poison') {
      if (room.witch.usedPoison || !target) return;
      const t = room.players[target];
      if (!t || !t.alive) return;
      room.witch.usedPoison = true;
      room.pendingWitchVictim = target;
      room.witchAction = { type: 'poison', target };
    } else {
      return;
    }
    io.to(room.gmSocketId).emit('gm:witchAction', room.witchAction);
    io.to(room.gmSocketId).emit('gm:state', gmSnapshot(room, roomCode));
  });

  socket.on('player:vote', ({ roomCode, target }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'day-vote') return;
    const voter = room.players[socket.data.playerName];
    if (!voter || !voter.alive) return;
    room.dayVotes[voter.name] = target;
    io.to(room.gmSocketId).emit('gm:dayVotes', tallyByName(room.dayVotes));
  });

  // Le Chasseur, une fois éliminé, abat immédiatement quelqu'un d'autre.
  socket.on('hunter:shoot', ({ roomCode, target }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const hunter = room.players[socket.data.playerName];
    if (!hunter || room.pendingHunter !== hunter.name) return;
    const t = room.players[target];
    if (!t || !t.alive) return;
    room.pendingHunter = null;
    syncPlayer(room, hunter); // renvoie l'écran "mort" normal au Chasseur
    eliminatePlayer(room, roomCode, target, 'chasseur');
    finishResolution(room, roomCode);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Loup-Garou en ligne : http://localhost:${PORT}`));
