// AI turnir: dva nivoa, po dva igrača svaki (naizmenično raspoređeni).
// Pokretanje: npm run sim -- 40 hard medium
// Prosečni poeni po igraču u meču (manje = bolje) + % pobeda u meču.

import { LoraGame } from '../src/game.js';
import { chooseAction, type AiLevel } from '../src/ai.js';
import { makeRng } from '../src/cards.js';
import { DEFAULT_CONTRACTS } from '../src/contracts.js';
import type { ContractId, Position } from '../src/types.js';

const n = Number(process.argv[2] ?? 20);
const A = (process.argv[3] ?? 'hard') as AiLevel;
const B = (process.argv[4] ?? 'medium') as AiLevel;
const sum: Record<string, number> = { [A]: 0, [B]: 0 };
const wins: Record<string, number> = { [A]: 0, [B]: 0 };
const perContract: Record<string, Record<string, number>> = {};
const t0 = Date.now();
let decisions = 0;

for (let seed = 1; seed <= n; seed++) {
  const levels: AiLevel[] = seed % 2 ? [A, B, A, B] : [B, A, B, A];
  const g = new LoraGame({ seed });
  const rng = makeRng(seed * 13);
  while (g.getState().phase !== 'MATCH_END') {
    const s = g.getState();
    if (s.phase === 'DEAL_END') { g.nextDeal(); continue; }
    const p = s.turn as Position;
    const a = chooseAction(g.getPlayerView(p), levels[p], rng);
    decisions++;
    if (a.type === 'pass') g.pass(p); else if (a.type === 'choose') g.choose(p, a.contract); else g.play(p, a.cardId);
  }
  const s = g.getState();
  s.scores.forEach((sc, p) => { sum[levels[p]] += sc / 2; });
  for (const w of s.winners) wins[levels[w]] += 1 / s.winners.length;
  for (const h of s.history) {
    perContract[h.contract] ??= { [A]: 0, [B]: 0 };
    h.points.forEach((pt, p) => { perContract[h.contract][levels[p]] += pt / 2; });
  }
}

console.log(`${n} mečeva: ${A} ${(sum[A] / n).toFixed(1)} poena, pobeda ${(100 * wins[A] / n).toFixed(0)}%  |  ${B} ${(sum[B] / n).toFixed(1)} poena, pobeda ${(100 * wins[B] / n).toFixed(0)}%`);
for (const c of DEFAULT_CONTRACTS as ContractId[]) {
  const x = perContract[c];
  if (x) console.log(`  ${c.padEnd(13)} ${A} ${(x[A] / n / 4).toFixed(2)}  ${B} ${(x[B] / n / 4).toFixed(2)}  (po partiji)`);
}
console.log(`${((Date.now() - t0) / decisions).toFixed(1)} ms po odluci`);
