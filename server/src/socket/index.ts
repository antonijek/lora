import type { Server, Socket } from 'socket.io';
import { verifyToken, fetchMe } from '../auth.js';
import { upsertPlayer, markActive } from '../db.js';
import { markOnline, markOffline } from '../presence.js';
import { registerRoomHandlers } from './roomEvents.js';

// Isto kao preferans socket/index.ts: jedan loš zahtev jednog klijenta ne sme
// da sruši ceo proces (i sve partije) — umotaj svaki handler u try/catch.
function wrapSocketErrors(socket: Socket): void {
  const originalOn = socket.on.bind(socket);
  socket.on = ((event: string, handler: (...args: unknown[]) => unknown) => {
    return originalOn(event, (...args: unknown[]) => {
      try {
        const result = handler(...args);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch(err => console.error(`[socket:${event}] async error (${socket.id}):`, err));
        }
      } catch (err) {
        console.error(`[socket:${event}] error (${socket.id}):`, err);
      }
    });
  }) as typeof socket.on;
}

export function registerSocketHandlers(io: Server): void {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string') return next(new Error('Missing auth token'));
    try {
      const payload = verifyToken(token);
      // Ime + ban provera iz preferans naloga — ban važi odmah, ne tek po isteku tokena.
      const me = await fetchMe(token);
      if (!me || me.id !== payload.userId) return next(new Error('Invalid auth token'));
      socket.data.userId = me.id;
      socket.data.name = String(me.name || `igrač-${me.id}`).slice(0, 40);
      next();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('auth server')) return next(new Error('Auth server unavailable'));
      if (err instanceof TypeError) return next(new Error('Auth server unavailable')); // fetch nije uspeo
      next(new Error('Invalid auth token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId: number = socket.data.userId;
    const name: string = socket.data.name;
    upsertPlayer(userId, name);
    markActive(userId);
    console.log(`Socket ${socket.id} authenticated as user ${userId} (${name})`);
    wrapSocketErrors(socket);
    markOnline(socket.id, userId, name);
    socket.on('disconnect', () => markOffline(socket.id));
    registerRoomHandlers(io, socket);
  });
}
