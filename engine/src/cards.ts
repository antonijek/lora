// Špil od 32 karte, mešanje, jačina karata.

import type { Card, Rank, Suit } from './types.js';

export const SUITS: readonly Suit[] = ['♠', '♥', '♦', '♣'];
export const RANKS: readonly Rank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUIT_LETTER: Record<Suit, string> = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' };

export function makeCard(rank: Rank, suit: Suit): Card {
  return { id: `${rank}${SUIT_LETTER[suit]}`, rank, suit };
}

export function cardFromId(id: string): Card {
  const letter = id.slice(-1);
  const rank = id.slice(0, -1) as Rank;
  const suit = SUITS.find(s => SUIT_LETTER[s] === letter);
  if (!suit || !RANKS.includes(rank)) throw new Error(`Nepoznata karta: ${id}`);
  return makeCard(rank, suit);
}

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(makeCard(rank, suit));
  return deck;
}

/** Jačina u štihu: 7 najslabija, A najjači. */
export function rankIndex(rank: Rank): number {
  return RANKS.indexOf(rank);
}

/** Sledeći rang u slaganju — posle keca dolazi sedmica. */
export function nextRank(rank: Rank): Rank {
  return RANKS[(rankIndex(rank) + 1) % RANKS.length];
}

export function makeRng(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Sortiranje ruke za prikaz: po boji, pa po jačini. */
export function sortHand(cards: Card[]): Card[] {
  return cards.slice().sort((a, b) =>
    SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || rankIndex(a.rank) - rankIndex(b.rank));
}
