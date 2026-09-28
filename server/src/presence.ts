// Ko je trenutno online (nezavisno od sobe) — kopija preferans presence.ts,
// rejting iz lora baze.

import { getRating } from './db.js';

const online = new Map<string, { userId: number; name: string; connectedAt: number }>();

export function markOnline(socketId: string, userId: number, name: string): void {
  online.set(socketId, { userId, name, connectedAt: Date.now() });
}

export function markOffline(socketId: string): void {
  online.delete(socketId);
}

export function listOnlineUsers(): { userId: number; name: string; rating: number }[] {
  const seen = new Set<number>();
  const result: { userId: number; name: string; rating: number }[] = [];
  for (const { userId, name } of online.values()) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    result.push({ userId, name, rating: getRating(userId) });
  }
  return result;
}

export function getSocketIdsForUser(userId: number): string[] {
  const ids: string[] = [];
  for (const [socketId, info] of online.entries()) if (info.userId === userId) ids.push(socketId);
  return ids;
}
