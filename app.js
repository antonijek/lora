// UI za Loru — tanak sloj nad engine-om (engine/dist).

import {
  LoraGame, LoraError, chooseAction, CONTRACT_NAMES, CONTRACT_GOALS, DEFAULT_CONTRACTS, SUITS, nextNeeded,
} from './engine/dist/index.js';

const ME = 0;
// ?fast — bez pauza (headless testovi)
const FAST = new URLSearchParams(location.search).has('fast');
const AI_DELAY = FAST ? 0 : 650;
const TRICK_PAUSE = FAST ? 0 : 1100;
const SAVE_KEY = 'lora.save.v1';
const NAMES = ['Vi', 'Desno', 'Preko puta', 'Levo'];

const $ = id => document.getElementById(id);

let game;
let level = 'medium';
let timer = null;
let busy = false;        // pauza dok se prikazuje završen štih
let toastTimer = null;

// ---------- čuvanje ----------

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ level, state: game.getState() })); } catch {}
}

function load() {
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

function newGame() {
  clearTimeout(timer);
  busy = false;
  game = new LoraGame();
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

const rel = p => (p - ME + 4) % 4;

// ---------- render ----------

function render(showTrick = null) {
  const v = game.getPlayerView(ME);

  $('contractName').textContent = CONTRACT_NAMES[v.contract];
  $('dealNo').textContent = `igra ${v.dealIndex + 1}/28 · deli: ${NAMES[v.dealer]}`;
  $('goal').textContent = CONTRACT_GOALS[v.contract];

  for (const p of [0, 1, 2, 3]) {
    const el = document.querySelector(`.seat[data-seat="${rel(p)}"]`);
    el.classList.toggle('active', !showTrick && v.turn === p && (v.phase === 'TRICKS' || v.phase === 'LAYOUT'));
    const tricks = v.phase === 'TRICKS' ? ` · štihova <b>${v.trickCounts[p]}</b>` : '';
    el.innerHTML = `<div class="name">${NAMES[p]}</div><div class="info">poena <b>${v.scores[p]}</b>${tricks}</div>`;
    if (p !== ME) {
      const backs = document.createElement('div');
      backs.className = 'backs';
      backs.append(...Array.from({ length: v.handCounts[p] }, backImg));
      el.appendChild(backs);
    }
    const pass = document.createElement('div');
    pass.className = 'pass';
    pass.textContent = v.lastPass === p ? 'dalje' : '';
    el.appendChild(pass);
  }

  renderCenter(v, showTrick);
  renderHand(v, showTrick);
}

function renderCenter(v, showTrick) {
  const trickEl = $('trick');
  const layoutEl = $('layout');
  const isLayout = v.contract === 'LORA';
  layoutEl.hidden = !isLayout;
  trickEl.hidden = isLayout;

  if (isLayout) {
    const rows = [];
    const start = v.layout.startRank;
    rows.push(`<div class="start">${start ? `Početni rang: <b>${start}</b>` : 'Prva karta određuje početni rang'}</div>`);
    layoutEl.innerHTML = rows.join('');
    for (const suit of SUITS) {
      const row = document.createElement('div');
      row.className = 'row';
      const red = suit === '♥' || suit === '♦';
      row.innerHTML = `<span class="suit ${red ? 'red' : ''}">${suit}</span>`;
      const pile = document.createElement('div');
      pile.className = 'pile';
      for (const rank of v.layout.piles[suit]) pile.appendChild(cardImg({ id: rank + letter(suit), rank, suit }));
      row.appendChild(pile);
      const need = nextNeeded(v.layout, suit);
      if (need) {
        const s = document.createElement('span');
        s.className = 'need';
        s.textContent = `sledeća: ${need}`;
        row.appendChild(s);
      }
      layoutEl.appendChild(row);
    }
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

function letter(suit) {
  return { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' }[suit];
}

function renderHand(v, showTrick) {
  const hand = $('myHand');
  const myTurn = !showTrick && !busy && v.turn === ME && (v.phase === 'TRICKS' || v.phase === 'LAYOUT');
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

// ---------- tok igre ----------

function humanPlay(cardId) {
  if (busy) return;
  const before = game.getState();
  try {
    game.play(ME, cardId);
  } catch (e) {
    if (e instanceof LoraError) { toast(e.message); return; }
    throw e;
  }
  afterAction(before);
}

function afterAction(before) {
  save();
  const s = game.getState();
  // četvrta karta u štihu → pokaži završen štih (i ko ga nosi), pa nastavi
  if (before.phase === 'TRICKS' && before.trick.length === 3 && s.lastTrick) {
    busy = true;
    render(s.lastTrick);
    timer = setTimeout(() => { busy = false; render(); step(); }, TRICK_PAUSE);
    return;
  }
  render();
  step();
}

function step() {
  clearTimeout(timer);
  const s = game.getState();
  if (s.phase === 'DEAL_END' || s.phase === 'MATCH_END') { showDealEnd(); return; }
  const v = game.getPlayerView(s.turn);
  if (s.turn === ME) {
    if (v.mustPass) {
      timer = setTimeout(() => { toast('Nemate kartu koja može — dalje'); const b = game.getState(); game.pass(ME); afterAction(b); }, FAST ? 0 : 700);
    }
    return;
  }
  timer = setTimeout(() => {
    const before = game.getState();
    const a = chooseAction(game.getPlayerView(before.turn), level);
    if (a.type === 'pass') game.pass(before.turn);
    else game.play(before.turn, a.cardId);
    afterAction(before);
  }, AI_DELAY);
}

// ---------- kraj partije / tabela ----------

function showDealEnd() {
  const s = game.getState();
  const last = s.history.at(-1);
  if (!last) return;
  $('dealEndTitle').textContent = s.phase === 'MATCH_END'
    ? (s.winners.includes(ME) ? 'Pobeda! 🎉' : `Pobednik: ${s.winners.map(p => NAMES[p]).join(', ')}`)
    : `${CONTRACT_NAMES[last.contract]} — kraj`;
  const min = Math.min(...s.scores);
  $('dealEndBody').innerHTML = [0, 1, 2, 3].map(p =>
    `<tr><td>${NAMES[p]}</td><td>${fmt(last.points[p])}</td><td class="${s.scores[p] === min ? 'best' : ''}">${s.scores[p]}</td></tr>`).join('');
  $('nextDealBtn').textContent = s.phase === 'MATCH_END' ? 'Nova igra' : 'Sledeća igra';
  $('dealEnd').showModal();
}

const fmt = n => (n > 0 ? `+${n}` : String(n));

function renderSheet() {
  const s = game.getState();
  const n = DEFAULT_CONTRACTS.length;
  let html = `<thead><tr><th>Igra</th>${NAMES.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>`;
  for (let i = 0; i < n * 4; i++) {
    const h = s.history[i];
    const contract = DEFAULT_CONTRACTS[i % n];
    const cls = [i % n === 0 && i > 0 ? 'sep' : '', h ? '' : 'pending'].join(' ');
    const cells = [0, 1, 2, 3].map(p => `<td class="${i % n === 0 && i > 0 ? 'sep' : ''}">${h ? fmt(h.points[p]) : ''}</td>`).join('');
    html += `<tr class="${h ? '' : 'pending'}"><td class="${cls}">${CONTRACT_NAMES[contract]}</td>${cells}</tr>`;
  }
  html += `<tr class="total"><td>Ukupno</td>${s.scores.map(x => `<td>${x}</td>`).join('')}</tr></tbody>`;
  $('sheetTable').innerHTML = html;
  $('sheet').showModal();
}

// ---------- toast / dugmad ----------

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

$('nextDealBtn').addEventListener('click', () => {
  $('dealEnd').close();
  if (game.getState().phase === 'MATCH_END') { newGame(); return; }
  game.nextDeal();
  save();
  render();
  step();
});
$('dealSheetBtn').addEventListener('click', renderSheet);
$('sheetBtn').addEventListener('click', renderSheet);
$('closeSheetBtn').addEventListener('click', () => $('sheet').close());
$('menuBtn').addEventListener('click', () => { $('levelSel').value = level; $('menu').showModal(); });
$('closeMenuBtn').addEventListener('click', () => $('menu').close());
$('levelSel').addEventListener('change', e => { level = e.target.value; save(); });
$('newGameBtn').addEventListener('click', () => { $('menu').close(); newGame(); });

// ---------- start ----------

if (load()) { render(); step(); }
else newGame();

window.__lora = { get game() { return game; }, get busy() { return busy; }, ME };
