// End-to-end: pravi preferans server (nalozi) + lora server, privremene baze.
// Dva čoveka + dva AI odigraju ceo meč preko socket.io.
// Pokretanje: cd server && npm run build && node test/e2e.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { chooseAction } from '../../engine/dist/ai.js';

const PREF_DIR = process.env.PREF_SERVER_DIR ?? 'D:/preferans/server';
const AUTH_PORT = 3901;
const LORA_PORT = 3902;
const tmp = mkdtempSync(path.join(tmpdir(), 'lora-e2e-'));
const SECRET = 'e2e-secret';
const procs = [];
const failures = [];
const log = m => console.log(new Date().toISOString().slice(11, 19), m);
const check = (cond, msg) => { log('check: ' + msg); if (!cond) { failures.push(msg); console.error('✖', msg); } };

function start(name, cwd, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['dist/index.js'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    const onData = d => { out += d; if (/listening/i.test(out)) resolve(p); };
    p.stdout.on('data', onData);
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => reject(new Error(`${name} exited ${code}:\n${out}`)));
    setTimeout(() => reject(new Error(`${name} did not start:\n${out}`)), 15000);
  });
}

const api = async (p, body, token) => {
  const res = await fetch(`http://127.0.0.1:${LORA_PORT}${p}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

function client(token) {
  const s = io(`http://127.0.0.1:${LORA_PORT}`, { auth: { token }, transports: ['websocket'], reconnection: false });
  s.last = null;
  s.on('room:state', st => { s.last = st; });
  return s;
}
const emit = (s, ev, payload) => new Promise(r => s.emit(ev, payload, r));
// za događaje koji možda ne vraćaju odgovor (chat:send) — ne čekaj zauvek
const emitT = (s, ev, payload) => new Promise(r => s.timeout(1500).emit(ev, payload, (err, res) => r(err ? { timeout: true } : res)));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 20000, what = 'condition') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await wait(20); }
  throw new Error(`timeout: ${what}`);
};

try {
  await start('auth', PREF_DIR, { PORT: String(AUTH_PORT), JWT_SECRET: SECRET, DB_PATH: path.join(tmp, 'pref.db') });
  await start('lora', path.resolve('.'), {
    PORT: String(LORA_PORT), JWT_SECRET: SECRET, AUTH_URL: `http://127.0.0.1:${AUTH_PORT}`, DB_PATH: path.join(tmp, 'lora.db'),
    AI_DELAY_MS: '0', AFTER_TRICK_MS: '0', CHOOSE_DELAY_MS: '0', NEXT_DEAL_MS: '50', DISCONNECTED_GRACE_MS: '300', WAITING_GRACE_MS: '1500',
  });

  // --- nalozi preko proxy-ja
  const ra = await api('/api/register', { email: 'a@test.rs', password: 'tajna123', name: 'Ana' });
  const rb = await api('/api/register', { email: 'b@test.rs', password: 'tajna123', name: 'Boris' });
  check(ra.status === 201 && rb.status === 201, `registracija preko proxy-ja (${ra.status}, ${rb.status})`);
  const dup = await api('/api/register', { email: 'a@test.rs', password: 'x', name: 'X' });
  check(dup.status === 409 && /već registrovan/.test(dup.data.error), 'duplikat emaila → 409 na srpskom');
  const bad = await api('/api/login', { email: 'a@test.rs', password: 'pogresna' });
  check(bad.status === 401, 'pogrešna lozinka → 401');
  const me = await api('/api/me', null, ra.data.token);
  check(me.data.user?.name === 'Ana', '/api/me preko proxy-ja');

  // --- statika: samo dozvoljeni fajlovi
  for (const [p, want] of [['/', 200], ['/app.js', 200], ['/engine/dist/game.js', 200], ['/icon.svg', 200], ['/favicon.ico', 200], ['/icons/apple-touch-icon.png', 200], ['/manifest.json', 200], ['/robots.txt', 200], ['/sitemap.xml', 200], ['/79033a1f38f6216677370c7b7e06b7db.txt', 200], ['/icons/cards/QH.webp', 200], ['/icons/og-image.jpg', 200], ['/server/lora.db', 404], ['/server/.env', 404], ['/docs/BACKEND.md', 404], ['/engine/src/game.ts', 404]]) {
    const r = await fetch(`http://127.0.0.1:${LORA_PORT}${p}`);
    check(r.status === want, `statika ${p} → ${r.status} (očekivano ${want})`);
  }

  // --- pretraživači i pregled linka
  const home = await (await fetch(`http://127.0.0.1:${LORA_PORT}/`)).text();
  check(/og:image/.test(home) && /application\/ld\+json/.test(home) && /rel="canonical"/.test(home), 'početna ima Open Graph, JSON-LD i canonical');
  const roomPage = await (await fetch(`http://127.0.0.1:${LORA_PORT}/?room=ab12c`)).text();
  check(roomPage.includes('Poziv na Loru — soba AB12C') && roomPage.includes('noindex'), 'link sobe ima svoj pregled (i nije za pretragu)');
  const sm = await (await fetch(`http://127.0.0.1:${LORA_PORT}/sitemap.xml`)).text();
  check(/<loc>https:\/\/lora\.igrajmo\.online\/pravila\.html<\/loc>/.test(sm) && /<lastmod>/.test(sm), 'sitemap sa obe stranice');
  const js = await fetch(`http://127.0.0.1:${LORA_PORT}/app.js`, { headers: { 'Accept-Encoding': 'gzip' } });
  check(js.headers.get('content-encoding') === 'gzip', 'JS se šalje sažet (gzip)');
  const img = await fetch(`http://127.0.0.1:${LORA_PORT}/icons/cards/QH.webp`);
  check(/max-age=604800/.test(img.headers.get('cache-control') ?? ''), 'karte se pamte u pregledaču');

  // --- loš token odbijen
  const bogus = io(`http://127.0.0.1:${LORA_PORT}`, { auth: { token: 'xyz' }, transports: ['websocket'], reconnection: false });
  const err = await new Promise(r => bogus.on('connect_error', e => r(e.message)));
  check(/Invalid/.test(err), 'loš token → connect_error');
  bogus.close();

  // --- pokvareni zahtevi ne smeju da obore server
  {
    const F = client((await api('/api/register', { email: 'f@test.rs', password: 'tajna123', name: 'Fuzz' })).data.token);
    await new Promise(r => F.on('room:none', r));
    const events = ['room:list', 'room:create', 'room:join', 'room:quick', 'room:addAi', 'room:removeAi', 'room:start',
      'room:leave', 'room:leaveFinished', 'room:invite', 'game:action', 'game:ready', 'chat:send', 'presence:list', 'room:peek'];
    const junk = [undefined, null, 5, 'x', [], {}, { code: {} }, { code: 'ZZZZZ' }, { seat: 99 }, { seat: -1 }, { userId: 'a' },
      { type: 'play', cardId: {} }, { type: 'choose', contract: 'X' }, { type: 'pass' }, { text: 'a'.repeat(5000) }, { aiLevel: {} }];
    for (const ev of events) for (const j of junk) {
      F.emit(ev, j);                  // bez ack
      F.emit(ev, j, 'nije-funkcija'); // "ack" koji nije funkcija
      await emitT(F, ev, j);          // sa ack
    }
    // i usred sopstvene sobe
    await emit(F, 'room:create', {});
    for (const ev of events) for (const j of junk) await emitT(F, ev, j);
    const health = await api('/api/health');
    check(health.status === 200, 'server živ posle pokvarenih zahteva');
    check(F.connected, 'klijent i dalje povezan posle pokvarenih zahteva');
    await emit(F, 'room:leave');
    F.close();
  }

  // (registracija je ograničena na 5 po satu po IP adresi — zato se nalozi ponovo koriste)
  let tokW;
  // --- osvežavanje stranice u čekaonici ne gubi sobu; dugo odsustvo oslobađa mesto
  {
    const tok = tokW = (await api('/api/register', { email: 'w@test.rs', password: 'tajna123', name: 'Vera' })).data.token;
    let W = client(tok);
    await new Promise(r => W.on('room:none', r));
    const { code } = await emit(W, 'room:create', {});
    W.close();
    await wait(300);
    W = client(tok);
    await until(() => W.last?.code === code, 3000, 'posle osvežavanja ista soba');
    check(W.last.hostSeat === W.last.mySeat, 'domaćin ostaje domaćin posle osvežavanja');
    W.close();
    await wait(2200);
    W = client(tok);
    const none = await new Promise(r => { W.on('room:none', () => r(true)); W.on('room:state', () => r(false)); });
    check(none, 'posle dužeg odsustva mesto u čekaonici je oslobođeno');
    W.close();
  }

  // --- soba: Ana pravi, Boris ulazi, Ana dodaje AI i počinje
  const A = client(ra.data.token);
  const B = client(rb.data.token);
  await Promise.all([new Promise(r => A.on('room:none', r)), new Promise(r => B.on('room:none', r))]);
  const created = await emit(A, 'room:create', { aiLevel: 'medium' });
  check(typeof created.code === 'string', 'room:create vraća kod');
  const list = await emit(B, 'room:list');
  check(list.rooms.some(r => r.code === created.code), 'soba je u lobiju');
  const joined = await emit(B, 'room:join', { code: created.code.toLowerCase() });
  check(joined.code === created.code, 'room:join (kod ne zavisi od velikih slova)');
  const notHost = await emit(B, 'room:start');
  check(notHost.error, 'samo domaćin sme da počne');
  await emit(A, 'room:addAi', { seat: 2 });
  await emit(A, 'room:start');
  await until(() => A.last?.status === 'PLAYING' && B.last?.status === 'PLAYING', 5000, 'meč počeo');
  check(A.last.rated === true, 'dva čoveka → rangirano');
  check(A.last.seats.filter(s => s.kind === 'ai').length === 2, '2 AI mesta');
  const late = client(tokW);
  await new Promise(r => late.on('room:none', r));
  const lateJoin = await emit(late, 'room:join', { code: created.code });
  check(/počeo/.test(lateJoin.error ?? ''), 'ne može se ući u meč koji je počeo');
  late.close();

  // --- igra: oba čoveka igraju kao AI (preko servera), proveravamo tajnost karata
  const players = [A, B];
  let moves = 0;
  let reconnectDone = false;
  let otherHandLeak = false;
  let dealsSeen = new Set();
  while (true) {
    await wait(5);
    for (const s of players) {
      const st = s.last;
      if (!st?.view) continue;
      const v = st.view;
      // tajnost: niko ne sme da dobije tuđu ruku
      if (JSON.stringify(st).includes('"hands"')) otherHandLeak = true;
      dealsSeen.add(v.dealIndex);
      if (v.phase === 'DEAL_END' && !st.ready.includes(st.mySeat)) { s.last = { ...st, ready: [...st.ready, st.mySeat] }; s.emit('game:ready', null, () => {}); }
      if (v.turn === st.mySeat && ['CHOOSING', 'TRICKS', 'LAYOUT'].includes(v.phase) && !s.pending && st.version !== s.actedVersion) {
        const a = chooseAction(v, 'medium');
        s.pending = true;
        s.actedVersion = st.version;
        const payload = a.type === 'choose' ? { type: 'choose', contract: a.contract } : a.type === 'pass' ? { type: 'pass' } : { type: 'play', cardId: a.cardId };
        s.emit('game:action', payload, res => { s.pending = false; if (res.error) failures.push(`akcija odbijena: ${res.error}`); });
        moves++;
      }
    }
    // test reconnect-a na sredini: Boris padne i vrati se
    if (!reconnectDone && dealsSeen.size >= 5) {
      reconnectDone = true;
      const seatB = B.last.mySeat;
      B.close();
      await wait(1200); // duže od grace perioda → AI igra za njega
      const B2 = client(rb.data.token);
      await until(() => B2.last?.mySeat === seatB, 5000, 'reconnect vraća isto mesto');
      check(B2.last.seats[seatB].kind === 'human', 'posle reconnect-a mesto je i dalje ljudsko');
      players[1] = B2;
      Object.assign(B, { last: null });
    }
    if (players[0].last?.status === 'FINISHED') break;
  }
  check(!otherHandLeak, 'stanje nikad ne sadrži sve ruke');
  await until(() => players[0].last?.rating, 3000, 'rejting rezultat');
  const r = players[0].last.rating;
  check(r.rated && r.deltas.some(d => d !== 0), `rejting promenjen (${r.deltas.join(', ')})`);
  check(players[0].last.view.history.length === 28, '28 partija odigrano');
  const lb = await api('/api/leaderboard');
  check(lb.data.players.length === 2, 'rang lista ima 2 čoveka');
  const hist = await api('/api/matches', null, ra.data.token);
  check(hist.data.matches.length === 1, 'istorija meča za igrača');
  const st = await api('/api/stats', null, ra.data.token);
  check(st.status === 200 && st.data.stats.matches === 1 && st.data.streak.current === 1, `moja statistika posle meča (${st.status}, ${st.data.stats?.matches}, niz ${st.data.streak?.current})`);
  check(st.data.stats.bestMatch?.points === r.scores[players[0].last.mySeat] && Object.keys(st.data.stats.bestDeal).length === 7, 'najbolji meč i najbolja partija za svih 7 igara');
  check(Array.isArray(r.records) && r.records.every(x => x.length === 0), 'prvi meč nema "novi rekord"');
  check((await api('/api/stats')).status === 401, 'statistika bez prijave → 401');

  // --- napuštanje: novi meč, Boris napusti → AI preuzima, pa se vrati
  await emit(players[0], 'room:leaveFinished');
  await emit(players[1], 'room:leaveFinished');
  const r2 = await emit(players[0], 'room:create', {});
  await emit(players[1], 'room:join', { code: r2.code });
  await emit(players[0], 'room:start');
  await until(() => players[1].last?.status === 'PLAYING' && players[1].last.code === r2.code, 5000, 'drugi meč počeo');
  const seatB = players[1].last.mySeat;
  await emit(players[1], 'room:leave');
  await until(() => players[0].last?.seats[seatB].kind === 'ai' && players[0].last.seats[seatB].left, 3000, 'AI preuzeo napušteno mesto');
  const back = await emit(players[1], 'room:join', { code: r2.code });
  check(back.code === r2.code, 'igrač koji je napustio može da se vrati');
  await until(() => players[0].last?.seats[seatB].kind === 'human', 3000, 'mesto vraćeno čoveku');

  // --- svi ljudi bez veze → meč stoji (AI ne igra umesto odsutnih)
  {
    const snap = players[0].last.view;
    players.forEach(s => s.close());
    await wait(1500); // AI kašnjenja su 0 — da nije pauze, meč bi odmakao
    const A2 = client(ra.data.token);
    await until(() => A2.last?.view, 5000, 'povratak posle pauze');
    const v = A2.last.view;
    check(v.dealIndex === snap.dealIndex && v.trickNo === snap.trickNo && v.hand.length === snap.hand.length,
      `meč stoji dok niko nije povezan (${snap.dealIndex}/${snap.trickNo} → ${v.dealIndex}/${v.trickNo})`);
    players[0] = A2;
    const B3 = client(rb.data.token);
    await until(() => B3.last?.view, 5000, 'Boris se vratio');
    players[1] = B3;
  }

  // --- restart servera usred meča (deploy): soba i mesto moraju preživeti
  const before = players[0].last;
  players.forEach(s => s.close());
  const lora = procs.pop();
  // Linux/pm2: SIGTERM → flush baze. Windows ubija proces odmah, pa sačekaj debounce upisa (2 s).
  await wait(2500);
  lora.kill('SIGTERM');
  await new Promise(r => lora.once('exit', r));
  await start('lora', path.resolve('.'), {
    PORT: String(LORA_PORT), JWT_SECRET: SECRET, AUTH_URL: `http://127.0.0.1:${AUTH_PORT}`, DB_PATH: path.join(tmp, 'lora.db'),
    AI_DELAY_MS: '100000', CHOOSE_DELAY_MS: '100000', NEXT_DEAL_MS: '100000', DISCONNECTED_GRACE_MS: '100000',
  });
  const A3 = client(ra.data.token);
  await until(() => A3.last?.code === r2.code, 8000, 'soba vraćena posle restarta');
  check(A3.last.mySeat === before.mySeat, 'isto mesto posle restarta');
  check(A3.last.view.dealIndex === before.view.dealIndex, 'ista partija posle restarta');
  A3.close();

  console.log(`\n${moves} poteza ljudi, ${dealsSeen.size} partija viđeno`);
} catch (e) {
  failures.push(String(e?.stack ?? e));
} finally {
  procs.forEach(p => p.kill());
  await wait(300);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (failures.length) {
  console.error(`\nNEUSPEŠNO (${failures.length}):\n` + failures.join('\n'));
  process.exit(1);
}
console.log('OK — e2e test servera prošao');
