// Jedino mesto kroz koje prolazi SVAKA promena sobe (kao broadcastRoomState u
// preferansu): pošalji svakom igraču njegov pogled, sačuvaj sobu, zakaži AI
// potez / sledeću partiju, obračunaj rejting tačno jednom.

import type { Server } from 'socket.io';
import { chooseAction } from '../../../engine/dist/ai.js';
import type { Position } from '../../../engine/dist/types.js';
import { getRating, updateRating, saveMatchLog } from '../db.js';
import type { Room, RatingResult } from './Room.js';
import { SEATS, status, persistRoom, humanSeats } from './Room.js';

// Pauze da ljudi stignu da isprate šta se desilo.
const AI_DELAY_MS = Number(process.env.AI_DELAY_MS ?? 700);
const AFTER_TRICK_MS = Number(process.env.AFTER_TRICK_MS ?? 1400);
const CHOOSE_DELAY_MS = Number(process.env.CHOOSE_DELAY_MS ?? 1200);
/** Čovek bez veze koji je na potezu — AI igra za njega posle ovoliko. */
const DISCONNECTED_GRACE_MS = Number(process.env.DISCONNECTED_GRACE_MS ?? 20000);
/** Sledeća partija kreće sama posle ovoliko (ili čim svi kliknu "Dalje"). */
const NEXT_DEAL_MS = Number(process.env.NEXT_DEAL_MS ?? 8000);

let io: Server | null = null;
export function setIo(server: Server): void {
  io = server;
}

/** Ceo prikaz sobe za jedno mesto (null = gost/lobi). */
export function buildRoomState(room: Room, mySeat: Position | null) {
  return {
    code: room.code,
    /** raste sa svakom promenom — klijent ne šalje potez na zastarelo stanje */
    version: room.version,
    status: status(room),
    hostSeat: room.hostSeat,
    mySeat,
    aiLevel: room.aiLevel,
    rated: room.rated,
    seats: SEATS.map(s => ({
      kind: room.seats[s].kind,
      name: room.seats[s].name,
      rating: room.seats[s].rating,
      connected: room.seats[s].kind === 'ai' || room.sockets[s] !== null,
      left: room.seats[s].formerUserId !== null,
    })),
    ready: [...room.ready],
    // Engine već skriva tuđe karte i špil — getPlayerView je jedini put ka klijentu.
    view: room.game && mySeat !== null ? room.game.getPlayerView(mySeat) : null,
    rating: room.ratingResult,
  };
}

export function broadcast(room: Room): void {
  // rejting PRE slanja, da ga igrači dobiju u istom stanju kao kraj meča
  if (room.game?.getState().phase === 'MATCH_END' && !room.ratingResult) resolveRating(room);
  room.version++;
  SEATS.forEach(seat => {
    room.sockets[seat]?.emit('room:state', buildRoomState(room, seat));
  });
  persistRoom(room);
  scheduleAi(room);
  scheduleNextDeal(room);
}

// ---------------------------------------------------------------- AI

/** Ko igra za ovo mesto sada: AI mesto uvek; čovek bez veze posle grace perioda. */
function aiControls(room: Room, seat: Position): 'now' | 'grace' | 'no' {
  const s = room.seats[seat];
  if (s.kind === 'ai') return 'now';
  if (s.kind === 'human' && room.sockets[seat] === null) return 'grace';
  return 'no';
}

export function scheduleAi(room: Room): void {
  if (room.aiTimer) {
    clearTimeout(room.aiTimer);
    room.aiTimer = null;
  }
  if (!room.game) return;
  const st = room.game.getState();
  if (st.phase !== 'CHOOSING' && st.phase !== 'TRICKS' && st.phase !== 'LAYOUT') return;
  const seat = st.turn;
  const who = aiControls(room, seat);
  if (who === 'no') return;

  let delay = st.phase === 'CHOOSING' ? CHOOSE_DELAY_MS : AI_DELAY_MS;
  // tek završen štih: pusti ljude da ga vide
  if (st.phase === 'TRICKS' && st.trick.length === 0 && st.lastTrick) delay = Math.max(delay, AFTER_TRICK_MS);
  if (who === 'grace') delay = Math.max(delay, DISCONNECTED_GRACE_MS);

  const expectTurn = seat;
  const expectDeal = st.dealIndex;
  room.aiTimer = setTimeout(() => {
    room.aiTimer = null;
    if (!room.game) return;
    const now = room.game.getState();
    // stanje se promenilo u međuvremenu (čovek se vratio i odigrao, i sl.)
    if (now.turn !== expectTurn || now.dealIndex !== expectDeal || aiControls(room, expectTurn) === 'no') {
      scheduleAi(room);
      return;
    }
    playAi(room, expectTurn);
    broadcast(room);
  }, delay);
}

function playAi(room: Room, seat: Position): void {
  const game = room.game!;
  const action = chooseAction(game.getPlayerView(seat), room.aiLevel);
  if (action.type === 'choose') game.choose(seat, action.contract);
  else if (action.type === 'pass') game.pass(seat);
  else game.play(seat, action.cardId);
}

// ---------------------------------------------------------------- partije

/** Posle DEAL_END: sledeća partija kad svi povezani ljudi kliknu "Dalje" ili istekne tajmer. */
function scheduleNextDeal(room: Room): void {
  if (!room.game || room.game.getState().phase !== 'DEAL_END') {
    if (room.nextDealTimer) { clearTimeout(room.nextDealTimer); room.nextDealTimer = null; }
    return;
  }
  const waitingFor = humanSeats(room).filter(s => room.sockets[s] !== null && !room.ready.has(s));
  if (waitingFor.length === 0) {
    startNextDeal(room);
    return;
  }
  if (room.nextDealTimer) return;
  const expectDeal = room.game.getState().dealIndex;
  room.nextDealTimer = setTimeout(() => {
    room.nextDealTimer = null;
    if (room.game?.getState().phase === 'DEAL_END' && room.game.getState().dealIndex === expectDeal) startNextDeal(room);
  }, NEXT_DEAL_MS);
}

function startNextDeal(room: Room): void {
  if (room.nextDealTimer) { clearTimeout(room.nextDealTimer); room.nextDealTimer = null; }
  room.ready.clear();
  room.game!.nextDeal();
  // setImmediate: ne ulazi rekurzivno u broadcast iz broadcast-a
  setImmediate(() => broadcast(room));
}

// ---------------------------------------------------------------- rejting

const K = 32;

/** ELO za više igrača: svaki par je "duel" (manje poena = pobeda), deljeno sa n−1. */
export function ratingDeltas(scores: number[], ratings: number[]): number[] {
  const n = scores.length;
  return scores.map((si, i) => {
    let d = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const actual = si < scores[j] ? 1 : si === scores[j] ? 0.5 : 0;
      const expected = 1 / (1 + 10 ** ((ratings[j] - ratings[i]) / 400));
      d += K * (actual - expected);
    }
    return Math.round(d / (n - 1));
  });
}

function resolveRating(room: Room): void {
  const st = room.game!.getState();
  const scores = st.scores;
  const ratings = SEATS.map(s => (room.seats[s].userId !== null ? getRating(room.seats[s].userId!) : 1000));
  const deltas = room.rated ? ratingDeltas(scores, ratings) : [0, 0, 0, 0];
  const newRatings = ratings.map((r, i) => r + deltas[i]);

  // Rejting se menja samo ljudima (i onome ko je napustio — i on dobija/gubi, kao u preferansu).
  SEATS.forEach(s => {
    const uid = room.seats[s].userId ?? room.seats[s].formerUserId;
    if (room.rated && uid !== null) {
      updateRating(uid, newRatings[s]);
      room.seats[s].rating = newRatings[s];
    }
  });

  const result: RatingResult = { rated: room.rated, scores, deltas, newRatings };
  room.ratingResult = result;
  saveMatchLog({
    roomCode: room.code,
    rated: room.rated,
    seats: room.seats.map(s => ({ userId: s.userId ?? s.formerUserId, name: s.name, kind: s.kind })),
    scores,
    deltas,
    history: st.history,
  });
  io?.to(room.code).emit('game:matchEnd', result);
}
