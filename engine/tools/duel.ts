// Duel dve konfiguracije istog AI-ja (hard) — npr. broj uzoraka.
// Pokretanje: node --import tsx tools/duel.ts 30 200 100
import { LoraGame } from '../src/game.js';
import { chooseAction } from '../src/ai.js';
import { makeRng } from '../src/cards.js';
import type { Position } from '../src/types.js';

const n = Number(process.argv[2] ?? 20);
const sa = Number(process.argv[3] ?? 200);
const sb = Number(process.argv[4] ?? 100);
const cfg = [{ samples: sa, chooseSamples: sa * 1.5 }, { samples: sb, chooseSamples: sb * 1.5 }];
let pa = 0, pb = 0, wa = 0;
const t0 = Date.now();
for (let seed = 1; seed <= n; seed++) {
  const who = seed % 2 ? [0, 1, 0, 1] : [1, 0, 1, 0];
  const g = new LoraGame({ seed: 1000 + seed });
  const rng = makeRng(seed);
  while (g.getState().phase !== 'MATCH_END') {
    const s = g.getState();
    if (s.phase === 'DEAL_END') { g.nextDeal(); continue; }
    const p = s.turn as Position;
    const a = chooseAction(g.getPlayerView(p), 'hard', rng, cfg[who[p]]);
    if (a.type === 'pass') g.pass(p); else if (a.type === 'choose') g.choose(p, a.contract); else g.play(p, a.cardId);
  }
  const s = g.getState();
  s.scores.forEach((sc, p) => { if (who[p] === 0) pa += sc / 2; else pb += sc / 2; });
  const best = Math.min(...s.scores);
  wa += s.scores.filter((sc, p) => sc === best && who[p] === 0).length / s.scores.filter(sc => sc === best).length;
}
console.log(`${n} mečeva: A(${sa}) ${(pa / n).toFixed(1)} poena, pobeda ${(100 * wa / n).toFixed(0)}%  |  B(${sb}) ${(pb / n).toFixed(1)}  (${Math.round((Date.now() - t0) / 1000)} s)`);
