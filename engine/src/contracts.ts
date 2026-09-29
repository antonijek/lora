// Igre unutar Lore: nazivi, bodovanje i kada se partija može završiti ranije.

import type { Card, ContractId } from './types.js';

export const DEFAULT_CONTRACTS: readonly ContractId[] = ['MAX', 'MIN', 'HERC', 'DAME', 'ZANDAR', 'KRALJ_ZADNJI', 'LORA'];

export const CONTRACT_NAMES: Record<ContractId, string> = {
  MAX: 'Maksimum',
  MIN: 'Minimum',
  HERC: 'Herc',
  DAME: 'Dame',
  ZANDAR: 'Žandar tref',
  KRALJ_ZADNJI: 'Kralj herc i poslednji',
  LORA: 'Lora',
};

export const CONTRACT_GOALS: Record<ContractId, string> = {
  MAX: 'Uzmite što više štihova (−1 po štihu).',
  MIN: 'Uzmite što manje štihova (+1 po štihu).',
  HERC: 'Ne nosite hercove (+1 po hercu; ko uzme svih 8: −8).',
  DAME: 'Ne nosite dame (+2 po dami).',
  ZANDAR: 'Ne nosite žandara tref (+8).',
  KRALJ_ZADNJI: 'Ne nosite kralja herc (+4) ni poslednji štih (+4).',
  LORA: 'Slažite karte redom; ko se prvi oslobodi karata dobija −8 (ako nijednom nije rekao „dalje“), ostali +1 po karti; svako „dalje“ +1.',
};

export const isHeart = (c: Card) => c.suit === '♥';
export const isQueen = (c: Card) => c.rank === 'Q';
export const isJackOfClubs = (c: Card) => c.rank === 'J' && c.suit === '♣';
export const isKingOfHearts = (c: Card) => c.rank === 'K' && c.suit === '♥';

/** Kazneni poeni koje nosi jedna karta u datoj igri (bez "poslednjeg štiha"). */
export function penaltyOf(contract: ContractId, card: Card): number {
  switch (contract) {
    case 'HERC': return isHeart(card) ? 1 : 0;
    case 'DAME': return isQueen(card) ? 2 : 0;
    case 'ZANDAR': return isJackOfClubs(card) ? 8 : 0;
    case 'KRALJ_ZADNJI': return isKingOfHearts(card) ? 4 : 0;
    default: return 0;
  }
}

/**
 * Da li je partija sa štihovima odlučena pre 8. štiha
 * (sve kaznene karte su već odnete, a poslednji štih ne nosi poene).
 */
export function isDecidedEarly(contract: ContractId, taken: readonly Card[][]): boolean {
  const all = taken.flat();
  switch (contract) {
    case 'HERC': return all.filter(isHeart).length === 8;
    case 'DAME': return all.filter(isQueen).length === 4;
    case 'ZANDAR': return all.some(isJackOfClubs);
    default: return false;
  }
}

/** Bodovi partije sa štihovima. */
export function scoreTricks(
  contract: ContractId,
  taken: readonly Card[][],
  trickCounts: readonly number[],
  lastTrickWinner: number | null,
): number[] {
  return taken.map((cards, p) => {
    switch (contract) {
      case 'MAX': return -trickCounts[p];
      case 'MIN': return trickCounts[p];
      case 'HERC': {
        const h = cards.filter(isHeart).length;
        return h === 8 ? -8 : h;
      }
      case 'KRALJ_ZADNJI':
        return cards.reduce((s, c) => s + penaltyOf(contract, c), 0) + (lastTrickWinner === p ? 4 : 0);
      default:
        return cards.reduce((s, c) => s + penaltyOf(contract, c), 0);
    }
  });
}

/**
 * Bodovi Lore (slaganje): svako "dalje" +1; ostali +1 po karti u ruci;
 * ko se prvi oslobodi karata dobija −8 SAMO ako nijednom nije rekao "dalje"
 * (inače ne dobija −8, nego samo svoje poene za "dalje").
 */
export function scoreLayout(handCounts: readonly number[], winner: number, passes: readonly number[] = [0, 0, 0, 0]): number[] {
  return handCounts.map((n, p) => {
    if (p === winner) return passes[p] > 0 ? passes[p] : -8;
    return n + passes[p];
  });
}
