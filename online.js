// Online deo: prijava (isti nalog kao Preferans), lobi, čekaonica, chat, pozivi.
// Server je izvor istine; sto (app.js) samo crta room:state koji ovde stigne.

// Radi i na sopstvenom domenu (/) i na podputanji (npr. antonije.dev/lora/).
const BASE = location.pathname.replace(/[^/]*$/, '');
const TOKEN_KEY = 'lora_token';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function initOnline(hooks) {
  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch {}
  let socket = null;
  let me = null;           // { id, name }
  let state = null;        // poslednji room:state
  let atTable = false;
  let registering = false;
  let lobbyTimer = null;
  let pendingInvite = null;
  let unread = 0;
  const wantedRoom = new URLSearchParams(location.search).get('room');

  // ---------------------------------------------------------------- prijava

  function showLogin(msg = '') {
    hooks.showScreen('loginScreen');
    $('loginError').textContent = msg;
    setRegistering(registering);
  }

  function setRegistering(on) {
    registering = on;
    $('loginTitle').textContent = on ? 'Registracija' : 'Prijava';
    $('nameRow').hidden = !on;
    $('loginName').required = on;
    $('loginSubmit').textContent = on ? 'Napravi nalog' : 'Prijavi se';
    $('loginToggle').textContent = on ? 'Već imate nalog? Prijavite se' : 'Nemate nalog? Registrujte se';
    $('loginPassword').autocomplete = on ? 'new-password' : 'current-password';
  }

  $('loginToggle').addEventListener('click', () => { setRegistering(!registering); $('loginError').textContent = ''; });
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = {
      email: $('loginEmail').value.trim(),
      password: $('loginPassword').value,
      name: $('loginName').value.trim(),
    };
    $('loginError').textContent = '';
    $('loginSubmit').disabled = true;
    try {
      const res = await fetch(`${BASE}api/${registering ? 'register' : 'login'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.token) { $('loginError').textContent = data.error || 'Greška pri prijavi.'; return; }
      token = data.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch {}
      hooks.onLogin?.();
      connect();
    } catch {
      $('loginError').textContent = 'Ne mogu da se povežem sa serverom.';
    } finally {
      $('loginSubmit').disabled = false;
    }
  });

  $('logoutBtn').addEventListener('click', () => {
    token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
    document.body.classList.remove('is-admin');
    socket?.disconnect();
    socket = null;
    showLogin();
  });

  for (const b of document.querySelectorAll('.backHome')) b.addEventListener('click', () => { stopLobbyRefresh(); hooks.goHome(); });

  // ---------------------------------------------------------------- socket

  function loadSocketIo() {
    return new Promise((resolve, reject) => {
      if (typeof io !== 'undefined') return resolve();
      const s = document.createElement('script');
      s.src = `${BASE}socket.io/socket.io.js`;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Online server nije dostupan sa ove adrese.'));
      document.head.appendChild(s);
    });
  }

  async function connect() {
    try {
      await loadSocketIo();
    } catch (e) {
      showLogin(e.message);
      return;
    }
    socket?.disconnect();
    let connectedOnce = false;
    let vid = null;
    try { vid = localStorage.getItem('lora.vid'); } catch {}
    // vid: da admin vidi ko je pre naloga igrao protiv računara (anonimno)
    socket = io({ path: `${BASE}socket.io`, auth: { token, vid } });

    socket.on('connect', () => { connectedOnce = true; });
    socket.on('connect_error', err => {
      // posle uspešne veze socket.io se sam rekonektuje — ne izbacuj korisnika
      if (connectedOnce) return;
      if (/Invalid|Missing|banned/i.test(err.message)) {
        token = null;
        try { localStorage.removeItem(TOKEN_KEY); } catch {}
        showLogin('Prijava je istekla — prijavite se ponovo.');
      } else {
        showLogin('Server trenutno nije dostupan. Pokušajte ponovo za minut.');
      }
      socket.disconnect();
    });

    socket.on('room:none', () => {
      state = null;
      leaveTable();
      if (wantedRoom && !sessionStorage.getItem(`tried:${wantedRoom}`)) {
        sessionStorage.setItem(`tried:${wantedRoom}`, '1');
        joinRoom(wantedRoom);
        return;
      }
      showLobby();
    });
    socket.on('room:state', st => {
      state = st;
      if (st.status === 'WAITING') {
        leaveTable();
        renderWaiting(st);
        hooks.onRoomState(st);
        return;
      }
      if (!atTable) {
        atTable = true;
        stopLobbyRefresh();
        hooks.onEnterTable();
      }
      hooks.onRoomState(st);
    });
    socket.on('chat:backlog', log => { $('chatLog').replaceChildren(); log.forEach(m => addChat(m, false)); });
    socket.on('chat:message', m => addChat(m, true));
    socket.on('room:invited', ({ code, fromName }) => {
      if (atTable) return; // ne prekidaj meč u toku
      pendingInvite = code;
      $('inviteText').textContent = `${fromName} vas zove u sobu ${code}.`;
      $('inviteDialog').showModal();
    });

    // ko sam (za lobi)
    fetch(`${BASE}api/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { me = d.user; document.body.classList.toggle('is-admin', !!me?.is_admin); renderMe(); loadStreak(); }).catch(() => {});
  }

  const emit = (ev, payload) => new Promise(resolve => {
    if (!socket) return resolve({ error: 'Niste povezani.' });
    socket.timeout(8000).emit(ev, payload, (err, res) => resolve(err ? { error: 'Server ne odgovara.' } : res));
  });

  function leaveTable() {
    if (!atTable) return;
    atTable = false;
    hooks.onLeaveTable();
    $('chatPanel').hidden = true;
  }

  // ---------------------------------------------------------------- lobi

  let myRating = null;
  let myStreak = 0;
  function renderMe() {
    $('lobbyMe').innerHTML = me
      ? `<span class="who"><span class="me-av">${esc(String(me.name)[0] ?? '?')}</span><b>${esc(me.name)}</b>${myRating ? ` <span class="muted small">${myRating}</span>` : ''}` +
        `${myStreak >= 2 ? ` <span class="streak" title="${myStreak} dana zaredom">🔥 ${myStreak}</span>` : ''}</span>`
      : '';
  }
  // niz dana zaredom pored imena u lobiju (podsticaj da se igra svaki dan)
  function loadStreak() {
    fetch(`${BASE}api/stats`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { myStreak = d.streak?.current ?? 0; renderMe(); }).catch(() => {});
  }

  function showLobby() {
    if (atTable && state?.status === 'PLAYING') return; // iz meča se izlazi preko "Napusti meč"
    leaveTable();
    hooks.showScreen('lobbyScreen');
    $('lobbyError').textContent = '';
    refreshLobby();
    stopLobbyRefresh();
    lobbyTimer = setInterval(refreshLobby, 5000);
  }

  function stopLobbyRefresh() {
    clearInterval(lobbyTimer);
    lobbyTimer = null;
  }

  async function refreshLobby() {
    const [{ rooms = [] }, { users = [] }, board] = await Promise.all([
      emit('room:list'),
      emit('presence:list'),
      fetch(`${BASE}api/leaderboard`).then(r => r.json()).catch(() => ({ players: [] })),
    ]);
    $('roomList').innerHTML = rooms.length
      ? rooms.map(r => `<li><span class="who"><b class="code">${esc(r.code)}</b><span class="nm muted small">${esc(r.host ?? '')} · ${r.players}/4</span></span><button class="btn" data-join="${esc(r.code)}">Uđi</button></li>`).join('')
      : '<li class="empty">Nema otvorenih soba. Klikni „Brza igra“ ili napravi svoju.</li>';
    $('onlineList').innerHTML = users.length
      ? users.map(u => `<li><span class="who"><span class="dot${u.busy ? ' busy' : ''}"></span><span class="nm">${esc(u.name)}</span></span><span class="muted small">${u.busy ? 'u meču' : u.rating}</span></li>`).join('')
      : '<li class="empty">Samo si ti trenutno ovde.</li>';
    $('onlineCount').textContent = users.length + 1;
    const players = board.players ?? [];
    $('leaderboard').innerHTML = players.length
      ? players.slice(0, 10).map((p, i) => `<li${me && p.user_id === me.id ? ' class="mine"' : ''}><span class="who"><span class="rank r${i + 1}">${i + 1}</span><span class="nm">${esc(p.name)}</span></span><b>${p.rating}</b></li>`).join('')
      : '<li class="empty">Još nema rangiranih mečeva.</li>';
    const mine = me && players.find(p => p.user_id === me.id);
    if (mine && mine.rating !== myRating) { myRating = mine.rating; renderMe(); }
  }

  $('roomList').addEventListener('click', e => {
    const code = e.target.closest('[data-join]')?.dataset.join;
    if (code) joinRoom(code);
  });
  $('quickBtn').addEventListener('click', async () => {
    const res = await emit('room:quick');
    if (res.error) $('lobbyError').textContent = res.error;
  });
  $('createBtn').addEventListener('click', async () => {
    const res = await emit('room:create', {});
    if (res.error) $('lobbyError').textContent = res.error;
  });
  $('joinForm').addEventListener('submit', e => {
    e.preventDefault();
    joinRoom($('joinCode').value);
  });

  async function joinRoom(code) {
    const res = await emit('room:join', { code: String(code).trim().toUpperCase() });
    if (res.error) {
      showLobby();
      $('lobbyError').textContent = res.error;
    }
  }

  $('inviteAccept').addEventListener('click', () => { $('inviteDialog').close(); if (pendingInvite) joinRoom(pendingInvite); });
  $('inviteDecline').addEventListener('click', () => $('inviteDialog').close());

  // ---------------------------------------------------------------- čekaonica

  function renderWaiting(st) {
    stopLobbyRefresh();
    hooks.showScreen('waitingScreen');
    const isHost = st.hostSeat === st.mySeat;
    $('roomCode').textContent = st.code;
    $('waitSeats').innerHTML = st.seats.map((s, i) => {
      const who = s.kind === 'empty' ? '<span class="muted">Slobodno mesto</span>'
        : `<div class="name"><b>${esc(s.name)}</b>${i === st.mySeat ? ' (vi)' : ''}${i === st.hostSeat ? ' · domaćin' : ''}</div>`
          + `<div class="muted small">${s.kind === 'ai' ? 'računar' : `rejting ${s.rating}`}</div>`;
      const btn = !isHost ? ''
        : s.kind === 'empty' ? `<button class="btn" data-ai-add="${i}">+ AI</button>`
        : s.kind === 'ai' ? `<button class="btn" data-ai-remove="${i}">Ukloni</button>` : '';
      return `<div class="wait-seat ${s.kind !== 'empty' ? 'filled' : ''}"><div class="grow">${who}</div>${btn}</div>`;
    }).join('');
    const humans = st.seats.filter(s => s.kind === 'human').length;
    const empty = st.seats.filter(s => s.kind === 'empty').length;
    $('startBtn').hidden = !isHost;
    $('startBtn').textContent = empty ? `Počni (${empty} × AI)` : 'Počni';
    $('waitHint').textContent = isHost
      ? (humans < 2 ? 'Sa manje od 2 čoveka meč nije rangiran.' : 'Meč će biti rangiran.') + ' Kad se skupe 4 čoveka, meč počinje sam.'
      : 'Čeka se da domaćin pokrene meč.';
  }

  $('waitSeats').addEventListener('click', e => {
    const add = e.target.closest('[data-ai-add]')?.dataset.aiAdd;
    const rem = e.target.closest('[data-ai-remove]')?.dataset.aiRemove;
    if (add !== undefined) emit('room:addAi', { seat: Number(add) });
    if (rem !== undefined) emit('room:removeAi', { seat: Number(rem) });
  });
  $('startBtn').addEventListener('click', async () => {
    const res = await emit('room:start');
    if (res.error) hooks.toast(res.error);
  });
  $('leaveRoomBtn').addEventListener('click', () => emit('room:leave'));
  $('copyLinkBtn').addEventListener('click', async () => {
    const url = `${location.origin}${BASE}?room=${state?.code ?? ''}`;
    try { await navigator.clipboard.writeText(url); $('copyLinkBtn').textContent = 'Kopirano ✓'; }
    catch {
      const input = document.createElement('input');
      input.value = url;
      input.readOnly = true;
      input.addEventListener('focus', () => input.select());
      hooks.ask({ title: 'Link sobe', text: 'Kopirajte link i pošaljite ga prijateljima.', ok: 'Zatvori', cancel: null, icon: 'link', extra: input });
    }
    setTimeout(() => { $('copyLinkBtn').textContent = 'Kopiraj link'; }, 2000);
  });
  $('inviteBtn').addEventListener('click', async () => {
    const list = $('inviteList');
    if (!list.hidden) { list.hidden = true; return; }
    const { users = [] } = await emit('presence:list');
    list.innerHTML = users.length
      ? users.map(u => `<li><span>${esc(u.name)} <span class="muted small">(${u.rating})</span></span>${u.busy
          ? '<button class="btn" disabled title="Igrač je u meču — poziv će moći kad završi">U meču</button>'
          : `<button class="btn" data-invite="${u.userId}">Pozovi</button>`}</li>`).join('')
      : '<li class="empty">Trenutno niko drugi nije online.</li>';
    list.hidden = false;
  });
  $('inviteList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-invite]');
    if (!btn) return;
    const res = await emit('room:invite', { userId: Number(btn.dataset.invite) });
    btn.textContent = res.busy ? 'U meču' : res.error ? 'Nije online' : 'Pozvan ✓';
    btn.disabled = true;
  });

  // ---------------------------------------------------------------- chat

  function addChat(m, fresh) {
    const line = document.createElement('div');
    if (m.name === 'Sistem') {
      line.className = 'sys';
      line.textContent = m.text;
    } else {
      line.innerHTML = `<b>${esc(m.name)}:</b> ${esc(m.text)}`;
    }
    $('chatLog').appendChild(line);
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
    if (fresh && $('chatPanel').hidden) {
      unread++;
      $('chatBadge').textContent = unread;
      $('chatBadge').hidden = false;
      if (m.name !== 'Sistem') hooks.toast(`${m.name}: ${m.text}`.slice(0, 80));
    }
    // sistemske poruke (neko napustio meč, vratio se, udaljen...) kao traka pri vrhu
    if (fresh && m.name === 'Sistem' && $('chatPanel').hidden) {
      hooks.notify(m.text);
    }
  }

  $('chatBtn').addEventListener('click', () => {
    const panel = $('chatPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      unread = 0;
      $('chatBadge').hidden = true;
      $('chatInput').focus();
    }
  });
  $('chatClose').addEventListener('click', () => { $('chatPanel').hidden = true; });
  $('chatForm').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;
    socket?.emit('chat:send', { text });
    $('chatInput').value = '';
  });

  // ---------------------------------------------------------------- API za sto

  return {
    start() {
      if (token) {
        hooks.showScreen('lobbyScreen');
        connect();
      } else {
        showLogin();
      }
    },
    showLobby,
    /** Pravo na formu za registraciju (poziv posle meča protiv računara). */
    register() {
      if (token) { this.start(); return; }
      setRegistering(true);
      showLogin();
    },
    async send(action) {
      const res = await emit('game:action', action);
      if (res.error) hooks.toast(res.error);
    },
    ready() { emit('game:ready'); },
    async leaveMatch() {
      await emit('room:leave');
    },
    async leaveFinished() {
      await emit('room:leaveFinished');
    },
  };
}
