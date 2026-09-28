import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoraGame } from '../src/game.js';
import { chooseAction, sampleHands } from '../src/ai.js';
import { makeRng } from '../src/cards.js';
import type { Position } from '../src/types.js';

test('sampleHands: tačan broj karata, bez viđenih i bez karata koje igrač sigurno nema', () => {
  const rng = makeRng(7);
  const g = new LoraGame({ seed: 11 });
  g.choose(0, 'MIN');
  // odigraj nekoliko poteza da nastanu "missing" informacije
  for (let i = 0; i < 14; i++) {
    const s = g.getState();
    const a = chooseAction(g.getPlayerView(s.turn), 'medium', rng);
    if (a.type === 'play') g.play(s.turn, a.cardId);
  }
  const view = g.getPlayerView(0);
  for (let k = 0; k < 50; k++) {
    const hands = sampleHands(view, rng);
    const ids = hands.flat().map(c => c.id);
    assert.equal(new Set(ids).size, ids.length, 'nema duplikata');
    for (const p of [1, 2, 3] as Position[]) {
      assert.equal(hands[p].length, view.handCounts[p]);
      for (const c of hands[p]) assert.ok(!view.missing[p].includes(c.id), `${c.id} kod igrača koji je nema`);
    }
    assert.deepEqual(hands[0].map(c => c.id).sort(), view.hand.map(c => c.id).sort());
  }
});

test('engine beleži da igrač nema boju kad je ne prati', () => {
  const g = new LoraGame({ seed: 3 });
  g.choose(0, 'MIN');
  const rng = makeRng(1);
  let found = false;
  for (let i = 0; i < 32 && !found; i++) {
    const s = g.getState();
    if (s.phase !== 'TRICKS') break;
    const lead = s.trick[0]?.card.suit;
    const a = chooseAction(g.getPlayerView(s.turn), 'easy', rng);
    if (a.type !== 'play') break;
    const card = s.hands[s.turn].find(c => c.id === a.cardId)!;
    g.play(s.turn, a.cardId);
    if (lead && card.suit !== lead) {
      const missing = g.getState().missing[s.turn];
      assert.equal(missing.filter(id => id.endsWith({ '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' }[lead])).length, 8);
      found = true;
    }
  }
  assert.ok(found, 'u partiji je bar neko bacio drugu boju');
});

test('hard: kad je sam kralj herc u ruci pod kecom, podmeće ga (KRALJ_ZADNJI)', () => {
  // Protivnik je poveo A♥; ja imam K♥ i 7♥ — K♥ ispod keca je čist dobitak.
  const g = new LoraGame({ seed: 1 });
  const st = g.getState();
  const card = (id: string) => ({ id, rank: id.slice(0, -1), suit: { S: '♠', H: '♥', D: '♦', C: '♣' }[id.slice(-1)] }) as never;
  st.phase = 'TRICKS';
  st.contract = 'KRALJ_ZADNJI';
  st.chooser = 3;
  st.used[3] = ['KRALJ_ZADNJI'];
  st.hands = [
    ['KH', '7H', '8S', '9S', '10D', 'JD', 'QC', 'AC'].map(card),
    ['8H', '9H', '7S', '10S', '7D', '8D', '7C', '8C'].map(card),
    ['10H', 'JH', 'JS', 'QS', '9D', 'QD', '9C', '10C'].map(card),
    ['QH', 'KS', 'AS', 'KD', 'AD', 'JC', 'KC', 'AH'].map(card),
  ];
  st.hands[3] = st.hands[3].filter((c: { id: string }) => c.id !== 'AH');
  st.trick = [{ player: 3, card: card('AH') }];
  st.turn = 0;
  const g2 = LoraGame.fromState(st);
  const a = chooseAction(g2.getPlayerView(0), 'hard', makeRng(2));
  assert.deepEqual(a, { type: 'play', cardId: 'KH' });
});

test('hard: bira igru za koju je ruka najbolja (sve male karte → MAX nije izbor)', () => {
  const g = new LoraGame({ seed: 1 });
  const st = g.getState();
  const card = (id: string) => ({ id, rank: id.slice(0, -1), suit: { S: '♠', H: '♥', D: '♦', C: '♣' }[id.slice(-1)] }) as never;
  st.hands[0] = ['7S', '8S', '7H', '8H', '7D', '8D', '7C', '8C'].map(card);
  const g2 = LoraGame.fromState(st);
  const a = chooseAction(g2.getPlayerView(0), 'hard', makeRng(3));
  assert.equal(a.type, 'choose');
  assert.notEqual((a as { contract: string }).contract, 'MAX');
});
