const socket = io();
let roomCode = null;
let players = [];
let lastWolfVotes = {};
let lastDayVotes = {};
let lastSeerCheck = null;
let lastWitchAction = null;
let currentConfig = { includeWitch: false };
let pendingWolfVictim = null;
let pendingHunter = null;
let maxWolvesAllowed = 1;

const $ = id => document.getElementById(id);

$('createBtn').onclick = () => {
  socket.emit('gm:createRoom', (res) => {
    roomCode = res.roomCode;
    $('lobbyView').style.display = 'none';
    $('waitingView').style.display = 'block';
    $('roomCodeDisplay').textContent = roomCode;
  });
};

socket.on('gm:state', (state) => {
  players = state.players;
  if (state.config) currentConfig = state.config;
  pendingWolfVictim = state.pendingWolfVictim || null;
  pendingHunter = state.pendingHunter || null;
  renderLobby();
  renderRoster();
  if (pendingHunter) renderHunterWait();
});

function renderLobby() {
  $('playerCount').textContent = players.length;
  $('lobbyPlayerList').innerHTML = players.map(p => `<li><span>${p.name}</span></li>`).join('');
  // Aligné sur la validation serveur : wolvesCount doit être < players.length.
  maxWolvesAllowed = Math.max(1, players.length - 1);
  $('wolvesCount').max = maxWolvesAllowed;
  if (parseInt($('wolvesCount').value, 10) > maxWolvesAllowed) $('wolvesCount').value = maxWolvesAllowed;
}

$('wolvesMinus').onclick = () => {
  const el = $('wolvesCount');
  el.value = Math.max(1, parseInt(el.value, 10) - 1);
};
$('wolvesPlus').onclick = () => {
  const el = $('wolvesCount');
  el.value = Math.min(maxWolvesAllowed, parseInt(el.value, 10) + 1);
};

$('startBtn').onclick = () => {
  const wolvesCount = parseInt($('wolvesCount').value, 10);
  const includeSeer = $('includeSeer').checked;
  const includeWitch = $('includeWitch').checked;
  const includeLittleGirl = $('includeLittleGirl').checked;
  const includeHunter = $('includeHunter').checked;
  socket.emit('gm:startGame', { roomCode, wolvesCount, includeSeer, includeWitch, includeLittleGirl, includeHunter }, (res) => {
    if (res.error) {
      $('startError').textContent = res.error;
      $('startError').style.display = 'block';
      return;
    }
    currentConfig = { includeWitch, includeLittleGirl, includeHunter };
    $('witchPhaseBtn').style.display = includeWitch ? '' : 'none';
    $('waitingView').style.display = 'none';
    $('gameView').style.display = 'block';
  });
};

document.querySelectorAll('[data-phase]').forEach(btn => {
  btn.onclick = () => socket.emit('gm:setPhase', { roomCode, phase: btn.dataset.phase });
});

socket.on('game:phase', ({ phase }) => {
  const labels = {
    'night-wolves': '🌙 Nuit — les loups choisissent',
    'night-witch': '🧪 Nuit — la sorcière agit',
    'night-seer': '🔮 Nuit — la voyante observe',
    'day-discussion': '☀️ Jour — le village débat',
    'day-vote': '🗳️ Jour — vote du village',
  };
  $('phaseLabel').textContent = labels[phase] || phase;
  document.querySelectorAll('[data-phase]').forEach(b => b.style.background = b.dataset.phase === phase ? 'var(--forest)' : 'transparent');
  lastWolfVotes = {}; lastDayVotes = {}; lastSeerCheck = null; lastWitchAction = null;
  renderAction(phase);
});

socket.on('gm:wolfVotes', (tally) => { lastWolfVotes = tally; renderAction('night-wolves'); });
socket.on('gm:dayVotes', (tally) => { lastDayVotes = tally; renderAction('day-vote'); });
socket.on('gm:seerChecked', (data) => { lastSeerCheck = data; renderAction('night-seer'); });
socket.on('gm:witchAction', (data) => { lastWitchAction = data; renderAction('night-witch'); });

function renderAction(phase) {
  const zone = $('actionZone');
  const alive = players.filter(p => p.alive);
  if (pendingHunter) { renderHunterWait(); return; }
  if (phase === 'night-wolves') {
    const withWitch = currentConfig.includeWitch;
    const btnLabel = withWitch ? 'Désigner la victime des loups' : 'Confirmer la victime des loups';
    const statusLine = withWitch && pendingWolfVictim
      ? `<p style="margin-top:10px;opacity:0.8">Victime désignée : <strong>${pendingWolfVictim}</strong> — passe en phase Sorcière pour continuer.</p>` : '';
    zone.innerHTML = `<h3 style="margin-top:0">Votes des loups</h3>${tallyHTML(lastWolfVotes)}
      <div style="margin-top:14px">
        <select id="elimSelect">${alive.filter(p=>p.role!=='Loup-Garou').map(p=>`<option value="${p.name}">${p.name}</option>`).join('')}</select>
        <button class="danger" id="confirmElim">${btnLabel}</button>
      </div>${statusLine}`;
    $('confirmElim').onclick = () => {
      const targetName = $('elimSelect').value;
      if (withWitch) {
        socket.emit('gm:designateWolfVictim', { roomCode, targetName });
      } else {
        socket.emit('gm:eliminate', { roomCode, targetName, cause: 'loups' });
      }
    };
  } else if (phase === 'night-witch') {
    const victimLine = pendingWolfVictim
      ? `Victime des loups cette nuit : <strong>${pendingWolfVictim}</strong>`
      : `Les loups n'ont pas encore désigné de victime.`;
    const actionLine = lastWitchAction
      ? (lastWitchAction.type === 'heal'
          ? `<p style="margin-top:10px">🧪 La Sorcière a sauvé <strong>${lastWitchAction.target}</strong>.</p>`
          : `<p style="margin-top:10px">☠️ La Sorcière a empoisonné <strong>${lastWitchAction.target}</strong>.</p>`)
      : `<p style="margin-top:10px;opacity:0.6">En attente de la décision de la Sorcière...</p>`;
    zone.innerHTML = `<h3 style="margin-top:0">Action de la Sorcière</h3><p>${victimLine}</p>${actionLine}
      <p style="margin-top:14px;opacity:0.7;font-size:0.85rem">Passe à la phase suivante quand la Sorcière a fini — les morts de la nuit seront alors annoncées.</p>`;
  } else if (phase === 'night-seer') {
    zone.innerHTML = `<h3 style="margin-top:0">Vision de la voyante</h3>` +
      (lastSeerCheck ? `<p>${lastSeerCheck.seer} a observé <strong>${lastSeerCheck.target}</strong> → <span class="tag">${lastSeerCheck.role}</span></p>` : `<p style="opacity:0.6">En attente de la voyante...</p>`);
  } else if (phase === 'day-vote') {
    zone.innerHTML = `<h3 style="margin-top:0">Votes du village</h3>${tallyHTML(lastDayVotes)}
      <div style="margin-top:14px">
        <select id="elimSelect">${alive.map(p=>`<option value="${p.name}">${p.name}</option>`).join('')}</select>
        <button class="danger" id="confirmElim">Éliminer ce joueur</button>
      </div>`;
    $('confirmElim').onclick = () => {
      const targetName = $('elimSelect').value;
      socket.emit('gm:eliminate', { roomCode, targetName, cause: 'vote' });
    };
  } else {
    zone.innerHTML = `<p style="opacity:0.6;margin:0">Le village discute à voix haute — aucune action numérique nécessaire.</p>`;
  }
}

function renderHunterWait() {
  $('actionZone').innerHTML = `<h3 style="margin-top:0">🏹 Le Chasseur a été éliminé</h3>
    <p style="opacity:0.75"><strong>${pendingHunter}</strong> choisit en ce moment une dernière victime avant de mourir. Attends son tir...</p>`;
}

function tallyHTML(tally) {
  const entries = Object.entries(tally);
  if (!entries.length) return `<p style="opacity:0.6;margin:0">Aucun vote pour l'instant.</p>`;
  return `<div class="tally">${entries.map(([name, count]) => `<div class="tally-row"><span>${name}</span><span>${count}</span></div>`).join('')}</div>`;
}

function renderRoster() {
  $('rosterList').innerHTML = players.map(p => {
    const tagClasses = { 'Loup-Garou': 'wolf', 'Voyante': 'seer', 'Sorcière': 'witch', 'Petite Fille': 'littlegirl', 'Chasseur': 'hunter' };
    const tagClass = tagClasses[p.role] || '';
    const connIcon = (p.alive && !p.connected) ? ' 🔌' : '';
    return `<li class="${p.alive ? '' : 'dead'}"><span>${p.name}${connIcon}</span><span class="tag ${tagClass}">${p.role || '?'}</span></li>`;
  }).join('');
}

socket.on('game:over', ({ winner, roster }) => {
  players = roster;
  renderRoster();
  $('gameView').querySelector('.btn-row').style.display = 'none';
  const zone = $('actionZone');
  const isWolves = winner === 'loups';
  zone.innerHTML = `<div class="winner-banner ${isWolves ? 'wolves' : 'village'}">
    <div class="moon">${isWolves ? '🐺' : '🕊️'}</div>
    <h2>${isWolves ? 'Les Loups-Garous gagnent !' : 'Le Village gagne !'}</h2>
  </div>`;
});
