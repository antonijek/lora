// UI za Loru — tanak sloj nad engine-om (engine/dist).
// Dva izvora stanja za isti sto:
//  - 'local': igra protiv računara u browseru (LoraGame + AI ovde),
//  - 'online': server šalje room:state (vidi online.js), ovde se samo crta.

import {
  LoraGame, LoraError, chooseAction, CONTRACT_NAMES, CONTRACT_GOALS, DEFAULT_CONTRACTS, SUITS, nextNeeded,
  computeStats, newRecords, streak,
} from './engine/dist/index.js';
import { initOnline } from './online.js';

// ?fast — bez pauza (headless testovi)
const FAST = new URLSearchParams(location.search).has('fast');
const AI_DELAY = FAST ? 0 : 650;

// nasumičan id pregledača za admin statistiku (posete, mečevi protiv računara) — bez ličnih podataka
const VISITOR = (() => {
  let vid = null;
  try { vid = localStorage.getItem('lora.vid'); } catch {}
  if (!vid) {
    vid = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem('lora.vid', vid); } catch {}
  }
  return vid;
})();
/** Anonimni događaj za admin statistiku (lokalni dev server nema /api — greška se tiho ignoriše). */
function track(kind) {
  if (FAST) return;
  fetch('api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: VISITOR, kind }) }).catch(() => {});
}
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
// jedan nivo AI-ja — najjači (Monte Carlo)
const level = 'hard';
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

// id meča protiv računara — da se u statistiku upiše tačno jednom (i posle osvežavanja)
let localMatchId = null;

function save() {
  if (mode !== 'local' || !game) return;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ state: game.getState(), id: localMatchId })); } catch {}
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    game = LoraGame.fromState(data.state);
    localMatchId = data.id ?? Date.now().toString(36);
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
  localMatchId = Date.now().toString(36);
  track('local_start');
  lastView = null;
  save();
  render();
  step();
}

// ---------- karte ----------

function cardImg(card) {
  const img = document.createElement('img');
  img.className = 'card-img';
  img.src = `./icons/cards/${card.id}.webp`;
  // prave dimenzije slike (5:7) — prostor se rezerviše pre učitavanja, sto ne "skače"
  img.width = 300;
  img.height = 420;
  img.alt = `${card.rank}${card.suit}`;
  img.draggable = false;
  return img;
}

function backImg() {
  const img = document.createElement('img');
  img.src = './icons/cards/back-red.webp';
  img.width = 300;
  img.height = 420;
  img.alt = '';
  return img;
}

const letter = suit => ({ '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' })[suit];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- render ----------

// "Poslednji štih" na telefonu: dodir prikaže prethodni štih na stolu na par sekundi
let peekTrick = null;
let contractKey = null; // za kratko svetljenje naziva igre kad se izabere
let peekTimer = null;

function render(showTrick = null) {
  const c = ctx();
  const { v, names } = c;
  if (!v) return;
  renderLastTrick(c);
  showTrick ??= peekTrick;
  const rel = p => (p - c.me + 4) % 4;

  $('contractName').textContent = v.contract ? CONTRACT_NAMES[v.contract] : 'Bira se igra';
  const ck = `${v.dealIndex}:${v.contract}`;
  if (v.contract && contractKey && ck !== contractKey) {
    $('contractName').classList.remove('flash');
    void $('contractName').offsetWidth;
    $('contractName').classList.add('flash');
  }
  contractKey = ck;
  // ko je delio (D) i čija je igra (oznaka sa nazivom) vide se na pločicama igrača
  $('dealNo').textContent = `${v.dealIndex + 1} / 28`;
  $('dealBar').style.width = `${((v.dealIndex + 1) / 28) * 100}%`;
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
  // span: na telefonu se štihovi prelamaju u novi red (uske pločice)
  const tricks = v.phase === 'TRICKS' ? `<span class="tr"><span class="sep"> · </span>štihova <b>${v.trickCounts[p]}</b></span>` : '';
  const tag = info?.kind === 'ai' && !String(info.name).includes('(AI)') ? '<span class="ai-tag">AI</span>'
    : info && !info.connected ? '<span class="ai-tag">bez veze</span>' : '';
  // rejting samo za ljude u online igri — kao mali broj pored imena
  const rating = info?.kind === 'human' ? `<span class="rt">${info.rating}</span>` : '';
  plate.innerHTML =
    `<div class="avatar" style="background:${COLORS[p]}">${esc(String(names[p])[0] ?? '?')}</div>` +
    `<div><div class="name">${esc(names[p])}${rating}${tag}</div>` +
    `<div class="sub">poena <b>${v.scores[p]}</b>${tricks}</div></div>` +
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

function renderLastTrick(c) {
  const { v, names } = c;
  const lt = v.phase === 'TRICKS' && v.lastTrick ? v.lastTrick : null;
  $('lastTrickBox').hidden = !lt;
  $('lastTrickBtn').hidden = !lt;
  if (!lt) {
    peekTrick = null;
    return;
  }
  $('lastTrickBtn').classList.toggle('on', !!peekTrick);
  $('lastTrickBox').classList.toggle('on', !!peekTrick);
  $('lastTrickBox').innerHTML =
    `<div class="lt-head">Poslednji štih <span>odneo: <b>${esc(names[lt.winner])}</b></span></div>` +
    '<div class="lt-cards">' + lt.cards.map(pc =>
      `<div class="lt-card${pc.player === lt.winner ? ' win' : ''}" title="${esc(names[pc.player])}">` +
      `<img class="card-img" src="./icons/cards/${pc.card.id}.webp" width="300" height="420" alt="${pc.card.rank}${pc.card.suit}" draggable="false">` +
      `<span class="lt-who" style="background:${COLORS[pc.player]}">${esc(String(names[pc.player])[0] ?? '?')}</span></div>`).join('') +
    '</div>';
}

function togglePeek() {
  clearTimeout(peekTimer);
  const v = ctx().v;
  peekTrick = peekTrick || !v?.lastTrick ? null : v.lastTrick;
  if (peekTrick) peekTimer = setTimeout(() => { peekTrick = null; render(); }, 3000);
  render();
}
$('lastTrickBtn').addEventListener('click', togglePeek);
// na uspravnom telefonu je mali prikaz štiha i sam dugme
$('lastTrickBox').addEventListener('click', () => { if (matchMedia('(max-width: 640px)').matches) togglePeek(); });

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
      timer = setTimeout(() => { passNote(); game.pass(0); afterLocalAction(); }, FAST ? 0 : 700);
    }
    return;
  }
  timer = setTimeout(() => {
    const turn = game.getState().turn;
    const a = chooseAction(game.getPlayerView(turn), level);
    if (a.type === 'pass') game.pass(turn);
    else if (a.type === 'choose') {
      game.choose(turn, a.contract); // izabrana igra se vidi u zaglavlju (kratko zasvetli) i na pločici
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
    passNote();
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

  // kraj celog meča ima svoj izgled (postolje, medalje, rejting); posle partije — tabela
  $('dealEnd').classList.toggle('final', finished);
  $('finalTop').hidden = !finished;
  $('finalView').hidden = !finished;
  $('dealTable').hidden = finished;
  $('confetti').replaceChildren();
  const min = Math.min(...v.scores);
  // ukupni poeni su i u tabeli (testovi i pregled čitaju kolonu "Ukupno")
  $('dealEnd').querySelector('thead tr').innerHTML = '<th></th><th>Ova igra</th><th>Ukupno</th>';
  $('dealEndBody').innerHTML = [0, 1, 2, 3].map(p => {
    const d = last.points[p];
    const lead = v.scores[p] === min;
    return `<tr class="${lead ? 'lead' : ''}${p === c.me ? ' me' : ''}">` +
      `<td><span class="who"><span class="avatar" style="background:${COLORS[p]}">${esc(String(names[p])[0] ?? '?')}</span><span class="nm">${esc(names[p])}</span></span></td>` +
      `<td><span class="pts ${d > 0 ? 'plus' : d < 0 ? 'minus' : ''}">${fmt(d)}</span></td>` +
      `<td class="${lead ? 'best' : ''}">${v.scores[p]}</td></tr>`;
  }).join('');
  $('dealSub').hidden = finished;
  if (finished) renderFinal(c, rating);
  else {
    $('dealEndTitle').textContent = CONTRACT_NAMES[last.contract];
    $('dealSub').textContent = `Kraj partije ${last.dealIndex + 1}/28 · igra: ${names[last.chooser]}`;
  }

  // "Pogledaj karte": snimak ruku ove partije — ostaje isti i ako sledeća partija krene (online tajmer)
  revealedSnap = v.revealed ? { title: CONTRACT_NAMES[last.contract], chooser: names[last.chooser], names: [...names], hands: v.revealed, points: [...last.points] } : null;
  $('viewCardsBtn').hidden = !revealedSnap;

  // novi lični rekordi na kraju meča (online: računa server; protiv računara: ovde)
  const recs = !finished ? [] : mode === 'online' ? rating?.records?.[c.me] ?? [] : recordLocalMatch(v);
  $('dealRecords').hidden = !recs.length;
  $('dealRecords').innerHTML = recs.length
    ? `<b>🏆 Novi lični rekord!</b><ul>${recs.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : '';
  if (mode === 'local' && !finished) markLocalDay();
  // posle meča protiv računara, ko nema nalog: poziv da igra i sa ljudima
  $('signupNudge').hidden = !(finished && mode === 'local' && !storedToken());

  const btn = $('nextDealBtn');
  btn.disabled = false;
  if (finished) btn.textContent = mode === 'online' ? 'Nazad u lobi' : 'Nova igra';
  else if (mode === 'online') updateReadyButton();
  else btn.textContent = 'Sledeća igra';
  if (!$('dealEnd').open) $('dealEnd').showModal();
}

const fmt = n => (n > 0 ? `+${n}` : String(n));

const TROPHY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4"/></svg>';

/** Kraj celog meča: mesto, pobednik, poredak sa medaljama, rejting, najbolja/najteža partija. */
function renderFinal(c, rating) {
  const { v, names, seats } = c;
  const P = [0, 1, 2, 3];
  const place = p => 1 + P.filter(q => v.scores[q] < v.scores[p]).length; // jednaki poeni = isto mesto
  const myPlace = place(c.me);
  const won = myPlace === 1;
  const medal = ['', 'gold', 'silver', 'bronze', 'plain'][myPlace];
  $('finalTop').innerHTML = `<div class="emblem ${medal}">${won ? TROPHY : `<b>${myPlace}.</b>`}<span>${won ? 'pobeda' : 'mesto'}</span></div>`;
  $('dealEndTitle').textContent = won ? (v.winners.length > 1 ? 'Podeljena pobeda!' : 'Pobeda!') : 'Kraj meča';
  const min = Math.min(...v.scores);
  $('finalSub').textContent = won
    ? `Najmanje poena posle ${v.history.length} partija: ${min}`
    : `Pobednik: ${v.winners.map(p => names[p]).join(', ')} · ${min} poena`;

  const rated = rating?.rated;
  $('finalList').innerHTML = [...P].sort((a, b) => v.scores[a] - v.scores[b]).map((p, i) => {
    const pl = place(p);
    const s = seats?.[p];
    const human = s && (s.kind === 'human' || s.left);
    const rt = rated && human
      ? `<span class="fr-rating">rejting ${rating.newRatings[p]} <i class="${rating.deltas[p] >= 0 ? 'up' : 'down'}">${fmt(rating.deltas[p])}</i></span>` : '';
    return `<li class="${pl === 1 ? 'win' : ''}${p === c.me ? ' me' : ''}" style="animation-delay:${0.15 + i * 0.12}s">` +
      `<span class="rank r${pl}">${pl}</span>` +
      `<span class="avatar" style="background:${COLORS[p]}">${esc(String(names[p])[0] ?? '?')}</span>` +
      `<span class="fr-name">${esc(names[p])}${rt}</span><b class="fr-pts">${v.scores[p]}</b></li>`;
  }).join('');

  const mine = v.history.map(h => ({ k: h.contract, p: h.points[c.me] }));
  const best = mine.reduce((a, b) => (b.p < a.p ? b : a));
  const worst = mine.reduce((a, b) => (b.p > a.p ? b : a));
  $('finalNote').textContent = `Vaša najbolja partija: ${CONTRACT_NAMES[best.k]} ${fmt(best.p)} · najteža: ${CONTRACT_NAMES[worst.k]} ${fmt(worst.p)}`;

  if (won) {
    const colors = ['#f2c14e', '#5fd08a', '#e25d5d', '#2f7dd1', '#ffffff', '#c98a4b'];
    $('confetti').replaceChildren(...Array.from({ length: 42 }, (_, i) => {
      const e = document.createElement('i');
      e.style.left = `${(i * 37) % 100}%`;
      e.style.background = colors[i % colors.length];
      e.style.animationDelay = `${((i * 13) % 20) / 10}s`;
      e.style.animationDuration = `${2.4 + ((i * 7) % 10) / 10}s`;
      return e;
    }));
  }
}

// ---------- moja statistika ----------

const STATS_KEY = 'lora.stats.v1';
const localDay = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD po lokalnom vremenu

function loadLocalStats() {
  try { return JSON.parse(localStorage.getItem(STATS_KEY)) ?? { matches: [], days: [], last: null }; }
  catch { return { matches: [], days: [], last: null }; }
}
function saveLocalStats(st) {
  st.matches = st.matches.slice(-300);
  st.days = [...new Set(st.days)].sort().slice(-400);
  try { localStorage.setItem(STATS_KEY, JSON.stringify(st)); } catch {}
}
function markLocalDay() {
  const st = loadLocalStats();
  if (!st.days.includes(localDay())) { st.days.push(localDay()); saveLocalStats(st); }
}
/** Upiši završen meč protiv računara (tačno jednom) i vrati nove rekorde. */
function recordLocalMatch(v) {
  const st = loadLocalStats();
  if (st.last?.id === localMatchId) return st.last.records;
  const rec = { date: localDay(), scores: [...v.scores], seat: 0, history: v.history };
  const records = newRecords(computeStats(st.matches), rec);
  st.matches.push(rec);
  st.days.push(localDay());
  st.last = { id: localMatchId, records };
  saveLocalStats(st);
  track('local_finish');
  return records;
}

const storedToken = () => { try { return localStorage.getItem('lora_token'); } catch { return null; } };

let statsTab = 'local';
function openStats(tab) {
  statsTab = tab ?? (storedToken() && (mode === 'online' || lastMode() === 'online') ? 'online' : 'local');
  if (!$('statsDlg').open) $('statsDlg').showModal();
  renderStats();
}
async function renderStats() {
  for (const b of $('statsTabs').children) b.classList.toggle('on', b.dataset.t === statsTab);
  const body = $('statsBody');
  if (statsTab === 'local') {
    const st = loadLocalStats();
    body.innerHTML = statsHtml(computeStats(st.matches), streak(st.days, localDay()), null) +
      (storedToken() ? '' : '<p class="stats-note">Ova statistika se čuva samo na ovom uređaju. <button class="link" type="button" data-signup>Napravi besplatan nalog</button> i igraj i sa pravim ljudima.</p>');
    return;
  }
  const token = storedToken();
  if (!token) { body.innerHTML = '<p class="stats-empty">Prijavite se za online statistiku (Igraj online).</p>'; return; }
  body.innerHTML = '<p class="stats-empty">Učitavam…</p>';
  try {
    const r = await fetch('api/stats', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error();
    const d = await r.json();
    if (statsTab === 'online') body.innerHTML = statsHtml(d.stats, d.streak, d);
  } catch {
    body.innerHTML = '<p class="stats-empty">Statistika trenutno nije dostupna.</p>';
  }
}
function statsHtml(s, str, online) {
  if (!s.matches) return '<p class="stats-empty">Još nema završenih mečeva. Odigraj prvi i ovde će se pojaviti tvoji rekordi.</p>';
  const tile = (num, lbl, cls = '') => `<div class="stat-tile ${cls}"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`;
  const dt = d => (d ? new Date(d.slice(0, 10) + 'T12:00:00').toLocaleDateString('sr-RS', { day: 'numeric', month: 'numeric', year: '2-digit' }) : '');
  const tiles = [
    tile(s.matches, 'odigranih mečeva'),
    tile(`${s.wins} <small class="pct">${Math.round((s.wins / s.matches) * 100)}%</small>`, 'pobeda'),
    tile(s.bestMatch.points, 'najbolji meč (poena)'),
    tile(s.avgScore, 'prosečno poena'),
    online ? tile(online.rating, `rejting · najviši ${online.bestRating}`) : '',
    tile(`🔥 ${str.current}`, `dana zaredom · najduže ${str.best}`, 'fire'),
  ].join('');
  const rows = DEFAULT_CONTRACTS.filter(k => s.bestDeal[k]).map(k =>
    `<tr><td>${CONTRACT_NAMES[k]}</td><td>${fmt(s.bestDeal[k].points)}</td><td>${dt(s.bestDeal[k].date)}</td></tr>`).join('');
  return `<div class="stat-tiles">${tiles}</div>
    <h3 class="stats-sub">Najbolja partija po igri</h3>
    <table class="result"><thead><tr><th>Igra</th><th>Poena</th><th>Kad</th></tr></thead><tbody>${rows}</tbody></table>`;
}

$('statsTabs').addEventListener('click', e => {
  const t = e.target.closest('button[data-t]')?.dataset.t;
  if (!t) return;
  statsTab = t;
  renderStats();
});
$('closeStatsBtn').addEventListener('click', () => $('statsDlg').close());
$('statsBody').addEventListener('click', e => {
  if (!e.target.closest('[data-signup]')) return;
  track('signup_click');
  $('statsDlg').close();
  rememberMode('online');
  online.register();
});
$('statsMenuBtn').addEventListener('click', () => { $('menu').close(); openStats(); });
$('startStatsBtn').addEventListener('click', () => openStats());
$('lobbyStatsBtn').addEventListener('click', () => openStats('online'));

let revealedSnap = null;
function showRevealed() {
  const r = revealedSnap;
  if (!r) return;
  $('cardsTitle').textContent = r.title;
  $('cardsSub').textContent = `igra: ${r.chooser} · sve karte kako su podeljene`;
  $('cardsBody').replaceChildren(...r.hands.map((hand, p) => {
    const row = document.createElement('div');
    row.className = 'reveal-row';
    const label = document.createElement('div');
    label.className = 'reveal-name';
    const cls = r.points[p] > 0 ? 'plus' : r.points[p] < 0 ? 'minus' : '';
    label.innerHTML = `<span class="avatar" style="background:${COLORS[p]}">${esc(String(r.names[p])[0] ?? '?')}</span>` +
      `<b>${esc(r.names[p])}</b><span class="pts ${cls}">${fmt(r.points[p])}</span>`;
    const cards = document.createElement('div');
    cards.className = 'reveal-cards';
    cards.append(...hand.map(cardImg));
    row.append(label, cards);
    return row;
  }));
  $('cardsDlg').showModal();
}

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

/** "Dalje" u Lori: poruka preko mojih karata (tada su sve zatamnjene), ne preko stola. */
let passTimer = null;
function passNote() {
  const n = $('passNote');
  n.innerHTML = 'Nemate odgovarajuću kartu — <b>dalje +1</b>';
  n.hidden = true;
  void n.offsetWidth; // ponovo pokreni animaciju
  n.hidden = false;
  clearTimeout(passTimer);
  passTimer = setTimeout(() => { n.hidden = true; }, 2200);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- potvrde i obaveštenja (u stilu igre, umesto confirm/alert/prompt) ----------

const ICONS = {
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
};

/** Prozor za potvrdu. Vraća Promise<boolean>. cancel: null = samo jedno dugme. */
function ask({ title, text = '', ok = 'U redu', cancel = 'Otkaži', danger = false, icon = danger ? 'warn' : 'info', extra = null }) {
  const dlg = $('askDlg');
  $('askIcon').innerHTML = ICONS[icon] ?? ICONS.info;
  $('askIcon').className = 'ask-icon' + (danger ? ' danger' : '');
  $('askTitle').textContent = title;
  $('askText').textContent = text;
  $('askExtra').replaceChildren(...(extra ? [extra] : []));
  $('askOk').textContent = ok;
  $('askOk').className = 'btn ' + (danger ? 'danger' : 'primary');
  $('askCancel').textContent = cancel ?? '';
  $('askCancel').hidden = cancel === null;
  return new Promise(resolve => {
    const done = v => { dlg.removeEventListener('close', onClose); resolve(v); };
    const onClose = () => done(dlg.returnValue === 'ok');
    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    $('askOk').onclick = () => dlg.close('ok');
    $('askCancel').onclick = () => dlg.close('');
    dlg.showModal();
  });
}

/** Traka sa obaveštenjem pri vrhu ekrana (neko napustio meč, vratio se...). */
function notify(text) {
  const n = document.createElement('div');
  n.className = 'notice';
  n.innerHTML = ICONS.info;
  n.append(text);
  $('notices').appendChild(n);
  setTimeout(() => { n.classList.add('out'); setTimeout(() => n.remove(), 300); }, 4500);
}

// ---------- ekrani / režimi ----------

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

// Poslednji režim (protiv računara / online) — osvežavanje stranice vraća tamo
// gde je igrač bio, a ne na početni ekran. Briše se samo kad sam ode na Početnu.
const MODE_KEY = 'lora.mode';
function rememberMode(m) {
  try { m ? localStorage.setItem(MODE_KEY, m) : localStorage.removeItem(MODE_KEY); } catch {}
}
function lastMode() {
  try { return localStorage.getItem(MODE_KEY); } catch { return null; }
}

function goHome() {
  clearTimeout(timer);
  rememberMode(null);
  showScreen('startScreen');
}

function startLocal() {
  mode = 'local';
  rememberMode('local');
  markLocalDay();
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
// Esc ne sme da zatvori kraj partije — bez dugmeta "Dalje" igra bi se zaglavila
$('dealEnd').addEventListener('cancel', e => e.preventDefault());
$('dealSheetBtn').addEventListener('click', renderSheet);
$('viewCardsBtn').addEventListener('click', showRevealed);
$('nudgeLater').addEventListener('click', () => { $('signupNudge').hidden = true; });
$('nudgeSignup').addEventListener('click', () => {
  track('signup_click');
  $('dealEnd').close();
  rememberMode('online');
  online.register();
});
$('closeCardsBtn').addEventListener('click', () => $('cardsDlg').close());
$('sheetBtn').addEventListener('click', renderSheet);
$('closeSheetBtn').addEventListener('click', () => $('sheet').close());
$('menuBtn').addEventListener('click', () => {
  const isOnline = mode === 'online';
  $('newGameBtn').hidden = isOnline;
  $('leaveMatchBtn').hidden = !isOnline;
  // iz online meča u toku izlazi se samo preko "Napusti meč" (showLobby tada ne radi ništa)
  $('homeBtn').hidden = isOnline && onlineState?.status === 'PLAYING';
  $('menu').showModal();
});
// klik pored menija (na pozadinu) ga zatvara
$('menu').addEventListener('click', e => { if (e.target === $('menu')) $('menu').close(); });
$('newGameBtn').addEventListener('click', () => { $('menu').close(); newLocalGame(); });
$('homeBtn').addEventListener('click', () => {
  $('menu').close();
  if (mode === 'online') online.showLobby();
  else goHome();
});
$('leaveMatchBtn').addEventListener('click', () => {
  $('menu').close();
  ask({
    title: 'Napustiti meč?', text: 'Računar će igrati umesto vas do kraja. Možete se vratiti istim kodom sobe.',
    ok: 'Napusti meč', cancel: 'Ostani', danger: true,
  }).then(yes => { if (yes) online.leaveMatch(); });
});
$('goLocalBtn').addEventListener('click', startLocal);
$('goOnlineBtn').addEventListener('click', () => { rememberMode('online'); online.start(); });
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
  ask,
  notify,
  goHome,
  showScreen,
});

// brojač posetilaca za admin statistiku
if (!FAST) fetch('api/visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: VISITOR }) }).catch(() => {});

// admin prečica (ikonica u zaglavlju, lobiju i na početnom ekranu) — samo za admin nalog
try {
  const tok = localStorage.getItem('lora_token');
  if (tok && !FAST) fetch('api/me', { headers: { Authorization: `Bearer ${tok}` } })
    .then(r => r.json()).then(d => document.body.classList.toggle('is-admin', !!d.user?.is_admin)).catch(() => {});
} catch {}

const params = new URLSearchParams(location.search);
if (params.has('room')) { rememberMode('online'); online.start(); }
else if (params.has('local')) startLocal();
else if (lastMode() === 'online') online.start();
else if (lastMode() === 'local') startLocal();
else goHome();

window.__lora = {
  get game() { return game; },
  get busy() { return busy; },
  get mode() { return mode; },
  get onlineState() { return onlineState; },
  ME: 0,
};
