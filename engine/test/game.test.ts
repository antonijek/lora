import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoraGame, LoraError } from '../src/game.js';
import { chooseAction, type AiLevel } from '../src/ai.js';
import { makeRng } from '../src/cards.js';
import { DEFAULT_CONTRACTS } from '../src/contracts.js';
import type { Position } from '../src/types.js';

test('početak: 4 × 8 karata, prva igra MAX, igra igrač posle delioca', () => {
  const g = new LoraGame({ seed: 1 });
  const s = g.getState();
  assert.deepEqual(s.hands.map(h => h.length), [8, 8, 8, 8]);
  assert.equal(new Set(s.hands.flat().map(c => c.id)).size, 32);
  assert.equal(s.contract, 'MAX');
  assert.equal(s.dealer, 3);
  assert.equal(s.turn, 0);
});

test('nelegalni potezi se odbijaju', () => {
  const g = new LoraGame({ seed: 2 });
  const s = g.getState();
  assert.throws(() => g.play(1, s.hands[1][0].id), LoraError);
  assert.throws(() => g.play(0, s.hands[1][0].id), LoraError);
  assert.throws(() => g.pass(0), LoraError);

  // posle prve karte, igrač 1 mora da prati boju ako može
  const first = s.hands[0][0];
  g.play(0, first.id);
  const h1 = g.getState().hands[1];
  const off = h1.find(c => c.suit !== first.suit);
  if (off && h1.some(c => c.suit === first.suit)) assert.throws(() => g.play(1, off.id), LoraError);
});

test('PlayerView ne otkriva tuđe karte', () => {
  const g = new LoraGame({ seed: 3 });
  const json = JSON.stringify(g.getPlayerView(0));
  for (const c of g.getState().hands[2]) assert.equal(json.includes(`"${c.id}"`), false);
});

test('redosled: svaki delilac odigra svih 7 igara', () => {
  const g = new LoraGame({ seed: 4 });
  const seq: string[] = [];
  playOut(g, ['easy', 'easy', 'easy', 'easy'], 4, (s) => seq.push(`${s.dealer}:${s.contract}`));
  assert.equal(seq.length, 28);
  for (let d = 0; d < 4; d++) {
    const dealer = (3 + d) % 4;
    assert.deepEqual(seq.slice(d * 7, d * 7 + 7), DEFAULT_CONTRACTS.map(c => `${dealer}:${c}`));
  }
});

function playOut(
  g: LoraGame, levels: AiLevel[], seed: number,
  onDealStart?: (s: ReturnType<LoraGame['getState']>) => void,
) {
  const rng = makeRng(seed);
  let guard = 0;
  onDealStart?.(g.getState());
  while (g.getState().phase !== 'MATCH_END') {
    const s = g.getState();
    if (s.phase === 'DEAL_END') {
      checkDeal(s);
      g.nextDeal();
      onDealStart?.(g.getState());
      continue;
    }
    const p = s.turn as Position;
    const a = chooseAction(g.getPlayerView(p), levels[p], rng);
    if (a.type === 'pass') g.pass(p);
    else g.play(p, a.cardId);
    if (++guard > 5000) throw new Error('meč se zaglavio');
  }
  checkDeal(g.getState());
  return g.getState();
}

function checkDeal(s: ReturnType<LoraGame['getState']>) {
  const last = s.history.at(-1)!;
  const sum = last.points.reduce((a, b) => a + b, 0);
  switch (last.contract) {
    case 'MAX': assert.equal(sum, -8); break;
    case 'MIN': assert.equal(sum, 8); break;
    case 'HERC': assert.ok(sum === 8 || sum === -8, `herc zbir ${sum}`); break;
    case 'DAME': case 'ZANDAR': case 'KRALJ_ZADNJI': assert.equal(sum, 8); break;
    case 'LORA': assert.equal(last.points.filter(p => p === -8).length, 1); break;
  }
}

test('ceo meč (28 partija) AI vs AI se završava, zbirovi po igri su tačni (20 mečeva)', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const s = playOut(new LoraGame({ seed }), ['medium', 'easy', 'medium', 'easy'], seed + 100);
    assert.equal(s.history.length, 28);
    assert.ok(s.winners.length >= 1);
    const totals = [0, 1, 2, 3].map(p => s.history.reduce((a, h) => a + h.points[p], 0));
    assert.deepEqual(totals, s.scores);
  }
});

test('podesiv izbor igara', () => {
  const g = new LoraGame({ seed: 5, contracts: ['MIN', 'LORA'] });
  const s = playOut(g, ['medium', 'medium', 'medium', 'medium'], 5);
  assert.equal(s.history.length, 8);
});
