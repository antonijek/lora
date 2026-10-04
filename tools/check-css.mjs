// Provera CSS-a pre slanja na server: neuparena zagrada tiho gasi sledeće pravilo
// (desilo se 2026-10-04: zagrada viška ugasila je .screen — ekrani van stola su se raspali).
// Pokretanje: node tools/check-css.mjs (poziva ga i tools/deploy.sh)
import { readFileSync } from 'node:fs';

let bad = false;
for (const file of ['lora.css']) {
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  let depth = 0;
  let line = 1;
  const open = [];
  for (const c of src) {
    if (c === '\n') line++;
    if (c === '{') { depth++; open.push(line); }
    if (c === '}') {
      if (depth === 0) { console.error(`✖ ${file}:${line} — zagrada } viška`); bad = true; continue; }
      depth--; open.pop();
    }
  }
  if (depth) { console.error(`✖ ${file} — nezatvorena { (otvorena na liniji ${open.at(-1)})`); bad = true; }
}
if (bad) process.exit(1);
console.log('CSS u redu');
