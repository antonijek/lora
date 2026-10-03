// QA: igra protiv računara u pregledaču — pune partije na više veličina ekrana,
// nasumično igranje i nasumično korišćenje svih opcija (tabela, meni, statistika,
// poslednji štih, pogledaj karte, osvežavanje usred meča).
// Hvata: JS greške, zaglavljivanje, sadržaj van ekrana, preklapanje karata i pločica.
// Pokretanje (dev server mora da radi: node tools/serve.js): node tools/qa-local.mjs

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.QA_URL ?? 'http://localhost:8002/';
const OUT = process.env.QA_OUT ?? 'tools/qa-out';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desk-1920', width: 1920, height: 1000 },
  { name: 'desk-1366', width: 1366, height: 700 },
  { name: 'phone-360', width: 360, height: 640, mobile: true },
  { name: 'phone-412', width: 412, height: 800, mobile: true },
  { name: 'land-740', width: 740, height: 360, mobile: true },
];

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const chance = p => rnd() < p;

const problems = [];
const seen = new Set();
function problem(vp, kind, msg) {
  const key = `${vp}|${kind}|${msg}`.slice(0, 200);
  if (seen.has(key)) return false;
  seen.add(key);
  problems.push(`[${vp}] ${kind}: ${msg}`);
  console.log(`  ✖ [${vp}] ${kind}: ${msg}`);
  return true;
}

/** Pravougaonici koji se ne smeju preklapati: pločice igrača naspram karata na stolu i dugmadi. */
async function layoutCheck(page) {
  return page.evaluate(() => {
    const out = [];
    const r = el => el.getBoundingClientRect();
    const area = a => Math.max(0, a.width) * Math.max(0, a.height);
    const inter = (a, b) => {
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return w > 0 && h > 0 ? w * h : 0;
    };
    const vis = el => { const b = r(el); return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]'); };
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`sadržaj širi od ekrana (${document.documentElement.scrollWidth} > ${innerWidth})`);
    const plates = [...document.querySelectorAll('.seat .plate')].filter(vis);
    const things = [
      ...[...document.querySelectorAll('.trick .slot')].map(e => ['karta na stolu', e]),
      ...[...document.querySelectorAll('.layout .row img, .layout .ghost')].map(e => ['red u Lori', e]),
      ...[...document.querySelectorAll('#actions .pick-btn, #lastTrickBtn')].map(e => ['dugme', e]),
    ].filter(([, e]) => vis(e));
    for (const p of plates) {
      const pb = r(p);
      for (const [what, e] of things) {
        const eb = r(e);
        const i = inter(pb, eb);
        if (i > 0.15 * Math.min(area(pb), area(eb))) out.push(`pločica „${p.querySelector('.name')?.textContent}“ prekriva: ${what}`);
      }
    }
    // dugme poslednjeg štiha ne sme da pokriva moju pločicu ni karte u ruci
    const lb = document.querySelector('#lastTrickBtn');
    if (lb && vis(lb)) for (const c of document.querySelectorAll('#myHand .card')) if (inter(r(lb), r(c)) > 0.2 * area(r(c))) { out.push('dugme „Poslednji štih“ prekriva kartu u ruci'); break; }
    return out;
  });
}

async function signature(page) {
  return page.evaluate(() => [
    document.getElementById('dealNo')?.textContent,
    document.querySelectorAll('#myHand .card').length,
    document.querySelectorAll('.trick .slot').length,
    document.querySelectorAll('.layout .row img').length,
    document.querySelector('#dealEnd')?.open,
    document.querySelector('.plate.active .name')?.textContent,
  ].join('|'));
}

async function runViewport(browser, vp) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: !!vp.mobile, hasTouch: !!vp.mobile });
  const page = await ctx.newPage();
  page.on('pageerror', e => problem(vp.name, 'JS greška', e.message));
  page.on('console', m => { if (m.type() === 'error' && !/api\/|Failed to load resource/.test(m.text())) problem(vp.name, 'konzola', m.text()); });
  await page.goto(URL);
  await page.waitForTimeout(400);
  if (!(await page.locator('#startScreen:not([hidden])').count())) problem(vp.name, 'start', 'početni ekran se ne vidi pri prvoj poseti');
  await page.click('#goLocalBtn');
  // ?fast: bez pauza (AI odmah) — stranica se ponovo otvara sa ?fast posle osvežavanja
  await page.goto(URL + '?fast');

  const t0 = Date.now();
  let lastSig = '';
  let lastChange = Date.now();
  let reloads = 0;
  let actions = 0;
  let finished = false;
  let layoutChecks = 0;
  while (Date.now() - t0 < 6 * 60_000) {
    actions++;
    try {
      // prozor kraja partije
      if (await page.locator('#dealEnd[open]').count()) {
        if (chance(0.15) && await page.locator('#viewCardsBtn:not([hidden])').count()) {
          await page.click('#viewCardsBtn', { timeout: 1000 });
          if (!(await page.locator('#cardsDlg[open] .reveal-row').count())) problem(vp.name, 'pogledaj karte', 'prozor bez ruku');
          await page.click('#closeCardsBtn', { timeout: 1000 });
        }
        if (chance(0.08)) { await page.click('#dealSheetBtn', { timeout: 1000 }); await page.click('#closeSheetBtn', { timeout: 1000 }); }
        const txt = await page.textContent('#nextDealBtn');
        if (txt.includes('Nova igra')) { finished = true; break; }
        await page.click('#nextDealBtn', { timeout: 1000 });
        continue;
      }
      // nasumične opcije
      if (chance(0.01)) { await page.click('#sheetBtn', { timeout: 1000 }); await page.click('#closeSheetBtn', { timeout: 1000 }); }
      if (chance(0.008)) { await page.click('#menuBtn', { timeout: 1000 }); await page.click('#statsMenuBtn', { timeout: 1000 }); await page.click('#closeStatsBtn', { timeout: 1000 }); }
      if (chance(0.01)) { await page.click('#menuBtn', { timeout: 1000 }); await page.keyboard.press('Escape'); }
      if (chance(0.02) && await page.locator('#lastTrickBtn:visible').count()) await page.click('#lastTrickBtn', { timeout: 1000 });
      if (chance(0.004) && reloads < 3) {
        reloads++;
        const before = await page.textContent('#dealNo');
        await page.reload();
        await page.waitForTimeout(500);
        if (await page.locator('#startScreen:not([hidden])').count()) problem(vp.name, 'osvežavanje', 'posle F5 vraćen na početni ekran');
        const after = await page.textContent('#dealNo');
        if (before !== after) problem(vp.name, 'osvežavanje', `partija se promenila posle F5 (${before} → ${after})`);
      }
      // izbor igre / potez
      const pick = page.locator('.pick-btn');
      if (await pick.count()) {
        if (!(await page.locator('.pick-menu').count())) await pick.click({ timeout: 1000 });
        const items = page.locator('.pick-menu button');
        const n = await items.count();
        if (n) await items.nth(Math.floor(rnd() * n)).click({ timeout: 1000 });
      } else {
        const legal = page.locator('.hand.my-turn .card.legal');
        const n = await legal.count();
        if (n) await legal.nth(Math.floor(rnd() * n)).click({ timeout: 1000 });
      }
      // raspored: povremeno, kad je nešto na stolu
      if (actions % 15 === 0 && layoutChecks < 400) {
        layoutChecks++;
        for (const msg of await layoutCheck(page)) {
          if (problem(vp.name, 'raspored', msg)) await page.screenshot({ path: `${OUT}/${vp.name}-raspored-${layoutChecks}.png` });
        }
      }
    } catch (e) {
      if (!/Timeout|detached|not attached|intercepts pointer|outside of the viewport|not visible|not stable/.test(String(e))) problem(vp.name, 'izuzetak', String(e).split('\n')[0]);
    }
    const sig = await signature(page).catch(() => lastSig);
    if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
    else if (Date.now() - lastChange > 20_000) {
      problem(vp.name, 'zaglavljeno', `nema promene 20 s (${sig})`);
      await page.screenshot({ path: `${OUT}/${vp.name}-zaglavljeno.png` });
      break;
    }
    await page.waitForTimeout(15);
  }
  if (!finished) problem(vp.name, 'kraj', 'meč nije stigao do kraja');
  else {
    const title = await page.textContent('#dealEndTitle');
    console.log(`  ✔ [${vp.name}] ${title} — ${actions} radnji, ${reloads} osvežavanja, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    await page.screenshot({ path: `${OUT}/${vp.name}-kraj.png` });
  }
  await ctx.close();
}

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  console.log(`▶ ${vp.name}`);
  await runViewport(browser, vp);
}
await browser.close();
console.log(problems.length ? `\n✖ ${problems.length} problema:\n- ${problems.join('\n- ')}` : '\nOK — bez problema');
process.exit(problems.length ? 1 : 0);
