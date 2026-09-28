// AI turnir: prosečni poeni po nivou (manje = bolje).
// Pokretanje: npm run sim -- 100

import { LoraGame } from '../src/game.js';
import { chooseAction, type AiLevel } from '../src/ai.js';
import { makeRng } from '../src/cards.js';
import { DEFAULT_CONTRACTS } from '../src/contracts.js';
import type { ContractId, Position } from '../src/types.js';

const n = Number(process.argv[2] ?? 50);
const sum: Record<AiLevel, number> = { easy: 0, medium: 0 };
const perContract: Record<string, Record<AiLevel, number>> = {};
const t0 = Date.now();

for (let seed = 1; seed <= n; seed++) {
  const levels: AiLevel[] = seed % 2 ? ['medium', 'easy', 'medium', 'easy'] : ['easy', 'medium', 'easy', 'medium'];
  const g = new LoraGame({ seed });
  const rng = makeRng(seed * 13);
  while (g.getState().phase !== 'MATCH_END') {
    const s = g.getState();
    if (s.phase === 'DEAL_END') { g.nextDeal(); continue; }
    const p = s.turn as Position;
    const a = chooseAction(g.getPlayerView(p), levels[p], rng);
    if (a.type === 'pass') g.pass(p); else g.play(p, a.cardId);
  }
  const s = g.getState();
  s.scores.forEach((sc, p) => { sum[levels[p]] += sc / 2; });
  for (const h of s.history) {
    perContract[h.contract] ??= { easy: 0, medium: 0 };
    h.points.forEach((pt, p) => { perContract[h.contract][levels[p]] += pt / 2; });
  }
}

console.log(`prosečno po igraču u meču (manje = bolje): medium ${(sum.medium / n).toFixed(1)}, easy ${(sum.easy / n).toFixed(1)}`);
for (const c of DEFAULT_CONTRACTS as ContractId[]) {
  const x = perContract[c];
  if (x) console.log(`  ${c.padEnd(13)} medium ${(x.medium / n / 4).toFixed(2)}  easy ${(x.easy / n / 4).toFixed(2)}  (po partiji)`);
}
console.log(`${Date.now() - t0} ms`);
