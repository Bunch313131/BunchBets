/**
 * Is a project ready for accounts? Run against production before launch.
 *
 * Two things the app needs that nothing on screen would explain if missing:
 *
 *   INDEXES. Every composite index in firestore.indexes.json must exist and be
 *   READY. A missing one makes a query throw, which the app reports as a failed
 *   load of history or invitations rather than as a missing index.
 *
 *   STALE CLAIMS. Auth accounts are per project. copy-project.mjs rewrote only
 *   the owner's uid, so anyone who accepted an invitation in beta arrives here
 *   with an invitation marked accepted, a golfer claimed by a uid that does not
 *   exist in this project, and that dead uid in the group's memberUids. Signing
 *   in finds no pending invitation, so they never join, and their golfer looks
 *   taken. --fix puts each such invitation back to pending and releases the
 *   golfer, so accepting it on production works exactly as it did in beta.
 *
 * A uid is "stale" when it is not an Auth account in THIS project. Real
 * accounts are never touched.
 *
 * Dry run by default.
 *
 *   node check-prod.mjs <key>.json [--fix]
 */
import fs from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const [KEY_PATH] = args.filter((a) => !a.startsWith('--'));
if (!KEY_PATH) { console.error('usage: check-prod.mjs <key>.json [--fix]'); process.exit(1); }

const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
const app = initializeApp({ credential: cert(key) });
const db = getFirestore();
let problems = 0;

console.log(`project ${key.project_id}\n`);

// ---------------------------------------------------------------- indexes
console.log('INDEXES');
const { access_token } = await app.options.credential.getAccessToken();
const ir = await fetch(`https://firestore.googleapis.com/v1/projects/${key.project_id}` +
  '/databases/(default)/collectionGroups/-/indexes', { headers: { Authorization: 'Bearer ' + access_token } });
const live = ir.ok ? ((await ir.json()).indexes || []) : null;
if (!live) {
  console.log(`  could not list indexes (${ir.status}) — check them in the console`);
  problems++;
} else {
  const sig = (cg, fields) => cg + ':' + fields
    .filter((f) => f.fieldPath !== '__name__')
    .map((f) => `${f.fieldPath}/${f.order || f.arrayConfig}`).join(',');
  const have = {};
  for (const ix of live) have[sig(ix.name.split('/collectionGroups/')[1].split('/')[0], ix.fields)] = ix.state;
  const want = JSON.parse(fs.readFileSync(new URL('./firestore.indexes.json', import.meta.url))).indexes;
  for (const w of want) {
    const s = sig(w.collectionGroup, w.fields);
    const state = have[s];
    if (state !== 'READY') problems++;
    console.log(`  ${state === 'READY' ? 'ok     ' : 'MISSING'}  ${s}${state && state !== 'READY' ? '  (' + state + ')' : ''}`);
  }
}

// ----------------------------------------------------------------- claims
const uids = new Set();
let page;
do {
  const r = await getAuth().listUsers(1000, page);
  r.users.forEach((u) => uids.add(u.uid));
  page = r.pageToken;
} while (page);
const real = (u) => uids.has(u);
console.log(`\nACCOUNTS  ${uids.size} in Auth`);

const invites = (await db.collection('invites').get()).docs;
const golfers = Object.fromEntries((await db.collection('golfers').get()).docs.map((d) => [d.id, d]));
const groups = (await db.collection('groups').get()).docs;

const byStatus = {};
invites.forEach((d) => { const s = d.get('status'); byStatus[s] = (byStatus[s] || 0) + 1; });
console.log(`INVITES   ${Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(', ')}`);

const fixes = [];
console.log('\nSTALE CLAIMS (accepted in beta, not here)');
for (const inv of invites) {
  if (inv.get('status') !== 'accepted') continue;
  const gid = inv.get('golferId');
  const g = gid && golfers[gid];
  const by = g?.get('claimedByUid');
  if (by && real(by)) continue;                       // claimed on this project: fine
  if (!g && gid) { console.log(`  ?  invite ${inv.id} names missing golfer ${gid}`); problems++; continue; }
  problems++;
  console.log(`  ${(g?.get('name') || '(no golfer)').padEnd(20)} ${inv.get('email')}` +
              `   claimedBy ${by || '—'} (not an account here)`);
  fixes.push({ inv, g });
}
if (!fixes.length) console.log('  none');

const deadMembers = [];
for (const grp of groups) {
  const dead = (grp.get('memberUids') || []).filter((u) => !real(u));
  if (dead.length) { problems++; deadMembers.push({ grp, dead }); }
  console.log(`\nGROUP ${grp.id}: ${(grp.get('memberUids') || []).length} members, ${dead.length} not accounts here` +
              (real(grp.get('ownerUid')) ? '' : '   OWNER IS NOT AN ACCOUNT HERE'));
  if (!real(grp.get('ownerUid'))) problems++;
}

if (FIX && (fixes.length || deadMembers.length)) {
  const batch = db.batch();
  for (const { inv, g } of fixes) {
    batch.update(inv.ref, { status: 'pending' });
    if (g) batch.update(g.ref, { claimedByUid: null, claimedViaInviteId: FieldValue.delete() });
  }
  for (const { grp, dead } of deadMembers) batch.update(grp.ref, { memberUids: FieldValue.arrayRemove(...dead) });
  await batch.commit();
  console.log(`\nFIXED: ${fixes.length} invitation(s) back to pending, golfers released, ` +
              `${deadMembers.reduce((n, d) => n + d.dead.length, 0)} dead member uid(s) removed`);
  console.log('Index problems, if any, still need deploying.');
} else {
  console.log(`\n${problems ? problems + ' problem(s)' : 'ready'}${problems && !FIX ? ' — rerun with --fix for the claims' : ''}`);
}
process.exit(problems && !FIX ? 1 : 0);
