import type { Request, Response, NextFunction } from 'express';

// Namerno bez dodatne zavisnosti (npm express-rate-limit) — projekat vec
// svuda koristi rucno pisano in-memory stanje za slicne stvari
// (RoomManager.ts, presence.ts), isti stil ovde. Dovoljno za JEDAN Node
// proces (fork mode, bez klastera) — ako se ikad skalira na vise instanci,
// ovo mora u deljeno stanje (Redis i sl.), Map ovde ne bi radila ispravno.
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Povremeno cisti istekle unose — bez ovoga bi Map rasla unedogled (retko
// pozvane rute, npr. register, nikad same ne bi "izbacile" svoj unos).
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

/**
 * Fiksni prozor (ne klizni) po IP adresi — dovoljno za odbranu od
 * brute-force/mass-signup bez slozenosti tacnog sliding-window algoritma.
 * Zahteva `app.set('trust proxy', 1)` da req.ip bude STVARNA klijentska
 * adresa iza nginx-a, ne sama proxy masina (vidi index.ts).
 */
export function rateLimit(options: { windowMs: number; max: number; keyPrefix: string; message?: string }) {
  const { windowMs, max, keyPrefix, message } = options;
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      res.status(429).json({ error: message ?? 'Previše pokušaja. Pokušajte ponovo kasnije.' });
      return;
    }
    next();
  };
}
