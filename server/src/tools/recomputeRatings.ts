// Jednokratno preračunavanje rejtinga nad bazom, dok server NE radi
// (sql.js drži bazu u memoriji — pokrenut server bi pregazio izmene).
// Na serveru: pm2 stop lora-server && node dist/tools/recomputeRatings.js && pm2 start lora-server
// Dok server radi, isto radi dugme "Preračunaj rejting" u admin panelu.

import 'dotenv/config';
import { initDb, recomputeRatings, flushPersist } from '../db.js';
import { ratingDeltas } from '../rooms/driver.js';

await initDb();
const r = recomputeRatings(ratingDeltas);
flushPersist();
console.log(`Preračunato: ${r.matches} rangiranih mečeva, ${r.players} igrača.`);
