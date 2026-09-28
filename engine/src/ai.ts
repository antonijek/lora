// AI za Loru — radi SAMO nad PlayerView.
//
// Heuristike:
// - "izbegavajuće" igre (MIN, HERC, DAME, ZANDAR, KRALJ_ZADNJI): podvlači se
//   ispod trenutno najjače karte, a kaznene karte se bacaju čim nema boje;
// - MAX: nosi što više, ali ne troši jaku kartu ako štih već pripada drugom;
// - LORA: bira početni rang i poteze tako da sopstveni nizovi ostanu "otvoreni".

import type { Card, ContractId, Layout, PlayerView, Rank, Suit } from './types.js';
import { nextRank, RANKS, rankIndex, SUITS } from './cards.js';
import { penaltyOf, isKingOfHearts } from './contracts.js';
import { trickWinner } from './rules.js';

export type AiLevel = 'easy' | 'medium';

export type AiAction =
  | { type: 'play'; cardId: string }
  | { type: 'pass' }
  | { type: 'choose'; contract: ContractId };

export function chooseAction(view: PlayerView, level: AiLevel = 'medium', rng: () => number = Math.random): AiAction {
  if (view.phase === 'CHOOSING') {
    const options = view.available;
    if (options.length === 0) throw new Error('AI nema igru za izbor');
    if (level === 'easy') return { type: 'choose', contract: options[Math.floor(rng() * options.length)] };
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
  const card = view.phase === 'LAYOUT' ? chooseLayout(view, legal) : chooseTrick(view, legal);
  return { type: 'play', cardId: card.id };
}

// ---------------------------------------------------------------- izbor igre

/**
 * Gruba procena koliko ću poena dobiti u igri sa ovom rukom (manje = bolje).
 * Konstante su prosečni rezultati po igraču; odstupanje zavisi od ruke.
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
      const hs = suit('♥').reduce((s, c) => s + high(c), 0);   // prosek 2.5
      return 2 + (hs - 2.5) * 0.5;
    }
    case 'DAME': {
      // dama bez bar dve niže karte u boji je lako "uhvatiti"
      return 2 + hand.filter(c => c.rank === 'Q').reduce((s, q) => s + (lowerIn(q) < 2 ? 1.4 : 0.4), 0) - 0.8;
    }
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

// ---------------------------------------------------------------- štihovi

const byRank = (a: Card, b: Card) => rankIndex(a.rank) - rankIndex(b.rank);
const highest = (cs: Card[]) => cs.slice().sort(byRank).at(-1)!;
const lowest = (cs: Card[]) => cs.slice().sort(byRank)[0];

/** Koliko je karta "opasna" za držanje u ruci u izbegavajućoj igri. */
function danger(contract: ContractId, c: Card): number {
  return penaltyOf(contract, c) * 10 + rankIndex(c.rank);
}

function chooseTrick(view: PlayerView, legal: Card[]): Card {
  const { trick } = view;
  const contract = view.contract!;
  const wantTricks = contract === 'MAX';
  const isLastToPlay = trick.length === 3;

  if (trick.length === 0) return lead(view, legal);

  const leadSuit = trick[0].card.suit;
  const winning = trickWinner(trick).card;
  const following = legal[0].suit === leadSuit;

  if (!following) {
    // Nema boje: u MAX baci najslabiju; inače se oslobodi najopasnije karte.
    if (wantTricks) return lowest(legal);
    return legal.slice().sort((a, b) => danger(contract, b) - danger(contract, a))[0];
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
  // Poslednji: nosim najjačom (rešavam se visoke karte); inače najnižom,
  // u nadi da će neko posle mene preći.
  const safe = legal.filter(c => penaltyOf(contract, c) === 0);
  const pool = safe.length ? safe : legal;
  return isLastToPlay ? highest(pool) : lowest(pool);
}

function lead(view: PlayerView, legal: Card[]): Card {
  const contract = view.contract!;
  if (contract === 'MAX') return highest(legal);

  // Izbegavanje: vodi najnižu kartu iz boje gde je ona najniža u odnosu na
  // karte koje su još u igri; ne vodi boju u kojoj držiš sopstvenu kaznenu kartu
  // (npr. herc kad imaš kralja herc).
  const played = new Set<string>();
  for (const t of view.taken) for (const c of t) played.add(c.id);
  const bySuit = new Map<Suit, Card[]>();
  for (const c of legal) bySuit.set(c.suit, [...(bySuit.get(c.suit) ?? []), c]);

  let best: Card | null = null;
  let bestScore = Infinity;
  for (const [suit, cards] of bySuit) {
    const low = lowest(cards);
    // koliko neodigranih tuđih karata u toj boji je slabije od moje najniže
    const mine = new Set(view.hand.map(c => c.id));
    let weakerOutside = 0;
    for (const r of RANKS) {
      const id = `${r}${suitLetter(suit)}`;
      if (!mine.has(id) && !played.has(id) && rankIndex(r) < rankIndex(low.rank)) weakerOutside++;
    }
    let score = weakerOutside * 3 + rankIndex(low.rank);
    if (cards.some(c => penaltyOf(contract, c) > 0)) score += 6;
    if (contract === 'KRALJ_ZADNJI' && suit === '♥' && cards.some(isKingOfHearts)) score += 10;
    if (score < bestScore) { bestScore = score; best = low; }
  }
  return best ?? lowest(legal);
}

function suitLetter(s: Suit): string {
  return ({ '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' } as const)[s];
}

// ---------------------------------------------------------------- lora (slaganje)

function chooseLayout(view: PlayerView, legal: Card[]): Card {
  const hand = view.hand;
  const has = (rank: Rank, suit: Suit) => hand.some(c => c.rank === rank && c.suit === suit);

  if (view.layout.startRank === null) {
    // Izaberi početni rang koji mi daje najduže sopstvene nizove.
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

  // Posle poteza: prednost karti čiji naslednik je kod mene (zadržavam tempo),
  // a izbegavam da otvaram put protivnicima kad ja nemam nastavak.
  let best = legal[0];
  let bestScore = -Infinity;
  for (const c of legal) {
    const nextR = nextRank(c.rank);
    const wrapsToStart = nextR === view.layout.startRank;
    let score = 0;
    if (!wrapsToStart && has(nextR, c.suit)) score += 5 + runLength(nextR, c.suit, has, view.layout);
    else if (!wrapsToStart) score -= 2; // otvaram protivnicima
    // otvaranje nove boje početnim rangom oslobađa i moje karte u toj boji
    if (view.layout.piles[c.suit].length === 0) score += 1;
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
