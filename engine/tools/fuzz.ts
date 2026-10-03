// Fuzz: hiljade mečeva sa NASUMIČNIM legalnim potezima (ne AI — da se pokriju
// i čudni potezi), u oba moda. Proverava pravila i bodovanje posle svake partije.
// Pokretanje: cd engine && node --import tsx tools/fuzz.ts [broj_mečeva]

import { LoraGame } from '../src/game.js';
import { makeRng } from '../src/cards.js';
import type { LoraMode, LoraState, Position } from '../src/types.js';

const N = Number(process.argv[2] ?? 2000);
const failures: string[] = [];
const fail = (seed: number, msg: string) => { if (failures.length < 30) failures.push(`seed ${seed}: ${msg}`); };

function checkDeal(seed: number, s: LoraState): void {
  const d = s.history.at(-1)!;
  const sum = d.points.reduce((a, b) => a + b, 0);
  const ok = {
    MAX: sum === -8,
    MIN: sum === 8,
    HERC: sum === 8 || sum === -8,
    DAME: sum === 8,
    ZANDAR: sum === 8,
    KRALJ_ZADNJI: sum === 8 || sum === 4, // rani kraj: kralj herc odnet pre poslednjeg štiha
    LORA: d.points.filter(p => p < 0).length <= 1,
  }[d.contract];
  if (!ok) fail(seed, `partija ${d.dealIndex + 1} ${d.contract}: zbir ${sum} (${d.points})`);
  if (d.contract !== 'LORA' && d.points.some(p => !Number.isInteger(p))) fail(seed, `necelobrojni poeni ${d.points}`);
}

let deals = 0;
let moves = 0;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const seed = 1000 + i;
  const mode: LoraMode = i % 5 === 0 ? 'fixed' : 'choice';
  const rng = makeRng(seed * 7 + 3);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rng() * a.length)];
  let g: LoraGame;
  try {
    g = new LoraGame({ seed, mode });
    let guard = 0;
    while (g.getState().phase !== 'MATCH_END') {
      if (++guard > 6000) { fail(seed, 'meč se zaglavio'); break; }
      const s = g.getState();
      if (s.phase === 'DEAL_END') {
        checkDeal(seed, s);
        deals++;
        // posle partije: otkrivene ruke = podeljene, 4 × 8 različitih karata
        const rev = g.getPlayerView(0).revealed;
        if (!rev || rev.flat().length !== 32 || new Set(rev.flat().map(c => c.id)).size !== 32) fail(seed, 'otkrivene ruke nisu 32 različite karte');
        // povremeno: snimak/vraćanje stanja usred meča (kao server posle restarta)
        g = rng() < 0.1 ? LoraGame.fromState(g.getState(), { mode }) : g;
        g.nextDeal();
        continue;
      }
      const p = s.turn as Position;
      const v = g.getPlayerView(p);
      if (v.revealed) fail(seed, 'tuđe karte vidljive tokom partije');
      if (s.phase === 'CHOOSING') {
        if (v.chooser !== p || !v.available.length) fail(seed, 'izbor igre: pogrešan igrač ili nema igara');
        g.choose(p, pick(v.available));
      } else if (v.mustPass) {
        g.pass(p);
      } else {
        if (!v.legal.length) { fail(seed, `nema legalnih karata u fazi ${s.phase}`); break; }
        g.play(p, pick(v.legal));
      }
      moves++;
      // ruke + odneto + sto = 32 karte (u štihovima)
      const st = g.getState();
      if (st.phase === 'TRICKS') {
        const total = st.hands.flat().length + st.taken.flat().length + st.trick.length;
        if (total !== 32) fail(seed, `${total} karata u igri umesto 32`);
      }
    }
    const end = g.getState();
    if (end.phase === 'MATCH_END') {
      checkDeal(seed, end);
      deals++;
      if (end.history.length !== g.totalDeals) fail(seed, `${end.history.length} partija umesto ${g.totalDeals}`);
      const sums = [0, 1, 2, 3].map(q => end.history.reduce((a, h) => a + h.points[q], 0));
      if (sums.some((x, q) => x !== end.scores[q])) fail(seed, `ukupni poeni ${end.scores} ≠ zbir partija ${sums}`);
      const used = end.used.map(u => [...u].sort().join());
      if (mode === 'choice' && new Set(used).size !== 1) fail(seed, 'nisu svi odigrali svih 7 igara');
      const min = Math.min(...end.scores);
      if (end.winners.some(w => end.scores[w] !== min) || !end.winners.length) fail(seed, 'pogrešan pobednik');
    }
  } catch (e) {
    fail(seed, `izuzetak: ${(e as Error).message}`);
  }
}
console.log(`${N} mečeva, ${deals} partija, ${moves} poteza za ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (failures.length) {
  console.log(`✖ ${failures.length}+ problema:\n- ` + failures.join('\n- '));
  process.exit(1);
}
console.log('OK — fuzz bez grešaka');
