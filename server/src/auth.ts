// Nalozi žive u preferans serveru (jedini vlasnik: registracija, lozinke, ban).
// Lora samo: (1) prosleđuje /api/login|register|me, (2) proverava JWT istim
// tajnim ključem, (3) pita /api/me za ime + ban proveru pri svakoj konekciji.

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { rateLimit } from './rateLimit.js';

const AUTH_URL = () => process.env.AUTH_URL || 'http://127.0.0.1:3001';

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

export function verifyToken(token: string): { userId: number } {
  return jwt.verify(token, jwtSecret()) as { userId: number };
}

export interface Me {
  id: number;
  name: string;
  is_admin: boolean;
}

/**
 * Pita preferans server ko je vlasnik tokena. Vraća null za nevažeći token
 * ili banovan nalog (preferans vraća 401/403). Baca grešku samo ako auth
 * server nije dostupan — to je razlika između "ne puštaj" i "pokušaj ponovo".
 */
export async function fetchMe(token: string): Promise<Me | null> {
  const res = await fetch(`${AUTH_URL()}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`auth server: HTTP ${res.status}`);
  const data = (await res.json()) as { user: Me | null };
  return data.user;
}

// Isti limiti kao na preferans serveru — ovde po IP-u stvarnog klijenta
// (trust proxy), jer bi preferans inače video samo 127.0.0.1 za sve.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'login', message: 'Previše pokušaja prijave. Pokušajte ponovo za 15 minuta.' });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: 'register', message: 'Previše pokušaja registracije. Pokušajte ponovo za sat vremena.' });

const ERRORS_SR: Record<string, string> = {
  'Invalid email or password': 'Pogrešan email ili lozinka.',
  'Email already registered': 'Taj email je već registrovan.',
  'email and password are required': 'Unesite email i lozinku.',
  'name is required': 'Unesite ime.',
};

async function forward(path: string, method: 'GET' | 'POST', body: unknown, authorization: string | undefined, clientIp: string) {
  const res = await fetch(`${AUTH_URL()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // Preferans ograničava pokušaje po IP-u (trust proxy 1) — bez ovoga bi svi
      // igrači Lore delili JEDAN limit, jer bi svi zahtevi dolazili sa 127.0.0.1.
      'X-Forwarded-For': clientIp,
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof data.error === 'string') data.error = ERRORS_SR[data.error] ?? data.error;
  return { status: res.status, data };
}

export const authRouter = Router();

function proxy(path: string, method: 'GET' | 'POST') {
  return async (req: import('express').Request, res: import('express').Response) => {
    try {
      const { status, data } = await forward(path, method, req.body, req.headers.authorization, req.ip ?? 'unknown');
      res.status(status).json(data);
    } catch (err) {
      console.error(`[auth proxy] ${path} failed:`, err);
      res.status(503).json({ error: 'Server za naloge trenutno nije dostupan. Pokušajte ponovo.' });
    }
  };
}

authRouter.post('/login', loginLimiter, proxy('/api/login', 'POST'));
authRouter.post('/register', registerLimiter, proxy('/api/register', 'POST'));
authRouter.get('/me', proxy('/api/me', 'GET'));
