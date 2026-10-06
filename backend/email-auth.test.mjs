/**
 * Email + password accounts, end to end: the real cloud module in a real
 * browser against the Auth and Firestore emulators with the real rules.
 *
 * The point of these is the unverified window. Someone who signs up with a
 * password has an account at once but an UNVERIFIED address until they tap the
 * emailed link — and the rules only match invitations against verified
 * addresses. The app must keep working in that window (an unverified invite
 * query used to be able to fail the whole profile load) and pick up the
 * invitation the moment the address is verified.
 *
 * Prereqs (from backend/):
 *   firebase emulators:start --only firestore,auth --project bb-test
 *   (cd .. && python3 -m http.server 8099)
 *   node --test email-auth.test.mjs
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8181';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';

const URL = 'http://127.0.0.1:8099/cloud-test.html?sdk=/vendor&emulator=1';
const DIR = 'dir-email';
const WED = 'wed-email';
const EMAIL = 'pat@example.com';

let browser, adminAuth, db, page;

before(async () => {
  await fetch('http://127.0.0.1:8181/emulator/v1/projects/bb-test/databases/(default)/documents', { method: 'DELETE' });
  await fetch('http://127.0.0.1:9099/emulator/v1/projects/bb-test/accounts', { method: 'DELETE' });
  initializeApp({ projectId: 'bb-test' }, 'email-auth');
  const { getApp } = await import('firebase-admin/app');
  adminAuth = getAuth(getApp('email-auth'));
  db = getFirestore(getApp('email-auth'));

  await db.doc(`groups/${DIR}`).set({ name: 'El Macero', ownerUid: 'uid_brian', memberUids: ['uid_brian'] });
  await db.doc(`groups/${WED}`).set({ name: 'Wednesday', kind: 'group', ownerUid: 'uid_brian',
                                     memberUids: ['uid_brian'], joinCode: 'wed-code' });
  await db.doc('golfers/ghin:9').set({ name: 'Pat Doe', claimedByUid: null, discoverable: false, poolGroupIds: [DIR] });
  await db.doc('invites/inv_pat').set({ groupId: DIR, email: EMAIL, golferId: 'ghin:9',
                                        invitedByUid: 'uid_brian', status: 'pending' });

  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });
  page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
});
after(async () => { await browser?.close(); });

const call = (fn, ...args) => page.evaluate(([f, a]) => window.cloud[f](...a)
  .then((v) => ({ ok: true, v: v && v.uid ? { uid: v.uid, emailVerified: v.emailVerified } : v }),
        (e) => ({ ok: false, e: e.code || e.message })), [fn, args]);
const waitForUser = (want) => page.waitForFunction((w) => !!window.cloud.currentUser() === w, want, { timeout: 10000 });

let UID;

describe('email and password', () => {
  test('a new account is made, named, and starts unverified', async () => {
    const r = await call('signUpWithEmail', EMAIL, 'fairway9', 'Pat Doe');
    assert.ok(r.ok, JSON.stringify(r));
    UID = r.v.uid;
    assert.strictEqual(r.v.emailVerified, false);
    await waitForUser(true);
    const doc = (await db.doc(`users/${UID}`).get()).data();
    assert.strictEqual(doc.displayName, 'Pat Doe');
    assert.deepStrictEqual(doc.groupIds, []);
  });

  test('unverified, the invitation query does not fail — it just finds nothing yet', async () => {
    const r = await call('pendingInvites');
    assert.deepStrictEqual(r, { ok: true, v: [] });
  });

  test('and the rules still refuse to accept the invitation for an unverified address', async () => {
    const r = await call('acceptInvite', 'inv_pat');
    assert.strictEqual(r.ok, false);
  });

  test('an invite LINK needs no verified email', async () => {
    const r = await call('joinGroup', WED, 'wed-code');
    assert.ok(r.ok, JSON.stringify(r));
  });

  test('refreshVerified says no until the link is tapped', async () => {
    assert.deepStrictEqual(await call('refreshVerified'), { ok: true, v: false });
  });

  test('after verifying, the invitation is found and accepted', async () => {
    await adminAuth.updateUser(UID, { emailVerified: true });    // what tapping the link does
    assert.deepStrictEqual(await call('refreshVerified'), { ok: true, v: true });
    const inv = await call('pendingInvites');
    assert.deepStrictEqual(inv.v.map((x) => x.id), ['inv_pat']);
    const acc = await call('acceptInvite', 'inv_pat');
    assert.ok(acc.ok, JSON.stringify(acc));
    assert.strictEqual((await db.doc('golfers/ghin:9').get()).data().claimedByUid, UID);
    assert.deepStrictEqual((await db.doc(`users/${UID}`).get()).data().groupIds.sort(), [DIR, WED].sort());
  });

  test('sign out, then a wrong password is refused', async () => {
    await page.evaluate(() => window.cloud.signOut());
    await waitForUser(false);
    const r = await call('signInWithEmail', EMAIL, 'wrong-one');
    assert.strictEqual(r.ok, false);
    assert.match(r.e, /invalid-credential|wrong-password/);
  });

  test('the right password signs back in to the same account', async () => {
    const r = await call('signInWithEmail', EMAIL, 'fairway9');
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.v.uid, UID);
  });

  test('the same email cannot make a second account', async () => {
    await page.evaluate(() => window.cloud.signOut());
    await waitForUser(false);
    const r = await call('signUpWithEmail', EMAIL, 'another1', 'Imposter');
    assert.strictEqual(r.ok, false);
    assert.match(r.e, /email-already-in-use/);
  });

  test('a password reset can be asked for', async () => {
    const r = await call('sendPasswordReset', EMAIL);
    assert.ok(r.ok, JSON.stringify(r));
  });
});
