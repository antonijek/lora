// Admin panel Lore (/admin.html) — isti obrazac kao preferans/server/src/admin.
// Nalozi žive u preferans bazi: admin je onaj kome preferans /api/me kaže
// is_admin, a ban ide preko preferans admin rute (važi za sve igre odjednom).
// Ovde je samo ono što je Lorino: statistika, igrači (rejting), sobe, mečevi.

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { verifyToken, fetchMe } from './auth.js';
import { all, get, run } from './db.js';
import type { Position } from '../../engine/dist/types.js';
import type { Room, ChatMessage } from './rooms/Room.js';
import {
  SEATS, CHAT_LOG_LIMIT, allRooms, getRoom, removeRoom, status, humanSeats,
  getUserLocation, clearUserLocation,
} from './rooms/Room.js';
import { broadcast, getIo, isPaused } from './rooms/driver.js';
import { listOnlineUsers, getSocketIdsForUser } from './presence.js';

const AUTH_URL = () => process.env.AUTH_URL || 'http://127.0.0.1:3001';

interface AdminRequest extends Request {
  adminId?: number;
}

async function requireAdmin(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  try {
    const { userId } = verifyToken(token);
    const me = await fetchMe(token);
    if (!me || me.id !== userId) { res.status(401).json({ error: 'Niste prijavljeni.' }); return; }
    if (!me.is_admin) { res.status(403).json({ error: 'Nemate admin prava.' }); return; }
    req.adminId = me.id;
    next();
  } catch (err) {
    if (err instanceof TypeError || (err instanceof Error && err.message.startsWith('auth server'))) {
      res.status(503).json({ error: 'Server za naloge nije dostupan.' });
      return;
    }
    res.status(401).json({ error: 'Niste prijavljeni.' });
  }
}

// ---------------------------------------------------------------- sobe

function systemMessage(room: Room, text: string): void {
  const msg: ChatMessage = { name: 'Sistem', seat: null, text, ts: Date.now() };
  room.chatLog.push(msg);
  if (room.chatLog.length > CHAT_LOG_LIMIT) room.chatLog.splice(0, room.chatLog.length - CHAT_LOG_LIMIT);
  getIo()?.to(room.code).emit('chat:message', msg);
}

/** Ukloni čoveka sa mesta: u čekaonici se mesto oslobađa, u meču AI preuzima (kao "Napusti meč"). */
export function adminKickSeat(room: Room, seat: Position, reason: string): { ok: true } | { ok: false; error: string } {
  const s = room.seats[seat];
  if (s.kind !== 'human' || s.userId === null) return { ok: false, error: 'Na tom mestu nije čovek.' };
  const st = status(room);
  if (st === 'FINISHED') return { ok: false, error: 'Meč je već završen.' };
  const uid = s.userId;
  const socket = room.sockets[seat];
  room.sockets[seat] = null;
  clearUserLocation(uid);
  if (socket) {
    socket.emit('game:error', reason);
    socket.leave(room.code);
    socket.emit('room:none');
  }
  if (st === 'WAITING') {
    room.seats[seat] = { kind: 'empty', userId: null, name: null, rating: 1000, formerUserId: null };
    const humans = humanSeats(room);
    if (humans.length === 0) { removeRoom(room); return { ok: true }; }
    if (room.hostSeat === seat) room.hostSeat = humans[0];
  } else {
    // formerUserId: isti igrač može da se vrati istim kodom (kao preferans); trajno udaljavanje = ban
    room.seats[seat] = { kind: 'ai', userId: null, name: `${s.name} (AI)`, rating: s.rating, formerUserId: uid };
    systemMessage(room, `Administrator je udaljio igrača ${s.name} — AI igra umesto njega.`);
  }
  broadcast(room);
  return { ok: true };
}

/** Ugasi sobu u bilo kojoj fazi (zaglavljena soba). Meč se ne upisuje i rejting se ne menja. */
export function adminCloseRoom(room: Room, reason: string): void {
  for (const seat of SEATS) {
    const uid = room.seats[seat].userId;
    if (uid !== null) clearUserLocation(uid);
    const socket = room.sockets[seat];
    if (socket) {
      socket.emit('game:error', reason);
      socket.leave(room.code);
      socket.emit('room:none');
    }
  }
  removeRoom(room);
}

function roomDetails(room: Room) {
  const st = room.game?.getState();
  return {
    code: room.code,
    status: status(room),
    createdAt: new Date(room.createdAt).toISOString(),
    rated: room.rated,
    paused: room.game ? isPaused(room) : false,
    deal: st ? Math.min(st.dealIndex + 1, room.game!.totalDeals) : 0,
    totalDeals: room.game?.totalDeals ?? 28,
    contract: st?.contract ?? null,
    scores: st?.scores ?? null,
    seats: SEATS.map(s => ({
      kind: room.seats[s].kind,
      userId: room.seats[s].userId,
      formerUserId: room.seats[s].formerUserId,
      name: room.seats[s].name,
      rating: room.seats[s].rating,
      connected: room.sockets[s] !== null,
      host: room.hostSeat === s,
    })),
  };
}

// ---------------------------------------------------------------- statistika

function lastDays(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

const count = (sql: string, params: (string | number)[] = []) => get<{ c: number }>(sql, params)?.c ?? 0;

function stats() {
  const days = lastDays(30);
  const series = (sql: string) => new Map(all<{ day: string; c: number }>(sql, [days[0]]).map(r => [r.day, r.c]));
  const active = series('SELECT day, COUNT(*) AS c FROM player_days WHERE day >= ? GROUP BY day');
  const visitors = series('SELECT day, COUNT(*) AS c FROM visits WHERE day >= ? GROUP BY day');
  const matches = series('SELECT date(ended_at) AS day, COUNT(*) AS c FROM match_log WHERE date(ended_at) >= ? GROUP BY day');
  const newPlayers = series('SELECT date(created_at) AS day, COUNT(*) AS c FROM lora_players WHERE date(created_at) >= ? GROUP BY day');
  const since = (d: number) => `date('now', '-${d - 1} days')`;
  return {
    onlineNow: listOnlineUsers().length,
    liveRooms: allRooms().length,
    playingRooms: allRooms().filter(r => status(r) === 'PLAYING').length,
    totalPlayers: count('SELECT COUNT(*) AS c FROM lora_players'),
    activeToday: count("SELECT COUNT(*) AS c FROM player_days WHERE day = date('now')"),
    active7: count(`SELECT COUNT(DISTINCT user_id) AS c FROM player_days WHERE day >= ${since(7)}`),
    active30: count(`SELECT COUNT(DISTINCT user_id) AS c FROM player_days WHERE day >= ${since(30)}`),
    visitorsToday: count("SELECT COUNT(*) AS c FROM visits WHERE day = date('now')"),
    visitors7: count(`SELECT COUNT(DISTINCT visitor) AS c FROM visits WHERE day >= ${since(7)}`),
    visitors30: count(`SELECT COUNT(DISTINCT visitor) AS c FROM visits WHERE day >= ${since(30)}`),
    newPlayers7: count(`SELECT COUNT(*) AS c FROM lora_players WHERE date(created_at) >= ${since(7)}`),
    matchesToday: count("SELECT COUNT(*) AS c FROM match_log WHERE date(ended_at) = date('now')"),
    matches7: count(`SELECT COUNT(*) AS c FROM match_log WHERE date(ended_at) >= ${since(7)}`),
    matchesTotal: count('SELECT COUNT(*) AS c FROM match_log'),
    daily: days.map(day => ({
      day,
      active: active.get(day) ?? 0,
      visitors: visitors.get(day) ?? 0,
      matches: matches.get(day) ?? 0,
      newPlayers: newPlayers.get(day) ?? 0,
    })),
  };
}

// ---------------------------------------------------------------- rute

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const intParam = (v: unknown) => (Number.isInteger(Number(v)) ? Number(v) : null);

adminRouter.get('/stats', (_req, res) => res.json(stats()));

adminRouter.get('/online', (_req, res) => {
  const users = listOnlineUsers().map(u => {
    const loc = getUserLocation(u.userId);
    return { ...u, room: loc?.code ?? null };
  });
  res.json({ users });
});

adminRouter.get('/players', async (req, res) => {
  const players = all<{ user_id: number }>(
    'SELECT user_id, name, rating, games_played, created_at, last_seen_at FROM lora_players ORDER BY COALESCE(last_seen_at, created_at) DESC',
  );
  // email i ban žive u preferans nalogu — ako preferans ne odgovori, spisak se ipak prikazuje
  const accounts = new Map<number, { email: string; banned: number }>();
  try {
    const r = await fetch(`${AUTH_URL()}/api/admin/users`, { headers: { Authorization: String(req.headers.authorization) } });
    if (r.ok) for (const u of ((await r.json()) as { users: { id: number; email: string; banned: number }[] }).users) accounts.set(u.id, u);
  } catch { /* preferans nedostupan */ }
  const online = new Set(listOnlineUsers().map(u => u.userId));
  res.json({
    players: players.map(p => ({
      ...p,
      email: accounts.get(p.user_id)?.email ?? null,
      banned: !!accounts.get(p.user_id)?.banned,
      online: online.has(p.user_id),
      room: getUserLocation(p.user_id)?.code ?? null,
    })),
  });
});

adminRouter.post('/players/:id/rating', (req, res) => {
  const id = intParam(req.params.id);
  const rating = req.body?.rating;
  if (id === null) return void res.status(400).json({ error: 'Pogrešan id.' });
  if (!Number.isInteger(rating) || rating < 0 || rating > 5000) return void res.status(400).json({ error: 'Rejting mora biti ceo broj od 0 do 5000.' });
  if (!get('SELECT user_id FROM lora_players WHERE user_id = ?', [id])) return void res.status(404).json({ error: 'Igrač ne postoji.' });
  run('UPDATE lora_players SET rating = ? WHERE user_id = ?', [rating, id]);
  res.json({ ok: true, rating });
});

// Ban važi za ceo nalog (sve igre) — upisuje ga preferans; Lora samo odmah
// skida igrača sa stola i prekida mu vezu.
adminRouter.post('/players/:id/ban', async (req: AdminRequest, res) => {
  const id = intParam(req.params.id);
  const banned = req.body?.banned;
  if (id === null || typeof banned !== 'boolean') return void res.status(400).json({ error: 'Pogrešan zahtev.' });
  if (id === req.adminId && banned) return void res.status(400).json({ error: 'Ne možete banovati sebe.' });
  try {
    const r = await fetch(`${AUTH_URL()}/api/admin/users/${id}/ban`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: String(req.headers.authorization) },
      body: JSON.stringify({ banned }),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) return void res.status(r.status).json({ error: data.error ?? 'Ban nije uspeo.' });
  } catch {
    return void res.status(503).json({ error: 'Server za naloge nije dostupan.' });
  }
  if (banned) {
    const loc = getUserLocation(id);
    const room = loc ? getRoom(loc.code) : undefined;
    if (room && loc) adminKickSeat(room, loc.seat, 'Nalog je suspendovan.');
    for (const sid of getSocketIdsForUser(id)) getIo()?.sockets.sockets.get(sid)?.disconnect(true);
  }
  res.json({ ok: true, banned });
});

adminRouter.get('/rooms', (_req, res) => res.json({ rooms: allRooms().map(roomDetails) }));

adminRouter.post('/rooms/:code/kick', (req, res) => {
  const room = getRoom(String(req.params.code));
  if (!room) return void res.status(404).json({ error: 'Soba ne postoji.' });
  const seat = Number(req.body?.seat) as Position;
  if (!SEATS.includes(seat)) return void res.status(400).json({ error: 'Pogrešno mesto.' });
  const r = adminKickSeat(room, seat, 'Administrator vas je udaljio iz sobe.');
  if (!r.ok) return void res.status(400).json({ error: r.error });
  res.json({ ok: true });
});

adminRouter.post('/rooms/:code/close', (req, res) => {
  const room = getRoom(String(req.params.code));
  if (!room) return void res.status(404).json({ error: 'Soba ne postoji.' });
  adminCloseRoom(room, 'Administrator je zatvorio sobu.');
  res.json({ ok: true });
});

adminRouter.get('/matches', (req, res) => {
  const limit = Math.min(Math.max(intParam(req.query.limit) ?? 100, 1), 500);
  res.json({
    matches: all(
      'SELECT id, room_code, ended_at, rated, seats_json, scores_json, rating_deltas_json FROM match_log ORDER BY id DESC LIMIT ?',
      [limit],
    ),
  });
});

adminRouter.get('/matches/:id', (req, res) => {
  const id = intParam(req.params.id);
  const match = id === null ? undefined : get('SELECT * FROM match_log WHERE id = ?', [id]);
  if (!match) return void res.status(404).json({ error: 'Meč ne postoji.' });
  res.json({ match });
});
