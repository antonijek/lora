import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, newRecords, streak, type MatchRecord } from '../src/stats.js';
import type { DealResult } from '../src/types.js';

const deal = (contract: DealResult['contract'], points: number[]): DealResult => ({ dealIndex: 0, dealer: 0, chooser: 0, contract, points });
const rec = (date: string, scores: number[], history: DealResult[], seat = 0 as const): MatchRecord => ({ date, scores, seat, history });

test('statistika: mečevi, pobede, najbolji meč, najbolja partija po igri, prosek', () => {
  const s = computeStats([
    rec('2026-09-01', [20, 30, 40, 50], [deal('MAX', [-2, -2, -2, -2]), deal('DAME', [4, 2, 2, 0])]),
    rec('2026-09-02', [35, 10, 40, 50], [deal('MAX', [-5, -1, -1, -1]), deal('DAME', [0, 2, 4, 2])]),
  ]);
  assert.equal(s.matches, 2);
  assert.equal(s.wins, 1);
  assert.deepEqual(s.bestMatch, { points: 20, date: '2026-09-01' });
  assert.equal(s.avgScore, 27.5);
  assert.equal(s.bestDeal.MAX?.points, -5);
  assert.equal(s.bestDeal.DAME?.points, 0);
});

test('novi rekordi: samo strogo bolje, ne u prvom meču, jedna stavka po igri', () => {
  const prev = computeStats([rec('2026-09-01', [20, 30, 40, 50], [deal('MAX', [-2, -2, -2, -2])])]);
  const r = newRecords(prev, rec('2026-09-02', [12, 30, 40, 50], [deal('MAX', [-4, -2, -1, -1]), deal('MAX', [-6, -1, -1, 0])]));
  assert.equal(r.length, 2);
  assert.match(r[0], /Najbolji meč: 12 poena \(ranije 20\)/);
  assert.match(r[1], /Maksimum — najbolje −6 \(ranije −2\)/);
  assert.deepEqual(newRecords(prev, rec('2026-09-02', [20, 30, 40, 50], [deal('MAX', [-2, 0, 0, 0])])), [], 'izjednačenje nije rekord');
  assert.deepEqual(newRecords(computeStats([]), rec('2026-09-02', [5, 30, 40, 50], [])), [], 'prvi meč bez rekorda');
});

test('niz dana zaredom', () => {
  assert.deepEqual(streak(['2026-09-28', '2026-09-29', '2026-09-30'], '2026-09-30'), { current: 3, best: 3 });
  assert.deepEqual(streak(['2026-09-28', '2026-09-29'], '2026-09-30'), { current: 2, best: 2 }, 'juče se računa');
  assert.deepEqual(streak(['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-28'], '2026-09-30'), { current: 0, best: 3 }, 'prekinut niz');
  assert.deepEqual(streak([], '2026-09-30'), { current: 0, best: 0 });
});
