import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardFromId, createDeck } from '../src/cards.js';
import { isDecidedEarly, scoreLayout, scoreTricks } from '../src/contracts.js';

const cards = (s: string) => (s ? s.split(' ').map(cardFromId) : []);

test('MAX: −1 po štihu, MIN: +1 po štihu', () => {
  const taken = [[], [], [], []];
  assert.deepEqual(scoreTricks('MAX', taken, [3, 2, 2, 1], null), [-3, -2, -2, -1]);
  assert.deepEqual(scoreTricks('MIN', taken, [3, 2, 2, 1], null), [3, 2, 2, 1]);
});

test('HERC: +1 po hercu; svih 8 → −8', () => {
  const hearts = createDeck().filter(c => c.suit === '♥');
  assert.deepEqual(scoreTricks('HERC', [cards('7H 8H'), cards('9H'), [], []], [0, 0, 0, 0], null), [2, 1, 0, 0]);
  assert.deepEqual(scoreTricks('HERC', [hearts, [], [], []], [0, 0, 0, 0], null), [-8, 0, 0, 0]);
});

test('DAME: +2 po dami', () => {
  assert.deepEqual(scoreTricks('DAME', [cards('QS QH'), cards('QD'), [], cards('QC 7S')], [0, 0, 0, 0], null), [4, 2, 0, 2]);
});

test('ŽANDAR TREF: +8', () => {
  assert.deepEqual(scoreTricks('ZANDAR', [[], [], cards('JC JS'), []], [0, 0, 0, 0], null), [0, 0, 8, 0]);
});

test('KRALJ HERC +4, poslednji štih +4', () => {
  assert.deepEqual(scoreTricks('KRALJ_ZADNJI', [cards('KH'), [], [], []], [0, 0, 0, 0], 0), [8, 0, 0, 0]);
  assert.deepEqual(scoreTricks('KRALJ_ZADNJI', [[], cards('KH'), [], []], [0, 0, 0, 0], 3), [0, 4, 0, 4]);
});

test('LORA: pobednik −8, ostali po +1 za svaku kartu', () => {
  assert.deepEqual(scoreLayout([0, 3, 5, 1], 0), [-8, 3, 5, 1]);
  // svako "dalje" +1; pobednik koji je rekao "dalje" gubi −8
  assert.deepEqual(scoreLayout([0, 3, 5, 1], 0, [0, 2, 0, 1]), [-8, 5, 5, 2]);
  assert.deepEqual(scoreLayout([0, 3, 5, 1], 0, [1, 0, 0, 0]), [1, 3, 5, 1]);
});

test('rani kraj: sve dame / žandar tref / svi hercovi odneti', () => {
  assert.ok(isDecidedEarly('DAME', [cards('QS QH'), cards('QD QC'), [], []]));
  assert.ok(!isDecidedEarly('DAME', [cards('QS QH'), cards('QD'), [], []]));
  assert.ok(isDecidedEarly('ZANDAR', [[], [], cards('JC'), []]));
  assert.ok(!isDecidedEarly('KRALJ_ZADNJI', [cards('KH'), [], [], []]));
  assert.ok(!isDecidedEarly('MIN', [cards('KH'), [], [], []]));
});
