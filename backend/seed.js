#!/usr/bin/env node
/**
 * Seed groups, golfers and invitations from a roster CSV.
 *
 *   node seed.js --csv roster.csv --group "El Macero Saturday" --owner-uid <uid> \
 *                --ghin-creds ../ghin-creds.rtf [--emulator] [--commit]
 *
 * Dry run by default — it prints the plan and writes nothing unless --commit.
 *
 * CSV columns (case-insensitive, extra columns ignored):
 *   Member Email, Member Name, GHIN, [Phone]
 *
 * Every GHIN number is checked against the GHIN API first. A transcription
 * error here would put someone on a stranger's handicap index for a season —
 * that is not a hypothetical, it was caught on the very first real roster.
 * Rows whose name does not match are refused unless --allow-mismatch.
 *
 * Idempotent: golfers are keyed ghin:<number>, groups by slug, invites by
 * group+email. Re-running updates rather than duplicating.
 */
import fs from 'node:fs';
import path from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

// ----------------------------------------------------------------- arguments
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') !== false ? true : arr[i + 1]]);
  return acc;
}, []));
const COMMIT = args.commit === true;
const EMULATOR = args.emulator === true;
const ALLOW_MISMATCH = args['allow-mismatch'] === true;
const CSV = args.csv || 'roster.csv';
const GROUP_NAME = args.group;
const OWNER_UID = args['owner-uid'] || (EMULATOR ? 'uid_seed_owner' : null);
const CREDS = args['ghin-creds'];

if (!GROUP_NAME) { console.error('--group "Name" is required'); process.exit(1); }
if (!OWNER_UID) { console.error('--owner-uid is required (the account that will own the group)'); process.exit(1); }

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const GROUP_ID = args['group-id'] || slug(GROUP_NAME);

// ---------------------------------------------------------------- csv (light)
function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const col = (row, ...names) => {
    for (const n of names) { const i = head.indexOf(n); if (i !== -1) return (row[i] || '').trim(); }
    return '';
  };
  return lines.slice(1).map((l) => {
    const row = l.split(',');
    return {
      email: col(row, 'member email', 'email').toLowerCase(),   // normalise: GHIN
      name:  col(row, 'member name', 'name'),                   // rosters arrive
      ghin:  col(row, 'ghin', 'ghin number').replace(/\D/g, ''),// in mixed case
      phone: col(row, 'phone', 'mobile', 'cell'),
    };
  });
}

// ------------------------------------------------------------------ ghin api
const BASE = 'https://api2.ghin.com/api/v1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function readCreds(p) {
  let raw = fs.readFileSync(p, 'utf8');
  if (raw.trimStart().startsWith('{\\rtf')) {
    raw = raw.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
             .replace(/\\[a-zA-Z]+-?\d* ?/g, ' ').replace(/[{}\\]/g, ' ');
  }
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);
  const email = tokens.find((t) => /@/.test(t) && /\./.test(t.split('@').pop()));
  const num = tokens.find((t) => /^\d{6,8}$/.test(t));
  const pw = raw.match(/(?:password|pass|pw)\s*[:=]?\s*(\S+)/i)?.[1]
          || tokens.filter((t) => t !== email && t !== num && t.length >= 6).pop();
  return { login: email || num, pw };
}

async function ghinLogin(credsPath) {
  const { login, pw } = readCreds(credsPath);
  const r = await fetch(`${BASE}/golfer_login.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ user: { email_or_ghin: login, password: pw, remember_me: true }, token: 'nonce', source: 'GHINcom' }),
  });
  const j = await r.json();
  const tok = j?.golfer_user?.golfer_user_token;
  if (!tok) throw new Error('GHIN login failed');
  return tok;
}

async function ghinLookup(tok, number) {
  const r = await fetch(`${BASE}/golfers/search.json?per_page=5&page=1&golfer_id=${number}&source=GHINcom`,
    { headers: { Authorization: `Bearer ${tok}`, 'User-Agent': UA } });
  const j = await r.json().catch(() => ({}));
  return (j.golfers || [])[0] || null;
}

const normName = (n) => (n || '').toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean).sort().join(' ');
function similarity(a, b) {
  a = normName(a); b = normName(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  const inter = [...A].filter((x) => B.has(x)).length;
  // token overlap, plus credit for a shared prefix (Tim/Timothy, Ken/Kenneth)
  const pref = [...A].some((x) => [...B].some((y) => x !== y && (x.startsWith(y) || y.startsWith(x)) && Math.min(x.length, y.length) >= 3));
  return inter / Math.max(A.size, B.size) + (pref ? 0.4 : 0);
}

// --------------------------------------------------------------------- main
const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
console.log(`roster: ${rows.length} rows from ${path.basename(CSV)}`);
console.log(`group : "${GROUP_NAME}"  (id: ${GROUP_ID})  owner: ${OWNER_UID}`);
console.log(COMMIT ? 'mode  : COMMIT — this will write\n' : 'mode  : DRY RUN — nothing will be written (pass --commit to write)\n');

let verified = rows.map((r) => ({ ...r, ghinName: '', index: null, club: '', verdict: 'unchecked' }));

if (CREDS) {
  const tok = await ghinLogin(CREDS);
  verified = [];
  for (const r of rows) {
    const rec = await ghinLookup(tok, r.ghin);
    if (!rec) { verified.push({ ...r, verdict: 'NOT FOUND' }); continue; }
    const ghinName = `${rec.first_name || ''} ${rec.last_name || ''}`.trim();
    const sim = similarity(r.name, ghinName);
    verified.push({
      ...r,
      ghinName,
      // handicap_index is a STRING and is not always numeric — "NH" means the
      // golfer has no established handicap. Never parseFloat this blindly.
      index: rec.handicap_index ?? null,
      club: rec.club_name || '',
      revDate: rec.rev_date || null,
      verdict: sim >= 0.99 ? 'ok' : sim >= 0.6 ? 'close' : 'NAME MISMATCH',
    });
  }
} else {
  console.log('!! no --ghin-creds given: seeding names and numbers unverified\n');
}

const w = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
console.log(`${w('SHEET NAME', 20)} ${w('GHIN', 10)} ${w('GHIN NAME', 20)} ${w('IDX', 6)} VERDICT`);
console.log('-'.repeat(72));
for (const v of verified) console.log(`${w(v.name, 20)} ${w(v.ghin, 10)} ${w(v.ghinName, 20)} ${w(v.index, 6)} ${v.verdict}`);

const blocked = verified.filter((v) => v.verdict === 'NAME MISMATCH' || v.verdict === 'NOT FOUND');
if (blocked.length && !ALLOW_MISMATCH) {
  console.log(`\n${blocked.length} row(s) refused: ${blocked.map((b) => b.name).join(', ')}`);
  console.log('Fix the number, or re-run with --allow-mismatch to seed them anyway.');
}
const seedable = ALLOW_MISMATCH ? verified : verified.filter((v) => !blocked.includes(v));
console.log(`\n${seedable.length} of ${verified.length} rows will be seeded.`);

if (!COMMIT) { console.log('\nDry run complete — nothing written.'); process.exit(0); }

// ------------------------------------------------------------------- write
if (EMULATOR) process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8181';
initializeApp(EMULATOR
  ? { projectId: args.project || 'bb-test' }
  : { credential: cert(JSON.parse(fs.readFileSync(args['service-account'], 'utf8'))) });
const db = getFirestore();

const golferIds = seedable.map((v) => `ghin:${v.ghin}`);
const batch = db.batch();

batch.set(db.doc(`groups/${GROUP_ID}`), {
  name: GROUP_NAME,
  ownerUid: OWNER_UID,
  memberUids: FieldValue.arrayUnion(OWNER_UID),
  poolGolferIds: FieldValue.arrayUnion(...golferIds),
  createdAt: FieldValue.serverTimestamp(),
}, { merge: true });

for (const v of seedable) {
  const gid = `ghin:${v.ghin}`;
  batch.set(db.doc(`golfers/${gid}`), {
    name: v.ghinName || v.name,          // prefer the name GHIN has on file
    ghinNumber: v.ghin,
    currentIndex: v.index,               // string; may be "NH" or a plus handicap
    indexUpdatedAt: v.revDate || null,
    homeClub: v.club || null,
    claimedByUid: null,                  // nobody has registered yet — correct
    discoverable: false,                 // never seeded as discoverable
    poolGroupIds: FieldValue.arrayUnion(GROUP_ID),
  }, { merge: true });

  if (v.phone) {
    batch.set(db.doc(`groups/${GROUP_ID}/contacts/${gid}`),
      { name: v.ghinName || v.name, phone: v.phone }, { merge: true });
  }

  if (v.email) {
    // The invitation carries golferId — that mapping is what later authorises
    // this person to claim their own record. See project doc 11.
    batch.set(db.doc(`invites/${GROUP_ID}__${v.email.replace(/[^a-z0-9]/g, '_')}`), {
      groupId: GROUP_ID,
      email: v.email,
      golferId: gid,
      invitedByUid: OWNER_UID,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
}

await batch.commit();
console.log(`\nwrote: 1 group, ${seedable.length} golfers, ` +
            `${seedable.filter((v) => v.email).length} invites, ` +
            `${seedable.filter((v) => v.phone).length} contacts`);
process.exit(0);
