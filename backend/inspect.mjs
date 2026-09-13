/**
 * Read back what is actually in Firestore.
 *
 * Admin credentials BYPASS security rules, so this shows ground truth — never
 * what a client is allowed to see. For that, drive the real client against the
 * real rules (cloud.test.mjs).
 *
 *   node backend/inspect.mjs <key>.json                  # summary + the seeded group
 *   node backend/inspect.mjs <key>.json golfers/ghin:123 # dump one document
 *
 * Run from inside backend/ so firebase-admin resolves.
 */
import fs from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const [keyPath, docPath, groupId = 'nunes'] = process.argv.slice(2);
initializeApp({ credential: cert(JSON.parse(fs.readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

if (docPath) {
  const d = await db.doc(docPath).get();
  console.log(d.exists ? JSON.stringify(d.data(), null, 2) : `${docPath} does not exist`);
  process.exit(0);
}

for (const c of ['groups', 'golfers', 'invites', 'users', 'rounds']) {
  console.log(`${c.padEnd(9)} ${String((await db.collection(c).get()).size).padStart(3)} docs`);
}

const g = (await db.doc(`groups/${groupId}`).get()).data() || {};
console.log(`\ngroups/${groupId}`);
console.log('  name          :', g.name);
console.log('  ownerUid      :', g.ownerUid);
console.log('  memberUids    :', JSON.stringify(g.memberUids));
console.log('  poolGolferIds :', (g.poolGolferIds || []).length, 'golfers');

// The exact query the client issues for a group pool.
const pool = await db.collection('golfers').where('poolGroupIds', 'array-contains', groupId).get();
console.log(`\npool query (array-contains ${groupId}): ${pool.size} golfers`);
pool.docs.slice(0, 3).forEach((s) => {
  const v = s.data();
  console.log(`  ${s.id.padEnd(16)} ${String(v.name).padEnd(18)} idx ${String(v.currentIndex).padEnd(6)}`
    + `claimed ${v.claimedByUid} discoverable ${v.discoverable}`);
});
const unclaimed = pool.docs.filter((d) => d.data().claimedByUid == null).length;
console.log(`  ${unclaimed} of ${pool.size} unclaimed — golfers, not users`);

const pending = await db.collection('invites').where('status', '==', 'pending').get();
console.log(`\npending invites: ${pending.size}`);
