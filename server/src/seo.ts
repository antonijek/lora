// Sve za pretraživače i pregled linkova: robots.txt, sitemap.xml, IndexNow ključ
// i pregled linka sobe ("Poziv na Loru — soba ABCDE") u Viberu/WhatsApp-u.
// Stranice (lora.html, pravila.html) same nose naslov, opis, Open Graph i JSON-LD.

import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';

export const SITE = (process.env.SITE_URL || 'https://lora.igrajmo.online').replace(/\/$/, '');
/** IndexNow (Bing, Yandex…): ključ mora biti dostupan na /<ključ>.txt — vidi tools/notify-indexnow.mjs. */
export const INDEXNOW_KEY = '79033a1f38f6216677370c7b7e06b7db';

const PAGES = [
  { loc: '/', file: 'lora.html', changefreq: 'weekly', priority: '1.0' },
  { loc: '/pravila.html', file: 'pravila.html', changefreq: 'monthly', priority: '0.8' },
];

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function seoRouter(root: string): Router {
  const router = Router();

  router.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send(
      ['User-agent: *', 'Allow: /', 'Disallow: /admin.html', 'Disallow: /api/', '', `Sitemap: ${SITE}/sitemap.xml`, ''].join('\n'),
    );
  });

  // lastmod = kada je stranica poslednji put menjana (datum fajla posle deploy-a)
  router.get('/sitemap.xml', (_req, res) => {
    const urls = PAGES.map(p => {
      let lastmod = '';
      try { lastmod = fs.statSync(path.join(root, p.file)).mtime.toISOString().slice(0, 10); } catch { /* nema fajla */ }
      return `  <url>\n    <loc>${SITE}${p.loc}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}` +
        `    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`;
    });
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
    );
  });

  router.get(`/${INDEXNOW_KEY}.txt`, (_req, res) => res.type('text/plain').send(INDEXNOW_KEY));

  // Link sobe (?room=ABCDE) koji se pošalje prijatelju: pregled u Viberu/WhatsApp-u
  // kaže da je to poziv u sobu. Ti programi ne izvršavaju JavaScript — čitaju samo
  // <meta> iz HTML-a, pa ih server menja pre slanja. Bez ?room stranica ide neizmenjena.
  router.get(['/', '/lora.html'], (req, res, next) => {
    const room = String(req.query.room ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(room)) return next();
    let html: string;
    try { html = fs.readFileSync(path.join(root, 'lora.html'), 'utf8'); } catch { return next(); }
    const title = esc(`Poziv na Loru — soba ${room}`);
    const desc = esc(`Pridruži se partiji Lore u sobi ${room}. Besplatno, u pregledaču, bez instaliranja.`);
    const url = esc(`${SITE}/?room=${room}`);
    html = html
      .replace(/(<meta property="og:title" content=")[^"]*/, `$1${title}`)
      .replace(/(<meta property="og:description" content=")[^"]*/, `$1${desc}`)
      .replace(/(<meta property="og:url" content=")[^"]*/, `$1${url}`)
      .replace(/(<meta name="twitter:title" content=")[^"]*/, `$1${title}`)
      .replace(/(<meta name="twitter:description" content=")[^"]*/, `$1${desc}`)
      // link sobe nije posebna stranica za pretragu — kanonski je početna (već u <link rel="canonical">)
      .replace('</head>', '  <meta name="robots" content="noindex">\n</head>');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });

  return router;
}
