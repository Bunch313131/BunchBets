/**
 * Re-read every pooled golfer's handicap index from GHIN and write back what has
 * moved.
 *
 * An index is the input to every course handicap in the app, so a stale one is a
 * wrong number of strokes on Wednesday with nothing on screen to say so. GHIN
 * revises on posting, which for a group that plays weekly means a fortnight-old
 * index is often simply wrong.
 *
 * Verified by NAME on every single golfer, not just on the ones that changed. A
 * GHIN number that silently starts resolving to a different person is the
 * failure this guards, and it cannot be caught by looking at the index alone.
 * Any mismatch is refused and reported; nothing about that golfer is written.
 *
 * Volume stays human-scale, per doc 03: one lookup per golfer, sequential.
 *
 * Dry run by default.
 *
 * Usage:
 *   node refresh-indexes.mjs <sa-key>.json <ghin-creds.rtf> [--commit]
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const [KEY_PATH, CREDS] = args.filter((a) => !a.startsWith('--'));
if (!CREDS) {
  console.error('usage: refresh-indexes.mjs <sa-key>.json <ghin-creds.rtf> [--commit]');
  process.exit(1);
}

// ------------------------------------------------------------------- ghin
const GBASE = 'https://api2.ghin.com/api/v1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
function readCreds(p) {
  let raw = fs.readFileSync(p, 'utf8');
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
const { login, pw } = readCreds(CREDS);
const lj = await (await fetch(`${GBASE}/golfer_login.json`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
  body: JSON.stringify({ user: { email_or_ghin: login, password: pw, remember_me: true },
                         token: 'nonce', source: 'GHINcom' }) })).json();
const gtok = lj?.golfer_user?.golfer_user_token;
if (!gtok) { console.error('GHIN login failed'); process.exit(1); }
const GH = { Authorization: `Bearer ${gtok}`, 'User-Agent': UA };

// -------------------------------------------------------------- firestore
const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jh = b64({ alg: 'RS256', typ: 'JWT' });
const jc = b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/datastore',
                 aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now });
const js = crypto.sign('RSA-SHA256', Buffer.from(jh + '.' + jc), key.private_key).toString('base64url');
const { access_token } = await (await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                              assertion: jh + '.' + jc + '.' + js }) })).json();
const base = `https://firestore.googleapis.com/v1/projects/${key.project_id}/databases/(default)/documents`;
const FH = { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' };

const docs = ((await (await fetch(`${base}/golfers?pageSize=200`, { headers: FH })).json()).documents || [])
  .sort((a, b) => a.fields.name.stringValue.localeCompare(b.fields.name.stringValue));

console.log(`${key.project_id}: ${docs.length} golfers\n`);
console.log('  name                 was     now    index updated   note');

const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const changed = [], refused = [], missing = [];

for (const d of docs) {
  const id = d.name.split('/').pop();
  const f = d.fields;
  const name = f.name.stringValue;
  const number = f.ghinNumber?.stringValue;
  const was = f.currentIndex?.stringValue ?? null;
  const wasDate = f.indexUpdatedAt?.stringValue ?? null;

  if (!number) { missing.push(name); continue; }

  const gj = await (await fetch(
    `${GBASE}/golfers/search.json?per_page=5&page=1&golfer_id=${number}&source=GHINcom`,
    { headers: GH })).json();
  const g = (gj.golfers || [])[0];
  if (!g) { refused.push(`${name} (${number}): GHIN returned nobody`); continue; }

  // The check that matters. An index that moved is routine; a NAME that moved
  // means the number now belongs to somebody else, and writing that index would
  // hand one man another man's strokes.
  const real = `${g.first_name} ${g.last_name}`.replace(/\s+/g, ' ').trim();
  if (norm(real) !== norm(name)) {
    refused.push(`${name} (${number}): GHIN now says "${real}" — NOT WRITTEN`);
    continue;
  }

  const nowIdx = String(g.handicap_index);
  const nowDate = String(g.rev_date || '').slice(0, 10);
  const moved = nowIdx !== was;
  console.log('  ' + (name + '                    ').slice(0, 20) +
    String(was ?? '—').padStart(5) + '   ' + String(nowIdx).padStart(5) + '    ' +
    String(nowDate).padEnd(12) + '  ' +
    (moved ? `was ${wasDate ?? '—'}` : 'unchanged'));

  if (moved || nowDate !== wasDate) {
    changed.push({ id, name, was, nowIdx, nowDate, club: g.club_name || '' });
  }
}

console.log(`\n${changed.length} to update, ${refused.length} refused, ${missing.length} without a GHIN number`);
refused.forEach((r) => console.log('  REFUSED ' + r));
missing.forEach((m) => console.log('  no GHIN number: ' + m));

if (!changed.length) { console.log('\nnothing to write'); process.exit(0); }
if (!COMMIT) { console.log('\ndry run — rerun with --commit'); process.exit(0); }

let ok = 0;
for (const c of changed) {
  // updateMask so this touches the index fields and nothing else — aliases,
  // claimedByUid and pool membership are not this script's business.
  const qs = 'updateMask.fieldPaths=currentIndex&updateMask.fieldPaths=indexUpdatedAt&updateMask.fieldPaths=homeClub';
  const r = await fetch(`${base}/golfers/${encodeURIComponent(c.id)}?${qs}`, {
    method: 'PATCH', headers: FH,
    body: JSON.stringify({ fields: {
      currentIndex: { stringValue: c.nowIdx },
      indexUpdatedAt: { stringValue: c.nowDate },
      homeClub: { stringValue: c.club },
    } }),
  });
  if (r.ok) ok++;
  else console.log(`  FAILED ${c.name}: ${r.status} ${(await r.text()).slice(0, 120)}`);
}
console.log(`\nupdated ${ok} of ${changed.length}`);
