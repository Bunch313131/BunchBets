/**
 * Find a golfer by name at a club, so an unlinked card name can be given a
 * real GHIN record rather than a guess.
 *
 * Deliberately narrow: one login, a handful of searches, printing only what is
 * needed to recognise the right man. The API is undocumented and its use is
 * against GHIN's terms, so volume stays human-scale (doc 03).
 *
 * Usage: node find-tyler.mjs <ghin-creds.rtf> <name> [club substring]
 */
import fs from 'node:fs';

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

const [credsPath, NAME, CLUB = 'Macero'] = process.argv.slice(2);
const { login, pw } = readCreds(credsPath);

const lr = await fetch(`${BASE}/golfer_login.json`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
  body: JSON.stringify({ user: { email_or_ghin: login, password: pw, remember_me: true },
                         token: 'nonce', source: 'GHINcom' }),
});
const lj = await lr.json();
const tok = lj?.golfer_user?.golfer_user_token;
if (!tok) { console.error('GHIN login failed'); process.exit(1); }

const H = { Authorization: `Bearer ${tok}`, 'User-Agent': UA };
const show = (g) => `  ${String(g.ghin).padEnd(10)} ${(g.first_name + ' ' + g.last_name).padEnd(26)} ` +
  `${String(g.handicap_index ?? '—').padStart(5)}  ${g.club_name || ''} ${g.state || ''}`;

// Tried as both halves of a name, because a card says "Tyler" and gives no hint
// which half it is.
for (const params of [
  { last_name: NAME, state: 'CA', status: 'Active' },
  { first_name: NAME, state: 'CA', status: 'Active' },
]) {
  const qs = new URLSearchParams({ per_page: '100', page: '1', source: 'GHINcom', ...params });
  const r = await fetch(`${BASE}/golfers/search.json?${qs}`, { headers: H });
  const j = await r.json().catch(() => ({}));
  const all = j.golfers || [];
  const hit = all.filter((g) => new RegExp(CLUB, 'i').test(g.club_name || ''));
  const label = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`\n${label}  →  ${all.length} in CA, ${hit.length} at ${CLUB}`);
  hit.forEach((g) => console.log(show(g)));
  if (!hit.length && all.length && all.length <= 12) {
    console.log('  (no club match; all CA results:)');
    all.forEach((g) => console.log(show(g)));
  }
}
