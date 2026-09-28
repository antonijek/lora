import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoraGame, LoraError } from '../src/game.js';
import { chooseAction, type AiLevel } from '../src/ai.js';
import { makeRng } from '../src/cards.js';
import { DEFAULT_CONTRACTS } from '../src/contracts.js';
import type { Position } from '../src/types.js';

test('početak: 4 × 8 karata, igrač posle delioca bira igru', () => {
  const g = new LoraGame({ seed: 1 });
  const s = g.getState();
  assert.deepEqual(s.hands.map(h => h.length), [8, 8, 8, 8]);
  assert.equal(new Set(s.hands.flat().map(c => c.id)).size, 32);
  assert.equal(s.phase, 'CHOOSING');
  assert.equal(s.contract, null);
  assert.equal(s.dealer, 3);
  assert.equal(s.chooser, 0);
  assert.equal(s.turn, 0);
  assert.deepEqual(g.getPlayerView(0).available, [...DEFAULT_CONTRACTS]);
});

test('izbor igre: samo igrač čija je partija, samo neodigrana igra', () => {
  const g = new LoraGame({ seed: 2 });
  assert.throws(() => g.choose(1, 'MIN'), LoraError);
  assert.throws(() => g.play(0, g.getState().hands[0][0].id), LoraError); // prvo se bira
  g.choose(0, 'MIN');
  const s = g.getState();
  assert.equal(s.contract, 'MIN');
  assert.equal(s.phase, 'TRICKS');
  assert.equal(s.turn, 0); // ko bira, igra prvi
  assert.deepEqual(s.used[0], ['MIN']);
  assert.equal(g.getPlayerView(0).available.includes('MIN'), false);
});

test('nelegalni potezi se odbijaju', () => {
  const g = new LoraGame({ seed: 2 });
  g.choose(0, 'MAX');
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

test('choice: delilac se menja svake partije, svako odigra svaku svoju igru tačno jednom', () => {
  const g = new LoraGame({ seed: 4 });
  const s = playOut(g, ['medium', 'easy', 'medium', 'easy'], 4);
  assert.equal(s.history.length, 28);
  s.history.forEach((h, i) => {
    assert.equal(h.dealer, (3 + i) % 4);
    assert.equal(h.chooser, i % 4);
  });
  for (const p of [0, 1, 2, 3]) {
    const mine = s.history.filter(h => h.chooser === p).map(h => h.contract).sort();
    assert.deepEqual(mine, [...DEFAULT_CONTRACTS].sort());
  }
});

test('fixed: isti delilac igra svih 7 igara redom', () => {
  const g = new LoraGame({ seed: 4, mode: 'fixed' });
  const s = playOut(g, ['easy', 'easy', 'easy', 'easy'], 4);
  const seq = s.history.map(h => `${h.dealer}:${h.contract}`);
  for (let d = 0; d < 4; d++) {
    const dealer = (3 + d) % 4;
    assert.deepEqual(seq.slice(d * 7, d * 7 + 7), DEFAULT_CONTRACTS.map(c => `${dealer}:${c}`));
  }
});

function playOut(g: LoraGame, levels: AiLevel[], seed: number) {
  const rng = makeRng(seed);
  let guard = 0;
  while (g.getState().phase !== 'MATCH_END') {
    const s = g.getState();
    if (s.phase === 'DEAL_END') {
      checkDeal(s);
      g.nextDeal();
      continue;
    }
    const p = s.turn as Position;
    const a = chooseAction(g.getPlayerView(p), levels[p], rng);
    if (a.type === 'pass') g.pass(p);
    else if (a.type === 'choose') g.choose(p, a.contract);
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
