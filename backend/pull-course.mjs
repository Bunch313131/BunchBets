/**
 * Pull a course's CURRENT tee sets out of GHIN and, optionally, write them to
 * Firestore.
 *
 * Doc 03 settled two things that this depends on:
 *
 *   Omit include_altered_tees. The default returns current tees only — 18 sets
 *   at El Macero rather than 157 including "White (2016)" and
 *   "Temp - Blue (Phase 3)". No filtering heuristics, no name regexes.
 *
 *   GHIN is a SOURCE, never a dependency. Pull once, write to Firestore, and
 *   have the app read only from Firestore. A GHIN outage must not break round
 *   setup.
 *
 * The per-hole Allocation — what the app calls hcp[] — varies BY TEE SET. That
 * is the whole reason this exists: the app currently carries one allocation
 * array for a whole course, which is wrong at the root rather than merely
 * incomplete.
 *
 * Dry run by default.
 *
 * Usage:
 *   node pull-course.mjs <ghin-creds.rtf> "<course name>" [--key <sa.json>] [--commit]
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const keyIdx = args.indexOf('--key');
const KEY_PATH = keyIdx >= 0 ? args[keyIdx + 1] : null;
// keyIdx is -1 when --key is absent, and -1 + 1 === 0 would then silently drop
// the FIRST positional argument. Guard it rather than relying on the arithmetic.
const keyValueIdx = keyIdx >= 0 ? keyIdx + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== keyValueIdx);
const [CREDS, NAME] = positional;
if (!CREDS || !NAME) {
  console.error('usage: pull-course.mjs <ghin-creds.rtf> "<course name>" [--key <sa.json>] [--commit]');
  process.exit(1);
}

const BASE = 'https://api2.ghin.com/api/v1';
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
const lj = await (await fetch(`${BASE}/golfer_login.json`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
  body: JSON.stringify({ user: { email_or_ghin: login, password: pw, remember_me: true },
                         token: 'nonce', source: 'GHINcom' }) })).json();
const tok = lj?.golfer_user?.golfer_user_token;
if (!tok) { console.error('GHIN login failed'); process.exit(1); }
const H = { Authorization: `Bearer ${tok}`, 'User-Agent': UA };

// ------------------------------------------------------------------ search
const sj = await (await fetch(
  `${BASE}/crsCourseMethods.asmx/SearchCourses.json?name=${encodeURIComponent(NAME)}&source=GHINcom`,
  { headers: H })).json();
const found = sj.courses || sj.Courses || [];
if (!found.length) { console.error(`no course matching "${NAME}"`); process.exit(1); }
if (found.length > 1) {
  console.log(`${found.length} matches — using the first. Others:`);
  found.slice(1, 6).forEach((c) => console.log(`   ${c.CourseID ?? c.CourseId}  ${c.CourseName} (${c.City}, ${c.State})`));
}
const course = found[0];
const courseId = course.CourseID ?? course.CourseId;
console.log(`\n${course.CourseName} — ${course.City}, ${course.State}  (GHIN course ${courseId}, ${course.CourseStatus})\n`);

// ------------------------------------------------------------------ details
// NOTE the absent include_altered_tees. Passing it returns every historical and
// temporary tee ever rated.
const dj = await (await fetch(
  `${BASE}/crsCourseMethods.asmx/GetCourseDetails.json?CourseId=${courseId}&source=GHINcom`,
  { headers: H })).json();

const sets = dj.TeeSets || dj.teeSets || [];
const rating = (t, type) => (t.Ratings || []).filter((r) => r.RatingType === type)[0] || null;

const tees = sets
  .filter((t) => (t.HolesNumber || 18) === 18)
  .map((t) => {
    const total = rating(t, 'Total'), front = rating(t, 'Front'), back = rating(t, 'Back');
    const holes = (t.Holes || []).slice().sort((a, b) => (a.Number || 0) - (b.Number || 0));
    return {
      name: t.TeeSetRatingName,
      gender: t.Gender,
      yardage: t.TotalYardage,
      par: t.TotalPar,
      rating: total ? total.CourseRating : null,
      slope: total ? total.SlopeRating : null,
      front: front ? { rating: front.CourseRating, slope: front.SlopeRating } : null,
      back: back ? { rating: back.CourseRating, slope: back.SlopeRating } : null,
      parArr: holes.map((h) => h.Par),
      hcpArr: holes.map((h) => h.Allocation),
    };
  })
  .sort((a, b) => (b.yardage || 0) - (a.yardage || 0));

console.log(`${sets.length} tee set(s) returned, ${tees.length} at 18 holes\n`);
console.log('  tee                  gender   yds  par    CR / slope');
for (const t of tees) {
  console.log('  ' + String(t.name).padEnd(20) + ' ' + String(t.gender || '').padEnd(7) +
    String(t.yardage ?? '—').padStart(5) + String(t.par ?? '—').padStart(5) + '    ' +
    String(t.rating ?? '—').padStart(4) + ' / ' + String(t.slope ?? '—'));
}

// The allocations are the point. Show where they actually differ between tees,
// because "one hcp[] per course" is only wrong if they do.
console.log('\nstroke index by tee (hole 1..18)\n');
for (const t of tees) {
  console.log('  ' + String(t.name).padEnd(20) + t.hcpArr.join(' ').replace(/\b(\d)\b/g, ' $1'));
}
const distinct = new Set(tees.map((t) => t.hcpArr.join(',')));
console.log(`\n  ${distinct.size} distinct allocation(s) across ${tees.length} tees — ` +
  (distinct.size > 1 ? 'a single course-level hcp[] CANNOT be right' : 'they happen to agree here'));

const pars = new Set(tees.map((t) => t.parArr.join(',')));
console.log(`  ${pars.size} distinct par array(s)`);

// --------------------------------------------------------------- firestore
if (!KEY_PATH) { console.log('\nno --key given: read-only probe, nothing written'); process.exit(0); }

const slug = String(course.CourseName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const doc = {
  name: course.CourseName,
  city: course.City || '',
  state: course.State || '',
  ghinCourseId: String(courseId),
  status: course.CourseStatus || '',
  tees,
  pulledAt: new Date().toISOString().slice(0, 10),
};

console.log(`\nwould write courses/${slug} — ${tees.length} tees`);
if (!COMMIT) { console.log('dry run — rerun with --commit'); process.exit(0); }

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

// Hand-encode rather than pull in a dependency: the shape is small and fixed.
const enc = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
};

const url = `https://firestore.googleapis.com/v1/projects/${key.project_id}/databases/(default)/documents/courses/${slug}`;
const r = await fetch(url, {
  method: 'PATCH',
  headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ fields: enc(doc).mapValue.fields }),
});
if (!r.ok) { console.error(`write failed ${r.status} ${(await r.text()).slice(0, 300)}`); process.exit(1); }

const back = await (await fetch(url, { headers: { Authorization: 'Bearer ' + access_token } })).json();
const wrote = (back.fields.tees.arrayValue.values || []).length;
console.log(`written and read back: courses/${slug}, ${wrote} tees`);
