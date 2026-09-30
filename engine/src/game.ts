// Game klasa — orkestrira 28 partija (4 igrača × 7 igara).

import type {
  Card, CardId, ContractId, LoraOptions, LoraState, PlayerView, Position,
} from './types.js';
import { createDeck, makeCard, makeRng, RANKS, shuffle, sortHand, SUITS } from './cards.js';
import { DEFAULT_CONTRACTS, isDecidedEarly, scoreLayout, scoreTricks } from './contracts.js';
import { emptyLayout, legalLayoutCards, legalTrickCards, nextNeeded, trickWinner } from './rules.js';

export const HAND_SIZE = 8;

export class LoraError extends Error {}

const next = (p: Position): Position => ((p + 1) % 4) as Position;

function addMissing(list: CardId[], ids: CardId[]): void {
  for (const id of ids) if (!list.includes(id)) list.push(id);
}

export class LoraGame {
  private state: LoraState;
  private readonly rng: () => number;
  readonly contracts: readonly ContractId[];

  constructor(opts: LoraOptions = {}) {
    this.contracts = opts.contracts ?? DEFAULT_CONTRACTS;
    if (this.contracts.length === 0) throw new LoraError('Mora postojati bar jedna igra');
    this.rng = makeRng(opts.seed);
    this.state = {
      mode: opts.mode ?? 'choice',
      phase: 'TRICKS',
      dealIndex: -1,
      dealer: 3,
      chooser: 0,
      contract: null,
      used: [[], [], [], []],
      turn: 0,
      hands: [[], [], [], []],
      dealt: [[], [], [], []],
      taken: [[], [], [], []],
      trickCounts: [0, 0, 0, 0],
      trick: [],
      trickNo: 0,
      lastTrick: null,
      layout: emptyLayout(),
      lastPass: null,
      missing: [[], [], [], []],
      passes: [0, 0, 0, 0],
      scores: [0, 0, 0, 0],
      history: [],
      winners: [],
    };
    this.startDeal();
  }

  static fromState(state: LoraState, opts: LoraOptions = {}): LoraGame {
    const g = new LoraGame({ ...opts, mode: state.mode });
    g.state = structuredClone(state);
    g.state.missing ??= [[], [], [], []]; // snimci pre ovog polja
    g.state.passes ??= [0, 0, 0, 0];
    g.state.dealt ??= [[], [], [], []];
    return g;
  }

  get totalDeals(): number {
    return this.contracts.length * 4;
  }

  getState(): LoraState {
    return structuredClone(this.state);
  }

  getPlayerView(me: Position): PlayerView {
    const { hands, dealt, ...rest } = this.state;
    const legal = this.legalCards(me);
    // tuđe karte tek kad je partija gotova — tada ih svi za stolom smeju videti
    const over = this.state.phase === 'DEAL_END' || this.state.phase === 'MATCH_END';
    return structuredClone({
      ...rest,
      me,
      hand: hands[me],
      revealed: over && dealt.some(h => h.length) ? dealt : null,
      handCounts: hands.map(h => h.length),
      legal: legal.map(c => c.id),
      mustPass: this.state.phase === 'LAYOUT' && this.state.turn === me && legal.length === 0,
      available: this.available(me),
    });
  }

  /** Igre koje igrač još nije odigrao iz svoje tabele. */
  available(player: Position): ContractId[] {
    const used = this.state.used[player];
    return this.contracts.filter(c => !used.includes(c));
  }

  /** Izbor igre (samo u 'choice' modu, samo igrač čija je partija). */
  choose(player: Position, contract: ContractId): void {
    const s = this.state;
    if (s.phase !== 'CHOOSING') throw new LoraError('Sada se ne bira igra');
    if (s.chooser !== player) throw new LoraError('Ne birate vi igru');
    if (!this.available(player).includes(contract)) throw new LoraError('Tu igru ste već odigrali');
    this.beginContract(contract);
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
    // sve karte koje su sada mogle na sto — ovaj igrač nijednu nema
    for (const suit of SUITS) {
      const need = nextNeeded(s.layout, suit);
      if (need) addMissing(s.missing[player], [makeCard(need, suit).id]);
    }
    s.lastPass = player;
    s.passes[player]++;
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
    if (s.mode === 'choice') {
      // delilac se menja svake partije; bira i prvi igra igrač posle delioca
      s.dealer = ((3 + s.dealIndex) % 4) as Position;
      s.chooser = next(s.dealer);
    } else {
      // isti delilac igra svih n igara redom; njegova je tabela
      s.dealer = ((3 + Math.floor(s.dealIndex / n)) % 4) as Position;
      s.chooser = s.dealer;
    }
    s.contract = null;
    s.turn = next(s.dealer);
    const deck = shuffle(createDeck(), this.rng);
    s.hands = [0, 1, 2, 3].map(i => sortHand(deck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE)));
    s.dealt = structuredClone(s.hands);
    s.taken = [[], [], [], []];
    s.trickCounts = [0, 0, 0, 0];
    s.trick = [];
    s.trickNo = 0;
    s.lastTrick = null;
    s.layout = emptyLayout();
    s.lastPass = null;
    s.missing = [[], [], [], []];
    s.passes = [0, 0, 0, 0];
    if (s.mode === 'choice') s.phase = 'CHOOSING';
    else this.beginContract(this.available(s.chooser)[0]);
  }

  private beginContract(contract: ContractId): void {
    const s = this.state;
    s.contract = contract;
    s.used[s.chooser].push(contract);
    s.turn = next(s.dealer);
    s.phase = contract === 'LORA' ? 'LAYOUT' : 'TRICKS';
  }

  private playToTrick(player: Position, card: Card): void {
    const s = this.state;
    const lead = s.trick[0]?.card.suit;
    if (lead && card.suit !== lead) {
      // nije pratio boju → nema je
      addMissing(s.missing[player], RANKS.map(r => makeCard(r, lead).id));
    }
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

    const contract = s.contract!;
    const allPlayed = s.hands.every(h => h.length === 0);
    if (allPlayed || isDecidedEarly(contract, s.taken)) {
      const lastTrickWinner = allPlayed ? winner : null;
      this.endDeal(scoreTricks(contract, s.taken, s.trickCounts, lastTrickWinner));
    }
  }

  private playToLayout(player: Position, card: Card): void {
    const s = this.state;
    if (s.layout.startRank === null) s.layout.startRank = card.rank;
    s.layout.piles[card.suit].push(card.rank);
    if (s.hands[player].length === 0) {
      this.endDeal(scoreLayout(s.hands.map(h => h.length), player, s.passes));
      return;
    }
    s.turn = next(player);
  }

  private endDeal(points: number[]): void {
    const s = this.state;
    points.forEach((pt, p) => { s.scores[p] += pt; });
    s.history.push({ dealIndex: s.dealIndex, dealer: s.dealer, chooser: s.chooser, contract: s.contract!, points });
    if (s.dealIndex + 1 >= this.totalDeals) {
      const min = Math.min(...s.scores);
      s.winners = ([0, 1, 2, 3] as Position[]).filter(p => s.scores[p] === min);
      s.phase = 'MATCH_END';
    } else {
      s.phase = 'DEAL_END';
    }
  }
}
