// Legalni potezi: štih (obaveza boje) i slaganje (Lora).

import type { Card, Layout, PlayedCard, Suit } from './types.js';
import { nextRank, rankIndex, RANKS } from './cards.js';

/** Štih: mora se pratiti boja; ako nema boje, može bilo šta. Nema aduta ni obaveze nadjačavanja. */
export function legalTrickCards(hand: readonly Card[], trick: readonly PlayedCard[]): Card[] {
  if (trick.length === 0) return hand.slice();
  const lead = trick[0].card.suit;
  const follow = hand.filter(c => c.suit === lead);
  return follow.length > 0 ? follow : hand.slice();
}

/** Ko nosi štih: najjača karta u boji koja je prva odigrana. */
export function trickWinner(trick: readonly PlayedCard[]): PlayedCard {
  const lead = trick[0].card.suit;
  let best = trick[0];
  for (const pc of trick) {
    if (pc.card.suit === lead && rankIndex(pc.card.rank) > rankIndex(best.card.rank)) best = pc;
  }
  return best;
}

export function emptyLayout(): Layout {
  return { startRank: null, piles: { '♠': [], '♥': [], '♦': [], '♣': [] } };
}

/**
 * Slaganje: prva karta određuje početni rang za sve boje. Posle toga igrač
 * sme da otvori novu boju početnim rangom ili da nastavi započetu boju
 * sledećim rangom (posle keca dolazi sedmica), dok boja nema svih 8 karata.
 */
export function canPlaceOnLayout(layout: Layout, card: Card): boolean {
  if (layout.startRank === null) return true;
  const pile = layout.piles[card.suit];
  if (pile.length === 0) return card.rank === layout.startRank;
  if (pile.length === RANKS.length) return false;
  return card.rank === nextRank(pile[pile.length - 1]);
}

export function legalLayoutCards(hand: readonly Card[], layout: Layout): Card[] {
  return hand.filter(c => canPlaceOnLayout(layout, c));
}

/** Karta koja je sledeća na redu u boji (ili null ako je boja završena). */
export function nextNeeded(layout: Layout, suit: Suit): Card['rank'] | null {
  if (layout.startRank === null) return null;
  const pile = layout.piles[suit];
  if (pile.length === 0) return layout.startRank;
  if (pile.length === RANKS.length) return null;
  return nextRank(pile[pile.length - 1]);
}
