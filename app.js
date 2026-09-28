// UI za Loru — tanak sloj nad engine-om (engine/dist).

import {
  LoraGame, LoraError, chooseAction, CONTRACT_NAMES, CONTRACT_GOALS, DEFAULT_CONTRACTS, SUITS, nextNeeded,
} from './engine/dist/index.js';

const ME = 0;
// ?fast — bez pauza (headless testovi)
const FAST = new URLSearchParams(location.search).has('fast');
const AI_DELAY = FAST ? 0 : 650;
const TRICK_PAUSE = FAST ? 0 : 1100;
// v2: izbor igara (stari snimci nemaju chooser/used)
const SAVE_KEY = 'lora.save.v2';
// Pozicije: 1 = desno, 2 = preko puta, 3 = levo (igra se suprotno od kazaljke).
const NAMES = ['Vi', 'Milan', 'Jelena', 'Bora'];
const COLORS = ['#2f7dd1', '#c0392b', '#8e44ad', '#d68910'];

const $ = id => document.getElementById(id);

let game;
let level = 'medium';
let timer = null;
let busy = false;        // pauza dok se prikazuje završen štih
let toastTimer = null;
let pickerOpen = false;  // meni za izbor igre — otvara se klikom na dugme

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
  pickerOpen = false;
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
const letter = suit => ({ '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' })[suit];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- render ----------

function render(showTrick = null) {
  const v = game.getPlayerView(ME);

  $('contractName').textContent = v.contract ? CONTRACT_NAMES[v.contract] : 'Bira se igra';
  $('dealInfo').innerHTML =
    `Igra: <strong>${esc(NAMES[v.chooser])}</strong> · Delio: <strong>${esc(NAMES[v.dealer])}</strong> · partija ${v.dealIndex + 1}/28`;
  let goal = v.contract ? esc(CONTRACT_GOALS[v.contract]) : '';
  if (v.contract === 'LORA') {
    goal += v.layout.startRank
      ? ` · počinje se od <b>${v.layout.startRank}</b>`
      : ' · prva karta određuje početni rang';
  }
  $('goal').innerHTML = goal;

  for (const p of [0, 1, 2, 3]) renderSeat(v, p, showTrick);
  renderCenter(v, showTrick);
  renderHand(v, showTrick);
  // akcije (izbor igre) stoje desno od karata
  $('actions').replaceChildren(...(v.phase === 'CHOOSING' && v.chooser === ME ? [picker(v)] : []));
}

function renderSeat(v, p, showTrick) {
  const el = document.querySelector(`.seat[data-seat="${rel(p)}"]`);
  const acting = v.phase === 'TRICKS' || v.phase === 'LAYOUT' || v.phase === 'CHOOSING';
  const active = !showTrick && acting && v.turn === p;

  const plate = document.createElement('div');
  plate.className = 'plate' + (active ? ' active' : '');
  const tricks = v.phase === 'TRICKS' ? ` · štihova <b>${v.trickCounts[p]}</b>` : '';
  const cards = p !== ME ? ` · karata <b>${v.handCounts[p]}</b>` : '';
  plate.innerHTML =
    `<div class="avatar" style="background:${COLORS[p]}">${esc(NAMES[p][0])}</div>` +
    `<div><div class="name">${esc(NAMES[p])}</div>` +
    `<div class="sub">poena <b>${v.scores[p]}</b>${tricks}</div>` +
    `<div class="sub">igre ${v.used[p].length}/${DEFAULT_CONTRACTS.length}${p !== ME ? cards : ''}</div></div>` +
    (v.dealer === p ? '<span class="dealer-chip" title="Delio">D</span>' : '');

  const chips = document.createElement('div');
  chips.className = 'chips';
  if (v.chooser === p && v.contract) chips.innerHTML += `<span class="chip">${esc(CONTRACT_NAMES[v.contract])}</span>`;
  if (v.lastPass === p) chips.innerHTML += '<span class="chip pass">dalje</span>';

  const parts = [plate];
  if (chips.childElementCount) parts.push(chips);

  if (p !== ME) {
    const backs = document.createElement('div');
    backs.className = 'backs';
    backs.append(...Array.from({ length: v.handCounts[p] }, backImg));
    parts.push(backs);
  }
  el.replaceChildren(...parts);
}

/** Padajući meni za izbor igre, uz vašu pločicu. */
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

function renderCenter(v, showTrick) {
  const trickEl = $('trick');
  const layoutEl = $('layout');
  const msgEl = $('centerMsg');
  const isChoosing = v.phase === 'CHOOSING';
  const isLayout = !isChoosing && v.contract === 'LORA';

  // kad vi birate, meni uz vaše ime je dovoljan — poruka na stolu bi se preklapala sa njim
  msgEl.hidden = !isChoosing || v.chooser === ME;
  layoutEl.hidden = !isLayout;
  trickEl.hidden = isChoosing || isLayout;
  if (!isLayout) layoutEl.replaceChildren();

  if (isChoosing) {
    msgEl.textContent = `${NAMES[v.chooser]} bira igru…`;
    return;
  }

  if (isLayout) {
    // po jedan red za svaku boju: odigrane karte + isprekidana "duh" karta za sledeću na redu
    layoutEl.replaceChildren(...SUITS.map(suit => {
      const row = document.createElement('div');
      row.className = 'row';
      for (const rank of v.layout.piles[suit]) row.appendChild(cardImg({ id: rank + letter(suit), rank, suit }));
      const need = v.layout.startRank ? nextNeeded(v.layout, suit) : null;
      const complete = v.layout.piles[suit].length === 8;
      if (!complete) {
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

function humanChoose(contract) {
  if (busy) return;
  const before = game.getState();
  try {
    game.choose(ME, contract);
  } catch (e) {
    if (e instanceof LoraError) { toast(e.message); return; }
    throw e;
  }
  pickerOpen = false;
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
    else if (a.type === 'choose') {
      game.choose(before.turn, a.contract);
      toast(`${NAMES[before.turn]} bira: ${CONTRACT_NAMES[a.contract]}`);
    } else game.play(before.turn, a.cardId);
    afterAction(before);
  }, s.phase === 'CHOOSING' ? AI_DELAY * 2 : AI_DELAY);
}

// ---------- kraj partije / tabela ----------

function showDealEnd() {
  const s = game.getState();
  const last = s.history.at(-1);
  if (!last) return;
  $('dealEndTitle').textContent = s.phase === 'MATCH_END'
    ? (s.winners.includes(ME) ? 'Pobeda! 🎉' : `Pobednik: ${s.winners.map(p => NAMES[p]).join(', ')}`)
    : `${CONTRACT_NAMES[last.contract]} (igra: ${NAMES[last.chooser]}) — kraj`;
  const min = Math.min(...s.scores);
  $('dealEndBody').innerHTML = [0, 1, 2, 3].map(p =>
    `<tr><td>${esc(NAMES[p])}</td><td>${fmt(last.points[p])}</td><td class="${s.scores[p] === min ? 'best' : ''}">${s.scores[p]}</td></tr>`).join('');
  $('nextDealBtn').textContent = s.phase === 'MATCH_END' ? 'Nova igra' : 'Sledeća igra';
  $('dealEnd').showModal();
}

const fmt = n => (n > 0 ? `+${n}` : String(n));

/** Svaki igrač ima svoju tabelu: 7 igara, odigrane sa rezultatima, ostale sive. */
function renderSheet() {
  const s = game.getState();
  const head = `<thead><tr><th>Igra</th>${NAMES.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead>`;
  let html = '';
  for (const owner of [0, 1, 2, 3]) {
    const played = s.history.filter(h => h.chooser === owner);
    const title = owner === ME ? 'Vaša tabela' : `Tabela: ${NAMES[owner]}`;
    html += `<h3>${esc(title)} (${played.length}/${DEFAULT_CONTRACTS.length})</h3><table class="result">${head}<tbody>`;
    for (const contract of DEFAULT_CONTRACTS) {
      const h = played.find(x => x.contract === contract);
      const current = !h && s.chooser === owner && s.contract === contract && s.phase !== 'CHOOSING';
      const cells = [0, 1, 2, 3].map(p => `<td class="${p === owner ? 'mine' : ''}">${h ? fmt(h.points[p]) : current ? '…' : ''}</td>`).join('');
      html += `<tr class="${h || current ? '' : 'pending'}"><td>${CONTRACT_NAMES[contract]}${current ? ' (u toku)' : ''}</td>${cells}</tr>`;
    }
    html += '</tbody></table>';
  }
  html += `<table class="result"><tbody><tr class="total"><td>Ukupno</td>${s.scores.map(x => `<td>${x}</td>`).join('')}</tr></tbody></table>`;
  $('sheetBody').innerHTML = html;
  $('sheet').showModal();
}

// ---------- toast / dugmad ----------

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
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
document.addEventListener('click', e => {
  if (pickerOpen && !e.target.closest('.picker')) { pickerOpen = false; render(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && pickerOpen && game.getState().phase === 'CHOOSING') { pickerOpen = false; render(); } });

// ---------- start ----------

if (load()) { render(); step(); }
else newGame();

window.__lora = { get game() { return game; }, get busy() { return busy; }, ME };
