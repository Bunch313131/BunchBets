import fs from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
initializeApp({ credential: cert(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))) });
const db = getFirestore();
const snap = await db.collection('rounds').get();
console.log(snap.size + ' round(s) in the cloud\n');
snap.forEach((d) => {
  const r = d.data();
  console.log('  ' + d.id);
  console.log('    date        :', r.date);
  console.log('    course      :', r.courseName, '| startingHole', r.startingHole);
  console.log('    groupId     :', r.groupId);
  console.log('    createdByUid:', r.createdByUid);
  console.log('    appVersion  :', r.appVersion);
  console.log('    golferIds   :', JSON.stringify(r.golferIds));
  if ((r.unmatchedNames || []).length) console.log('    UNMATCHED   :', JSON.stringify(r.unmatchedNames));
  console.log('    games       :', (r.games || []).map((g) => g.gameType).join(', ') || '(none)');
  console.log('    results:');
  for (const [gid, v] of Object.entries(r.results || {})) {
    console.log(`      ${gid.padEnd(22)} ${String(v.name).padEnd(18)} money ${String(v.money).padStart(5)}  `
      + `gross ${v.gross === null ? ' n/a' : String(v.gross).padStart(4)}  holes ${v.holes}  hcp ${v.handicap}`);
  }
  console.log('');
});
