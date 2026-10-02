// Slika za pregled linka (Viber, WhatsApp, Facebook, Google): icons/og-image.jpg, 1200×630.
// Pokretanje: node tools/og-image.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// slike karata ugrađene direktno (setContent stranica ne sme da čita fajlove sa diska)
const card = id => 'data:image/webp;base64,' + readFileSync(path.resolve(`icons/cards/${id}.webp`)).toString('base64');
const fan = ['JC', 'QS', 'KH', 'QH'];

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; font-family: 'Segoe UI', system-ui, sans-serif; color: #f5f7f5;
    background: radial-gradient(ellipse at 30% 40%, #1c8a52 0%, #0e4d2e 70%, #0b3a23 100%);
    border: 18px solid #6b4424; box-shadow: inset 0 0 0 4px #4a2e17, inset 0 0 80px rgba(0,0,0,.45);
    display: flex; align-items: center; padding: 0 70px; overflow: hidden; position: relative; }
  .text { flex: 1; z-index: 2; }
  h1 { font-size: 132px; line-height: 1; color: #f2c14e; letter-spacing: .01em; text-shadow: 0 4px 10px rgba(0,0,0,.35); }
  h1 span { font-size: 58px; color: #f5f7f5; font-weight: 600; margin-left: 14px; }
  p { font-size: 34px; margin-top: 22px; line-height: 1.3; color: #e6efe9; max-width: 560px; }
  .tags { display: flex; gap: 12px; margin-top: 30px; }
  .tags b { font-size: 22px; padding: 8px 16px; border-radius: 999px; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.18); font-weight: 600; }
  .url { position: absolute; left: 70px; bottom: 34px; font-size: 24px; color: #b8cbbf; }
  .fan { position: relative; width: 440px; height: 470px; }
  .fan img { position: absolute; width: 230px; left: 105px; top: 40px; border-radius: 14px; box-shadow: -6px 10px 24px rgba(0,0,0,.45); transform-origin: 50% 120%; }
</style></head><body>
  <div class="text">
    <h1>Lora<span>online</span></h1>
    <p>Besplatna kartaška igra — igraj sa prijateljima ili protiv računara.</p>
    <div class="tags"><b>7 igara</b><b>Sobe i chat</b><b>Rejting</b></div>
  </div>
  <div class="fan">${fan.map((id, i) => `<img src="${card(id)}" style="transform: rotate(${(i - 1.5) * 14}deg)">`).join('')}</div>
  <div class="url">lora.igrajmo.online</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: 'load' });
// JPG: WhatsApp ne prikazuje pregled sa slikom većom od ~300 KB
await page.screenshot({ path: 'icons/og-image.jpg', type: 'jpeg', quality: 86 });
await browser.close();
console.log('icons/og-image.jpg');
