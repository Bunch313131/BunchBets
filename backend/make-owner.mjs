/**
 * Look up — or create — the Firebase Auth account that will own a seeded group.
 *
 * The group needs a real uid before the app has any sign-in UI, which is a
 * chicken-and-egg. Creating the account from the owner's email address breaks it:
 * Firebase's default "one account per email address" means a later Google
 * sign-in on the same address LINKS to this account rather than making a second
 * one, so the uid is stable and nothing has to be patched afterwards. Google
 * also sets emailVerified itself at that point, which the invite rules require.
 *
 *   node backend/make-owner.mjs <serviceAccount>.json <email> ["Display Name"]
 *
 * Idempotent: run it twice and the second run just reports the existing uid.
 * Run from inside backend/ so firebase-admin resolves.
 */
import fs from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const [keyPath, email, displayName] = process.argv.slice(2);
if (!keyPath || !email) { console.error('usage: make-owner.mjs <key>.json <email> ["Name"]'); process.exit(1); }

initializeApp({ credential: cert(JSON.parse(fs.readFileSync(keyPath, 'utf8'))) });
const auth = getAuth();

let u, created = false;
try {
  u = await auth.getUserByEmail(email);
} catch {
  u = await auth.createUser({ email, displayName: displayName || undefined, emailVerified: false });
  created = true;
}
console.log(created ? 'created' : 'already existed');
console.log('  uid           :', u.uid);
console.log('  email         :', u.email);
console.log('  emailVerified :', u.emailVerified, '(Google sign-in sets this true)');
console.log('  providers     :', u.providerData.map(p => p.providerId).join(', ') || '(none yet — email only)');
