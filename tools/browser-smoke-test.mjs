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
  for (const viewport of [{ width: 390, height: 844 }, { width: 1920, height: 880 }, { width: 1280, height: 720 }]) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    // brojač poseta se prekine kad test odmah pređe na drugu stranicu — to nije greška
    page.on('requestfailed', r => { if (!/\/api\/(visit|event)$/.test(r.url())) errors.push(`request failed: ${r.url()}`); });
    // početni ekran mora da prekriva ceo ekran (pokvaren CSS ga je jednom ostavio u uglu)
    await page.goto(`http://localhost:${PORT}/?fast`); // ?fast: bez brojača poseta (lokalni server nema /api)
    const box = await page.locator('#startScreen').boundingBox();
    if (!box || box.width < viewport.width - 2 || box.height < viewport.height - 2) errors.push(`[${viewport.width}px] početni ekran ne prekriva ceo ekran (${JSON.stringify(box)})`);
    // pravila moraju da se skroluju (igra zabranjuje skrolovanje — to je jednom važilo i za pravila)
    await page.goto(`http://localhost:${PORT}/pravila.html`);
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(300);
    if ((await page.evaluate(() => scrollY)) < 200) errors.push(`[${viewport.width}px] pravila se ne skroluju`);
    await page.goto(`http://localhost:${PORT}/?fast&local`);
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
      // tabla od Lore ne sme da bude vidljiva u drugim igrama (bag: mešale se igre)
      const leak = await page.evaluate(() => {
        const s = window.__lora.game.getState();
        const shown = getComputedStyle(document.getElementById('layout')).display !== 'none';
        return s.contract !== 'LORA' && shown;
      });
      if (leak) errors.push(`[${viewport.width}px] tabla Lore vidljiva u drugoj igri`);

      const pickBtn = page.locator('.pick-btn');
      if (await pickBtn.count() && !(await page.locator('.pick-menu').count())) {
        await pickBtn.click();
        continue;
      }
      const chooseBtn = page.locator('.pick-menu button');
      if (await chooseBtn.count()) {
        if (moves < 30) await page.screenshot({ path: `tools/screenshot-${viewport.width}-choose.png` });
        const box = await page.locator('.pick-menu').boundingBox();
        if (box && (box.y < 0 || box.y + box.height > viewport.height)) errors.push(`[${viewport.width}px] meni za izbor izlazi iz ekrana`);
        await chooseBtn.last().click();
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

    const handBottom = await page.evaluate(() => document.getElementById('myHand').getBoundingClientRect().bottom);
    if (handBottom > viewport.height + 1) errors.push(`[${viewport.width}x${viewport.height}] ruka ne staje u ekran (${handBottom}px)`);
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
