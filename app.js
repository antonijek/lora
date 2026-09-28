// UI za Loru — tanak sloj nad engine-om (engine/dist).
// Dva izvora stanja za isti sto:
//  - 'local': igra protiv računara u browseru (LoraGame + AI ovde),
//  - 'online': server šalje room:state (vidi online.js), ovde se samo crta.

import {
  LoraGame, LoraError, chooseAction, CONTRACT_NAMES, CONTRACT_GOALS, DEFAULT_CONTRACTS, SUITS, nextNeeded,
} from './engine/dist/index.js';
import { initOnline } from './online.js';

// ?fast — bez pauza (headless testovi)
const FAST = new URLSearchParams(location.search).has('fast');
const AI_DELAY = FAST ? 0 : 650;
const TRICK_PAUSE = FAST ? 0 : 1100;
// v2: izbor igara (stari snimci nemaju chooser/used)
const SAVE_KEY = 'lora.save.v2';
// Lokalno: 0 = vi, 1 = desno, 2 = preko puta, 3 = levo (igra se suprotno od kazaljke).
const LOCAL_NAMES = ['Vi', 'Milan', 'Jelena', 'Bora'];
const COLORS = ['#2f7dd1', '#c0392b', '#8e44ad', '#d68910'];

const $ = id => document.getElementById(id);

let mode = 'local';      // 'local' | 'online'
let game = null;         // lokalna igra
let online = null;       // API iz online.js
let onlineState = null;  // poslednji room:state
let level = 'medium';
let timer = null;
let busy = false;        // pauza dok se prikazuje završen štih
let lastView = null;     // prethodni prikaz (za otkrivanje završenog štiha)
let toastTimer = null;
let pickerOpen = false;
let dealEndShown = null; // dealIndex za koji je prikazan dijalog kraja partije
let passSentFor = null;  // online: automatsko "dalje" samo jednom po verziji

// ---------- izvor stanja ----------

/** Sve što sto treba da nacrta, bez obzira odakle stiže. */
function ctx() {
  if (mode === 'online') {
    const st = onlineState;
    if (!st?.view) return { v: null, me: 0, names: [], seats: null };
    return {
      v: st.view,
      me: st.mySeat,
      names: st.seats.map((s, i) => (i === st.mySeat ? 'Vi' : s.name ?? '—')),
      seats: st.seats,
    };
  }
  return { v: game.getPlayerView(0), me: 0, names: LOCAL_NAMES, seats: null };
}

// ---------- lokalno čuvanje ----------

function save() {
  if (mode !== 'local' || !game) return;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ level, state: game.getState() })); } catch {}
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    level = data.level ?? 'medium';
    game = LoraGame.fromState(data.state);
    return true;
  } catch {
    return false;
  }
}

function newLocalGame() {
  clearTimeout(timer);
  busy = false;
  pickerOpen = false;
  dealEndShown = null;
  game = new LoraGame();
  lastView = null;
  save();
  render();
  step();
}

// ---------- karte ----------

function cardImg(card) {
  const img = document.createElement('img');
  img.className = 'card-img';
  img.src = `./icons/cards/${card.id}.svg`;
  img.alt = `${card.rank}${card.suit}`;
  img.draggable = false;
  return img;
}

function backImg() {
  const img = document.createElement('img');
  img.src = './icons/cards/back-red.svg';
  img.alt = '';
  return img;
}

const letter = suit => ({ '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' })[suit];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- render ----------

function render(showTrick = null) {
  const c = ctx();
  const { v, names } = c;
  if (!v) return;
  const rel = p => (p - c.me + 4) % 4;

  $('contractName').textContent = v.contract ? CONTRACT_NAMES[v.contract] : 'Bira se igra';
  $('dealInfo').innerHTML =
    `Igra: <strong>${esc(names[v.chooser])}</strong> · Delio: <strong>${esc(names[v.dealer])}</strong> · partija ${v.dealIndex + 1}/28`;
  // opis igre nije na stolu — vidi se kao podsetnik preko naziva u zaglavlju
  $('contractName').title = v.contract ? CONTRACT_GOALS[v.contract] : '';

  for (const p of [0, 1, 2, 3]) renderSeat(c, p, rel(p), showTrick);
  renderCenter(c, rel, showTrick);
  renderHand(c, showTrick);
  $('actions').replaceChildren(...(v.phase === 'CHOOSING' && v.chooser === c.me ? [picker(v)] : []));
}

function renderSeat(c, p, relPos, showTrick) {
  const { v, names, seats } = c;
  const el = document.querySelector(`.seat[data-seat="${relPos}"]`);
  const acting = v.phase === 'TRICKS' || v.phase === 'LAYOUT' || v.phase === 'CHOOSING';
  const active = !showTrick && acting && v.turn === p;
  const info = seats?.[p];

  const plate = document.createElement('div');
  plate.className = 'plate' + (active ? ' active' : '') + (info && !info.connected ? ' offline' : '');
  const tricks = v.phase === 'TRICKS' ? ` · štihova <b>${v.trickCounts[p]}</b>` : '';
  const cards = p !== c.me ? ` · karata <b>${v.handCounts[p]}</b>` : '';
  const tag = info?.kind === 'ai' && !String(info.name).includes('(AI)') ? '<span class="ai-tag">AI</span>'
    : info && !info.connected ? '<span class="ai-tag">bez veze</span>' : '';
  plate.innerHTML =
    `<div class="avatar" style="background:${COLORS[p]}">${esc(String(names[p])[0] ?? '?')}</div>` +
    `<div><div class="name">${esc(names[p])}${tag}</div>` +
    `<div class="sub">poena <b>${v.scores[p]}</b>${tricks}</div>` +
    `<div class="sub">igre ${v.used[p].length}/${DEFAULT_CONTRACTS.length}${cards}${info && p !== c.me ? ` · rejting ${info.rating}` : ''}</div></div>` +
    (v.dealer === p ? '<span class="dealer-chip" title="Delio">D</span>' : '');

  const chips = document.createElement('div');
  chips.className = 'chips';
  if (v.chooser === p && v.contract) chips.innerHTML += `<span class="chip">${esc(CONTRACT_NAMES[v.contract])}</span>`;
  if (v.lastPass === p) chips.innerHTML += '<span class="chip pass">dalje</span>';

  const parts = [plate];
  if (chips.childElementCount) parts.push(chips);
  if (p !== c.me) {
    const backs = document.createElement('div');
    backs.className = 'backs';
    backs.append(...Array.from({ length: v.handCounts[p] }, backImg));
    parts.push(backs);
  }
  el.replaceChildren(...parts);
}

/** Padajući meni za izbor igre, desno od karata. */
function picker(v) {
  const wrap = document.createElement('div');
  wrap.className = 'picker';
  const btn = document.createElement('button');
  btn.className = 'pick-btn' + (pickerOpen ? '' : ' pulse');
  btn.textContent = pickerOpen ? 'Igra ▴' : 'Izaberi igru ▾';
  btn.setAttribute('aria-expanded', String(pickerOpen));
  btn.addEventListener('click', () => { pickerOpen = !pickerOpen; render(); });
  wrap.appendChild(btn);
  if (pickerOpen) {
    const menu = document.createElement('div');
    menu.className = 'pick-menu';
    menu.setAttribute('role', 'menu');
    for (const c of v.available) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.textContent = CONTRACT_NAMES[c];
      b.title = CONTRACT_GOALS[c];
      b.addEventListener('click', () => humanChoose(c));
      menu.appendChild(b);
    }
    wrap.appendChild(menu);
  }
  return wrap;
}

function renderCenter(c, rel, showTrick) {
  const { v, names } = c;
  const trickEl = $('trick');
  const layoutEl = $('layout');
  const msgEl = $('centerMsg');
  const isChoosing = v.phase === 'CHOOSING';
  const isLayout = !isChoosing && v.contract === 'LORA';

  msgEl.hidden = !isChoosing || v.chooser === c.me;
  layoutEl.hidden = !isLayout;
  trickEl.hidden = isChoosing || isLayout;
  if (!isLayout) layoutEl.replaceChildren();

  if (isChoosing) {
    msgEl.textContent = `${names[v.chooser]} bira igru…`;
    return;
  }

  if (isLayout) {
    layoutEl.replaceChildren(...SUITS.map(suit => {
      const row = document.createElement('div');
      row.className = 'row';
      for (const rank of v.layout.piles[suit]) row.appendChild(cardImg({ id: rank + letter(suit), rank, suit }));
      const need = v.layout.startRank ? nextNeeded(v.layout, suit) : null;
      if (v.layout.piles[suit].length < 8) {
        const ghost = document.createElement('div');
        ghost.className = 'ghost' + (suit === '♥' || suit === '♦' ? ' red' : '');
        ghost.innerHTML = need ? `${need}<small>${suit}</small>` : suit;
        ghost.title = need ? `Sledeća: ${need}${suit}` : 'Boja još nije otvorena';
        row.appendChild(ghost);
      }
      return row;
    }));
    return;
  }

  const cards = showTrick ? showTrick.cards : v.trick;
  trickEl.replaceChildren(...cards.map(pc => {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.dataset.rel = rel(pc.player);
    if (showTrick && pc.player === showTrick.winner) slot.classList.add('winner');
    slot.appendChild(cardImg(pc.card));
    return slot;
  }));
}

function renderHand(c, showTrick) {
  const { v } = c;
  const hand = $('myHand');
  const myTurn = !showTrick && !busy && v.turn === c.me && (v.phase === 'TRICKS' || v.phase === 'LAYOUT');
  hand.classList.toggle('my-turn', myTurn);
  hand.replaceChildren(...v.hand.map(card => {
    const el = document.createElement('div');
    el.className = 'card';
    const legal = myTurn && v.legal.includes(card.id);
    el.classList.add(legal ? 'legal' : myTurn ? 'illegal' : 'idle');
    el.appendChild(cardImg(card));
    if (legal) {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.addEventListener('click', () => humanPlay(card.id));
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); humanPlay(card.id); } });
    }
    return el;
  }));
}

// ---------- potezi čoveka ----------

function humanPlay(cardId) {
  if (busy) return;
  if (mode === 'online') { online.send({ type: 'play', cardId }); return; }
  try {
    game.play(0, cardId);
  } catch (e) {
    if (e instanceof LoraError) { toast(e.message); return; }
    throw e;
  }
  afterLocalAction();
}

function humanChoose(contract) {
  if (busy) return;
  pickerOpen = false;
  if (mode === 'online') { online.send({ type: 'choose', contract }); return; }
  try {
    game.choose(0, contract);
  } catch (e) {
    if (e instanceof LoraError) { toast(e.message); return; }
    throw e;
  }
  afterLocalAction();
}

/** Da li je između dva prikaza završen štih (i koji). */
function completedTrick(prev, v) {
  if (!prev || !v || prev.dealIndex !== v.dealIndex || !v.lastTrick) return null;
  return v.trickNo > prev.trickNo ? v.lastTrick : null;
}

/** Posle svake promene: pokaži završen štih pa nastavi, ili odmah nastavi. */
function showUpdate(then) {
  const v = ctx().v;
  const done = completedTrick(lastView, v);
  lastView = v;
  if (done) {
    busy = true;
    render(done);
    timer = setTimeout(() => { busy = false; render(); then(); }, TRICK_PAUSE);
    return;
  }
  render();
  then();
}

// ---------- lokalni tok (protiv računara) ----------

function afterLocalAction() {
  save();
  showUpdate(step);
}

function step() {
  clearTimeout(timer);
  const s = game.getState();
  if (s.phase === 'DEAL_END' || s.phase === 'MATCH_END') { showDealEnd(); return; }
  const v = game.getPlayerView(s.turn);
  if (s.turn === 0) {
    if (v.mustPass) {
      timer = setTimeout(() => { toast('Nemate kartu koja može — dalje'); game.pass(0); afterLocalAction(); }, FAST ? 0 : 700);
    }
    return;
  }
  timer = setTimeout(() => {
    const turn = game.getState().turn;
    const a = chooseAction(game.getPlayerView(turn), level);
    if (a.type === 'pass') game.pass(turn);
    else if (a.type === 'choose') {
      game.choose(turn, a.contract);
      toast(`${LOCAL_NAMES[turn]} bira: ${CONTRACT_NAMES[a.contract]}`);
    } else game.play(turn, a.cardId);
    afterLocalAction();
  }, s.phase === 'CHOOSING' ? AI_DELAY * 2 : AI_DELAY);
}

// ---------- online tok (server odlučuje, ovde se samo crta) ----------

function onRoomState(st) {
  const prevStatus = onlineState?.status;
  onlineState = st;
  if (st.status === 'WAITING') { lastView = null; return; } // čekaonicu crta online.js
  if (busy) return; // posle pauze se crta najnovije stanje
  showUpdate(() => afterOnlineUpdate(prevStatus));
}

function afterOnlineUpdate() {
  const st = onlineState;
  const v = st.view;
  if (!v) return;
  // nova partija počela → zatvori dijalog prethodne
  if ($('dealEnd').open && v.phase !== 'DEAL_END' && st.status !== 'FINISHED') $('dealEnd').close();
  if ((v.phase === 'DEAL_END' || st.status === 'FINISHED') && dealEndShown !== `${v.dealIndex}:${st.status}`) {
    dealEndShown = `${v.dealIndex}:${st.status}`;
    showDealEnd();
  }
  if (v.phase === 'DEAL_END' && $('dealEnd').open) updateReadyButton();
  if (v.mustPass && v.turn === st.mySeat && passSentFor !== st.version) {
    passSentFor = st.version;
    toast('Nemate kartu koja može — dalje');
    setTimeout(() => online.send({ type: 'pass' }), FAST ? 0 : 700);
  }
}

function updateReadyButton() {
  const st = onlineState;
  const btn = $('nextDealBtn');
  const waiting = st.seats.filter((s, i) => s.kind === 'human' && s.connected && !st.ready.includes(i)).length;
  if (st.ready.includes(st.mySeat)) {
    btn.disabled = true;
    btn.textContent = waiting ? `Čeka se još ${waiting}…` : 'Kreće…';
  } else {
    btn.disabled = false;
    btn.textContent = 'Sledeća igra';
  }
}

// ---------- kraj partije / meča ----------

function showDealEnd() {
  const c = ctx();
  const { v, names } = c;
  const last = v.history.at(-1);
  if (!last) return;
  const finished = v.phase === 'MATCH_END';
  const rating = mode === 'online' ? onlineState.rating : null;

  $('dealEndTitle').textContent = finished
    ? (v.winners.includes(c.me) ? 'Pobeda! 🎉' : `Pobednik: ${v.winners.map(p => names[p]).join(', ')}`)
    : `${CONTRACT_NAMES[last.contract]} (igra: ${names[last.chooser]}) — kraj`;
  const min = Math.min(...v.scores);
  const ratingCol = finished && rating?.rated;
  $('dealEnd').querySelector('thead tr').innerHTML =
    `<th></th><th>Ova igra</th><th>Ukupno</th>${ratingCol ? '<th>Rejting</th>' : ''}`;
  $('dealEndBody').innerHTML = [0, 1, 2, 3].map(p =>
    `<tr><td>${esc(names[p])}</td><td>${fmt(last.points[p])}</td><td class="${v.scores[p] === min ? 'best' : ''}">${v.scores[p]}</td>` +
    (ratingCol ? `<td>${rating.newRatings[p]} (${fmt(rating.deltas[p])})</td>` : '') + '</tr>').join('');

  const btn = $('nextDealBtn');
  btn.disabled = false;
  if (finished) btn.textContent = mode === 'online' ? 'Nazad u lobi' : 'Nova igra';
  else if (mode === 'online') updateReadyButton();
  else btn.textContent = 'Sledeća igra';
  if (!$('dealEnd').open) $('dealEnd').showModal();
}

const fmt = n => (n > 0 ? `+${n}` : String(n));

/** Svaki igrač ima svoju tabelu: 7 igara, odigrane sa rezultatima, ostale sive. */
function renderSheet() {
  const c = ctx();
  const { v, names } = c;
  if (!v) return;
  const head = `<thead><tr><th>Igra</th>${names.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead>`;
  let html = '';
  for (const owner of [0, 1, 2, 3]) {
    const played = v.history.filter(h => h.chooser === owner);
    const title = owner === c.me ? 'Vaša tabela' : `Tabela: ${names[owner]}`;
    html += `<h3>${esc(title)} (${played.length}/${DEFAULT_CONTRACTS.length})</h3><table class="result">${head}<tbody>`;
    for (const contract of DEFAULT_CONTRACTS) {
      const h = played.find(x => x.contract === contract);
      const current = !h && v.chooser === owner && v.contract === contract && v.phase !== 'CHOOSING';
      const cells = [0, 1, 2, 3].map(p => `<td class="${p === owner ? 'mine' : ''}">${h ? fmt(h.points[p]) : current ? '…' : ''}</td>`).join('');
      html += `<tr class="${h || current ? '' : 'pending'}"><td>${CONTRACT_NAMES[contract]}${current ? ' (u toku)' : ''}</td>${cells}</tr>`;
    }
    html += '</tbody></table>';
  }
  html += `<table class="result"><tbody><tr class="total"><td>Ukupno</td>${v.scores.map(x => `<td>${x}</td>`).join('')}</tr></tbody></table>`;
  $('sheetBody').innerHTML = html;
  $('sheet').showModal();
}

// ---------- toast ----------

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- ekrani / režimi ----------

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

function goHome() {
  clearTimeout(timer);
  showScreen('startScreen');
}

function startLocal() {
  mode = 'local';
  onlineState = null;
  lastView = null;
  $('chatBtn').hidden = true;
  $('chatPanel').hidden = true;
  showScreen(null);
  if (game) { render(); step(); }
  else if (loadLocal()) { render(); step(); }
  else newLocalGame();
}

// ---------- dugmad ----------

$('nextDealBtn').addEventListener('click', () => {
  if (mode === 'online') {
    if (onlineState.status === 'FINISHED') { $('dealEnd').close(); online.leaveFinished(); return; }
    online.ready();
    return;
  }
  $('dealEnd').close();
  if (game.getState().phase === 'MATCH_END') { newLocalGame(); return; }
  game.nextDeal();
  save();
  lastView = null;
  render();
  step();
});
$('dealSheetBtn').addEventListener('click', renderSheet);
$('sheetBtn').addEventListener('click', renderSheet);
$('closeSheetBtn').addEventListener('click', () => $('sheet').close());
$('menuBtn').addEventListener('click', () => {
  const isOnline = mode === 'online';
  $('levelSel').value = level;
  $('levelLabel').hidden = isOnline;
  $('newGameBtn').hidden = isOnline;
  $('leaveMatchBtn').hidden = !isOnline;
  $('menu').showModal();
});
$('closeMenuBtn').addEventListener('click', () => $('menu').close());
$('levelSel').addEventListener('change', e => { level = e.target.value; save(); });
$('newGameBtn').addEventListener('click', () => { $('menu').close(); newLocalGame(); });
$('homeBtn').addEventListener('click', () => {
  $('menu').close();
  if (mode === 'online') online.showLobby();
  else goHome();
});
$('leaveMatchBtn').addEventListener('click', () => {
  if (!confirm('Napustiti meč? AI će igrati umesto vas do kraja, a možete se vratiti istim kodom sobe.')) return;
  $('menu').close();
  online.leaveMatch();
});
$('goLocalBtn').addEventListener('click', startLocal);
$('goOnlineBtn').addEventListener('click', () => online.start());
document.addEventListener('click', e => {
  if (pickerOpen && !e.target.closest('.picker')) { pickerOpen = false; render(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && pickerOpen) { pickerOpen = false; render(); }
});

// ---------- start ----------

online = initOnline({
  onRoomState,
  onEnterTable() {
    mode = 'online';
    clearTimeout(timer);
    busy = false;
    lastView = null;
    dealEndShown = null;
    passSentFor = null;
    $('chatBtn').hidden = false;
    showScreen(null);
    if (onlineState?.view) render();
  },
  onLeaveTable() {
    if ($('dealEnd').open) $('dealEnd').close();
    onlineState = null;
    lastView = null;
  },
  toast,
  goHome,
  showScreen,
});

if (new URLSearchParams(location.search).has('room')) online.start();
else if (new URLSearchParams(location.search).has('local')) startLocal();
else goHome();

window.__lora = {
  get game() { return game; },
  get busy() { return busy; },
  get mode() { return mode; },
  get onlineState() { return onlineState; },
  ME: 0,
};
