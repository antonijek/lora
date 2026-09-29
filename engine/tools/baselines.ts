// Prosečan relativan rezultat igrača koji bira igru (i igra prvi) sa nasumičnom
// rukom, kad svi igraju heuristikama. Rezultat ide u CONTRACT_BASELINE (ai.ts).
// Pokretanje: node --import tsx tools/baselines.ts 20000

import { createDeck, makeRng, shuffle } from '../src/cards.js';
import { DEFAULT_CONTRACTS } from '../src/contracts.js';
import { __test } from '../src/ai.js';

const n = Number(process.argv[2] ?? 5000);
const rng = makeRng(12345);
const out: Record<string, number> = {};
for (const contract of DEFAULT_CONTRACTS) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const deck = shuffle(createDeck(), rng);
    const hands = [0, 1, 2, 3].map(p => deck.slice(p * 8, p * 8 + 8));
    const pts = __test.simulate({ contract, hands, turn: 0, trick: [], taken: [[], [], [], []], counts: [0, 0, 0, 0], passes: [0, 0, 0, 0], layout: __test.emptyLayoutSim() });
    sum += __test.relative(pts, 0);
  }
  out[contract] = Math.round((sum / n) * 1000) / 1000;
}
console.log(JSON.stringify(out, null, 2));
