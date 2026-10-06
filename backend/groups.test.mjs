/**
 * Groups, end to end: the real cloud module in a real browser, against the Auth
 * and Firestore emulators with the real rules loaded.
 *
 * rules.test.js asserts the rules against writes written by hand. This asserts
 * them against the writes js/cloud.js actually makes — arrayUnion, batches,
 * the order things happen in — which is where hand-written assumptions break.
 *
 * Unlike cloud.test.mjs it seeds its own data with the admin SDK, so it needs
 * no roster file and no GHIN access.
 *
 * Prereqs (from backend/):
 *   firebase emulators:start --only firestore,auth --project bb-test
 *   (cd .. && python3 -m http.server 8099)
 *   node --test groups.test.mjs
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
const DIR = 'dir-el-macero';          // the directory: no kind, as seeded today

let browser, adminAuth, db;

before(async () => {
  await fetch('http://127.0.0.1:8181/emulator/v1/projects/bb-test/databases/(default)/documents',
              { method: 'DELETE' });
  initializeApp({ projectId: 'bb-test' });
  adminAuth = getAuth();
  db = getFirestore();

  await db.doc(`groups/${DIR}`).set({ name: 'El Macero', ownerUid: 'uid_brian',
                                     memberUids: ['uid_brian', 'uid_mike'] });
  for (const [uid, groups] of [['uid_brian', [DIR]], ['uid_mike', [DIR]], ['uid_tim', []]]) {
    await db.doc(`users/${uid}`).set({ displayName: uid, groupIds: groups, myGolferId: null });
  }
  const golfers = {
    'ghin:1': { name: 'Tyler Bryan', currentIndex: '+0.3' },
    'ghin:2': { name: 'Brian Casey', currentIndex: '5.5' },
    'ghin:3': { name: 'Brian Bunch', currentIndex: '7.0', claimedByUid: 'uid_brian' },
    'ghin:4': { name: 'Kenneth Bernard', currentIndex: '10.8' },
  };
  for (const [id, g] of Object.entries(golfers)) {
    await db.doc(`golfers/${id}`).set({ claimedByUid: null, discoverable: false, poolGroupIds: [DIR], ...g });
  }
  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });
});
after(async () => { await browser?.close(); });

async function as(uid) {
  const email = uid.replace('uid_', '') + '@x.com';
  try { await adminAuth.deleteUser(uid); } catch (e) {}
  await adminAuth.createUser({ uid, email, emailVerified: true, displayName: uid });
  const token = await adminAuth.createCustomToken(uid);
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  await page.evaluate(async (t) => {
    await firebase.app('bbcloud').auth().signInWithCustomToken(t);
    await new Promise((r) => {
      const off = firebase.app('bbcloud').auth().onAuthStateChanged((u) => { if (u) { off(); r(); } });
    });
  }, token);
  return page;
}

const call = (page, fn, ...args) => page.evaluate(([f, a]) => window.cloud[f](...a)
  .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: e.code || e.message })), [fn, args]);

let WED, CODE;

describe('a playing group, built from the directory', () => {
  test('Mike starts "Wednesday" with three golfers from the directory', async () => {
    const mike = await as('uid_mike');
    const r = await call(mike, 'createGroup', 'Wednesday', ['ghin:1', 'ghin:2', 'ghin:3']);
    assert.ok(r.ok, JSON.stringify(r));
    WED = r.v;
    const g = (await db.doc(`groups/${WED}`).get()).data();
    assert.deepStrictEqual([g.kind, g.ownerUid, g.memberUids], ['group', 'uid_mike', ['uid_mike']]);
    assert.ok(g.joinCode && g.joinCode.length >= 10, 'it has a join code');
    CODE = g.joinCode;
    const pool = await call(mike, 'groupPool', WED);
    assert.deepStrictEqual(pool.v.map((x) => x.id).sort(), ['ghin:1', 'ghin:2', 'ghin:3']);
    // Brian Bunch had claimed his record; being put in a group still works.
    assert.deepStrictEqual((await db.doc('golfers/ghin:3').get()).data().poolGroupIds, [DIR, WED]);
    assert.deepStrictEqual((await db.doc('users/uid_mike').get()).data().groupIds, [DIR, WED]);
    await mike.close();
  });

  test('Tim, in no group, cannot read it or its golfers', async () => {
    const tim = await as('uid_tim');
    assert.strictEqual((await call(tim, 'groupPool', WED)).ok, false);
    await tim.close();
  });

  test('Tim cannot join without the code', async () => {
    const tim = await as('uid_tim');
    const r = await call(tim, 'joinGroup', WED, 'wrong-code');
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual((await db.doc(`groups/${WED}`).get()).data().memberUids, ['uid_mike']);
    await tim.close();
  });

  test('Tim joins with the link code, and then sees the group\'s golfers — only those', async () => {
    const tim = await as('uid_tim');
    const r = await call(tim, 'joinGroup', WED, CODE);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual(r.v.memberUids, ['uid_mike', 'uid_tim']);
    const pool = await call(tim, 'groupPool', WED);
    assert.deepStrictEqual(pool.v.map((x) => x.id).sort(), ['ghin:1', 'ghin:2', 'ghin:3']);
    // Kenneth is in the directory but not Wednesday, and Tim is not in the directory.
    assert.strictEqual((await call(tim, 'groupPool', DIR)).ok, false);
    await tim.close();
  });

  test('Tim adds a brand-new golfer to Wednesday', async () => {
    const tim = await as('uid_tim');
    const r = await call(tim, 'createGolfer', { name: 'Gary Nunes', currentIndex: '10.4' }, [WED]);
    assert.ok(r.ok, JSON.stringify(r));
    assert.match(r.v, /^guest:/);
    const pool = await call(tim, 'groupPool', WED);
    assert.ok(pool.v.some((x) => x.name === 'Gary Nunes'));
    await tim.close();
  });

  test('but cannot put him in the directory, which he is not in', async () => {
    const tim = await as('uid_tim');
    const r = await call(tim, 'createGolfer', { name: 'Sneaky' }, [DIR]);
    assert.strictEqual(r.ok, false);
    await tim.close();
  });

  test('a GHIN already on file elsewhere is reported plainly, not as a permission error', async () => {
    const tim = await as('uid_tim');
    const r = await call(tim, 'createGolfer', { name: 'Kenny', ghinNumber: '4' }, [WED]);
    assert.strictEqual(r.ok, false);
    assert.match(r.e, /already on file/);
    await tim.close();
  });

  test('Mike adds Kenneth from the directory later', async () => {
    const mike = await as('uid_mike');
    assert.ok((await call(mike, 'addToGroup', WED, ['ghin:4'])).ok);
    const pool = await call(mike, 'groupPool', WED);
    assert.ok(pool.v.some((x) => x.id === 'ghin:4'));
    await mike.close();
  });

  test('a member takes a golfer out of Wednesday, but not out of the directory', async () => {
    const mike = await as('uid_mike');
    assert.ok((await call(mike, 'removeFromGroup', WED, 'ghin:2')).ok);
    assert.deepStrictEqual((await db.doc('golfers/ghin:2').get()).data().poolGroupIds, [DIR]);
    assert.strictEqual((await call(mike, 'removeFromGroup', DIR, 'ghin:2')).ok, false);
    await mike.close();
  });

  test('Tim cannot reset the code; Mike, the owner, can — and the old link dies', async () => {
    const tim = await as('uid_tim');
    assert.strictEqual((await call(tim, 'resetJoinCode', WED)).ok, false);
    await tim.close();
    const mike = await as('uid_mike');
    const r = await call(mike, 'resetJoinCode', WED);
    assert.ok(r.ok);
    assert.notStrictEqual(r.v, CODE);
    await mike.close();
    const brian = await as('uid_brian');
    assert.strictEqual((await call(brian, 'joinGroup', WED, CODE)).ok, false);
    assert.ok((await call(brian, 'joinGroup', WED, r.v)).ok);
    await brian.close();
  });

  test('the directory has no code until its owner asks for one; a member cannot make one', async () => {
    const mike = await as('uid_mike');
    assert.strictEqual((await call(mike, 'joinCodeFor', DIR)).v, null);
    await mike.close();
    const brian = await as('uid_brian');
    const r = await call(brian, 'joinCodeFor', DIR);
    assert.ok(r.ok && r.v, JSON.stringify(r));
    await brian.close();
  });

  test('Tim leaves Wednesday, and can no longer read its rounds', async () => {
    const tim = await as('uid_tim');
    assert.ok((await call(tim, 'leaveGroup', WED)).ok);
    assert.ok(!(await db.doc(`groups/${WED}`).get()).data().memberUids.includes('uid_tim'));
    assert.deepStrictEqual((await db.doc('users/uid_tim').get()).data().groupIds, []);
    assert.strictEqual((await call(tim, 'groupRounds', WED)).ok, false);
    await tim.close();
  });

  test('an emailed invitation still works: join the directory and claim your record in one go', async () => {
    await db.doc('invites/inv_dave').set({ groupId: DIR, email: 'dave@x.com', golferId: 'ghin:4',
                                           invitedByUid: 'uid_brian', status: 'pending' });
    await db.doc('users/uid_dave').set({ displayName: 'Dave', groupIds: [], myGolferId: null });
    const dave = await as('uid_dave');
    const r = await call(dave, 'acceptInvite', 'inv_dave');
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok((await db.doc(`groups/${DIR}`).get()).data().memberUids.includes('uid_dave'));
    assert.strictEqual((await db.doc('golfers/ghin:4').get()).data().claimedByUid, 'uid_dave');
    assert.deepStrictEqual((await db.doc('users/uid_dave').get()).data().groupIds, [DIR]);
    await dave.close();
  });

  test('the owner cannot leave their own group', async () => {
    const mike = await as('uid_mike');
    assert.strictEqual((await call(mike, 'leaveGroup', WED)).ok, false);
    await mike.close();
  });
});
