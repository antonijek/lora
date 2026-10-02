// Javi Bing-u, Yandex-u i ostalima (IndexNow) da su stranice Lore promenjene,
// da ne čekaju da same dođu. Google IndexNow ne koristi — za njega važi
// sitemap.xml i "Request indexing" u Google Search Console.
// Pokretanje posle deploy-a koji menja tekst stranica: npm run indexnow
// Ključ je u server/src/seo.ts i server ga pokazuje na /<ključ>.txt.

const HOST = 'lora.igrajmo.online';
const KEY = '79033a1f38f6216677370c7b7e06b7db';
const urls = [`https://${HOST}/`, `https://${HOST}/pravila.html`];

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls }),
});
console.log('IndexNow:', res.status, res.statusText, '(200/202 = primljeno)');
if (res.status >= 400) console.log(await res.text().catch(() => ''));
