/**
 * Copy a season from one Firebase project to another.
 *
 * Written for beta -> production, once. Not a sync: it copies forward, never
 * deletes, and never reads back from the destination to decide what to do.
 *
 * THE UID IS THE WHOLE PROBLEM. Auth accounts are per-project, so the owner has
 * a different uid on the destination, and every reference to the old one has to
 * be rewritten: the group's ownerUid and memberUids, each round's createdByUid,
 * the claimedByUid on the golfer he has claimed, and the user document's own id.
 * Miss one and the rules simply deny him access to his own data, which looks
 * like a bug in the app rather than a bad copy.
 *
 * DOCUMENT IDS ARE PRESERVED, deliberately. Round ids are the local round ids,
 * and the phone stores them as `cloudId` against its own history — so keeping
 * them means the device still recognises its own rounds after the switch. New
 * ids would silently orphan every one of them and re-upload duplicates.
 *
 * Dry run by default.
 *
 * Usage:
 *   node copy-project.mjs <from-key>.json <to-key>.json <oldUid> <newUid> [--commit]
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const [FROM_KEY, TO_KEY, OLD_UID, NEW_UID] = args.filter((a) => !a.startsWith('--'));
if (!NEW_UID) {
  console.error('usage: copy-project.mjs <from>.json <to>.json <oldUid> <newUid> [--commit]');
  process.exit(1);
}

const COLLECTIONS = ['groups', 'golfers', 'invites', 'rounds', 'courses'];

async function token(key) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = b64({ alg: 'RS256', typ: 'JWT' });
  const c = b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/datastore',
                  aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now });
  const s = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + c), key.private_key).toString('base64url');
  const r = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                                assertion: h + '.' + c + '.' + s }) })).json();
  return r.access_token;
}

const from = JSON.parse(fs.readFileSync(FROM_KEY, 'utf8'));
const to = JSON.parse(fs.readFileSync(TO_KEY, 'utf8'));
const fromTok = await token(from), toTok = await token(to);
const base = (k) => `https://firestore.googleapis.com/v1/projects/${k.project_id}/databases/(default)/documents`;

console.log(`${from.project_id}  ->  ${to.project_id}`);
console.log(`uid ${OLD_UID}  ->  ${NEW_UID}\n`);

/**
 * Rewrite the old uid wherever it appears, at any depth.
 *
 * Works on the RAW Firestore value shapes rather than decoding to plain JS and
 * re-encoding: decoding loses the difference between an integer and a double,
 * and a handicap that arrives back as 12.0 where it left as 12 is the kind of
 * difference that shows up much later as a failed comparison.
 */
let swaps = 0;
function remap(v) {
  if (v.stringValue === OLD_UID) { swaps++; return { stringValue: NEW_UID }; }
  if (v.arrayValue) return { arrayValue: { values: (v.arrayValue.values || []).map(remap) } };
  if (v.mapValue) {
    return { mapValue: { fields: Object.fromEntries(
      Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, remap(x)])) } };
  }
  return v;
}

const plan = [];   // { coll, id, fields (to send), source (as it was read) }
for (const coll of COLLECTIONS) {
  let pageToken = '', docs = [];
  do {
    const url = `${base(from)}/${coll}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const j = await (await fetch(url, { headers: { Authorization: 'Bearer ' + fromTok } })).json();
    if (j.error) { console.log(`  ${coll}: ${j.error.message.slice(0, 70)}`); break; }
    docs = docs.concat(j.documents || []);
    pageToken = j.nextPageToken || '';
  } while (pageToken);

  docs.forEach((d) => {
    const id = d.name.split('/').pop();
    const fields = Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, remap(v)]));
    plan.push({ coll, id, fields, source: d.fields || {} });
  });
  console.log(`  ${coll.padEnd(9)} ${docs.length}`);
}

// The user document is keyed BY the uid, so it is copied under the new id
// rather than remapped in place.
const ud = await (await fetch(`${base(from)}/users/${OLD_UID}`,
  { headers: { Authorization: 'Bearer ' + fromTok } })).json();
if (ud.fields) {
  plan.push({ coll: 'users', id: NEW_UID, source: ud.fields,
              fields: Object.fromEntries(Object.entries(ud.fields).map(([k, v]) => [k, remap(v)])) });
  console.log(`  users     1  (re-keyed ${OLD_UID.slice(0, 8)}… -> ${NEW_UID.slice(0, 8)}…)`);
}

console.log(`\n${plan.length} document(s), ${swaps} uid reference(s) rewritten`);
if (!COMMIT) { console.log('\ndry run — rerun with --commit'); process.exit(0); }

let ok = 0, failed = 0;
for (const { coll, id, fields } of plan) {
  const r = await fetch(`${base(to)}/${coll}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + toTok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (r.ok) ok++;
  else { failed++; console.log(`  FAILED ${coll}/${id}: ${r.status} ${(await r.text()).slice(0, 120)}`); }
}
console.log(`\nwritten ${ok}, failed ${failed}`);

// Read every document back and compare, because "the write returned 200" is not
// the same claim as "the data is there and identical".
//
// Keys are SORTED before comparing. Firestore returns a document's fields in its
// own order, not the order they were sent, so a plain JSON.stringify comparison
// reports every single document as different — which is exactly what the first
// run of this did: 41 of 41 "DIFFERS" against a copy that was in fact perfect.
// A check that cries wolf on a good run is worse than no check, because the next
// person to see it will assume the same thing and be wrong.
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((a, k) => { a[k] = canon(v[k]); return a; }, {});
  }
  return v;
};

// Compared against the SOURCE document, not against the payload this script
// built. remap() rebuilds every array and map it walks, and in doing so it
// normalises an empty one — Firestore returns {"arrayValue":{}} where the
// rebuilt copy says {"arrayValue":{"values":[]}}. Identical data, different
// text, and comparing against the intermediate reported three perfectly good
// rounds as drifted.
//
// The question worth asking is "does the destination match the source", so ask
// exactly that. The uid swap is applied to the source by plain text replacement,
// which cannot introduce a normalisation of its own.
const swapped = (src) => JSON.parse(JSON.stringify(src).split('"' + OLD_UID + '"').join('"' + NEW_UID + '"'));

let drift = 0;
for (const { coll, id, source } of plan) {
  const back = await (await fetch(`${base(to)}/${coll}/${encodeURIComponent(id)}`,
    { headers: { Authorization: 'Bearer ' + toTok } })).json();
  const want = canon(swapped(source)), got = canon(back.fields || {});
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    drift++;
    console.log(`  DIFFERS ${coll}/${id}`);
    for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
      const a = JSON.stringify(want[k]), b = JSON.stringify(got[k]);
      if (a !== b) console.log(`      ${k}\n        source: ${String(a).slice(0, 90)}\n        dest:   ${String(b).slice(0, 90)}`);
    }
  }
}
console.log(drift ? `${drift} document(s) differ after write` : 'every document read back identical');
