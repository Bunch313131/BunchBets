/**
 * Add one golfer to a group's pool from their GHIN number.
 *
 * A regular who will never install the app is a first-class golfer, not a
 * guest (doc 08 §6.2). Giving him a GHIN is what makes the record
 * deterministic — added twice from two groups it lands on the same id — keeps
 * his index live, and lets him inherit every round if he ever does claim it.
 *
 * The number is VERIFIED BY NAME before anything is written. A wrong GHIN
 * resolves cleanly to a different person, so existence is not evidence; only
 * the name coming back is.
 *
 * Created unclaimed and not discoverable, which is the only shape the rules
 * permit for someone who has not published themselves.
 *
 * The group is given by id, or by its name ("ELMO") when no group has that id.
 * Membership is the golfer's own poolGroupIds — what the app reads. The
 * group's legacy poolGolferIds list is still appended to, for older tools.
 *
 * Usage:
 *   node add-golfer.mjs <key.json> <ghin-creds.rtf> <ghinNumber> "<Expected Name>" <group id or name> [--commit]
 */
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const [keyPath, credsPath, NUMBER, EXPECTED, GROUP_ARG] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const COMMIT = process.argv.includes('--commit');
if (!GROUP_ARG) {
  console.error('usage: add-golfer.mjs <key.json> <ghin-creds.rtf> <ghin> "<Name>" <groupId> [--commit]');
  process.exit(1);
}

// ------------------------------------------------------------------ ghin
const GBASE = 'https://api2.ghin.com/api/v1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
function readCreds(p) {
  let raw = readFileSync(p, 'utf8');
  if (raw.trimStart().startsWith('{\\rtf')) {
    raw = raw.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
             .replace(/\\[a-zA-Z]+-?\d* ?/g, ' ').replace(/[{}\\]/g, ' ');
  }
  const t = raw.split(/[\s,;]+/).filter(Boolean);
  const email = t.find((x) => /@/.test(x) && /\./.test(x.split('@').pop()));
  const num = t.find((x) => /^\d{6,8}$/.test(x));
  const pw = raw.match(/(?:password|pass|pw)\s*[:=]?\s*(\S+)/i)?.[1]
          || t.filter((x) => x !== email && x !== num && x.length >= 6).pop();
  return { login: email || num, pw };
}
const { login, pw } = readCreds(credsPath);
const lj = await (await fetch(`${GBASE}/golfer_login.json`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
  body: JSON.stringify({ user: { email_or_ghin: login, password: pw, remember_me: true },
                         token: 'nonce', source: 'GHINcom' }) })).json();
const gtok = lj?.golfer_user?.golfer_user_token;
if (!gtok) { console.error('GHIN login failed'); process.exit(1); }

const gj = await (await fetch(
  `${GBASE}/golfers/search.json?per_page=5&page=1&golfer_id=${NUMBER}&source=GHINcom`,
  { headers: { Authorization: `Bearer ${gtok}`, 'User-Agent': UA } })).json();
const g = (gj.golfers || [])[0];
if (!g) { console.error(`GHIN ${NUMBER} returned nobody`); process.exit(1); }

const real = `${g.first_name} ${g.last_name}`.replace(/\s+/g, ' ').trim();
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
console.log(`GHIN ${NUMBER} → ${real}   index ${g.handicap_index}   ${g.club_name}   rev ${g.rev_date}`);
if (norm(real) !== norm(EXPECTED)) {
  console.error(`\nREFUSED: that number belongs to "${real}", not "${EXPECTED}".`);
  process.exit(1);
}
console.log(`name matches "${EXPECTED}" — proceeding\n`);

// ------------------------------------------------------------- firestore
const key = JSON.parse(readFileSync(keyPath, 'utf8'));
const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const h = b64({ alg: 'RS256', typ: 'JWT' });
const c = b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/datastore',
                aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now });
const s = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + c), key.private_key).toString('base64url');
const { access_token } = await (await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                              assertion: h + '.' + c + '.' + s }) })).json();
const ROOT = `projects/${key.project_id}/databases/(default)/documents`;
const base = `https://firestore.googleapis.com/v1/${ROOT}`;
const H = { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' };

// The group: by id, else by name (case-insensitive), and it must be exactly one.
let GROUP = GROUP_ARG;
const byId = await fetch(`${base}/groups/${encodeURIComponent(GROUP_ARG)}`, { headers: H });
if (!byId.ok) {
  const all = ((await (await fetch(`${base}/groups?pageSize=300`, { headers: H })).json()).documents || []);
  const hits = all.filter((d) => String(d.fields?.name?.stringValue || '').toLowerCase() === GROUP_ARG.toLowerCase());
  if (hits.length !== 1) {
    console.error(`no single group with id or name "${GROUP_ARG}" — groups: ` +
      all.map((d) => `${d.fields?.name?.stringValue} (${d.name.split('/').pop()})`).join(', '));
    process.exit(1);
  }
  GROUP = hits[0].name.split('/').pop();
}
const groupName = byId.ok ? (await byId.json()).fields?.name?.stringValue
  : GROUP_ARG;
console.log(`group: ${groupName} (id ${GROUP})`);

const id = `ghin:${NUMBER}`;
const existing = await fetch(`${base}/golfers/${id}`, { headers: H });
if (existing.ok) {
  const f = (await existing.json()).fields;
  console.log(`golfers/${id} already exists as "${f.name?.stringValue}" — will only ensure pool membership`);
}

const fields = {
  name: { stringValue: real },
  ghinNumber: { stringValue: String(NUMBER) },
  currentIndex: { stringValue: String(g.handicap_index) },
  indexUpdatedAt: { stringValue: String(g.rev_date || '').slice(0, 10) },
  homeClub: { stringValue: g.club_name || '' },
  claimedByUid: { nullValue: null },
  discoverable: { booleanValue: false },
  poolGroupIds: { arrayValue: { values: [{ stringValue: GROUP }] } },
  aliases: { arrayValue: { values: [] } },
};

console.log(`\nwould write golfers/${id}:`);
for (const [k, v] of Object.entries(fields)) console.log(`  ${k.padEnd(15)} ${JSON.stringify(Object.values(v)[0])}`);
console.log(`and make sure ${id} is in ${groupName}: golfers/${id}.poolGroupIds gains ${GROUP}`);

if (!COMMIT) { console.log('\ndry run — rerun with --commit'); process.exit(0); }

if (!existing.ok) {
  const r = await fetch(`${base}/golfers/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ fields }) });
  if (!r.ok) { console.error(`\nwrite failed ${r.status} ${(await r.text()).slice(0, 300)}`); process.exit(1); }
  console.log(`\ncreated golfers/${id}`);
}

// appendMissingElements, so a rerun cannot produce a duplicate entry. The
// golfer's own poolGroupIds is what the app's group pool query reads; an
// existing golfer used to get only the group's legacy list, and so never
// appeared in the group.
const t = await fetch(`https://firestore.googleapis.com/v1/${ROOT}:commit`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ writes: [
    { transform: { document: `${ROOT}/golfers/${id}`,
      fieldTransforms: [{ fieldPath: 'poolGroupIds', appendMissingElements: { values: [{ stringValue: GROUP }] } }] } },
    { transform: { document: `${ROOT}/groups/${GROUP}`,
      fieldTransforms: [{ fieldPath: 'poolGolferIds', appendMissingElements: { values: [{ stringValue: id }] } }] } },
  ] }),
});
if (!t.ok) { console.error(`group membership failed ${t.status} ${(await t.text()).slice(0, 300)}`); process.exit(1); }

const gf = (await (await fetch(`${base}/golfers/${encodeURIComponent(id)}`, { headers: H })).json()).fields || {};
const groups = (gf.poolGroupIds?.arrayValue?.values || []).map((v) => v.stringValue);
console.log(`golfers/${id}: ${gf.name?.stringValue}, index ${gf.currentIndex?.stringValue}, in ${groupName}: ${groups.includes(GROUP)}`);
if (!groups.includes(GROUP)) process.exit(1);
