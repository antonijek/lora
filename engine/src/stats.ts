// Lična statistika i rekordi igrača — isti proračun za igru protiv računara
// (zapisi u browseru) i za online (zapisi iz match_log na serveru).
// Manje poena je bolje: i za ceo meč i za svaku partiju.

import type { ContractId, DealResult, Position } from './types.js';
import { CONTRACT_NAMES } from './contracts.js';

/** Jedan završen meč iz ugla jednog igrača. */
export interface MatchRecord {
  /** Datum kraja meča, 'YYYY-MM-DD…' (dovoljno je da počinje datumom). */
  date: string;
  scores: number[];
  seat: Position;
  history: DealResult[];
}

export interface Best {
  points: number;
  date: string;
}

export interface PlayerStats {
  matches: number;
  wins: number;
  /** Najmanje poena u celom meču. */
  bestMatch: Best | null;
  avgScore: number | null;
  /** Najbolja (najmanja) partija po igri — sve partije u kojima je igrao, ne samo one koje je on birao. */
  bestDeal: Partial<Record<ContractId, Best>>;
}

export function computeStats(records: readonly MatchRecord[]): PlayerStats {
  const stats: PlayerStats = { matches: 0, wins: 0, bestMatch: null, avgScore: null, bestDeal: {} };
  let total = 0;
  for (const r of records) {
    const mine = r.scores[r.seat];
    stats.matches++;
    total += mine;
    if (mine === Math.min(...r.scores)) stats.wins++;
    if (!stats.bestMatch || mine < stats.bestMatch.points) stats.bestMatch = { points: mine, date: r.date };
    for (const d of r.history) {
      const p = d.points[r.seat];
      const cur = stats.bestDeal[d.contract];
      if (!cur || p < cur.points) stats.bestDeal[d.contract] = { points: p, date: r.date };
    }
  }
  if (stats.matches) stats.avgScore = Math.round((total / stats.matches) * 10) / 10;
  return stats;
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/**
 * Šta je u ovom meču novi lični rekord (strogo bolje od dosadašnjeg).
 * Prvi meč nikad ne daje rekorde — sve bi bilo "rekord".
 */
export function newRecords(prev: PlayerStats, rec: MatchRecord): string[] {
  if (prev.matches === 0) return [];
  const out: string[] = [];
  const mine = rec.scores[rec.seat];
  if (prev.bestMatch && mine < prev.bestMatch.points) {
    // ukupni poeni se svuda pišu bez plusa (kao u tabeli), samo minus ako ga ima
    out.push(`Najbolji meč: ${mine} poena (ranije ${prev.bestMatch.points})`);
  }
  const seen = new Set<ContractId>();
  for (const d of rec.history) {
    const p = d.points[rec.seat];
    const old = prev.bestDeal[d.contract];
    if (old && p < old.points && !seen.has(d.contract)) {
      // u meču ima 4 partije iste igre — prijavi najbolju od njih
      const bestHere = Math.min(...rec.history.filter(h => h.contract === d.contract).map(h => h.points[rec.seat]));
      out.push(`${CONTRACT_NAMES[d.contract]} — najbolje ${signed(bestHere)} (ranije ${signed(old.points)})`);
      seen.add(d.contract);
    }
  }
  return out;
}

/** Niz dana zaredom (danas ili juče uključeno) i najduži niz. days: 'YYYY-MM-DD'. */
export function streak(days: readonly string[], today: string): { current: number; best: number } {
  const set = new Set(days.map(d => d.slice(0, 10)));
  const sorted = [...set].sort();
  const dayNum = (d: string) => Math.round(Date.parse(d + 'T00:00:00Z') / 86_400_000);
  let best = 0;
  let run = 0;
  let prevNum: number | null = null;
  for (const d of sorted) {
    const n = dayNum(d);
    run = prevNum !== null && n === prevNum + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prevNum = n;
  }
  // tekući niz: mora da uključi danas ili juče (inače je prekinut)
  const t = dayNum(today);
  let current = 0;
  let start = set.has(today) ? t : set.has(new Date((t - 1) * 86_400_000).toISOString().slice(0, 10)) ? t - 1 : null;
  while (start !== null && set.has(new Date(start * 86_400_000).toISOString().slice(0, 10))) {
    current++;
    start--;
  }
  return { current, best };
}
