// Lora baza — isti obrazac kao preferans/server/src/db.ts (sql.js u memoriji,
// debounce upis na disk, flush pri gašenju). Nalozi NISU ovde: žive u
// preferans bazi, ovde je samo ono što je specifično za Loru.

import fs from 'node:fs';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';

const DB_PATH = process.env.DB_PATH || './lora.db';

let db: Database;

export async function initDb(): Promise<void> {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();

  // Sve tabele sa IF NOT EXISTS — važi i za svežu i za postojeću bazu
  // (preferans je imao bag gde se migracija nije pokretala na svežoj bazi).
  db.run(`CREATE TABLE IF NOT EXISTS lora_players (
    user_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    rating INTEGER NOT NULL DEFAULT 1000,
    games_played INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS match_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    ended_at TEXT NOT NULL DEFAULT (datetime('now')),
    rated INTEGER NOT NULL,
    seats_json TEXT NOT NULL,
    scores_json TEXT NOT NULL,
    rating_deltas_json TEXT NOT NULL,
    history_json TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS active_rooms (
    code TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Statistika za admin panel: ko je bio online kog dana (prijavljeni) i
  // koliko je posetilaca otvorilo igru (i oni bez naloga, protiv računara).
  // visitor je nasumičan id iz localStorage — nema ličnih podataka.
  db.run(`CREATE TABLE IF NOT EXISTS player_days (
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    PRIMARY KEY (user_id, day)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS visits (
    day TEXT NOT NULL,
    visitor TEXT NOT NULL,
    PRIMARY KEY (day, visitor)
  )`);
  const cols = all<{ name: string }>('PRAGMA table_info(lora_players)').map(c => c.name);
  if (!cols.includes('last_seen_at')) db.run('ALTER TABLE lora_players ADD COLUMN last_seen_at TEXT');
  persist();
}

let persistTimer: NodeJS.Timeout | null = null;

export function persist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
    persistTimer = null;
  }, 2000);
}

/** Odmah upiši (SIGTERM/pm2 restart), bez čekanja debounce-a. */
export function flushPersist(): void {
  if (!db) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

type Param = string | number | null;

export function run(sql: string, params: Param[] = []): void {
  db.run(sql, params);
  persist();
}

export function get<T = Record<string, unknown>>(sql: string, params: Param[] = []): T | undefined {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? (stmt.getAsObject() as T) : undefined;
  stmt.free();
  return row;
}

export function all<T = Record<string, unknown>>(sql: string, params: Param[] = []): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as T);
  stmt.free();
  return rows;
}

// ---------- igrači ----------

/** Upiši/osveži igrača (ime se menja u preferans nalogu, pa se osvežava pri svakoj konekciji). */
export function upsertPlayer(userId: number, name: string): void {
  run(
    `INSERT INTO lora_players (user_id, name) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET name = excluded.name`,
    [userId, name],
  );
}

/** Prijavljen igrač se povezao — beleži dan (za "aktivni danas/7/30 dana") i poslednji dolazak. */
export function markActive(userId: number): void {
  run("INSERT OR IGNORE INTO player_days (user_id, day) VALUES (?, date('now'))", [userId]);
  run("UPDATE lora_players SET last_seen_at = datetime('now') WHERE user_id = ?", [userId]);
}

export function recordVisit(visitor: string): void {
  run("INSERT OR IGNORE INTO visits (day, visitor) VALUES (date('now'), ?)", [visitor]);
}

export function getRating(userId: number): number {
  return get<{ rating: number }>('SELECT rating FROM lora_players WHERE user_id = ?', [userId])?.rating ?? 1000;
}

export function updateRating(userId: number, rating: number): void {
  run('UPDATE lora_players SET rating = ?, games_played = games_played + 1 WHERE user_id = ?', [rating, userId]);
}

export function topPlayers(limit = 20): { user_id: number; name: string; rating: number; games_played: number }[] {
  return all('SELECT user_id, name, rating, games_played FROM lora_players WHERE games_played > 0 ORDER BY rating DESC LIMIT ?', [limit]);
}

// ---------- istorija ----------

export function saveMatchLog(e: {
  roomCode: string; rated: boolean; seats: unknown; scores: number[]; deltas: number[]; history: unknown;
}): void {
  run(
    `INSERT INTO match_log (room_code, rated, seats_json, scores_json, rating_deltas_json, history_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [e.roomCode, e.rated ? 1 : 0, JSON.stringify(e.seats), JSON.stringify(e.scores), JSON.stringify(e.deltas), JSON.stringify(e.history)],
  );
}

export function matchesForUser(userId: number, limit = 50): unknown[] {
  // seats_json sadrži userId-jeve; LIKE je dovoljan za ovu količinu podataka
  return all(
    `SELECT id, room_code, ended_at, rated, seats_json, scores_json, rating_deltas_json
     FROM match_log WHERE seats_json LIKE ? ORDER BY id DESC LIMIT ?`,
    [`%"userId":${userId},%`, limit],
  );
}

// ---------- aktivne sobe (preživljavaju restart/deploy) ----------

export function saveActiveRoom(code: string, stateJson: string): void {
  run(
    `INSERT INTO active_rooms (code, state_json, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(code) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    [code, stateJson],
  );
}

export function deleteActiveRoom(code: string): void {
  run('DELETE FROM active_rooms WHERE code = ?', [code]);
}

export function getAllActiveRooms(): { code: string; state_json: string }[] {
  return all('SELECT code, state_json FROM active_rooms');
}

// ---------- preračunavanje rejtinga (posle promene formule) ----------

/**
 * Vrati sve na 1000 i ponovo odigraj sve rangirane mečeve redom, novom formulom.
 * Ažurira i rating_deltas_json u istoriji. Ručne izmene rejtinga iz admina se gube.
 */
export function recomputeRatings(deltasFor: (scores: number[], ratings: number[]) => number[]): { matches: number; players: number } {
  run('UPDATE lora_players SET rating = 1000, games_played = 0');
  const ratings = new Map<number, number>();
  const games = new Map<number, number>();
  const rows = all<{ id: number; seats_json: string; scores_json: string }>(
    'SELECT id, seats_json, scores_json FROM match_log WHERE rated = 1 ORDER BY id',
  );
  for (const m of rows) {
    const seats = JSON.parse(m.seats_json) as { userId: number | null }[];
    const scores = JSON.parse(m.scores_json) as number[];
    const before = seats.map(s => (s.userId !== null ? ratings.get(s.userId) ?? 1000 : 1000));
    const deltas = deltasFor(scores, before);
    seats.forEach((s, i) => {
      if (s.userId === null) return;
      ratings.set(s.userId, before[i] + deltas[i]);
      games.set(s.userId, (games.get(s.userId) ?? 0) + 1);
    });
    run('UPDATE match_log SET rating_deltas_json = ? WHERE id = ?', [JSON.stringify(deltas), m.id]);
  }
  for (const [uid, r] of ratings) {
    run('UPDATE lora_players SET rating = ?, games_played = ? WHERE user_id = ?', [r, games.get(uid) ?? 0, uid]);
  }
  return { matches: rows.length, players: ratings.size };
}
