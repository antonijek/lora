// Pravi lakše WebP karte iz originalnih SVG karata (icons/cards/*.svg).
// SVG slike (dame, kraljevi, žandari, poleđina) imaju ugrađene velike rastere —
// ~400 KB po karti, ~6,5 MB za ceo špil; WebP 300×420 je ~10–30 KB, a i dalje
// oštar na telefonima (karta je najviše ~100 px široka, × 3 za gust ekran).
// Pokretanje (posle promene SVG karata): node tools/cards-webp.mjs

import { chromium } from 'playwright';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('icons/cards');
const W = 300;
const H = 420;
const QUALITY = 0.88;

const files = readdirSync(DIR).filter(f => f.endsWith('.svg'));
const browser = await chromium.launch();
const page = await browser.newPage();
let before = 0;
let after = 0;
for (const f of files) {
  const svg = readFileSync(path.join(DIR, f), 'utf8');
  const dataUrl = await page.evaluate(async ({ svg, W, H, QUALITY }) => {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    c.getContext('2d').drawImage(img, 0, 0, W, H);
    return c.toDataURL('image/webp', QUALITY);
  }, { svg, W, H, QUALITY });
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  writeFileSync(path.join(DIR, f.replace(/\.svg$/, '.webp')), buf);
  before += Buffer.byteLength(svg);
  after += buf.length;
}
await browser.close();
console.log(`${files.length} karata: ${(before / 1e6).toFixed(1)} MB SVG → ${(after / 1e3).toFixed(0)} KB WebP`);
