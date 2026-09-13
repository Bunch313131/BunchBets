import fs from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
initializeApp({ credential: cert(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))) });
const db = getFirestore();
const tries = [
  ['pendingInvites(): email + status', () => db.collection('invites')
      .where('email','==','bunch3131@gmail.com').where('status','==','pending').get()],
  ['groupPool(): array-contains',      () => db.collection('golfers')
      .where('poolGroupIds','array-contains','nunes').get()],
  ['myRounds(): createdByUid + limit',  () => db.collection('rounds')
      .where('createdByUid','==','LVrINx3a57T8w7NkBvNLIs9hwBz2').limit(50).get()],
  ['groupRounds(): groupId + limit',    () => db.collection('rounds')
      .where('groupId','==','nunes').limit(200).get()],
];
for (const [label, run] of tries) {
  try { const s = await run(); console.log(`  ok    ${label}  -> ${s.size} docs`); }
  catch (e) { console.log(`  FAIL  ${label}\n          ${e.code || ''} ${String(e.message).slice(0,260)}`); }
}
