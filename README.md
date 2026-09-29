# Lora

Web aplikacija za Loru (lore, lorum): vi i 3 računara. Isti principi kao
`D:\preferans` i `D:\tablic`: čist TypeScript engine, AI odvojen od engine-a i tanak Vanilla JS UI.

## Status
- ✅ Engine: 28 partija. Podrazumevani mod je `choice`: delilac se menja svake partije, a igrač posle delioca bira jednu od svojih preostalih igara i igra prvi, pa svako ima svoju tabelu. U modu `fixed` isti delilac igra svih 7 igara redom. Tu su i štih sa obaveznim praćenjem boje, slaganje (Lora), rani kraj kad su sve kaznene karte odnete i podesiv skup igara (`contracts`). Testovi: `npm test`
- ✅ AI bira igru prema ruci: jaka ruka → maksimum, a izbegava igru u kojoj drži nezaštićenu damu, žandara ili kralja herc
- ✅ AI: `easy` (nasumično) i `medium` (heuristike po igri). U 200 mečeva medium ima prosečno 12,6 poena, a easy 44,2, i bolji je u svakoj igri (`npm run sim` u `engine/`)
- ✅ UI: sto za 4 igrača, prikaz završenog štiha, slaganje po bojama, tabela svih 28 igara, čuvanje partije
- ✅ Karte: CC0 SVG set iz preferansa (lora koristi istih 32 karte)
- ✅ **Online** (`server/`, dizajn u [docs/BACKEND.md](docs/BACKEND.md)): prijava istim nalogom kao Preferans, lobi, brza igra, sobe sa kodom/linkom, pozivi, chat, AI popunjava prazna mesta i igra za igrače bez veze, rejting (ELO, samo sa ≥2 čoveka), sobe preživljavaju restart
- 🌐 Uživo: https://lora.antonije.dev/ (pm2 `lora-server`, port 3002)
- ⏳ Jači AI, PWA, zajedničko jezgro platforme sa preferansom i tablićem

## Pravila (podrazumevana varijanta)
| Igra | Bodovanje |
|---|---|
| Maksimum | −1 po štihu |
| Minimum | +1 po štihu |
| Herc | +1 po hercu; svih 8 → −8 |
| Dame | +2 po dami |
| Žandar tref | +8 |
| Kralj herc i poslednji | +4 kralj herc, +4 poslednji štih |
| Lora | prvi koji se oslobodi karata −8 (samo ako nije rekao „dalje“), ostali +1 po karti; svako „dalje“ +1 |

Izvor: legalbet.rs („Lora: kompletna pravila“). Varijante se razlikuju po krajevima,
pa su redosled i izbor igara podesivi, a bodovanje je u `engine/src/contracts.ts`.

## Online — lokalno
```bash
cd engine && npm run build && cd ../server && npm install && npm run build
# potreban i preferans server (nalozi) sa ISTIM JWT_SECRET, npr. na 3001
cp .env.example .env   # upisati JWT_SECRET
npm start              # http://localhost:3002/
npm run test:server    # e2e: 2 čoveka + 2 AI, ceo meč, reconnect, restart
npm run test:online    # isto kroz dva browsera
```

## Deploy
`npm run deploy` (= `sh tools/deploy.sh`). Prvi put: `sh tools/deploy.sh --setup` (nginx + sertifikat).

## Pokretanje
```bash
cd engine && npm install && npm run build && cd ..
npm install
node tools/serve.js      # http://localhost:8002/
npm run test:ui          # ceo meč kroz UI u headless Chromium-u (koristi ?fast)
```
