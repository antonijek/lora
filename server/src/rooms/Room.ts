// Soba za Loru: 4 mesta (ljudi ili AI), igra, chat, spremnost za sledeću partiju.
// Isti principi kao preferans/server/src/rooms (RoomState + RoomManager):
// sobe u memoriji, trajno čuvanje u active_rooms, userLocation za reconnect.

import type { Socket } from 'socket.io';
import { LoraGame } from '../../../engine/dist/game.js';
import type { LoraState, Position } from '../../../engine/dist/types.js';
import type { AiLevel } from '../../../engine/dist/ai.js';
import { saveActiveRoom, deleteActiveRoom, getAllActiveRooms } from '../db.js';

export type SeatKind = 'empty' | 'human' | 'ai';

export interface Seat {
  kind: SeatKind;
  userId: number | null;
  name: string | null;
  rating: number;
  /** Čovek koji je napustio meč — AI igra za njega, ali on može da se vrati. */
  formerUserId: number | null;
}

export interface ChatMessage {
  name: string;
  seat: Position | null;
  text: string;
  ts: number;
}

export const CHAT_LOG_LIMIT = 50;
export const SEATS: readonly Position[] = [0, 1, 2, 3];

export type RoomStatus = 'WAITING' | 'PLAYING' | 'FINISHED';

export interface RatingResult {
  rated: boolean;
  scores: number[];
  deltas: number[];
  newRatings: number[];
  /** Novi lični rekordi po mestu (tekst za prikaz na kraju meča). */
  records?: string[][];
}

export interface Room {
  code: string;
  createdAt: number;
  hostSeat: Position;
  aiLevel: AiLevel;
  seats: Seat[];
  sockets: (Socket | null)[];
  game: LoraGame | null;
  /** Rangirano samo ako su bar 2 čoveka seli za sto na početku. */
  rated: boolean;
  chatLog: ChatMessage[];
  /** Ljudi koji su kliknuli "Dalje" posle partije. */
  ready: Set<Position>;
  ratingResult: RatingResult | null;
  version: number;
  // runtime tajmeri (ne čuvaju se)
  aiTimer: ReturnType<typeof setTimeout> | null;
  nextDealTimer: ReturnType<typeof setTimeout> | null;
}

export function status(room: Room): RoomStatus {
  if (!room.game) return 'WAITING';
  return room.game.getState().phase === 'MATCH_END' ? 'FINISHED' : 'PLAYING';
}

const emptySeat = (): Seat => ({ kind: 'empty', userId: null, name: null, rating: 1000, formerUserId: null });

// ---------------------------------------------------------------- manager

export type UserLocation = { code: string; seat: Position };

const roomsByCode = new Map<string, Room>();
const userLocation = new Map<number, UserLocation>();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  let code: string;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (roomsByCode.has(code));
  return code;
}

export function createRoom(aiLevel: AiLevel): Room {
  const room: Room = {
    code: generateCode(),
    createdAt: Date.now(),
    hostSeat: 0,
    aiLevel,
    seats: SEATS.map(emptySeat),
    sockets: [null, null, null, null],
    game: null,
    rated: false,
    chatLog: [],
    ready: new Set(),
    ratingResult: null,
    version: 0,
    aiTimer: null,
    nextDealTimer: null,
  };
  roomsByCode.set(room.code, room);
  return room;
}

export function getRoom(code: string): Room | undefined {
  return roomsByCode.get(String(code ?? '').trim().toUpperCase());
}

export function removeRoom(room: Room): void {
  if (room.aiTimer) clearTimeout(room.aiTimer);
  if (room.nextDealTimer) clearTimeout(room.nextDealTimer);
  roomsByCode.delete(room.code);
  deleteActiveRoom(room.code);
  for (const [uid, loc] of userLocation) if (loc.code === room.code) userLocation.delete(uid);
}

export function getUserLocation(userId: number): UserLocation | undefined {
  return userLocation.get(userId);
}

export function setUserLocation(userId: number, loc: UserLocation): void {
  userLocation.set(userId, loc);
}

export function clearUserLocation(userId: number): void {
  userLocation.delete(userId);
}

export function humanSeats(room: Room): Position[] {
  return SEATS.filter(s => room.seats[s].kind === 'human');
}

export function anyoneConnected(room: Room): boolean {
  return room.sockets.some(s => s !== null);
}

export interface RoomSummary {
  code: string;
  players: number;
  host: string | null;
}

/** Javni lobi: samo sobe koje čekaju i imaju slobodno mesto. */
export function listOpenRooms(): RoomSummary[] {
  const out: RoomSummary[] = [];
  for (const room of roomsByCode.values()) {
    if (status(room) !== 'WAITING') continue;
    const players = room.seats.filter(s => s.kind !== 'empty').length;
    if (players < 4) out.push({ code: room.code, players, host: room.seats[room.hostSeat].name });
  }
  return out;
}

export function allRooms(): Room[] {
  return [...roomsByCode.values()];
}

/** Soba u WAITING bez ikoga povezanog, starija od 30 min — briše se (curenje memorije). */
export function removeAbandonedRooms(): number {
  let removed = 0;
  const now = Date.now();
  for (const room of roomsByCode.values()) {
    const st = status(room);
    const stale = now - room.createdAt > 30 * 60 * 1000;
    if (!anyoneConnected(room) && ((st === 'WAITING' && stale) || st === 'FINISHED')) {
      removeRoom(room);
      removed++;
    }
  }
  return removed;
}

// ---------------------------------------------------------------- persist

interface SerializedRoom {
  code: string;
  createdAt: number;
  hostSeat: Position;
  aiLevel: AiLevel;
  seats: Seat[];
  gameState: LoraState | null;
  rated: boolean;
  chatLog: ChatMessage[];
  ready: Position[];
  ratingResult: RatingResult | null;
}

export function persistRoom(room: Room): void {
  const data: SerializedRoom = {
    code: room.code,
    createdAt: room.createdAt,
    hostSeat: room.hostSeat,
    aiLevel: room.aiLevel,
    seats: room.seats,
    gameState: room.game ? room.game.getState() : null,
    rated: room.rated,
    chatLog: room.chatLog,
    ready: [...room.ready],
    ratingResult: room.ratingResult,
  };
  saveActiveRoom(room.code, JSON.stringify(data));
}

/** Pri startu servera: vrati sve nezavršene sobe; igrači se sami rekonektuju. */
export function loadPersistedRooms(): Room[] {
  const loaded: Room[] = [];
  for (const row of getAllActiveRooms()) {
    let d: SerializedRoom;
    try {
      d = JSON.parse(row.state_json);
    } catch {
      continue;
    }
    const room: Room = {
      code: d.code,
      createdAt: d.createdAt,
      hostSeat: d.hostSeat,
      aiLevel: 'hard', // jedan nivo AI-ja — i stare sačuvane sobe dobijaju najjači
      seats: d.seats,
      sockets: [null, null, null, null],
      game: d.gameState ? LoraGame.fromState(d.gameState) : null,
      rated: d.rated,
      chatLog: d.chatLog ?? [],
      ready: new Set(d.ready ?? []),
      ratingResult: d.ratingResult ?? null,
      version: 0,
      aiTimer: null,
      nextDealTimer: null,
    };
    roomsByCode.set(room.code, room);
    for (const s of SEATS) {
      const uid = room.seats[s].userId;
      if (room.seats[s].kind === 'human' && uid !== null) userLocation.set(uid, { code: room.code, seat: s });
    }
    loaded.push(room);
  }
  return loaded;
}
