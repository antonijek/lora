import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { initDb, flushPersist, topPlayers, matchesForUser, recordVisit } from './db.js';
import { adminRouter } from './admin.js';
import { authRouter, verifyToken } from './auth.js';
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
  // Javno je SAMO ono što treba browseru — nikad server/ (baza, .env), docs/, node_modules/.
  const PUBLIC = /^\/(lora\.html|pravila\.html|admin\.html|app\.js|online\.js|lora\.css|engine\/dist\/[\w.-]+\.js|icons\/cards\/[\w.-]+\.svg|icon\.svg|manifest\.json|icons\/[\w.-]+\.png)?$/;
  // pregledači same traže /favicon.ico — dobijaju PNG ikonicu
  app.get('/favicon.ico', (_req, res) => res.type('png').sendFile(path.join(PROJECT_ROOT, 'icons/favicon-32.png')));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/') || PUBLIC.test(req.path)) return next();
    res.status(404).end();
  });
  app.use(express.static(PROJECT_ROOT, {
    index: 'lora.html',
    setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
  }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: allRooms().length }));
  app.use('/api', authRouter);
  app.use('/api/admin', adminRouter);
  // Brojač posetilaca (i onih bez naloga) — nasumičan id iz browsera, bez ličnih podataka.
  app.post('/api/visit', (req, res) => {
    const v = req.body?.v;
    if (typeof v === 'string' && /^[a-z0-9]{8,32}$/.test(v)) recordVisit(v);
    res.status(204).end();
  });
  app.get('/api/leaderboard', (_req, res) => res.json({ players: topPlayers(20) }));
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
  }, 5 * 60 * 1000);
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
