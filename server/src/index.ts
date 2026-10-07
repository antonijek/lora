import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import compression from 'compression';
import { Server as SocketIOServer } from 'socket.io';
import { initDb, flushPersist, topPlayers, matchesForUser, recordVisit, recordEvent, EVENT_KINDS, userMatchRecords, allUserRecords, saveLocalMatch, upsertPlayer, userDays, getRating } from './db.js';
import { computeStats, streak, newRecords } from '../../engine/dist/stats.js';
import { DEFAULT_CONTRACTS } from '../../engine/dist/contracts.js';
import { adminRouter } from './admin.js';
import { seoRouter } from './seo.js';
import { classifySource, parseAgent, logVisit } from './visits.js';
import { authRouter, verifyToken, fetchMe } from './auth.js';
import { registerSocketHandlers } from './socket/index.js';
import { loadPersistedRooms, removeAbandonedRooms, allRooms, status } from './rooms/Room.js';
import { setIo, broadcast } from './rooms/driver.js';

// server/dist/index.js → server → koren projekta (lora.html, app.js, engine/dist, icons)
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

async function main(): Promise<void> {
  await initDb();
  const restored = loadPersistedRooms();
  if (restored.length) console.log(`[STARTUP] Restored ${restored.length} room(s)`);

  const app = express();
  app.set('trust proxy', 1); // nginx → prava IP adresa za rate limit
  app.use(express.json());
  // sažimanje (gzip) — JS, CSS, SVG i JSON su ranije išli nesažeti (nginx sažima samo HTML)
  app.use(compression());
  // robots.txt, sitemap.xml, IndexNow ključ, pregled linka sobe
  app.use(seoRouter(PROJECT_ROOT));
  // Javno je SAMO ono što treba browseru — nikad server/ (baza, .env), docs/, node_modules/.
  const PUBLIC = /^\/(lora\.html|pravila\.html|privatnost\.html|admin\.html|app\.js|online\.js|lora\.css|engine\/dist\/[\w.-]+\.js|icons\/cards\/[\w.-]+\.(?:svg|webp)|icon\.svg|manifest\.json|icons\/[\w.-]+\.(?:png|jpg))?$/;
  // pregledači same traže /favicon.ico — dobijaju PNG ikonicu
  app.get('/favicon.ico', (_req, res) => res.type('png').sendFile(path.join(PROJECT_ROOT, 'icons/favicon-32.png')));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/') || PUBLIC.test(req.path)) return next();
    res.status(404).end();
  });
  app.use(express.static(PROJECT_ROOT, {
    index: 'lora.html',
    // slike (karte, ikonice) se ne menjaju — pregledač ih čuva nedelju dana; HTML/JS/CSS se uvek proveravaju
    setHeaders: (res, filePath) => res.setHeader('Cache-Control',
      /[\\/]icons[\\/]/.test(filePath) ? 'public, max-age=604800' : 'no-cache'),
  }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: allRooms().length }));
  app.use('/api', authRouter);
  app.use('/api/admin', adminRouter);
  // Brojač posetilaca (i onih bez naloga) — nasumičan id iz browsera, bez ličnih podataka.
  app.post('/api/visit', (req, res) => {
    const { v, ref, src, page, app: standalone } = req.body ?? {};
    if (typeof v === 'string' && /^[a-z0-9]{8,32}$/.test(v)) {
      recordVisit(v);
      // izvor/uređaj za admin karticu "Posete" — bez IP adrese
      const agent = parseAgent(String(req.headers['user-agent'] ?? '').slice(0, 400), standalone === true);
      logVisit({
        visitor: v,
        page: page === 'pravila' ? 'pravila' : 'igra',
        source: classifySource(typeof ref === 'string' ? ref.slice(0, 300) : '', typeof src === 'string' ? src.replace(/[^\w.-]/g, '').toLowerCase() : ''),
        ...agent,
      });
    }
    res.status(204).end();
  });
  // Anonimni događaji iz igre protiv računara (isti nasumični id kao /api/visit)
  app.post('/api/event', (req, res) => {
    const { v, kind } = req.body ?? {};
    if (typeof v === 'string' && /^[a-z0-9]{8,32}$/.test(v) && (EVENT_KINDS as readonly string[]).includes(kind)) recordEvent(v, kind);
    res.status(204).end();
  });
  app.get('/api/leaderboard', (_req, res) => res.json({ players: topPlayers(20) }));
  // Moja statistika (online): mečevi, pobede, rekordi, niz dana, najviši rejting
  app.get('/api/stats', (req, res) => {
    let userId: number;
    try {
      ({ userId } = verifyToken(String(req.headers.authorization ?? '').replace(/^Bearer /, '')));
    } catch {
      return void res.status(401).json({ error: 'Niste prijavljeni.' });
    }
    // jedna statistika: online sobe + "Igraj protiv računara"; rejting samo iz rangiranih (≥2 čoveka)
    const records = allUserRecords(userId);
    const rating = getRating(userId);
    let r = 1000;
    let bestRating = rating;
    for (const m of userMatchRecords(userId)) if (m.rated) { r += m.delta; bestRating = Math.max(bestRating, r); }
    res.json({
      stats: computeStats(records),
      streak: streak(userDays(userId), new Date().toISOString().slice(0, 10)),
      rating,
      bestRating,
      ratedMatches: records.filter(m => m.rated).length,
      vsComputer: records.filter(m => m.humans < 2).length,
      withPeople: records.filter(m => m.humans >= 2).length,
    });
  });
  // Mečevi "Igraj protiv računara" iz pregledača prijavljenog igrača (pri prijavi svi raniji,
  // posle svaki novi). Vraća nove lične rekorde za poslednji meč iz paketa.
  app.post('/api/local-matches', async (req, res) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    let me;
    try {
      const { userId } = verifyToken(token);
      me = await fetchMe(token);
      if (!me || me.id !== userId) throw new Error('auth');
    } catch {
      return void res.status(401).json({ error: 'Niste prijavljeni.' });
    }
    const list = Array.isArray(req.body?.matches) ? req.body.matches.slice(0, 300) : [];
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const valid = list.filter((m: any) =>
      typeof m?.id === 'string' && /^[\w-]{4,40}$/.test(m.id) &&
      typeof m.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.date) && m.date <= tomorrow &&
      Number.isInteger(m.seat) && m.seat >= 0 && m.seat <= 3 &&
      Array.isArray(m.scores) && m.scores.length === 4 && m.scores.every((x: unknown) => Number.isInteger(x) && Math.abs(x as number) < 1000) &&
      Array.isArray(m.history) && m.history.length === 28 && m.history.every((h: any) =>
        (DEFAULT_CONTRACTS as readonly string[]).includes(h?.contract) && Array.isArray(h.points) && h.points.length === 4 && h.points.every(Number.isInteger)),
    ).sort((a: any, b: any) => a.date.localeCompare(b.date));
    upsertPlayer(me.id, String(me.name || `igrač-${me.id}`).slice(0, 40));
    let saved = 0;
    let records: string[] = [];
    valid.forEach((m: any, i: number) => {
      const last = i === valid.length - 1;
      const before = last ? computeStats(allUserRecords(me!.id)) : null;
      if (saveLocalMatch(me!.id, m)) {
        saved++;
        if (before) records = newRecords(before, m);
      }
    });
    res.json({ ok: true, saved, accepted: valid.map((m: any) => m.id), records });
  });
  app.get('/api/matches', (req, res) => {
    try {
      const { userId } = verifyToken(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      res.json({ matches: matchesForUser(userId) });
    } catch {
      res.status(401).json({ error: 'Niste prijavljeni.' });
    }
  });

  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, { cors: { origin: true } });
  setIo(io);
  registerSocketHandlers(io);

  // Vraćene sobe: pokreni AI/tajmere (niko još nije povezan — AI igra za AI mesta,
  // ljudi dobijaju grace period kao da im je pala veza).
  for (const room of restored) if (status(room) === 'PLAYING') broadcast(room);

  const port = Number(process.env.PORT) || 3002;
  httpServer.listen(port, () => console.log(`Lora server listening on port ${port}`));

  const shutdown = (signal: string) => {
    console.log(`[SHUTDOWN] ${signal}, flushing DB`);
    flushPersist();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', err => {
    console.error('[FATAL] uncaughtException:', err);
    try { flushPersist(); } catch {}
    process.exit(1);
  });
  process.on('unhandledRejection', reason => {
    console.error('[FATAL] unhandledRejection:', reason);
    try { flushPersist(); } catch {}
    process.exit(1);
  });

  setInterval(() => {
    const removed = removeAbandonedRooms();
    if (removed) console.log(`[CLEANUP] Removed ${removed} room(s)`);
  }, Number(process.env.CLEANUP_MS ?? 5 * 60 * 1000));
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
