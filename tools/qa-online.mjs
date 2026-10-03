// QA: online Lora kroz prave pregledače, sa pravim serverima (preferans za naloge
// + lora), privremene baze. Scenariji:
//  S1  4 čoveka: chat, pad veze jednog igrača, osvežavanje stranice drugog
//  S2  2 čoveka + 2 AI: jedan napusti meč pa se vrati istim kodom
//  S3  1 čovek + 3 AI (brza igra): restart servera usred meča
//  S4  pozivi i brza igra: 3 čoveka u istu sobu, pa svi napuste meč (soba ne sme da ostane zauvek)
// Hvata: JS greške u pregledaču, greške servera, zaglavljivanje, različite rezultate kod igrača.
// Pokretanje: node tools/qa-online.mjs [S1,S2,...]

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const PREF_DIR = process.env.PREF_SERVER_DIR ?? 'D:/preferans/server';
const LORA_DIR = path.resolve('server');
const OUT = process.env.QA_OUT ?? 'tools/qa-out';
mkdirSync(OUT, { recursive: true });
const ONLY = (process.argv[2] ?? 'S1,S2,S3,S4').split(',');
const tmp = mkdtempSync(path.join(tmpdir(), 'lora-qa-'));
const AUTH_PORT = 3951, PORT = 3952;
const URL = `http://127.0.0.1:${PORT}/`;
const ENV = { JWT_SECRET: 'qa', AI_DELAY_MS: '30', AFTER_TRICK_MS: '30', CHOOSE_DELAY_MS: '30', NEXT_DEAL_MS: '400', DISCONNECTED_GRACE_MS: '2500', WAITING_GRACE_MS: '5000' };

const problems = [];
const problem = (sc, msg) => { problems.push(`[${sc}] ${msg}`); console.log(`  ✖ [${sc}] ${msg}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));

let serverErr = '';
function startServer(name, cwd, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['dist/index.js'], { cwd, env: { ...process.env, ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; if (/listening/i.test(out)) resolve(p); });
    p.stderr.on('data', d => { serverErr += `[${name}] ${d}`; });
    p.on('exit', code => { if (code && code !== 0 && !p.killedByUs) serverErr += `[${name}] izašao sa kodom ${code}\n`; });
    setTimeout(() => reject(new Error(`${name} nije startovao:\n${out}`)), 15000);
  });
}
const loraEnv = { PORT: String(PORT), AUTH_URL: `http://127.0.0.1:${AUTH_PORT}`, DB_PATH: path.join(tmp, 'lora.db') };
let pref, lora;
async function startLora() { lora = await startServer('lora', LORA_DIR, loraEnv); }
async function stopLora() { lora.killedByUs = true; lora.kill(); await wait(800); }

let ipN = 1;
async function register(name) {
  const res = await fetch(URL + 'api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.0.${ipN++}` }, // svaki "sa svoje adrese" (limit registracija po IP-u)
    body: JSON.stringify({ email: `${name.toLowerCase()}@qa.rs`, password: 'tajna123', name }),
  });
  const d = await res.json();
  if (!d.token) throw new Error(`registracija ${name}: ${JSON.stringify(d)}`);
  return d.token;
}

let browser;
async function player(sc, name, token, vp = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  await ctx.addInitScript(t => { localStorage.setItem('lora_token', t); localStorage.setItem('lora.mode', 'online'); }, token);
  const page = await ctx.newPage();
  page.on('pageerror', e => problem(sc, `${name}: JS greška: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|WebSocket/.test(m.text())) problem(sc, `${name}: konzola: ${m.text()}`); });
  await page.goto(URL + '?fast');
  await page.waitForSelector('#lobbyScreen:not([hidden])', { timeout: 10000 });
  return { name, ctx, page, done: false, finalTotals: null };
}

/** Jedan korak igranja. Vraća 'done' kad je meč gotov i igrač kliknuo "Nazad u lobi". */
async function act(p) {
  const page = p.page;
  try {
    if (await page.locator('#dealEnd[open]').count()) {
      const btn = page.locator('#nextDealBtn');
      if (!(await btn.isEnabled())) return 'wait';
      const txt = await btn.textContent();
      if (txt.includes('lobi')) {
        p.finalTotals = (await page.$$eval('#dealEndBody tr', rows => rows.map(r => Number(r.children[2].textContent)))).sort((a, b) => a - b).join(',');
        await btn.click({ timeout: 1500 });
        return 'done';
      }
      await btn.click({ timeout: 1500 });
      return 'next';
    }
    const pick = page.locator('.pick-btn');
    if (await pick.count()) {
      if (!(await page.locator('.pick-menu').count())) await pick.click({ timeout: 1500 });
      const items = page.locator('.pick-menu button');
      const n = await items.count();
      if (n) await items.nth(Math.floor(Math.random() * n)).click({ timeout: 1500 });
      return 'choose';
    }
    const legal = page.locator('#myHand.my-turn .card.legal');
    const n = await legal.count();
    if (n) { await legal.nth(Math.floor(Math.random() * n)).click({ timeout: 1500 }); return 'play'; }
  } catch (e) {
    if (!/Timeout|detached|not attached|intercepts pointer|not stable|not visible|Target closed|context was destroyed|navigation/.test(String(e))) throw e;
  }
  return 'wait';
}

const dealNo = async p => Number(((await p.page.textContent('#dealNo').catch(() => '0')) ?? '0').split('/')[0]) || 0;
const sig = async p => p.page.evaluate(() => [document.getElementById('dealNo')?.textContent, document.querySelectorAll('#myHand .card').length,
  document.querySelectorAll('.trick .slot').length, document.querySelectorAll('.layout .row img').length, document.querySelector('#dealEnd')?.open].join('|')).catch(() => 'x');

/** Igraju svi dok svi ne završe; hooks(deal) se poziva kad prvi igrač stigne do nove partije. */
async function playAll(sc, players, hooks = {}, limitMs = 8 * 60_000, partial = false) {
  const t0 = Date.now();
  let lastDeal = 0;
  let lastSig = '';
  let lastChange = Date.now();
  while (players.some(p => !p.done) && Date.now() - t0 < limitMs) {
    for (const p of players) {
      if (p.done || p.away) continue;
      if ((await act(p)) === 'done') p.done = true;
    }
    const d = await dealNo(players.find(p => !p.done && !p.away) ?? players[0]);
    if (d > lastDeal) { lastDeal = d; if (hooks[d]) await hooks[d](); }
    const s = (await Promise.all(players.filter(p => !p.away).map(sig))).join('#');
    if (s !== lastSig) { lastSig = s; lastChange = Date.now(); }
    else if (Date.now() - lastChange > 30_000) {
      problem(sc, `zaglavljeno 30 s u partiji ${lastDeal}`);
      for (const p of players) await p.page.screenshot({ path: `${OUT}/${sc}-${p.name}-zaglavljeno.png` }).catch(() => {});
      return false;
    }
    await wait(20);
  }
  const ok = players.every(p => p.done);
  if (partial) return true; // namerno samo deo meča
  if (!ok) problem(sc, `nisu svi završili meč (${players.filter(p => !p.done).map(p => p.name).join(', ')})`);
  const totals = new Set(players.map(p => p.finalTotals).filter(Boolean));
  if (totals.size > 1) problem(sc, `igrači vide različite konačne rezultate: ${[...totals].join(' / ')}`);
  console.log(`  ${ok ? '✔' : '…'} [${sc}] meč za ${((Date.now() - t0) / 1000).toFixed(0)} s, rezultati ${[...totals].join(' / ')}`);
  return ok;
}

async function createRoom(p) {
  await p.page.click('#createBtn');
  await p.page.waitForSelector('#waitingScreen:not([hidden])');
  return (await p.page.textContent('#roomCode')).trim();
}
async function joinRoom(p, code) {
  await p.page.fill('#joinCode', code);
  await p.page.press('#joinCode', 'Enter');
}
async function sendChat(p, text) {
  await p.page.click('#chatBtn');
  await p.page.fill('#chatInput', text);
  await p.page.press('#chatInput', 'Enter');
  await p.page.click('#chatClose');
}
const health = async () => (await (await fetch(URL + 'api/health')).json()).rooms;

// ------------------------------------------------------------------ scenariji

async function S1(t) {
  const ps = [];
  for (const n of ['Ana', 'Boris', 'Ceca', 'Dule']) ps.push(await player('S1', n, t[n], n === 'Dule' ? { width: 390, height: 800 } : undefined));
  const code = await createRoom(ps[0]);
  for (const p of ps.slice(1)) await joinRoom(p, code);
  await ps[0].page.waitForSelector('#myHand .card', { timeout: 10000 }); // 4 čoveka → meč počinje sam
  let chatSeen = false;
  await playAll('S1', ps, {
    3: async () => {
      await sendChat(ps[1], 'Zdravo svima!');
      await wait(500);
      chatSeen = (await ps[0].page.textContent('#chatLog')).includes('Zdravo svima!');
    },
    6: async () => { // Ceca gubi vezu 8 s (AI igra umesto nje posle 2,5 s), pa se vraća
      ps[2].away = true;
      await ps[2].ctx.setOffline(true);
      await wait(8000);
      await ps[2].ctx.setOffline(false);
      ps[2].away = false;
    },
    10: async () => { await ps[3].page.reload(); await ps[3].page.waitForSelector('#myHand .card', { timeout: 10000 }).catch(() => problem('S1', 'Dule posle F5 nije vraćen za sto')); },
  });
  if (!chatSeen) problem('S1', 'poruka u chatu nije stigla drugom igraču');
  for (const p of ps) await p.ctx.close();
}

async function S2(t) {
  const [a, b] = [await player('S2', 'Ana', t.Ana), await player('S2', 'Boris', t.Boris)];
  const code = await createRoom(a);
  await joinRoom(b, code);
  await a.page.waitForFunction(() => document.querySelectorAll('#waitSeats .wait-seat.filled').length === 2);
  await a.page.click('#startBtn');
  let noticeSeen = false;
  await playAll('S2', [a, b], {
    4: async () => { // Boris napušta meč (prozor potvrde u stilu igre)
      b.away = true;
      await b.page.click('#menuBtn');
      await b.page.click('#leaveMatchBtn');
      await b.page.click('#askOk');
      await b.page.waitForSelector('#lobbyScreen:not([hidden])', { timeout: 5000 }).catch(() => problem('S2', 'Boris posle napuštanja nije u lobiju'));
      await wait(600);
      noticeSeen = (await a.page.textContent('#notices')).includes('napustio') || (await a.page.textContent('#chatLog')).includes('napustio');
    },
    9: async () => { // Boris se vraća istim kodom
      await joinRoom(b, code);
      await b.page.waitForSelector('#myHand .card', { timeout: 8000 }).catch(() => problem('S2', 'Boris se nije vratio za sto istim kodom'));
      const names = await a.page.$$eval('.seat .name', els => els.map(e => e.textContent));
      if (names.some(n => n.startsWith('Boris') && n.includes('(AI)'))) problem('S2', `posle povratka Boris je i dalje AI (${names})`);
      b.away = false;
    },
  });
  if (!noticeSeen) problem('S2', 'Ana nije dobila obaveštenje da je Boris napustio meč');
  for (const p of [a, b]) await p.ctx.close();
}

async function S3(t) {
  const a = await player('S3', 'Ana', t.Ana, { width: 412, height: 800 });
  await a.page.click('#quickBtn');
  await a.page.waitForSelector('#startBtn:not([hidden])');
  await a.page.click('#startBtn');
  await playAll('S3', [a], {
    5: async () => { // restart servera usred meča: soba se vraća iz baze, pregledač se sam ponovo poveže
      await stopLora();
      await startLora();
      await a.page.waitForSelector('#myHand .card', { timeout: 15000 }).catch(() => problem('S3', 'posle restarta servera igrač nije vraćen za sto'));
    },
  });
  await a.ctx.close();
}

async function S4(t) {
  const a = await player('S4', 'Ana', t.Ana), b = await player('S4', 'Boris', t.Boris), c = await player('S4', 'Ceca', t.Ceca);
  await a.page.click('#quickBtn');
  await a.page.waitForSelector('#inviteBtn');
  await a.page.click('#inviteBtn');
  await a.page.waitForSelector(`#inviteList [data-invite]`, { timeout: 5000 }).catch(() => problem('S4', 'u spisku za poziv nema igrača iz lobija'));
  await a.page.locator('#inviteList li', { hasText: 'Boris' }).locator('[data-invite]').click().catch(() => problem('S4', 'Boris nije u spisku za poziv'));
  await b.page.waitForSelector('#inviteDialog[open]', { timeout: 5000 }).then(() => b.page.click('#inviteAccept')).catch(() => problem('S4', 'Boris nije dobio poziv'));
  await c.page.click('#quickBtn'); // brza igra: ulazi u otvorenu sobu
  await a.page.waitForFunction(() => document.querySelectorAll('#waitSeats .wait-seat.filled').length === 3, null, { timeout: 8000 })
    .catch(() => problem('S4', 'poziv + brza igra: u sobi nisu 3 čoveka'));
  await a.page.click('#startBtn');
  await playAll('S4', [a, b, c], {}, 25_000, true); // samo početak meča
  const before = await health();
  for (const p of [a, b, c]) {
    if (await p.page.locator('#dealEnd[open]').count()) continue;
    await p.page.click('#menuBtn').catch(() => {});
    await p.page.click('#leaveMatchBtn').catch(() => {});
    await p.page.click('#askOk').catch(() => {});
  }
  await wait(1000);
  console.log(`  [S4] sobe pre/posle napuštanja svih ljudi: ${before} → ${await health()} (meč bez ijednog čoveka čisti se automatski posle vremena — vidi removeAbandonedRooms)`);
  for (const p of [a, b, c]) await p.ctx.close();
}

// ------------------------------------------------------------------ pokretanje

try {
  pref = await startServer('pref', PREF_DIR, { PORT: String(AUTH_PORT), DB_PATH: path.join(tmp, 'pref.db') });
  await startLora();
  const t = {};
  for (const n of ['Ana', 'Boris', 'Ceca', 'Dule']) t[n] = await register(n);
  browser = await chromium.launch();
  for (const [name, fn] of Object.entries({ S1, S2, S3, S4 })) {
    if (!ONLY.includes(name)) continue;
    console.log(`▶ ${name}`);
    try { await fn(t); } catch (e) { problem(name, `izuzetak: ${String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')}`); }
  }
} catch (e) {
  problems.push(String(e?.stack ?? e));
} finally {
  await browser?.close();
  if (lora) { lora.killedByUs = true; lora.kill(); }
  if (pref) { pref.killedByUs = true; pref.kill(); }
}
if (serverErr.trim()) problems.push('greške servera:\n' + serverErr.trim().split('\n').slice(-30).join('\n'));
console.log(problems.length ? `\n✖ ${problems.length} problema:\n- ${problems.join('\n- ')}` : '\nOK — bez problema');
process.exit(problems.length ? 1 : 0);
