# Lora — online backend (dizajn)

Cilj: online Lora sa pravim ljudima. Ako nema dovoljno ljudi, prazna mesta popunjava AI.
Server je napravljen po uzoru na `D:\preferans\server` (isti stack, obrasci i zaštite),
da bi se kasnije lako spojio u zajedničko jezgro platforme.

## 1. Arhitektura

```
 browser (lora.html + app.js)
      │  HTTP /api/*            │  WebSocket (socket.io)
      ▼                         ▼
 ┌──────────────── lora-server (Node, port 3002) ───────────────┐
 │ express static (lora.html, app.js, engine/dist, icons)       │
 │ /api/login|register|me  ──proxy──►  pref-server :3001        │  ← nalozi žive SAMO u preferans bazi
 │ socket.io: sobe, igra, chat, prisustvo                       │
 │ engine/dist (LoraGame, AI) — server je jedini izvor istine   │
 │ sql.js baza lora.db: lora_players, match_log, active_rooms   │
 └──────────────────────────────────────────────────────────────┘
```

**Zašto se nalozi ne kopiraju:** preferans koristi sql.js, a sql.js drži celu bazu u memoriji
jednog procesa i prepisuje fajl. Dva procesa nad istim `data.db` bi se međusobno pregazila.
Zato je preferans server jedini vlasnik naloga (registracija, lozinke, ban). Lora:
- prosleđuje `/api/login`, `/api/register` i `/api/me` na `AUTH_URL` (preferans, localhost);
- proverava JWT potpisan **istim** `JWT_SECRET`;
- pri svakoj socket konekciji pita `/api/me`. Tako dobija ime, a ban važi odmah,
  jer preferans vraća 403 za banovan nalog.

Jedan nalog važi za obe igre. Kad platforma dobije zajedničko jezgro, ovaj proxy se zameni
direktnim pozivom.

## 2. Šta je preuzeto iz preferans servera

| Preferans | Lora | Napomena |
|---|---|---|
| `db.ts` (sql.js, debounce `persist`, `flushPersist`) | isti obrazac | druge tabele |
| `rateLimit.ts` | kopija | login/register limit na proxy-ju |
| `presence.ts` | kopija | rejting iz lora baze |
| `socket/index.ts` `wrapSocketErrors` | kopija | jedan loš zahtev ne sme da sruši proces |
| `io.use` auth + ban provera | isto, preko `/api/me` | |
| `RoomManager` (kodovi soba, `userLocation`, cleanup, persist/restore) | prošireno na 4 mesta + AI mesta | |
| `broadcastRoomState` kao jedino mesto za promene | isto | persist + AI + auto-nastavak + rejting |
| `withAuthenticatedActor` (klijent ne bira sedište) | isto | |
| `redact` | `LoraGame.getPlayerView(seat)` | engine već skriva tuđe karte |
| reconnect (`room:none` ili stanje odmah pri konekciji) | isto | |
| kraj meča: rejting + `match_log` tačno jednom | isto (`ratingResolved`) | |
| SIGTERM/uncaught flush baze | isto | |
| `Cache-Control: no-cache` za statiku | isto | |

## 3. Sobe i mesta

Mesto (`Seat`): `{ kind: 'empty' | 'human' | 'ai', userId, name, formerUserId }`.

Tok sobe:
1. **WAITING**: domaćin pravi sobu, dobija kod od 5 znakova i deli ga ili poziva ljude koji su online.
   - „Brza igra“ ulazi u prvu otvorenu sobu, a ako je nema, pravi novu.
   - Domaćin može da doda AI na prazno mesto ili da klikne **„Počni“**, pa AI popuni sva prazna mesta.
   - Kad se skupe 4 čoveka, igra počinje sama.
2. **PLAYING**: server drži `LoraGame`. Svaki igrač dobija samo svoj `PlayerView`.
3. **DEAL_END**: sledeća partija kreće kad svi povezani ljudi kliknu „Dalje“, ili posle 8 s.
4. **MATCH_END**: rejting i `match_log` se upisuju jednom. Igrači se vraćaju u lobi (`room:leaveFinished`).

Kada nema ljudi:
- **Napusti** usred meča: mesto preuzima AI do kraja. Ako se isti čovek vrati istim kodom,
  vraća mu se mesto (`formerUserId`).
- **Pad veze**: mesto ostaje njegovo i čeka reconnect. Ako je on na potezu, AI igra umesto
  njega posle 20 s, da ostali ne čekaju. Posle reconnect-a igra opet sam.
- Soba u WAITING bez ijednog povezanog čoveka briše se odmah. Stare prazne sobe čisti
  čišćenje na 5 min (isto kao preferans).

## 4. Protokol (socket.io)

Klijent → server:

| događaj | payload | ack |
|---|---|---|
| `room:list` | — | `{ rooms }` |
| `room:create` | `{ aiLevel }` | `{ code }` / `{ error }` |
| `room:join` | `{ code }` | `{ code }` / `{ error }` |
| `room:quick` | — | `{ code }` |
| `room:addAi` / `room:removeAi` | `{ seat }` | domaćin |
| `room:start` | — | domaćin; prazna mesta dobijaju AI |
| `room:leave` | — | WAITING: oslobodi mesto; PLAYING: AI preuzima |
| `room:leaveFinished` | — | posle kraja meča |
| `room:invite` | `{ userId }` | |
| `game:action` | `{ type:'choose', contract }` / `{ type:'play', cardId }` / `{ type:'pass' }` | |
| `game:ready` | — | „Dalje“ posle partije |
| `chat:send` | `{ text }` | |
| `presence:list` | — | `{ users }` |

Server → klijent: `room:none`, `room:state` (ceo prikaz sobe za tog igrača), `chat:message`,
`chat:backlog`, `room:invited`, `game:error`.

`room:state` = `{ code, status, hostSeat, mySeat, seats[], ready[], view, rating }`, gde je
`view` rezultat `getPlayerView(mySeat)`. Klijent dobija samo ono što sme da vidi.

## 5. AI na serveru

- Koristi isti `chooseAction` iz `engine/dist/ai.js` kao igra protiv računara.
- Pauze da ljudi stignu da isprate: 700 ms po potezu, 1400 ms posle završenog štiha,
  1200 ms za izbor igre.
- Tajmer se zakazuje iz `broadcastRoomState` i uvek ponovo proverava stanje, jer se
  soba u međuvremenu može promeniti.

## 6. Rejting

- Svako ima lora rejting (početno 1000) u tabeli `lora_players`, odvojen od preferansa.
- ELO za više igrača: svaki par igrača je jedan „duel“ (manje poena je bolje), K = 32. Duel nije samo pobeda ili poraz: jednaki poeni daju 0,5, razlika od 40 i više poena je puna pobeda, a između se računa srazmerno. Tako skoro isti poeni više ne donose ±5. Zbir iz sva tri duela se deli sa 3.
- AI ima fiksnih 1000 i ne menja se.
- **Rangirano je samo ako su bar 2 čoveka seli za sto na početku.** Protiv 3 AI se rejting
  ne menja, da se ne bi „farmao“ protiv računara.

## 7. Baza (`lora.db`)

- `lora_players(user_id PK, name, rating, games_played, created_at)`
- `match_log(id, room_code, ended_at, rated, seats_json, scores_json, rating_deltas_json, history_json)`
- `active_rooms(code PK, state_json, updated_at)`: sobe u toku prežive restart i deploy.

## 8. Produkcija

- `pm2` proces `lora-server`, port 3002, folder `/var/www/lora`.
- `.env`: `PORT=3002`, `AUTH_URL=http://127.0.0.1:3001`, `JWT_SECRET` (isti kao preferans;
  deploy skripta ga kopira na serveru, ne prolazi kroz git), `DB_PATH=/var/www/lora/server/lora.db`.
- nginx: dok nema novog domena, radi na `antonije.dev/lora/` (location `/lora/` → `127.0.0.1:3002`).
  Klijent koristi samo relativne putanje i socket.io path izveden iz URL-a, pa isti kod
  radi i na podputanji i na sopstvenom domenu.
- `tools/deploy.sh`: `git archive` → ssh → `npm ci` → build engine i servera → provera dist-a
  → `pm2 startOrReload`. Build mora da uspe pre restarta (lekcija iz preferans STATUS.md).
