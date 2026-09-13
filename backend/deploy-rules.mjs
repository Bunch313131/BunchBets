// Read/write Realtime Database rules using a service-account key, with no
// dependencies — node's built-in crypto mints the OAuth token directly.
// The key is only ever read from disk here; nothing about it is printed.
import fs from 'node:fs';
import crypto from 'node:crypto';

const [keyPath, dbUrl, action, rulesPath] = process.argv.slice(2);
const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))
  .toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

const now = Math.floor(Date.now() / 1000);
const claims = {
  iss: key.client_email,
  scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
  aud: 'https://oauth2.googleapis.com/token',
  iat: now, exp: now + 3600,
};
const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64(claims);
const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key)
  .toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

const tokRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: unsigned + '.' + sig,
  }),
});
const tok = await tokRes.json();
if (!tok.access_token) { console.error('TOKEN FAILED:', JSON.stringify(tok)); process.exit(1); }
console.error('token ok (expires in ' + tok.expires_in + 's)');

const url = dbUrl.replace(/\/$/, '') + '/.settings/rules.json';
const auth = { authorization: 'Bearer ' + tok.access_token };

if (action === 'get') {
  const r = await fetch(url, { headers: auth });
  console.error('GET rules -> HTTP ' + r.status);
  console.log(await r.text());
} else if (action === 'put') {
  const body = fs.readFileSync(rulesPath, 'utf8');
  const r = await fetch(url, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body });
  console.error('PUT rules -> HTTP ' + r.status);
  console.log(await r.text());
  process.exit(r.ok ? 0 : 1);
}

/*
 * Usage:
 *   node backend/deploy-rules.mjs <serviceAccount.json> <databaseURL> get
 *   node backend/deploy-rules.mjs <serviceAccount.json> <databaseURL> put backend/database.rules.json
 *
 * No dependencies — node's built-in crypto mints the OAuth token from the
 * service-account key, so this needs neither firebase-tools nor a global login.
 * The key is read from disk and never printed.
 *
 * Keys are gitignored (*-firebase-adminsdk-*.json). There is one for
 * bunchbets-test in the repo root; production has none by design.
 */
