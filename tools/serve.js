// Jednostavan HTTP server za razvoj.
// Pokretanje: cd D:\tablic && node tools/serve.js
// Otvoriti: http://localhost:8002/

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const PORT = Number(process.env.PORT ?? 8002);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  // brojač poseta i događaji (pravi server: server/src) — ovde se samo prime, da stranice ne javljaju grešku
  if (req.method === 'POST' && (path === '/api/visit' || path === '/api/event')) { res.writeHead(204); res.end(); return; }
  if (path === '/') path = '/lora.html';
  const filePath = normalize(join(ROOT, path));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const s = await stat(filePath);
    if (!s.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`LORA server: http://localhost:${PORT}/`);
});
