import type { Server, Socket } from 'socket.io';
import { LoraGame, LoraError } from '../../../engine/dist/game.js';
import type { ContractId, Position } from '../../../engine/dist/types.js';
import type { AiLevel } from '../../../engine/dist/ai.js';
import { getRating } from '../db.js';
import { listOnlineUsers, getSocketIdsForUser } from '../presence.js';
import type { Room, ChatMessage } from '../rooms/Room.js';
import {
  SEATS, CHAT_LOG_LIMIT, createRoom, getRoom, removeRoom, status, listOpenRooms,
  getUserLocation, setUserLocation, clearUserLocation, humanSeats, anyoneConnected,
} from '../rooms/Room.js';
import { broadcast, buildRoomState, scheduleAi } from '../rooms/driver.js';

type Ack = (response: Record<string, unknown>) => void;

const AI_NAMES = ['Milan', 'Jelena', 'Bora', 'Vesna', 'Zoran', 'Maja'];
const AI_LEVELS: AiLevel[] = ['easy', 'medium', 'hard'];
const CONTRACTS: ContractId[] = ['MAX', 'MIN', 'HERC', 'DAME', 'ZANDAR', 'KRALJ_ZADNJI', 'LORA'];

function aiName(room: Room): string {
  const used = new Set(room.seats.map(s => s.name));
  return `${AI_NAMES.find(n => !used.has(`${n} (AI)`)) ?? 'Robot'} (AI)`;
}

function systemMessage(io: Server, room: Room, text: string): void {
  const msg: ChatMessage = { name: 'Sistem', seat: null, text, ts: Date.now() };
  room.chatLog.push(msg);
  if (room.chatLog.length > CHAT_LOG_LIMIT) room.chatLog.splice(0, room.chatLog.length - CHAT_LOG_LIMIT);
  io.to(room.code).emit('chat:message', msg);
}

/** Pokreni meč: prazna mesta dobijaju AI; rangirano ako su bar 2 čoveka. */
function startMatch(io: Server, room: Room): void {
  for (const s of SEATS) {
    if (room.seats[s].kind === 'empty') room.seats[s] = { kind: 'ai', userId: null, name: aiName(room), rating: 1000, formerUserId: null };
  }
  room.rated = humanSeats(room).length >= 2;
  room.game = new LoraGame({ seed: Date.now() });
  systemMessage(io, room, room.rated ? 'Meč je počeo (rangiran).' : 'Meč je počeo (nerangiran — manje od 2 čoveka).');
}

export function registerRoomHandlers(io: Server, socket: Socket): void {
  const userId: number = socket.data.userId;
  const name: string = socket.data.name;

  function current(): { room: Room; seat: Position } | null {
    const loc = getUserLocation(userId);
    const room = loc ? getRoom(loc.code) : undefined;
    return room && loc ? { room, seat: loc.seat } : null;
  }

  /** Sedi u sobu: vrati staro mesto (rejoin/povratak posle napuštanja) ili zauzmi prazno. */
  function seatInto(room: Room): Position | null {
    let seat = SEATS.find(s => room.seats[s].userId === userId);
    if (seat === undefined) {
      // povratak posle "napusti": AI vraća mesto
      seat = SEATS.find(s => room.seats[s].formerUserId === userId);
      if (seat !== undefined) systemMessage(io, room, `${name} se vratio za sto.`);
    }
    if (seat === undefined) {
      if (status(room) !== 'WAITING') return null;
      seat = SEATS.find(s => room.seats[s].kind === 'empty');
      if (seat === undefined) return null;
    }
    const old = getUserLocation(userId);
    if (old && old.code !== room.code) leaveCurrent(false);
    room.seats[seat] = { kind: 'human', userId, name, rating: getRating(userId), formerUserId: null };
    room.sockets[seat] = socket;
    socket.join(room.code);
    setUserLocation(userId, { code: room.code, seat });
    socket.emit('chat:backlog', room.chatLog);
    if (status(room) === 'WAITING' && SEATS.every(s => room.seats[s].kind === 'human')) startMatch(io, room);
    return seat;
  }

  /** Napusti trenutnu sobu. WAITING: oslobodi mesto. PLAYING: AI preuzima. */
  function leaveCurrent(announce = true): void {
    const cur = current();
    if (!cur) return;
    const { room, seat } = cur;
    socket.leave(room.code);
    clearUserLocation(userId);
    room.sockets[seat] = null;
    const st = status(room);
    if (st === 'WAITING') {
      room.seats[seat] = { kind: 'empty', userId: null, name: null, rating: 1000, formerUserId: null };
      if (room.hostSeat === seat) {
        const nextHost = humanSeats(room)[0];
        if (nextHost !== undefined) room.hostSeat = nextHost;
      }
      if (humanSeats(room).length === 0) { removeRoom(room); return; }
    } else if (st === 'PLAYING') {
      room.seats[seat] = { kind: 'ai', userId: null, name: `${name} (AI)`, rating: room.seats[seat].rating, formerUserId: userId };
      if (announce) systemMessage(io, room, `${name} je napustio meč — AI igra umesto njega.`);
    } else if (!anyoneConnected(room)) {
      removeRoom(room);
      return;
    }
    broadcast(room);
  }

  // Reconnect: odmah vrati u sobu (ili eksplicitno "nema sobe", da klijent ne pogađa).
  const loc = getUserLocation(userId);
  const resumeRoom = loc ? getRoom(loc.code) : undefined;
  if (resumeRoom && loc && status(resumeRoom) !== 'FINISHED') {
    resumeRoom.sockets[loc.seat] = socket;
    resumeRoom.seats[loc.seat].name = name;
    socket.join(resumeRoom.code);
    socket.emit('chat:backlog', resumeRoom.chatLog);
    broadcast(resumeRoom);
  } else {
    if (resumeRoom && loc) clearUserLocation(userId);
    socket.emit('room:none');
  }

  // ---------------------------------------------------------------- lobi

  socket.on('room:list', (_p: unknown, ack?: Ack) => ack?.({ rooms: listOpenRooms() }));

  socket.on('presence:list', (_p: unknown, ack?: Ack) => {
    ack?.({ users: listOnlineUsers().filter(u => u.userId !== userId) });
  });

  socket.on('room:create', (payload: { aiLevel?: string }, ack?: Ack) => {
    const aiLevel = AI_LEVELS.includes(payload?.aiLevel as AiLevel) ? (payload!.aiLevel as AiLevel) : 'hard';
    leaveCurrent();
    const room = createRoom(aiLevel);
    const seat = seatInto(room)!;
    room.hostSeat = seat;
    ack?.({ code: room.code });
    broadcast(room);
  });

  socket.on('room:join', (payload: { code?: string }, ack?: Ack) => {
    const room = getRoom(payload?.code ?? '');
    if (!room) return ack?.({ error: 'Soba ne postoji.' });
    const seat = seatInto(room);
    if (seat === null) return ack?.({ error: status(room) === 'WAITING' ? 'Soba je puna.' : 'Meč je već počeo.' });
    ack?.({ code: room.code });
    broadcast(room);
  });

  // Brza igra: prva otvorena soba, ili nova.
  socket.on('room:quick', (_p: unknown, ack?: Ack) => {
    const open = listOpenRooms().sort((a, b) => b.players - a.players)[0];
    const room = open ? getRoom(open.code)! : null;
    if (room && seatInto(room) !== null) {
      ack?.({ code: room.code });
      broadcast(room);
      return;
    }
    leaveCurrent();
    const fresh = createRoom('hard');
    fresh.hostSeat = seatInto(fresh)!;
    ack?.({ code: fresh.code });
    broadcast(fresh);
  });

  function hostOnly(ack?: Ack): Room | null {
    const cur = current();
    if (!cur) { ack?.({ error: 'Niste u sobi.' }); return null; }
    if (cur.room.hostSeat !== cur.seat) { ack?.({ error: 'Samo domaćin to može.' }); return null; }
    if (status(cur.room) !== 'WAITING') { ack?.({ error: 'Meč je već počeo.' }); return null; }
    return cur.room;
  }

  socket.on('room:addAi', (payload: { seat?: number }, ack?: Ack) => {
    const room = hostOnly(ack);
    if (!room) return;
    const seat = Number(payload?.seat) as Position;
    if (!SEATS.includes(seat) || room.seats[seat].kind !== 'empty') return ack?.({ error: 'Mesto nije prazno.' });
    room.seats[seat] = { kind: 'ai', userId: null, name: aiName(room), rating: 1000, formerUserId: null };
    ack?.({ ok: true });
    broadcast(room);
  });

  socket.on('room:removeAi', (payload: { seat?: number }, ack?: Ack) => {
    const room = hostOnly(ack);
    if (!room) return;
    const seat = Number(payload?.seat) as Position;
    if (!SEATS.includes(seat) || room.seats[seat].kind !== 'ai') return ack?.({ error: 'Na tom mestu nije AI.' });
    room.seats[seat] = { kind: 'empty', userId: null, name: null, rating: 1000, formerUserId: null };
    ack?.({ ok: true });
    broadcast(room);
  });

  socket.on('room:start', (_p: unknown, ack?: Ack) => {
    const room = hostOnly(ack);
    if (!room) return;
    startMatch(io, room);
    ack?.({ ok: true });
    broadcast(room);
  });

  socket.on('room:leave', (_p: unknown, ack?: Ack) => {
    leaveCurrent();
    ack?.({ ok: true });
    socket.emit('room:none');
  });

  socket.on('room:leaveFinished', (_p: unknown, ack?: Ack) => {
    const cur = current();
    if (cur && status(cur.room) === 'FINISHED') leaveCurrent(false);
    ack?.({ ok: true });
    socket.emit('room:none');
  });

  socket.on('room:invite', (payload: { userId?: unknown }, ack?: Ack) => {
    const cur = current();
    if (!cur) return ack?.({ error: 'Prvo napravite sobu.' });
    const target = Number(payload?.userId);
    const sids = Number.isInteger(target) ? getSocketIdsForUser(target) : [];
    if (sids.length === 0) return ack?.({ error: 'Igrač više nije online.' });
    for (const sid of sids) io.to(sid).emit('room:invited', { code: cur.room.code, fromName: name });
    ack?.({ ok: true });
  });

  // ---------------------------------------------------------------- igra

  socket.on('game:action', (action: { type?: string; contract?: string; cardId?: string }, ack?: Ack) => {
    const cur = current();
    if (!cur?.room.game) return ack?.({ error: 'Niste u meču.' });
    const { room, seat } = cur; // mesto uvek sa servera, nikad od klijenta
    const game = room.game!;
    try {
      if (action?.type === 'choose' && CONTRACTS.includes(action.contract as ContractId)) game.choose(seat, action.contract as ContractId);
      else if (action?.type === 'play' && typeof action.cardId === 'string') game.play(seat, action.cardId);
      else if (action?.type === 'pass') game.pass(seat);
      else return ack?.({ error: 'Nepoznata akcija.' });
    } catch (e) {
      if (e instanceof LoraError) return ack?.({ error: e.message });
      throw e;
    }
    ack?.({ ok: true });
    broadcast(room);
  });

  socket.on('game:ready', (_p: unknown, ack?: Ack) => {
    const cur = current();
    if (!cur?.room.game || cur.room.game.getState().phase !== 'DEAL_END') return ack?.({ ok: true });
    cur.room.ready.add(cur.seat);
    ack?.({ ok: true });
    broadcast(cur.room);
  });

  socket.on('chat:send', (payload: { text?: string }) => {
    const cur = current();
    if (!cur || typeof payload?.text !== 'string' || !payload.text.trim()) return;
    const msg: ChatMessage = { name, seat: cur.seat, text: payload.text.trim().slice(0, 300), ts: Date.now() };
    cur.room.chatLog.push(msg);
    if (cur.room.chatLog.length > CHAT_LOG_LIMIT) cur.room.chatLog.splice(0, cur.room.chatLog.length - CHAT_LOG_LIMIT);
    io.to(cur.room.code).emit('chat:message', msg);
  });

  socket.on('disconnect', () => {
    const cur = current();
    if (!cur || cur.room.sockets[cur.seat] !== socket) return;
    const { room, seat } = cur;
    room.sockets[seat] = null;
    if (status(room) === 'WAITING') {
      // niko se ne čeka dok meč nije počeo — oslobodi mesto
      leaveCurrent(false);
      return;
    }
    if (status(room) === 'FINISHED' && !anyoneConnected(room)) { removeRoom(room); return; }
    // mesto ostaje njegovo (reconnect); ako je na potezu, AI igra posle grace perioda
    broadcast(room);
    scheduleAi(room);
  });

  // za testove/debug
  socket.on('room:peek', (_p: unknown, ack?: Ack) => {
    const cur = current();
    ack?.(cur ? buildRoomState(cur.room, cur.seat) as unknown as Record<string, unknown> : { none: true });
  });
}
