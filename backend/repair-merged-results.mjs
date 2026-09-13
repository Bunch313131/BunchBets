/**
 * One-off repair: drop results entries for golfers who are not in the round.
 *
 * `saveRound` used set(..., { merge: true }). Arrays are replaced but maps are
 * deep-merged, so re-saving a round after linking names left the old
 * results['guest:bunch'] sitting beside the new results['ghin:1506580'].
 * golferIds is correct — it is an array — so it is the authority on who played,
 * and any results key not in it is a leftover.
 *
 * Prints a plan and changes nothing unless --commit is passed.
 */
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const keyPath = process.argv[2];
const COMMIT = process.argv.includes('--commit');
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

const docs = (await (await fetch(base + '/rounds?pageSize=300', { headers: H })).json()).documents || [];

let touched = 0;
for (const d of docs) {
  const id = d.name.split('/').pop();
  const ids = (d.fields.golferIds?.arrayValue?.values || []).map((v) => v.stringValue);
  const resultFields = d.fields.results?.mapValue?.fields || {};
  const stale = Object.keys(resultFields).filter((k) => !ids.includes(k));
  if (!stale.length) { console.log(`  ok    ${id}  ${Object.keys(resultFields).length} results, all in golferIds`); continue; }

  touched++;
  console.log(`  FIX   ${id}  dropping ${stale.length}: ${stale.join(', ')}`);
  if (!COMMIT) continue;

  const keep = {};
  for (const k of Object.keys(resultFields)) if (ids.includes(k)) keep[k] = resultFields[k];

  // updateMask on `results` replaces that field wholesale and touches nothing else.
  const r = await fetch(`${base}/rounds/${id}?updateMask.fieldPaths=results`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ fields: { results: { mapValue: { fields: keep } } } }),
  });
  if (!r.ok) { console.log('        FAILED ' + r.status + ' ' + (await r.text()).slice(0, 200)); continue; }
  const back = await r.json();
  const nowKeys = Object.keys(back.fields.results.mapValue.fields).sort();
  const want = ids.slice().sort();
  console.log(`        ${JSON.stringify(nowKeys) === JSON.stringify(want) ? 'verified' : 'MISMATCH ' + JSON.stringify(nowKeys)}`);
}

console.log(`\n${touched} round(s) ${COMMIT ? 'repaired' : 'need repair'}${COMMIT ? '' : ' — rerun with --commit'}`);
