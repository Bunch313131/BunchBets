/**
 * Deploy firestore.rules with nothing but a service-account key.
 *
 * firebase-tools would do this too, but it wants a global install and an
 * interactive login; node's built-in crypto mints the OAuth token directly, so
 * this runs anywhere the key is readable. The key is never printed.
 *
 *   node backend/deploy-firestore-rules.mjs <key>.json <projectId> [get|put]
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const [keyPath, project, action = 'get'] = process.argv.slice(2);
const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))
  .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const now = Math.floor(Date.now() / 1000);
const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
  iss: key.client_email,
  scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase',
  aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
});
const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key)
  .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const tr = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }),
});
const tok = await tr.json();
if (!tok.access_token) { console.error('TOKEN FAILED:', JSON.stringify(tok)); process.exit(1); }
const H = { authorization: 'Bearer ' + tok.access_token, 'content-type': 'application/json' };
const API = `https://firebaserules.googleapis.com/v1/projects/${project}`;

if (action === 'get') {
  const rel = await (await fetch(`${API}/releases/cloud.firestore`, { headers: H })).json();
  console.log('release:', JSON.stringify(rel, null, 2).slice(0, 600));
  if (rel.rulesetName) {
    const rs = await (await fetch(`https://firebaserules.googleapis.com/v1/${rel.rulesetName}`, { headers: H })).json();
    for (const f of rs.source?.files || []) {
      console.log(`\n--- ${f.name} (${f.content.length} bytes) ---`);
      console.log(f.content.split('\n').slice(0, 12).join('\n'));
      console.log('  ...');
    }
  }
  process.exit(0);
}

// Create the ruleset, then point the live release at it.
const content = fs.readFileSync('backend/firestore.rules', 'utf8');
const mk = await fetch(`${API}/rulesets`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ source: { files: [{ name: 'firestore.rules', content }] } }),
});
const ruleset = await mk.json();
if (!ruleset.name) { console.error('RULESET FAILED:', JSON.stringify(ruleset).slice(0, 800)); process.exit(1); }
console.log('ruleset created:', ruleset.name);

let r = await fetch(`${API}/releases/cloud.firestore`, {
  method: 'PATCH', headers: H,
  body: JSON.stringify({ release: { name: `projects/${project}/releases/cloud.firestore`, rulesetName: ruleset.name } }),
});
if (!r.ok) {   // no release yet on a brand-new database
  r = await fetch(`${API}/releases`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: `projects/${project}/releases/cloud.firestore`, rulesetName: ruleset.name }),
  });
}
const out = await r.json();
console.log(r.ok ? 'RELEASED -> ' + out.rulesetName : 'RELEASE FAILED: ' + JSON.stringify(out).slice(0, 800));
process.exit(r.ok ? 0 : 1);
