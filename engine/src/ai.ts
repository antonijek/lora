// AI za Loru — radi SAMO nad PlayerView (ne vidi tuđe karte).
//
// Nivoi (igra i server koriste samo hard; easy i medium ostaju kao
// protivnici za poređenje u engine/tools i kao politika simulacije):
//  - easy:   nasumičan legalan potez / nasumična igra
//  - medium: heuristike (brze, "ljudska pravila palca")
//  - hard:   Monte Carlo pretraga — za svaki mogući potez AI mnogo puta
//            nasumično podeli karte koje ne vidi (poštujući ono što se zna:
//            ko nije pratio boju nema je, ko je rekao "dalje" nema potrebne
//            karte), odigra partiju do kraja heuristikama i izabere potez sa
//            najboljim prosekom. Izbor igre isto, uz poređenje sa prosekom te
//            igre (svaku igru ionako mora da odigra — bira onu gde mu je OVA
//            ruka najbolja u odnosu na tipičnu ruku).
//
// Mera uspeha je RELATIVNA: moji poeni minus prosek ostalih (plasman je ono
// što se računa, ne apsolutni poeni).

import type { Card, CardId, ContractId, Layout, PlayedCard, PlayerView, Position, Rank, Suit } from './types.js';
import { createDeck, nextRank, RANKS, rankIndex, SUITS } from './cards.js';
import { penaltyOf, isKingOfHearts, isDecidedEarly, scoreTricks, scoreLayout } from './contracts.js';
import { trickWinner, legalTrickCards, legalLayoutCards, canPlaceOnLayout } from './rules.js';

export type AiLevel = 'easy' | 'medium' | 'hard';

export type AiAction =
  | { type: 'play'; cardId: string }
  | { type: 'pass' }
  | { type: 'choose'; contract: ContractId };

export interface AiOptions {
  /** Broj nasumičnih deljenja po potezu (hard). */
  samples?: number;
  /** Broj nasumičnih deljenja po igri pri izboru igre (hard). */
  chooseSamples?: number;
}

export function chooseAction(
  view: PlayerView,
  level: AiLevel = 'hard',
  rng: () => number = Math.random,
  opts: AiOptions = {},
): AiAction {
  if (view.phase === 'CHOOSING') {
    const options = view.available;
    if (options.length === 0) throw new Error('AI nema igru za izbor');
    if (level === 'easy' || options.length === 1) return { type: 'choose', contract: options[Math.floor(rng() * options.length)] };
    if (level === 'hard') return { type: 'choose', contract: searchContract(view, rng, opts.chooseSamples ?? 450) };
    let best = options[0];
    for (const c of options) if (estimateContract(c, view.hand) < estimateContract(best, view.hand)) best = c;
    return { type: 'choose', contract: best };
  }
  if (view.mustPass) return { type: 'pass' };
  const legal = view.hand.filter(c => view.legal.includes(c.id));
  if (legal.length === 0) throw new Error('AI nema legalan potez');
  if (level === 'easy' || legal.length === 1) {
    return { type: 'play', cardId: legal[Math.floor(rng() * legal.length)].id };
  }
  if (level === 'hard') return { type: 'play', cardId: searchCard(view, legal, rng, opts.samples ?? 300).id };
  const card = view.phase === 'LAYOUT'
    ? heuristicLayout(view.hand, view.layout, legal)
    : heuristicTrick({ hand: view.hand, trick: view.trick, contract: view.contract!, played: playedSet(view) }, legal);
  return { type: 'play', cardId: card.id };
}

function playedSet(view: PlayerView): Set<CardId> {
  const s = new Set<CardId>();
  for (const t of view.taken) for (const c of t) s.add(c.id);
  for (const pc of view.trick) s.add(pc.card.id);
  return s;
}

// ================================================================ Monte Carlo

/** Moji poeni minus prosek ostalih — manje je bolje. */
function relative(points: number[], me: number): number {
  let others = 0;
  for (let p = 0; p < 4; p++) if (p !== me) others += points[p];
  return points[me] - others / 3;
}

/**
 * Prosečan relativan rezultat igrača koji BIRA igru (i igra prvi) sa
 * nasumičnom rukom, kad svi igraju heuristikama. Izračunato sa
 * tools/baselines.ts (20 000 deljenja po igri). Izbor igre poredi
 * procenu za OVU ruku sa ovim prosekom.
 */
export const CONTRACT_BASELINE: Record<ContractId, number> = {
  MAX: 0.48,
  MIN: 0.313,
  HERC: 0.21,
  DAME: 0.189,
  ZANDAR: 0.132,
  KRALJ_ZADNJI: 0.443,
  LORA: -1.426, // sa pravilom: "dalje" +1 i gubi −8
};

function searchContract(view: PlayerView, rng: () => number, samples: number): ContractId {
  const me = view.me;
  const mine = new Set(view.hand.map(c => c.id));
  const unknown = createDeck().filter(c => !mine.has(c.id));
  const totals = new Map<ContractId, number>(view.available.map(c => [c, 0]));
  for (let i = 0; i < samples; i++) {
    const deal = shuffled(unknown, rng);
    const hands: Card[][] = [[], [], [], []];
    let k = 0;
    for (let p = 0; p < 4; p++) hands[p] = p === me ? view.hand.slice() : deal.slice(k * 8, (k++ + 1) * 8);
    // ista deljenja za sve igre (manja varijansa poređenja)
    for (const c of view.available) {
      const pts = simulate({ contract: c, hands: hands.map(h => h.slice()), turn: me, trick: [], taken: [[], [], [], []], counts: [0, 0, 0, 0], passes: [0, 0, 0, 0], layout: emptyLayoutSim() });
      totals.set(c, totals.get(c)! + relative(pts, me));
    }
  }
  let best = view.available[0];
  let bestVal = Infinity;
  for (const c of view.available) {
    const val = totals.get(c)! / samples - CONTRACT_BASELINE[c];
    if (val < bestVal) { bestVal = val; best = c; }
  }
  return best;
}

function searchCard(view: PlayerView, legal: Card[], rng: () => number, samples: number): Card {
  const me = view.me;
  const totals = new Map<CardId, number>(legal.map(c => [c.id, 0]));
  for (let i = 0; i < samples; i++) {
    const hands = sampleHands(view, rng);
    for (const card of legal) {
      const sim = simFromView(view, hands);
      applyMove(sim, me, card);
      const pts = sim.done ?? simulate(sim);
      totals.set(card.id, totals.get(card.id)! + relative(pts, me));
    }
  }
  let best = legal[0];
  let bestVal = Infinity;
  for (const c of legal) {
    const v = totals.get(c.id)!;
    if (v < bestVal) { bestVal = v; best = c; }
  }
  return best;
}

// ---------------------------------------------------------------- nasumično deljenje

function shuffled<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Nasumično podeli karte koje ne vidim protivnicima, tako da svako dobije
 * tačno onoliko koliko ima u ruci i nijednu kartu za koju se zna da je nema.
 */
export function sampleHands(view: PlayerView, rng: () => number): Card[][] {
  const me = view.me;
  const seen = new Set<CardId>(view.hand.map(c => c.id));
  for (const t of view.taken) for (const c of t) seen.add(c.id);
  for (const pc of view.trick) seen.add(pc.card.id);
  for (const suit of SUITS) for (const r of view.layout.piles[suit]) seen.add(`${r}${LETTER[suit]}`);
  const unknown = createDeck().filter(c => !seen.has(c.id));
  const others = ([0, 1, 2, 3] as Position[]).filter(p => p !== me);
  const missing = others.map(p => new Set(view.missing?.[p] ?? []));

  for (let attempt = 0; attempt < 40; attempt++) {
    const cap = others.map(p => view.handCounts[p]);
    const hands: Card[][] = others.map(() => []);
    // najograničenije karte prve (najmanje igrača koji ih mogu imati)
    const cards = shuffled(unknown, rng).sort((a, b) =>
      others.filter((_, i) => !missing[i].has(a.id)).length - others.filter((_, i) => !missing[i].has(b.id)).length);
    let ok = true;
    for (const card of cards) {
      const eligible: number[] = [];
      let weight = 0;
      for (let i = 0; i < others.length; i++) if (cap[i] > 0 && !missing[i].has(card.id)) { eligible.push(i); weight += cap[i]; }
      if (eligible.length === 0) { ok = false; break; }
      let r = rng() * weight;
      let pick = eligible[eligible.length - 1];
      for (const i of eligible) { r -= cap[i]; if (r < 0) { pick = i; break; } }
      hands[pick].push(card);
      cap[pick]--;
    }
    if (ok) return assemble(view, others, hands);
  }
  // ograničenja se nisu mogla ispuniti (retko) — podeli bez njih
  const deal = shuffled(unknown, rng);
  let k = 0;
  const hands = others.map(p => deal.slice(k, (k += view.handCounts[p])));
  return assemble(view, others, hands);
}

function assemble(view: PlayerView, others: Position[], hands: Card[][]): Card[][] {
  const out: Card[][] = [[], [], [], []];
  out[view.me] = view.hand.slice();
  others.forEach((p, i) => { out[p] = hands[i]; });
  return out;
}

const LETTER: Record<Suit, string> = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' };

// ---------------------------------------------------------------- brza simulacija partije

interface Sim {
  contract: ContractId;
  hands: Card[][];
  turn: number;
  trick: PlayedCard[];
  taken: Card[][];
  counts: number[];
  layout: Layout;
  /** "dalje" po igraču (Lora) */
  passes: number[];
  /** Poeni kad je partija gotova. */
  done?: number[];
}

function emptyLayoutSim(): Layout {
  return { startRank: null, piles: { '♠': [], '♥': [], '♦': [], '♣': [] } };
}

function simFromView(view: PlayerView, hands: Card[][]): Sim {
  return {
    contract: view.contract!,
    hands: hands.map(h => h.slice()),
    turn: view.turn,
    trick: view.trick.slice(),
    taken: view.taken.map(t => t.slice()),
    counts: view.trickCounts.slice(),
    passes: (view.passes ?? [0, 0, 0, 0]).slice(),
    layout: { startRank: view.layout.startRank, piles: { '♠': [...view.layout.piles['♠']], '♥': [...view.layout.piles['♥']], '♦': [...view.layout.piles['♦']], '♣': [...view.layout.piles['♣']] } },
  };
}

function applyMove(sim: Sim, p: number, card: Card): void {
  const hand = sim.hands[p];
  hand.splice(hand.findIndex(c => c.id === card.id), 1);
  if (sim.contract === 'LORA') {
    if (sim.layout.startRank === null) sim.layout.startRank = card.rank;
    sim.layout.piles[card.suit].push(card.rank);
    if (hand.length === 0) { sim.done = scoreLayout(sim.hands.map(h => h.length), p, sim.passes); return; }
    sim.turn = (p + 1) % 4;
    return;
  }
  sim.trick.push({ player: p as Position, card });
  if (sim.trick.length < 4) { sim.turn = (p + 1) % 4; return; }
  const winner = trickWinner(sim.trick).player;
  for (const pc of sim.trick) sim.taken[winner].push(pc.card);
  sim.counts[winner]++;
  sim.trick = [];
  sim.turn = winner;
  const allPlayed = sim.hands.every(h => h.length === 0);
  if (allPlayed || isDecidedEarly(sim.contract, sim.taken)) {
    sim.done = scoreTricks(sim.contract, sim.taken, sim.counts, allPlayed ? winner : null);
  }
}

/** Odigraj partiju do kraja heuristikama; vrati poene. */
function simulate(sim: Sim): number[] {
  const played = new Set<CardId>();
  for (const t of sim.taken) for (const c of t) played.add(c.id);
  for (const pc of sim.trick) played.add(pc.card.id);
  let guard = 0;
  while (!sim.done) {
    if (++guard > 500) throw new Error('simulacija se zaglavila');
    const p = sim.turn;
    if (sim.contract === 'LORA') {
      const legal = legalLayoutCards(sim.hands[p], sim.layout);
      if (legal.length === 0) { sim.passes[p]++; sim.turn = (p + 1) % 4; continue; }
      applyMove(sim, p, legal.length === 1 ? legal[0] : heuristicLayout(sim.hands[p], sim.layout, legal));
    } else {
      const legal = legalTrickCards(sim.hands[p], sim.trick);
      const card = legal.length === 1 ? legal[0] : heuristicTrick({ hand: sim.hands[p], trick: sim.trick, contract: sim.contract, played }, legal);
      played.add(card.id);
      applyMove(sim, p, card);
    }
  }
  return sim.done;
}

// ================================================================ heuristike (medium + politika simulacije)

/**
 * Gruba procena koliko ću poena dobiti u igri sa ovom rukom (manje = bolje).
 * Koristi je nivo medium; hard koristi Monte Carlo.
 */
export function estimateContract(contract: ContractId, hand: readonly Card[]): number {
  const high = (c: Card) => Math.max(0, rankIndex(c.rank) - 3); // J=1 Q=2 K=3 A=4
  const strength = hand.reduce((s, c) => s + high(c), 0);         // prosek ≈ 10
  const suit = (s: Suit) => hand.filter(c => c.suit === s);
  const lowerIn = (c: Card) => hand.filter(x => x.suit === c.suit && rankIndex(x.rank) < rankIndex(c.rank)).length;

  switch (contract) {
    case 'MAX': return -2 - (strength - 10) * 0.3;
    case 'MIN': return 2 + (strength - 10) * 0.3;
    case 'HERC': {
      const hs = suit('♥').reduce((s, c) => s + high(c), 0);
      return 2 + (hs - 2.5) * 0.5;
    }
    case 'DAME':
      return 2 + hand.filter(c => c.rank === 'Q').reduce((s, q) => s + (lowerIn(q) < 2 ? 1.4 : 0.4), 0) - 0.8;
    case 'ZANDAR': {
      const jc = hand.find(c => c.rank === 'J' && c.suit === '♣');
      return jc ? (lowerIn(jc) < 2 ? 5 : 3) : 1.3;
    }
    case 'KRALJ_ZADNJI': {
      const kh = hand.find(isKingOfHearts);
      const aces = hand.filter(c => c.rank === 'A').length;
      return (kh ? (lowerIn(kh) < 2 ? 5 : 3.5) : 1.2) + (aces - 1) * 0.3;
    }
    case 'LORA': {
      const has = (r: Rank, s: Suit) => hand.some(c => c.rank === r && c.suit === s);
      let bestRuns = 0;
      for (const r of RANKS) {
        let runs = 0;
        for (const s of SUITS) runs += runLength(r, s, has);
        bestRuns = Math.max(bestRuns, runs);
      }
      return 0.5 - (bestRuns - 5) * 0.6;
    }
  }
}

const byRank = (a: Card, b: Card) => rankIndex(a.rank) - rankIndex(b.rank);
const highest = (cs: Card[]) => cs.reduce((a, b) => (byRank(a, b) >= 0 ? a : b));
const lowest = (cs: Card[]) => cs.reduce((a, b) => (byRank(a, b) <= 0 ? a : b));

/** Koliko je karta "opasna" za držanje u ruci u izbegavajućoj igri. */
function danger(contract: ContractId, c: Card): number {
  return penaltyOf(contract, c) * 10 + rankIndex(c.rank);
}

export interface TrickSituation {
  hand: Card[];
  trick: PlayedCard[];
  contract: ContractId;
  /** Karte koje su već izašle iz igre (odnete + u tekućem štihu). */
  played: Set<CardId>;
}

export function heuristicTrick(sit: TrickSituation, legal: Card[]): Card {
  const { trick, contract } = sit;
  const wantTricks = contract === 'MAX';
  const isLastToPlay = trick.length === 3;

  if (trick.length === 0) return heuristicLead(sit, legal);

  const leadSuit = trick[0].card.suit;
  const winning = trickWinner(trick).card;
  const following = legal[0].suit === leadSuit;

  if (!following) {
    // Nema boje: u MAX baci najslabiju; inače se oslobodi najopasnije karte.
    if (wantTricks) return lowest(legal);
    return legal.reduce((a, b) => (danger(contract, b) > danger(contract, a) ? b : a));
  }

  const beats = legal.filter(c => rankIndex(c.rank) > rankIndex(winning.rank));
  const under = legal.filter(c => rankIndex(c.rank) < rankIndex(winning.rank));

  if (wantTricks) {
    if (beats.length === 0) return lowest(legal);
    return isLastToPlay ? lowest(beats) : highest(beats);
  }

  // Izbegavanje: najveća karta koja i dalje ne nosi; kaznenu kartu podmetni odmah.
  if (under.length > 0) {
    const penaltyUnder = under.filter(c => penaltyOf(contract, c) > 0);
    if (penaltyUnder.length > 0) return highest(penaltyUnder);
    return highest(under);
  }
  // Moram da nosim. Kaznenu kartu ne dajem sam sebi ako imam drugu.
  const safe = legal.filter(c => penaltyOf(contract, c) === 0);
  const pool = safe.length ? safe : legal;
  return isLastToPlay ? highest(pool) : lowest(pool);
}

function heuristicLead(sit: TrickSituation, legal: Card[]): Card {
  const { contract, played, hand } = sit;
  if (contract === 'MAX') return highest(legal);

  // Izbegavanje: vodi najnižu kartu iz boje gde je ona najniža u odnosu na
  // karte koje su još u igri; ne vodi boju u kojoj držiš sopstvenu kaznenu kartu.
  const mine = new Set(hand.map(c => c.id));
  const bySuit = new Map<Suit, Card[]>();
  for (const c of legal) {
    const arr = bySuit.get(c.suit);
    if (arr) arr.push(c); else bySuit.set(c.suit, [c]);
  }
  let best: Card | null = null;
  let bestScore = Infinity;
  for (const [suit, cards] of bySuit) {
    const low = lowest(cards);
    let weakerOutside = 0;
    for (const r of RANKS) {
      if (rankIndex(r) >= rankIndex(low.rank)) break;
      const id = `${r}${LETTER[suit]}`;
      if (!mine.has(id) && !played.has(id)) weakerOutside++;
    }
    let score = weakerOutside * 3 + rankIndex(low.rank);
    if (cards.some(c => penaltyOf(contract, c) > 0)) score += 6;
    if (contract === 'KRALJ_ZADNJI' && suit === '♥' && cards.some(isKingOfHearts)) score += 10;
    if (score < bestScore) { bestScore = score; best = low; }
  }
  return best ?? lowest(legal);
}

export function heuristicLayout(hand: Card[], layout: Layout, legal: Card[]): Card {
  const has = (rank: Rank, suit: Suit) => hand.some(c => c.rank === rank && c.suit === suit);

  if (layout.startRank === null) {
    // Početni rang koji mi daje najduže sopstvene nizove.
    let best = legal[0];
    let bestScore = -Infinity;
    for (const c of legal) {
      let score = 0;
      for (const suit of SUITS) score += runLength(c.rank, suit, has);
      score += SUITS.filter(s => has(c.rank, s)).length * 2;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  // Prednost karti čiji naslednik je kod mene (zadržavam tempo);
  // izbegavam da otvaram put protivnicima kad ja nemam nastavak.
  let best = legal[0];
  let bestScore = -Infinity;
  for (const c of legal) {
    const nextR = nextRank(c.rank);
    const wrapsToStart = nextR === layout.startRank;
    let score = 0;
    if (!wrapsToStart && has(nextR, c.suit)) score += 5 + runLength(nextR, c.suit, has, layout);
    else if (!wrapsToStart) score -= 2;
    if (layout.piles[c.suit].length === 0) score += 1;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

function runLength(from: Rank, suit: Suit, has: (r: Rank, s: Suit) => boolean, layout?: Layout): number {
  let n = 0;
  let r = from;
  const stop = layout?.startRank ?? from;
  for (let i = 0; i < RANKS.length; i++) {
    if (!has(r, suit)) break;
    n++;
    r = nextRank(r);
    if (r === stop) break;
  }
  return n;
}

// Za testove / alate.
export const __test = { simulate, simFromView, applyMove, emptyLayoutSim, relative, canPlaceOnLayout };
