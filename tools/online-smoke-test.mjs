// Online UI test: preferans (nalozi) + lora server, dva browsera (Ana i Boris).
// Ana se registruje, pravi sobu; Boris ulazi linkom; Ana dodaje AI i pokreće;
// oba igraju klikovima dok se ne odigra ceo meč. Proverava i JS greške.
// Pokretanje: npm run test:online   (potreban build engine-a i servera)

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const PREF_DIR = process.env.PREF_SERVER_DIR ?? 'D:/preferans/server';
const AUTH_PORT = 3911;
const PORT = 3912;
const tmp = mkdtempSync(path.join(tmpdir(), 'lora-ui-'));
const procs = [];
const errors = [];

function start(name, cwd, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['dist/index.js'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    p.stdout.on('data', d => { out += d; if (/listening/i.test(out)) resolve(p); });
    p.stderr.on('data', d => { out += d; if (/FATAL|Error/.test(String(d))) errors.push(`${name}: ${d}`); });
    setTimeout(() => reject(new Error(`${name} did not start:\n${out}`)), 40000);
  });
}

async function register(page, email, name) {
  await page.click('#goOnlineBtn');
  await page.click('#loginToggle');
  await page.fill('#loginName', name);
  await page.fill('#loginEmail', email);
  await page.fill('#loginPassword', 'tajna123');
  await page.click('#loginSubmit');
}

/** Jedan "korak" igrača: bira igru, igra legalnu kartu, klikće Dalje. */
async function act(page) {
  try {
    return await actOnce(page);
  } catch (e) {
    if (/Timeout|detached|not attached/.test(String(e))) return 'wait'; // stanje se promenilo između provere i klika
    throw e;
  }
}

async function actOnce(page) {
  const quick = { timeout: 1500 };
  if (await page.locator('#dealEnd[open]').count()) {
    const btn = page.locator('#nextDealBtn');
    if (await btn.isEnabled()) {
      const txt = await btn.textContent();
      if (txt.includes('lobi')) {
        // kraj meča: poseban prikaz (postolje, rejting) — mora da postoji
        if (!(await page.locator('#dealEnd.final .final-list li').count())) throw new Error('kraj meča bez posebnog prikaza');
        await page.waitForTimeout(800);
        await page.screenshot({ path: `tools/screenshot-online-final-${page.viewportSize().width}.png` });
      }
      await btn.click(quick);
      return txt.includes('lobi') ? 'done' : 'next';
    }
    return 'wait';
  }
  const pick = page.locator('.pick-btn');
  if (await pick.count()) {
    if (!(await page.locator('.pick-menu').count())) await pick.click(quick);
    await page.locator('.pick-menu button').first().click(quick);
    return 'choose';
  }
  const legal = page.locator('#myHand .card.legal');
  if (await legal.count()) { await legal.first().click(quick); return 'play'; }
  return 'wait';
}

let browser;
try {
  await start('auth', PREF_DIR, { PORT: String(AUTH_PORT), JWT_SECRET: 'ui-secret', DB_PATH: path.join(tmp, 'pref.db') });
  await start('lora', path.resolve('server'), {
    PORT: String(PORT), JWT_SECRET: 'ui-secret', AUTH_URL: `http://127.0.0.1:${AUTH_PORT}`, DB_PATH: path.join(tmp, 'lora.db'),
    AI_DELAY_MS: '0', AFTER_TRICK_MS: '0', CHOOSE_DELAY_MS: '0', NEXT_DEAL_MS: '300',
  });

  browser = await chromium.launch();
  const mk = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`[${w}] ${e}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`[${w}] console: ${m.text()}`); });
    return page;
  };
  const ana = await mk(1920, 880);
  const boris = await mk(390, 844);

  await ana.goto(`http://127.0.0.1:${PORT}/?fast`);
  await register(ana, 'ana@test.rs', 'Ana');
  await ana.waitForSelector('#lobbyScreen:not([hidden])');
  await ana.click('#createBtn');
  await ana.waitForSelector('#waitingScreen:not([hidden])');
  const code = (await ana.textContent('#roomCode')).trim();

  // Boris dolazi preko linka sobe
  await boris.goto(`http://127.0.0.1:${PORT}/?fast&room=${code}`);
  await boris.click('#loginToggle');
  await boris.fill('#loginName', 'Boris');
  await boris.fill('#loginEmail', 'boris@test.rs');
  await boris.fill('#loginPassword', 'tajna123');
  await boris.click('#loginSubmit');
  await boris.waitForSelector('#waitingScreen:not([hidden])');
  await ana.waitForFunction(() => document.querySelectorAll('#waitSeats .wait-seat.filled').length === 2);
  await ana.screenshot({ path: 'tools/screenshot-online-waiting.png' });

  await ana.click('#startBtn');
  await ana.waitForSelector('#myHand .card');
  await boris.waitForSelector('#myHand .card');

  // chat
  await boris.click('#chatBtn');
  await boris.fill('#chatInput', 'Srećno svima!');
  await boris.click('#chatForm button');
  await ana.waitForFunction(() => document.getElementById('chatLog').textContent.includes('Srećno svima!'));
  const chatBox = await boris.locator('#chatPanel').boundingBox();
  const handBox = await boris.locator('#myHand').boundingBox();
  if (chatBox.y + chatBox.height > handBox.y) errors.push('chat na telefonu prekriva karte');
  await boris.screenshot({ path: 'tools/screenshot-online-chat-390.png' });
  await boris.click('#chatClose');

  let shot = false;
  const t0 = Date.now();
  const done = new Set();
  while (done.size < 2 && Date.now() - t0 < 480_000) {
    for (const [name, page] of [['ana', ana], ['boris', boris]]) {
      if (done.has(name)) continue;
      const r = await act(page);
      if (r === 'done') done.add(name);
      if (!shot && r === 'play') {
        await ana.screenshot({ path: 'tools/screenshot-online-table.png' });
        shot = true;
      }
      if (r === 'wait') await page.waitForTimeout(30);
    }
  }
  if (done.size < 2) errors.push('meč nije završen u roku');
  await ana.waitForSelector('#lobbyScreen:not([hidden])');
  const board = await ana.textContent('#leaderboard');
  if (!/Ana|Boris/.test(board)) errors.push('rang lista ne prikazuje igrače posle meča');
  await ana.screenshot({ path: 'tools/screenshot-online-lobby.png' });
  console.log(`meč završen za ${Math.round((Date.now() - t0) / 1000)} s`);
} catch (e) {
  errors.push(String(e?.stack ?? e));
} finally {
  await browser?.close();
  procs.forEach(p => p.kill());
}

if (errors.length) {
  console.error('GREŠKE:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
}
console.log('OK — online UI test prošao');
