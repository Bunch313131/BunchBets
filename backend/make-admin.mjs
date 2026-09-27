/**
 * Grant (or remove) the site-admin role: the `admin` custom claim that
 * firestore.rules' isAdmin() checks, which is what lets admin.html see and
 * change everything.
 *
 * It is a claim in the signed ID token, never a Firestore field, because a
 * field can be rewritten by anything able to write the document. One account.
 *
 * The person has to get a fresh token before it takes effect — admin.html
 * forces one on sign-in, so signing in there again is enough.
 *
 *   node make-admin.mjs <key>.json <email>            # grant
 *   node make-admin.mjs <key>.json <email> --revoke   # remove
 *
 * Run from inside backend/ so firebase-admin resolves.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import fs from 'node:fs';

const [keyPath, email] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const revoke = process.argv.includes('--revoke');
if (!keyPath || !email) {
  console.error('usage: node make-admin.mjs <key>.json <email> [--revoke]');
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(fs.readFileSync(keyPath, 'utf8'))) });
const auth = getAuth();
const user = await auth.getUserByEmail(email);
const claims = { ...(user.customClaims || {}) };
if (revoke) delete claims.admin; else claims.admin = true;
await auth.setCustomUserClaims(user.uid, claims);
const after = (await auth.getUser(user.uid)).customClaims || {};
console.log(email, revoke ? 'is no longer admin' : 'is now admin', '| claims:', JSON.stringify(after));
