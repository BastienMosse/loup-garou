const socket = io();
let roomCode = null;
let myName = null;
let myRole = null;
let alive = true;
const $ = id => document.getElementById(id);
const STORAGE_KEY = 'loupgarou_session';

function attemptJoin(code, name, isAutoReconnect) {
  socket.emit('player:join', { roomCode: code, name }, (res) => {
    if (res.error) {
      if (isAutoReconnect) {
        // La session enregistrée n'est plus valide (partie finie, nom déjà repris ailleurs...)
        localStorage.removeItem(STORAGE_KEY);
        $('reconnectView').style.display = 'none';
        $('joinView').style.display = 'block';
        return;
      }
      $('joinError').textContent = res.error;
      $('joinError').style.display = 'block';
      return;
    }
    roomCode = code;
    myName = name;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ roomCode: code, name }));
    $('reconnectView').style.display = 'none';
    $('joinView').style.display = 'none';
    if (!res.reconnected) {
      $('waitView').style.display = 'block';
    }
    // Si reconnecté en pleine partie, l'état complet arrive via 'player:sync'
  });
}

$('joinBtn').onclick = () => {
  const code = $('codeInput').value.trim().toUpperCase();
  const name = $('nameInput').value.trim();
  if (!code || !name) return;
  attemptJoin(code, name, false);
};

// Reconnexion automatique si le téléphone s'est mis en veille / la page a rechargé
(function tryAutoReconnect() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) { $('joinView').style.display = 'block'; return; }
  try {
    const { roomCode: code, name } = JSON.parse(saved);
    $('reconnectView').style.display = 'block';
    attemptJoin(code, name, true);
  } catch (e) {
    localStorage.removeItem(STORAGE_KEY);
    $('joinView').style.display = 'block';
  }
})();

// Le navigateur suspend souvent le socket quand l'écran se verrouille ;
// on force une tentative de reconnexion propre dès que l'onglet redevient actif.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.connected) {
    socket.connect();
  }
});
document.getElementById('leaveBtnWait').onclick = () => {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
};

socket.io.on('reconnect', () => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && roomCode) {
    const { roomCode: code, name } = JSON.parse(saved);
    attemptJoin(code, name, true);
  }
});

const ROLE_INFO = {
  'Loup-Garou': { icon: '🐺', desc: 'Chaque nuit, choisis une victime avec les autres loups. Le jour, fais profil bas et mens si nécessaire.' },
  'Voyante': { icon: '🔮', desc: 'Chaque nuit, tu peux observer secrètement le rôle d\'un autre joueur.' },
  'Villageois': { icon: '🧑\u200d🌾', desc: 'Tu n\'as pas de pouvoir spécial. Observe, débats et vote pour démasquer les loups.' },
};

const PHASE_WAIT_MSG = {
  'night-wolves': '🌙 Les loups choisissent leur victime. Ferme les yeux et attends.',
  'night-seer': '🔮 La voyante observe en silence.',
  'day-discussion': '☀️ C\'est l\'heure du débat ! Discutez à voix haute avec les autres joueurs.',
  'day-vote': '🗳️ Vote en cours...',
};

// Reçu à chaque changement de phase ET juste après une reconnexion :
// reconstruit tout l'écran du joueur à partir de l'état serveur (source unique de vérité).
socket.on('player:sync', ({ role, alive: isAlive, phase, wolfTeam, targets }) => {
  myRole = role;
  alive = isAlive;
  $('reconnectView').style.display = 'none';
  $('joinView').style.display = 'none';
  $('waitView').style.display = 'none';

  if (!alive) { showDeadWaiting(); return; }

  const info = ROLE_INFO[role];
  $('roleView').style.display = 'block';
  $('roleView').innerHTML = `<div class="card role-card">
    <div class="role-icon">${info.icon}</div>
    <div class="role-name">${role}</div>
    <div class="role-desc">${info.desc}</div>
    ${wolfTeam && wolfTeam.length > 1 ? `<div style="margin-top:16px;font-size:0.9rem;opacity:0.8">Tes complices : ${wolfTeam.join(', ')}</div>` : ''}
  </div>`;
  $('actionView').style.display = 'block';
  $('deadView').style.display = 'none';

  if (targets) {
    const titles = {
      'night-wolves': 'Choisissez la victime de cette nuit',
      'night-seer': 'Observe un joueur',
      'day-vote': 'Vote pour éliminer un joueur',
    };
    const events = { 'night-wolves': 'wolf:vote', 'night-seer': 'seer:check', 'day-vote': 'player:vote' };
    renderTargetGrid(titles[phase], targets, (id) => socket.emit(events[phase], { roomCode, target: id }));
  } else {
    showWaitingForPhase(PHASE_WAIT_MSG[phase]);
  }
});

function showWaitingForPhase(msg) {
  $('actionView').innerHTML = `<div class="center-msg">${msg || 'En attente du Maître du Jeu...'}</div>`;
}

function renderTargetGrid(title, targets, onPick) {
  $('actionView').innerHTML = `<div class="panel"><h3 style="margin-top:0">${title}</h3>
    <div class="target-grid" id="grid">${targets.map(t => `<button data-id="${t.id}">${t.name}</button>`).join('')}</div>
    <p id="confirmMsg" style="opacity:0.7;font-size:0.85rem;margin-top:10px"></p>
  </div>`;
  document.querySelectorAll('#grid button').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#grid button').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onPick(btn.dataset.id);
      $('confirmMsg').textContent = '✓ Choix envoyé au Maître du Jeu.';
    };
  });
}

socket.on('seer:result', ({ name, role }) => {
  const p = document.createElement('div');
  p.className = 'card';
  p.innerHTML = `<strong>${name}</strong> est... <span class="tag">${role}</span>`;
  $('actionView').prepend(p);
});

socket.on('game:eliminated', ({ name, role }) => {
  // Everyone sees the village announcement
  const banner = document.createElement('div');
  banner.className = 'panel';
  banner.innerHTML = `<p style="margin:0;text-align:center">💀 <strong>${name}</strong> a été éliminé — c'était <span class="tag">${role}</span></p>`;
  document.getElementById('app').insertBefore(banner, $('overView'));
});

function showDeadWaiting() {
  $('actionView').style.display = 'none';
  $('deadView').style.display = 'block';
  $('deadText').textContent = `Tu es éliminé. Tu peux observer la suite en silence, ton rôle était : ${myRole}.`;
}

socket.on('game:over', ({ winner }) => {
  const isWolves = winner === 'loups';
  $('actionView').style.display = 'none';
  $('deadView').style.display = 'none';
  $('overView').style.display = 'block';
  $('overView').innerHTML = `<div class="winner-banner ${isWolves ? 'wolves' : 'village'}">
    <div class="moon">${isWolves ? '🐺' : '🕊️'}</div>
    <h2>${isWolves ? 'Les Loups-Garous gagnent !' : 'Le Village gagne !'}</h2>
  </div>`;
});

socket.on('game:gmLeft', () => {
  showWaitingForPhase('⚠️ Le Maître du Jeu a quitté la partie.');
});
