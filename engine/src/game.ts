// Game klasa — orkestrira 28 partija (4 delioca × 7 igara).

import type {
  Card, CardId, ContractId, LoraOptions, LoraState, PlayerView, Position,
} from './types.js';
import { createDeck, makeRng, shuffle, sortHand } from './cards.js';
import { DEFAULT_CONTRACTS, isDecidedEarly, scoreLayout, scoreTricks } from './contracts.js';
import { emptyLayout, legalLayoutCards, legalTrickCards, trickWinner } from './rules.js';

export const HAND_SIZE = 8;

export class LoraError extends Error {}

const next = (p: Position): Position => ((p + 1) % 4) as Position;

export class LoraGame {
  private state: LoraState;
  private readonly rng: () => number;
  readonly contracts: readonly ContractId[];

  constructor(opts: LoraOptions = {}) {
    this.contracts = opts.contracts ?? DEFAULT_CONTRACTS;
    if (this.contracts.length === 0) throw new LoraError('Mora postojati bar jedna igra');
    this.rng = makeRng(opts.seed);
    this.state = {
      phase: 'TRICKS',
      dealIndex: -1,
      dealer: 3,
      contract: this.contracts[0],
      turn: 0,
      hands: [[], [], [], []],
      taken: [[], [], [], []],
      trickCounts: [0, 0, 0, 0],
      trick: [],
      trickNo: 0,
      lastTrick: null,
      layout: emptyLayout(),
      lastPass: null,
      scores: [0, 0, 0, 0],
      history: [],
      winners: [],
    };
    this.startDeal();
  }

  static fromState(state: LoraState, opts: LoraOptions = {}): LoraGame {
    const g = new LoraGame(opts);
    g.state = structuredClone(state);
    return g;
  }

  get totalDeals(): number {
    return this.contracts.length * 4;
  }

  getState(): LoraState {
    return structuredClone(this.state);
  }

  getPlayerView(me: Position): PlayerView {
    const { hands, ...rest } = this.state;
    const legal = this.legalCards(me);
    return structuredClone({
      ...rest,
      me,
      hand: hands[me],
      handCounts: hands.map(h => h.length),
      legal: legal.map(c => c.id),
      mustPass: this.state.phase === 'LAYOUT' && this.state.turn === me && legal.length === 0,
    });
  }

  legalCards(player: Position): Card[] {
    const s = this.state;
    if (s.turn !== player) return [];
    if (s.phase === 'TRICKS') return legalTrickCards(s.hands[player], s.trick);
    if (s.phase === 'LAYOUT') return legalLayoutCards(s.hands[player], s.layout);
    return [];
  }

  play(player: Position, cardId: CardId): void {
    const s = this.state;
    if (s.phase !== 'TRICKS' && s.phase !== 'LAYOUT') throw new LoraError('Partija nije u toku');
    if (s.turn !== player) throw new LoraError('Nije vaš red');
    const hand = s.hands[player];
    const card = hand.find(c => c.id === cardId);
    if (!card) throw new LoraError('Te karte nema u ruci');
    if (!this.legalCards(player).some(c => c.id === cardId)) {
      throw new LoraError(s.phase === 'TRICKS' ? 'Morate pratiti boju' : 'Ta karta ne može na sto');
    }
    s.hands[player] = hand.filter(c => c.id !== cardId);
    s.lastPass = null;
    if (s.phase === 'TRICKS') this.playToTrick(player, card);
    else this.playToLayout(player, card);
  }

  /** "Dalje" u slaganju — dozvoljeno samo kad igrač nema nijednu kartu koja može. */
  pass(player: Position): void {
    const s = this.state;
    if (s.phase !== 'LAYOUT') throw new LoraError('Dalje se kaže samo u Lori');
    if (s.turn !== player) throw new LoraError('Nije vaš red');
    if (this.legalCards(player).length > 0) throw new LoraError('Imate kartu koju morate odigrati');
    s.lastPass = player;
    s.turn = next(player);
  }

  nextDeal(): void {
    if (this.state.phase !== 'DEAL_END') throw new LoraError('Partija još nije završena');
    this.startDeal();
  }

  // ---------------------------------------------------------------

  private startDeal(): void {
    const s = this.state;
    s.dealIndex++;
    const n = this.contracts.length;
    s.dealer = ((3 + Math.floor(s.dealIndex / n)) % 4) as Position;
    s.contract = this.contracts[s.dealIndex % n];
    s.turn = next(s.dealer);
    const deck = shuffle(createDeck(), this.rng);
    s.hands = [0, 1, 2, 3].map(i => sortHand(deck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE)));
    s.taken = [[], [], [], []];
    s.trickCounts = [0, 0, 0, 0];
    s.trick = [];
    s.trickNo = 0;
    s.lastTrick = null;
    s.layout = emptyLayout();
    s.lastPass = null;
    s.phase = s.contract === 'LORA' ? 'LAYOUT' : 'TRICKS';
  }

  private playToTrick(player: Position, card: Card): void {
    const s = this.state;
    s.trick.push({ player, card });
    if (s.trick.length < 4) {
      s.turn = next(player);
      return;
    }
    const winner = trickWinner(s.trick).player;
    s.taken[winner].push(...s.trick.map(pc => pc.card));
    s.trickCounts[winner]++;
    s.lastTrick = { cards: s.trick, winner };
    s.trick = [];
    s.trickNo++;
    s.turn = winner;

    const allPlayed = s.hands.every(h => h.length === 0);
    if (allPlayed || isDecidedEarly(s.contract, s.taken)) {
      const lastTrickWinner = allPlayed ? winner : null;
      this.endDeal(scoreTricks(s.contract, s.taken, s.trickCounts, lastTrickWinner));
    }
  }

  private playToLayout(player: Position, card: Card): void {
    const s = this.state;
    if (s.layout.startRank === null) s.layout.startRank = card.rank;
    s.layout.piles[card.suit].push(card.rank);
    if (s.hands[player].length === 0) {
      this.endDeal(scoreLayout(s.hands.map(h => h.length), player));
      return;
    }
    s.turn = next(player);
  }

  private endDeal(points: number[]): void {
    const s = this.state;
    points.forEach((pt, p) => { s.scores[p] += pt; });
    s.history.push({ dealIndex: s.dealIndex, dealer: s.dealer, contract: s.contract, points });
    if (s.dealIndex + 1 >= this.totalDeals) {
      const min = Math.min(...s.scores);
      s.winners = ([0, 1, 2, 3] as Position[]).filter(p => s.scores[p] === min);
      s.phase = 'MATCH_END';
    } else {
      s.phase = 'DEAL_END';
    }
  }
}
