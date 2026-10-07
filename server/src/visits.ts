// Posete (anonimno): odakle je posetilac došao, sa kog uređaja, koju stranicu je otvorio.
// Bez IP adrese, imena i kolačića — samo nasumični id pregledača (isti kao za /api/visit).
// Jedan red po "dolasku": novi red tek ako isti pregledač nije bio aktivan 30 minuta.

import { all, get, run } from './db.js';

/** Izvor posete iz referera / ?utm_source / ?room. */
export function classifySource(ref: string, src: string): string {
  if (src === 'room') return 'Link sobe';
  if (src) return src.slice(0, 30);
  let host = '';
  try { host = new URL(ref).hostname.replace(/^www\./, ''); } catch { /* bez referera */ }
  if (!host) return 'Direktno';
  const known: [RegExp, string][] = [
    [/(^|\.)google\./, 'Google'], [/(^|\.)bing\.com$/, 'Bing'], [/duckduckgo\.com$/, 'DuckDuckGo'], [/yandex\./, 'Yandex'],
    [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'Facebook'], [/instagram\.com$/, 'Instagram'], [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'X / Twitter'],
    [/reddit\.com$/, 'Reddit'], [/viber\.com$/, 'Viber'], [/whatsapp\.com$/, 'WhatsApp'], [/klix\.ba$/, 'Klix.ba'],
    [/^igrajmo\.online$/, 'igrajmo.online'], [/^preferans\.igrajmo\.online$/, 'Preferans'], [/antonije\.dev$/, 'antonije.dev'],
  ];
  for (const [re, name] of known) if (re.test(host)) return name;
  return host.slice(0, 40);
}

/** Uređaj, pregledač i sistem iz User-Agent zaglavlja (grubo, dovoljno za pregled). */
export function parseAgent(ua: string, app: boolean): { device: string; browser: string; os: string } {
  const device = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'telefon' : 'računar';
  const browser =
    /FBAN|FBAV|FB_IAB/.test(ua) ? 'Facebook (u aplikaciji)' :
    /Instagram/.test(ua) ? 'Instagram (u aplikaciji)' :
    /Viber/i.test(ua) ? 'Viber (u aplikaciji)' :
    /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung' :
    /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'drugi';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' :
    /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'drugi';
  return { device: app ? `${device} (aplikacija)` : device, browser, os };
}

export function logVisit(v: { visitor: string; page: string; source: string; device: string; browser: string; os: string }): void {
  const recent = get<{ id: number }>(
    "SELECT id FROM visit_log WHERE visitor = ? AND ts >= datetime('now', '-30 minutes') ORDER BY id DESC LIMIT 1", [v.visitor],
  );
  if (recent) { run("UPDATE visit_log SET last_ts = datetime('now') WHERE id = ?", [recent.id]); return; }
  run(
    `INSERT INTO visit_log (ts, last_ts, day, visitor, page, source, device, browser, os)
     VALUES (datetime('now'), datetime('now'), date('now'), ?, ?, ?, ?, ?, ?)`,
    [v.visitor, v.page, v.source, v.device, v.browser, v.os],
  );
}

/** Za admin karticu "Posete". */
export function visitsReport() {
  const since30 = "date('now', '-29 days')";
  const group = (col: string) => all<{ k: string; c: number }>(
    `SELECT ${col} AS k, COUNT(DISTINCT visitor) AS c FROM visit_log WHERE day >= ${since30} GROUP BY ${col} ORDER BY c DESC`,
  );
  const recent = all<{ id: number; ts: string; visitor: string; page: string; source: string; device: string; browser: string; os: string; day: string }>(
    'SELECT id, ts, visitor, page, source, device, browser, os, day FROM visit_log ORDER BY id DESC LIMIT 150',
  ).map(r => {
    const played = get<{ s: number; f: number }>(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'local_start' THEN n END), 0) AS s, COALESCE(SUM(CASE WHEN kind = 'local_finish' THEN n END), 0) AS f
       FROM visit_events WHERE visitor = ? AND day = ?`, [r.visitor, r.day],
    );
    const player = get<{ name: string }>('SELECT name FROM lora_players WHERE visitor = ?', [r.visitor]);
    const firstSeen = get<{ d: string }>('SELECT MIN(day) AS d FROM visits WHERE visitor = ?', [r.visitor])?.d;
    return {
      ts: r.ts, page: r.page, source: r.source, device: r.device, browser: r.browser, os: r.os,
      localStarted: played?.s ?? 0, localFinished: played?.f ?? 0,
      account: player?.name ?? null, returning: !!firstSeen && firstSeen < r.day,
      who: r.visitor.slice(0, 4), // kratka oznaka da se vidi da je isti pregledač, bez punog id-a
    };
  });
  const count = (sql: string) => get<{ c: number }>(sql)?.c ?? 0;
  return {
    today: count("SELECT COUNT(*) AS c FROM visit_log WHERE day = date('now')"),
    uniqueToday: count("SELECT COUNT(DISTINCT visitor) AS c FROM visit_log WHERE day = date('now')"),
    unique7: count("SELECT COUNT(DISTINCT visitor) AS c FROM visit_log WHERE day >= date('now', '-6 days')"),
    unique30: count(`SELECT COUNT(DISTINCT visitor) AS c FROM visit_log WHERE day >= ${since30}`),
    bySource: group('source'),
    byDevice: group('device'),
    byPage: group('page'),
    recent,
  };
}
