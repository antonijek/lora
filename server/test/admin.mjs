// Admin panel: prava pristupa, statistika, igrači, udaljavanje, zatvaranje sobe, ban.
// Pravi preferans server (nalozi) + lora server, privremene baze.
// Pokretanje: cd server && npm run build && node test/admin.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { io } from 'socket.io-client';

const PREF_DIR = process.env.PREF_SERVER_DIR ?? 'D:/preferans/server';
const AUTH_PORT = 3911;
const LORA_PORT = 3912;
const tmp = mkdtempSync(path.join(tmpdir(), 'lora-admin-'));
const PREF_DB = path.join(tmp, 'pref.db');
const SECRET = 'admin-secret';
const procs = [];
const failures = [];
const log = m => console.log(new Date().toISOString().slice(11, 19), m);
const check = (cond, msg) => { log('check: ' + msg); if (!cond) { failures.push(msg); console.error('✖', msg); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

function start(name, cwd, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['dist/index.js'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    p.stdout.on('data', d => { out += d; if (/listening/i.test(out)) resolve(p); });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => reject(new Error(`${name} exited ${code}:\n${out}`)));
    setTimeout(() => reject(new Error(`${name} did not start:\n${out}`)), 15000);
  });
}
const startAuth = () => start('auth', PREF_DIR, { PORT: String(AUTH_PORT), JWT_SECRET: SECRET, DB_PATH: PREF_DB });

const api = async (p, body, token, method) => {
  const res = await fetch(`http://127.0.0.1:${LORA_PORT}${p}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const emit = (s, ev, payload) => new Promise(r => s.emit(ev, payload, r));
const until = async (fn, ms = 5000, what = 'condition') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await wait(30); }
  throw new Error(`timeout: ${what}`);
};

try {
  // --- nalozi: Admin (dobija is_admin direktno u preferans bazi) i Ana
  let auth = await startAuth();
  await start('lora', path.resolve('.'), {
    PORT: String(LORA_PORT), JWT_SECRET: SECRET, AUTH_URL: `http://127.0.0.1:${AUTH_PORT}`, DB_PATH: path.join(tmp, 'lora.db'),
    AI_DELAY_MS: '50', CHOOSE_DELAY_MS: '50', AFTER_TRICK_MS: '50',
  });
  const ra = await api('/api/register', { email: 'admin@test.rs', password: 'tajna123', name: 'Admin' });
  const rb = await api('/api/register', { email: 'ana@test.rs', password: 'tajna123', name: 'Ana' });
  check(ra.status === 201 && rb.status === 201, 'registracija');
  await wait(2600); // preferans upisuje bazu posle 2 s (debounce)
  auth.kill();
  await wait(300);
  const SQL = await initSqlJs();
  const pdb = new SQL.Database(readFileSync(PREF_DB));
  pdb.run("UPDATE users SET is_admin = 1 WHERE email = 'admin@test.rs'");
  writeFileSync(PREF_DB, Buffer.from(pdb.export()));
  auth = await startAuth();
  const adminTok = ra.data.token;
  const anaTok = rb.data.token;

  // --- prava pristupa
  check((await api('/api/admin/stats')).status === 401, 'bez tokena → 401');
  check((await api('/api/admin/stats', null, anaTok)).status === 403, 'običan igrač → 403');
  const st0 = await api('/api/admin/stats', null, adminTok);
  check(st0.status === 200 && st0.data.daily?.length === 30, 'admin dobija statistiku sa 30 dana');

  // --- posetioci i aktivnost
  await api('/api/visit', { v: 'posetilac01' });
  await api('/api/visit', { v: 'posetilac01' }); // isti dan, isti posetilac → jednom
  await api('/api/visit', { v: 'posetilac02' });
  await api('/api/visit', { v: 'LOŠ id!' });
  // posetilac01 igra protiv računara (2 meča počeo, 1 završio), klikne "Napravi nalog" i uđe online kao Ana
  await api('/api/event', { v: 'posetilac01', kind: 'local_start' });
  await api('/api/event', { v: 'posetilac01', kind: 'local_start' });
  await api('/api/event', { v: 'posetilac01', kind: 'local_finish' });
  await api('/api/event', { v: 'posetilac01', kind: 'signup_click' });
  await api('/api/event', { v: 'posetilac02', kind: 'hakovanje' }); // nepoznata vrsta se ne upisuje
  const ana = io(`http://127.0.0.1:${LORA_PORT}`, { auth: { token: anaTok, vid: 'posetilac01' }, transports: ['websocket'], reconnection: false });
  ana.last = null;
  ana.errors = [];
  ana.on('room:state', s => { ana.last = s; });
  ana.on('game:error', m => ana.errors.push(m));
  await until(() => ana.connected, 5000, 'Ana povezana');
  const st1 = (await api('/api/admin/stats', null, adminTok)).data;
  check(st1.visitorsToday === 2, `posetioci danas = 2 (${st1.visitorsToday})`);
  check(st1.activeToday === 1 && st1.onlineNow === 1 && st1.totalPlayers === 1, `aktivni/online/ukupno = 1 (${st1.activeToday}/${st1.onlineNow}/${st1.totalPlayers})`);
  check(st1.daily.at(-1).visitors === 2 && st1.daily.at(-1).active === 1, 'današnji dan u grafikonu');
  check(st1.localStartedToday === 2 && st1.localFinished7 === 1 && st1.daily.at(-1).localMatches === 2, `mečevi protiv računara (${st1.localStartedToday}, ${st1.localFinished7})`);
  const f = st1.funnel;
  check(f.visitors === 2 && f.playedLocal === 1 && f.finishedLocal === 1 && f.signupClicks === 1 && f.newOnline === 1 && f.fromLocal === 1,
    `put do naloga ${JSON.stringify(f)}`);

  const pl = (await api('/api/admin/players', null, adminTok)).data.players;
  check(pl.length === 1 && pl[0].name === 'Ana' && pl[0].email === 'ana@test.rs' && pl[0].online && !pl[0].banned, 'spisak igrača sa emailom iz preferansa');
  const rr = await api(`/api/admin/players/${pl[0].user_id}/rating`, { rating: 1234 }, adminTok);
  const pl2 = (await api('/api/admin/players', null, adminTok)).data.players;
  check(rr.status === 200 && pl2[0].rating === 1234, 'promena rejtinga');
  check((await api(`/api/admin/players/${pl[0].user_id}/rating`, { rating: -5 }, adminTok)).status === 400, 'loš rejting → 400');
  const rc = await api('/api/admin/recompute-ratings', {}, adminTok);
  const pl3 = (await api('/api/admin/players', null, adminTok)).data.players;
  check(rc.status === 200 && rc.data.matches === 0 && pl3[0].rating === 1000, 'preračunavanje rejtinga (bez rangiranih mečeva → 1000)');
  check((await api('/api/admin/recompute-ratings', {}, anaTok)).status === 403, 'preračunavanje samo za admina');

  // --- sobe: Ana pravi sobu i počinje meč sa 3 AI, admin je udaljava
  const { code } = await emit(ana, 'room:create', {});
  await emit(ana, 'room:start');
  await until(() => ana.last?.status === 'PLAYING', 5000, 'meč počeo');
  const rooms = (await api('/api/admin/rooms', null, adminTok)).data.rooms;
  check(rooms.length === 1 && rooms[0].code === code && rooms[0].status === 'PLAYING' && rooms[0].seats.filter(s => s.kind === 'ai').length === 3, 'admin vidi sobu uživo');
  const anaSeat = rooms[0].seats.findIndex(s => s.kind === 'human');
  check((await api(`/api/admin/rooms/${code}/kick`, { seat: (anaSeat + 1) % 4 }, adminTok)).status === 400, 'udaljavanje AI mesta → 400');
  let gotNone = false;
  ana.once('room:none', () => { gotNone = true; });
  const kick = await api(`/api/admin/rooms/${code}/kick`, { seat: anaSeat }, adminTok);
  check(kick.status === 200, 'udaljavanje igrača');
  await until(() => gotNone, 3000, 'Ana dobila room:none');
  check(ana.errors.some(m => /udaljio/.test(m)), 'Ana dobila poruku o udaljavanju');
  const afterKick = (await api('/api/admin/rooms', null, adminTok)).data.rooms[0];
  check(afterKick.seats[anaSeat].kind === 'ai' && afterKick.seats[anaSeat].formerUserId === pl[0].user_id, 'AI preuzeo Anino mesto');
  const back = await emit(ana, 'room:join', { code });
  check(back.code === code, 'Ana se vratila istim kodom');

  // --- pozivi: igraču u meču se ne može poslati poziv
  const adm = io(`http://127.0.0.1:${LORA_PORT}`, { auth: { token: adminTok }, transports: ['websocket'], reconnection: false });
  await until(() => adm.connected, 5000, 'admin povezan');
  await emit(adm, 'room:create', {});
  const pres = await emit(adm, 'presence:list');
  check(pres.users.some(u => u.name === 'Ana' && u.busy === true), 'Ana u meču je označena kao zauzeta');
  let invited = false;
  ana.once('room:invited', () => { invited = true; });
  const inv = await emit(adm, 'room:invite', { userId: pl[0].user_id });
  await wait(200);
  check(inv.busy === true && inv.error && !invited, 'poziv igraču u meču se odbija i ne stiže');
  await emit(adm, 'room:leave');
  adm.close();

  // --- zatvaranje sobe
  gotNone = false;
  ana.once('room:none', () => { gotNone = true; });
  check((await api(`/api/admin/rooms/${code}/close`, {}, adminTok)).status === 200, 'zatvaranje sobe');
  await until(() => gotNone, 3000, 'Ana izbačena iz zatvorene sobe');
  check((await api('/api/admin/rooms', null, adminTok)).data.rooms.length === 0, 'soba je nestala');
  check((await api('/api/admin/rooms/NEMA1/close', {}, adminTok)).status === 404, 'nepostojeća soba → 404');

  // --- ban preko preferansa: veza se prekida, nova konekcija odbijena
  await emit(ana, 'room:create', {});
  const banR = await api(`/api/admin/players/${pl[0].user_id}/ban`, { banned: true }, adminTok);
  check(banR.status === 200, `ban (${banR.status} ${JSON.stringify(banR.data)})`);
  await until(() => !ana.connected, 3000, 'Ani prekinuta veza');
  const again = io(`http://127.0.0.1:${LORA_PORT}`, { auth: { token: anaTok }, transports: ['websocket'], reconnection: false });
  const refused = await new Promise(r => { again.on('connect', () => r(false)); again.on('connect_error', () => r(true)); });
  again.close();
  check(refused, 'banovana Ana ne može da se poveže');
  check((await api('/api/admin/players', null, adminTok)).data.players.find(p => p.user_id === pl[0].user_id).banned === true, 'spisak pokazuje ban');
  check((await api(`/api/admin/players/${pl[0].user_id}/ban`, { banned: false }, adminTok)).status === 200, 'skidanje bana');
  const adminId = (await api('/api/me', null, adminTok)).data.user.id;
  check((await api(`/api/admin/players/${adminId}/ban`, { banned: true }, adminTok)).status === 400, 'admin ne može da banuje sebe');

  const m = await api('/api/admin/matches', null, adminTok);
  check(m.status === 200 && Array.isArray(m.data.matches), 'spisak mečeva');
  check((await api('/api/admin/matches/999', null, adminTok)).status === 404, 'nepostojeći meč → 404');
  const page = await fetch(`http://127.0.0.1:${LORA_PORT}/admin.html`);
  check(page.status === 200, 'admin.html se servira');
  ana.close();
} catch (err) {
  failures.push(String(err?.stack ?? err));
  console.error(err);
} finally {
  procs.forEach(p => p.kill());
  await wait(300);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (failures.length) {
  console.error(`\n✖ ${failures.length} neuspešnih provera:\n- ` + failures.join('\n- '));
  process.exit(1);
}
console.log('\nOK — admin test prošao');
