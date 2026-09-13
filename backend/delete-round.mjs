/**
 * Delete one round document by id. Dry-run unless --commit.
 *
 * Prints the round first, because "a round" is the one thing in this system
 * that cannot be reconstructed — the only safe delete is one you have read.
 */
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const [keyPath, roundId] = process.argv.slice(2);
const COMMIT = process.argv.includes('--commit');
if (!keyPath || !roundId) { console.error('usage: delete-round.mjs <key.json> <roundId> [--commit]'); process.exit(1); }

const key = JSON.parse(readFileSync(keyPath, 'utf8'));
const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const hdr = b64({ alg: 'RS256', typ: 'JWT' });
const clm = b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/datastore',
                  aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now });
const sig = crypto.sign('RSA-SHA256', Buffer.from(hdr + '.' + clm), key.private_key).toString('base64url');
const { access_token } = await (await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                              assertion: hdr + '.' + clm + '.' + sig }) })).json();
const base = `https://firestore.googleapis.com/v1/projects/${key.project_id}/databases/(default)/documents`;
const H = { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' };

const r = await fetch(`${base}/rounds/${roundId}`, { headers: H });
if (!r.ok) { console.log(`round ${roundId} not found (${r.status})`); process.exit(1); }
const d = await r.json();
const f = d.fields || {};
console.log(`round ${roundId}`);
console.log(`  date    : ${f.date?.stringValue}`);
console.log(`  course  : ${f.courseName?.stringValue}`);
console.log(`  group   : ${f.groupId?.stringValue ?? 'null'}`);
console.log(`  golfers : ${(f.golferIds?.arrayValue?.values || []).map((v) => v.stringValue).join(', ')}`);
for (const [gid, v] of Object.entries(f.results?.mapValue?.fields || {})) {
  const rf = v.mapValue?.fields || {};
  console.log(`    ${gid.padEnd(22)} money ${String(rf.money?.integerValue ?? rf.money?.doubleValue ?? 0).padStart(5)}` +
              `  holes ${rf.holes?.integerValue ?? '—'}`);
}

if (!COMMIT) { console.log('\ndry run — rerun with --commit to delete'); process.exit(0); }
const del = await fetch(`${base}/rounds/${roundId}`, { method: 'DELETE', headers: H });
console.log(del.ok ? '\ndeleted' : `\nDELETE failed ${del.status} ${(await del.text()).slice(0, 200)}`);
const gone = await fetch(`${base}/rounds/${roundId}`, { headers: H });
console.log(gone.status === 404 ? 'verified gone' : `STILL THERE (${gone.status})`);
