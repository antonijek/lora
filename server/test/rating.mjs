// Rejting: promena mora zavisiti od razlike u poenima, ne samo od "ko ima manje".
// Pokretanje: cd server && npm run build && node test/rating.mjs
import { ratingDeltas } from '../dist/rooms/driver.js';

const failures = [];
const check = (cond, msg) => { console.log((cond ? '✔ ' : '✖ ') + msg); if (!cond) failures.push(msg); };
const R = [1000, 1000, 1000, 1000];
const sum = a => a.reduce((x, y) => x + y, 0);

let d = ratingDeltas([30, 31, 60, 70], R);
check(Math.abs(d[0] - d[1]) <= 1, `skoro isti poeni (30 i 31) → skoro ista promena (${d[0]}, ${d[1]})`);
d = ratingDeltas([30, 31, 30, 31], R);
check(d.every(x => Math.abs(x) <= 1), `svi skoro isti → promene oko nule (${d})`);
d = ratingDeltas([10, 80, 80, 80], R);
check(d[0] >= 15 && d.slice(1).every(x => x < 0), `ubedljiva pobeda → veliki plus (${d})`);
const a = ratingDeltas([20, 40, 60, 80], R), b = ratingDeltas([20, 25, 60, 80], R);
check(a[0] > b[0], `veća razlika do drugog → veći plus pobedniku (${a[0]} > ${b[0]})`);
check(Math.abs(sum(ratingDeltas([22, 47, 51, 90], [1100, 1000, 950, 1000]))) <= 2, 'zbir promena ≈ 0');
d = ratingDeltas([40, 40, 40, 40], [1200, 1000, 1000, 1000]);
check(d[0] < 0, `jači igrač koji samo izjednači gubi malo (${d[0]})`);

if (failures.length) { console.error(`\n✖ ${failures.length} neuspešnih`); process.exit(1); }
console.log('\nOK — rejting test prošao');
