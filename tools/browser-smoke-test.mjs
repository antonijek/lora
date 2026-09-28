// Headless test: odigraj CEO meč Lore (28 igara) kroz UI klikovima na legalne karte.
// Pokretanje: npm run test:ui

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 8124;
const server = spawn(process.execPath, ['tools/serve.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
await new Promise(r => server.stdout.once('data', r));

const errors = [];
const browser = await chromium.launch();
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', r => errors.push(`request failed: ${r.url()}`));
    await page.goto(`http://localhost:${PORT}/?fast`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('#myHand .card');

    let moves = 0;
    let shotLayout = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 480_000) {
      if (await page.locator('#dealEnd[open]').count()) {
        const btn = await page.textContent('#nextDealBtn');
        if (btn.includes('Nova')) { console.log(`[${viewport.width}px] ${await page.textContent('#dealEndTitle')} — ${moves} poteza`); break; }
        await page.click('#nextDealBtn');
        continue;
      }
      const legal = page.locator('#myHand .card.legal');
      if (await legal.count()) {
        if (!shotLayout && (await page.textContent('#contractName')) === 'Lora' && moves > 0) {
          await page.screenshot({ path: `tools/screenshot-${viewport.width}-lora.png` });
          shotLayout = true;
        }
        if (moves === 3) await page.screenshot({ path: `tools/screenshot-${viewport.width}-trick.png` });
        await legal.first().click();
        moves++;
      } else {
        await page.waitForTimeout(80);
      }
    }
    const done = await page.evaluate(() => window.__lora.game.getState().phase);
    if (done !== 'MATCH_END') errors.push(`[${viewport.width}px] meč nije završen (faza ${done}, potezi ${moves})`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) errors.push(`horizontalni scroll na ${viewport.width}px`);
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}

if (errors.length) {
  console.error('GREŠKE:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
}
console.log('OK — UI smoke test prošao');
