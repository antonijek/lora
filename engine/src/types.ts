// SVI TIPOVI za Lora engine — ništa sem tipova.

export type Suit = '♠' | '♥' | '♦' | '♣';
export type Rank = '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

// Id = rank + slovo boje ("10D", "AS") — isto kao SVG fajlovi u icons/cards.
export type CardId = string;

export interface Card {
  id: CardId;
  suit: Suit;
  rank: Rank;
}

export type Position = 0 | 1 | 2 | 3;
export const POSITIONS: readonly Position[] = [0, 1, 2, 3];

/**
 * Igre (ugovori) unutar Lore:
 * - MAX: svaki štih −1
 * - MIN: svaki štih +1
 * - HERC: svaki herc +1; ko uzme svih 8 → −8
 * - DAME: svaka dama +2
 * - ZANDAR: žandar tref +8
 * - KRALJ_ZADNJI: kralj herc +4, poslednji štih +4
 * - LORA: slaganje; ko se prvi oslobodi karata −8, ostali +1 po karti u ruci
 */
export type ContractId = 'MAX' | 'MIN' | 'HERC' | 'DAME' | 'ZANDAR' | 'KRALJ_ZADNJI' | 'LORA';

/**
 * - 'choice' (podrazumevano): delilac se menja svake partije; igrač posle
 *   delioca pogleda karte i bira jednu od SVOJIH preostalih igara, pa igra prvi.
 *   Svaki igrač ima svoju tabelu sa svim igrama.
 * - 'fixed': isti delilac igra sve igre redom, pa sledeći delilac.
 */
export type LoraMode = 'choice' | 'fixed';

export interface LoraOptions {
  seed?: number;
  /** Skup (i za 'fixed' redosled) igara. Podrazumevano svih 7. */
  contracts?: ContractId[];
  mode?: LoraMode;
}

export type Phase = 'CHOOSING' | 'TRICKS' | 'LAYOUT' | 'DEAL_END' | 'MATCH_END';

export interface PlayedCard {
  player: Position;
  card: Card;
}

export interface CompletedTrick {
  cards: PlayedCard[];
  winner: Position;
}

export interface Layout {
  /** Rang kojim počinje svaka boja (određuje ga prva odigrana karta). */
  startRank: Rank | null;
  /** Odigrane karte po boji, redom. */
  piles: Record<Suit, Rank[]>;
}

export interface DealResult {
  dealIndex: number;
  dealer: Position;
  /** Čija je igra (u čiju tabelu se upisuje). */
  chooser: Position;
  contract: ContractId;
  points: number[];
}

export interface LoraState {
  mode: LoraMode;
  phase: Phase;
  /** 0..(4 × broj igara − 1) */
  dealIndex: number;
  dealer: Position;
  /** Igrač čija je igra u ovoj partiji (bira je i igra prvi). */
  chooser: Position;
  /** null dok igrač bira. */
  contract: ContractId | null;
  /** Igre koje je svaki igrač već odigrao iz svoje tabele. */
  used: ContractId[][];
  turn: Position;
  hands: Card[][];
  /** Karte koje je igrač odneo u štihovima ove partije. */
  taken: Card[][];
  trickCounts: number[];
  trick: PlayedCard[];
  trickNo: number;
  lastTrick: CompletedTrick | null;
  layout: Layout;
  /** Ko je rekao "dalje" u slaganju (za UI). */
  lastPass: Position | null;
  /**
   * Karte za koje se ZNA da ih igrač nema (javna informacija, svi za stolom
   * je vide): nije pratio boju → nema tu boju; rekao "dalje" u Lori → nema
   * nijednu kartu koja je tada mogla na sto. Koristi je AI za realna deljenja.
   */
  missing: CardId[][];
  scores: number[];
  history: DealResult[];
  /** Na kraju meča: igrač(i) sa najmanje poena. */
  winners: Position[];
}

export interface PlayerView extends Omit<LoraState, 'hands'> {
  me: Position;
  hand: Card[];
  handCounts: number[];
  legal: CardId[];
  mustPass: boolean;
  /** Igre koje ja još imam da biram. */
  available: ContractId[];
}
