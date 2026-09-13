/** Who exists in Firebase Auth, and how did they sign in? */
import fs from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
initializeApp({ credential: cert(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))) });
const res = await getAuth().listUsers(50);
console.log(res.users.length + ' user(s):\n');
for (const u of res.users) {
  console.log('  uid       :', u.uid);
  console.log('  email     :', u.email, '| verified:', u.emailVerified);
  console.log('  providers :', u.providerData.map((p) => p.providerId).join(', ') || '(none)');
  console.log('  created   :', u.metadata.creationTime);
  console.log('  lastSignIn:', u.metadata.lastSignInTime || '(never)');
  console.log('');
}
