/**
 * The admin page, end to end: admin.html driven in a real browser against the
 * Auth and Firestore emulators with the real rules. The admin account carries
 * the `admin` token claim; everything it does goes through the rules' isAdmin
 * path, which is the only thing standing between this page and everybody's
 * data — so it is also checked that an ordinary account gets nothing.
 *
 * Prereqs (from backend/):
 *   firebase emulators:start --only firestore,auth --project bb-test
 *   (cd .. && python3 -m http.server 8099)     # repo root; needs ../vendor
 *   node --test admin.test.mjs
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright';
import { initializeApp, getApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8181';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
const URL = 'http://127.0.0.1:8099/admin.html?sdk=/vendor&emulator=1';

let browser, auth, db, page;

async function seed() {
  const set = (p, d) => db.doc(p).set(d);
  await set('groups/dir', { name: 'El Macero', ownerUid: 'uid_brian', memberUids: ['uid_brian', 'uid_mike'] });
  await set('groups/wed', { name: 'Wednesday', kind: 'group', ownerUid: 'uid_mike', memberUids: ['uid_mike'], joinCode: 'x' });
  await set('groups/wed2', { name: 'Wednesday game', kind: 'group', ownerUid: 'uid_brian', memberUids: ['uid_brian'], joinCode: 'y' });
  await set('users/uid_brian', { displayName: 'Brian', email: 'brian@x.com', groupIds: ['dir', 'wed2'], myGolferId: 'ghin:1' });
  await set('users/uid_mike', { displayName: 'Mike', email: 'mike@x.com', groupIds: ['dir', 'wed'], myGolferId: null });
  await set('golfers/ghin:1', { name: 'Brian Bunch', ghinNumber: '1', currentIndex: '7.0', poolGroupIds: ['dir', 'wed2'], claimedByUid: 'uid_brian' });
  // The same man, typed in again as a guest, with a round of his own.
  await set('golfers/guest:bb', { name: 'B Bunch', ghinNumber: '1', currentIndex: null, poolGroupIds: ['wed'], claimedByUid: null, aliases: ['Bunchy'] });
  await set('golfers/ghin:2', { name: 'Tyler Bryan', ghinNumber: '2', currentIndex: '+0.3', poolGroupIds: ['dir', 'wed'], claimedByUid: null });
  await set('golfers/ghin:3', { name: 'Nobody Played', ghinNumber: '3', poolGroupIds: ['dir'], claimedByUid: null });
  await set('rounds/r1', { groupId: 'wed', date: '2026-09-20', courseName: 'El Macero', createdByUid: 'uid_mike',
    golferIds: ['guest:bb', 'ghin:2'], results: { 'guest:bb': { name: 'B Bunch', money: 10, gross: 80 }, 'ghin:2': { name: 'Tyler Bryan', money: -10, gross: 72 } } });
  await set('rounds/r2', { groupId: 'wed2', date: '2026-09-21', courseName: 'Del Paso', createdByUid: 'uid_brian',
    golferIds: ['ghin:1'], results: { 'ghin:1': { name: 'Brian Bunch', money: 5, gross: 79 } } });
  await set('invites/inv1', { groupId: 'wed2', email: 'pat@x.com', invitedByUid: 'uid_brian', status: 'pending' });
  await set('groups/dir/contacts/guest:bb', { phone: '555' });
}

async function signIn(uid, claims) {
  try { await auth.deleteUser(uid); } catch (e) {}
  await auth.createUser({ uid, email: uid.replace('uid_', '') + '@x.com', emailVerified: true });
  if (claims) await auth.setCustomUserClaims(uid, claims);
  const token = await auth.createCustomToken(uid);
  page = await browser.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__adminSignIn === 'function', { timeout: 15000 });
  await page.evaluate((t) => window.__adminSignIn(t), token);
}
const tabText = () => page.evaluate(() => [...document.querySelectorAll('.tab')].map((t) => t.textContent));
const open = async (tabName, id) => {
  await page.click(`.tab[data-tab="${tabName}"]`);
  if (id) await page.click(`tr.row[data-id="${id}"]`);
};
const settle = () => page.waitForTimeout(700);

before(async () => {
  await fetch('http://127.0.0.1:8181/emulator/v1/projects/bb-test/databases/(default)/documents', { method: 'DELETE' });
  initializeApp({ projectId: 'bb-test' }, 'admin-test');
  auth = getAuth(getApp('admin-test')); db = getFirestore(getApp('admin-test'));
  await seed();
  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });
});
after(async () => { await browser?.close(); });

describe('who gets in', () => {
  test('an ordinary account is told it is not the admin', async () => {
    await signIn('uid_mike', null);
    await page.waitForSelector('.gate h1');
    assert.strictEqual(await page.textContent('.gate h1'), 'Not an admin');
    // And the rules, not the page, are what stop it.
    const read = await page.evaluate(() => firebase.app('bbadmin').firestore().collection('users').get().then(() => 'read', (e) => e.code));
    assert.strictEqual(read, 'permission-denied');
    await page.close();
  });

  test('the admin sees everything, with the duplicate flagged', async () => {
    await signIn('uid_brian', { admin: true });
    await page.waitForSelector('.tab');
    const tabs = await tabText();
    assert.deepStrictEqual(tabs.map((t) => t.replace(/\d.*$/, '')), ['Groups', 'Golfers', 'Users', 'Rounds', 'Courses', 'Invitations']);
    assert.match(tabs[1], /4 · 2 dup\?/);
  });
});

describe('golfers', () => {
  test('merging the guest into the real record moves his round, groups, names and contact', async () => {
    await open('golfers', 'guest:bb');
    const likely = await page.evaluate(() => [...document.querySelectorAll('#fInto optgroup[label="Likely"] option')].map((o) => o.value));
    assert.deepStrictEqual(likely, ['ghin:1'], 'the real record is offered first');
    await page.selectOption('#fInto', 'ghin:1');
    await page.click('#fMerge');
    await settle();
    assert.strictEqual((await db.doc('golfers/guest:bb').get()).exists, false);
    const keep = (await db.doc('golfers/ghin:1').get()).data();
    assert.deepStrictEqual(keep.poolGroupIds.sort(), ['dir', 'wed', 'wed2']);
    assert.deepStrictEqual(keep.aliases.sort(), ['B Bunch', 'Bunchy']);
    assert.strictEqual(keep.claimedByUid, 'uid_brian');
    const r1 = (await db.doc('rounds/r1').get()).data();
    assert.deepStrictEqual(r1.golferIds, ['ghin:1', 'ghin:2']);
    assert.deepStrictEqual(Object.keys(r1.results).sort(), ['ghin:1', 'ghin:2']);
    assert.strictEqual(r1.results['ghin:1'].money, 10, 'his money came with him');
    assert.strictEqual((await db.doc('groups/dir/contacts/ghin:1').get()).data().phone, '555');
    assert.strictEqual((await db.doc('groups/dir/contacts/guest:bb').get()).exists, false);
  });

  test('two records scored in the same round are refused as two different people', async () => {
    await db.doc('golfers/guest:tb').set({ name: 'T Bryan', poolGroupIds: ['wed'], claimedByUid: null });
    await db.doc('rounds/r3').set({ groupId: 'wed', createdByUid: 'uid_mike', golferIds: ['guest:tb', 'ghin:2'],
      results: { 'guest:tb': { money: 1 }, 'ghin:2': { money: -1 } } });
    await page.click('#rf'); await settle();
    await open('golfers', 'guest:tb');
    await page.selectOption('#fInto', 'ghin:2');
    await page.click('#fMerge');
    await settle();
    assert.match(await page.textContent('#toast'), /two different people/);
    assert.strictEqual((await db.doc('golfers/guest:tb').get()).exists, true, 'nothing changed');
    await db.doc('rounds/r3').delete(); await db.doc('golfers/guest:tb').delete();
    await page.click('#rf'); await settle();
  });

  test('details and groups can be edited', async () => {
    await open('golfers', 'ghin:2');
    await page.fill('#fIdx', '1.2');
    await page.click('#fSave'); await settle();
    assert.strictEqual((await db.doc('golfers/ghin:2').get()).data().currentIndex, '1.2');
    await page.uncheck('[data-grp="wed"]');
    await page.click('#fGroups'); await settle();
    assert.deepStrictEqual((await db.doc('golfers/ghin:2').get()).data().poolGroupIds, ['dir']);
  });

  test('a golfer in no round can be deleted; one in a round cannot be', async () => {
    await open('golfers', 'ghin:1');
    assert.strictEqual(await page.locator('#fDel').count(), 0);
    await open('golfers', 'ghin:3');
    await page.click('#fDel'); await settle();
    assert.strictEqual((await db.doc('golfers/ghin:3').get()).exists, false);
  });
});

describe('groups', () => {
  test('rename, and hand to another member', async () => {
    await open('groups', 'dir');
    await page.fill('#gName', 'Everyone');
    await page.click('#gNameSave'); await settle();
    await page.selectOption('#gOwner', 'uid_mike');
    await page.click('#gOwnerSave'); await settle();
    const g = (await db.doc('groups/dir').get()).data();
    assert.deepStrictEqual([g.name, g.ownerUid], ['Everyone', 'uid_mike']);
  });

  test('merging the duplicate "Wednesday game" into "Wednesday" moves everything', async () => {
    await open('groups', 'wed2');
    await page.selectOption('#gInto', 'wed');
    await page.click('#gMerge'); await settle();
    assert.strictEqual((await db.doc('groups/wed2').get()).exists, false);
    assert.deepStrictEqual((await db.doc('groups/wed').get()).data().memberUids.sort(), ['uid_brian', 'uid_mike']);
    assert.strictEqual((await db.doc('rounds/r2').get()).data().groupId, 'wed');
    assert.strictEqual((await db.doc('invites/inv1').get()).data().groupId, 'wed');
    assert.deepStrictEqual((await db.doc('users/uid_brian').get()).data().groupIds.sort(), ['dir', 'wed']);
    assert.deepStrictEqual((await db.doc('golfers/ghin:1').get()).data().poolGroupIds.sort(), ['dir', 'wed']);
  });

  test('deleting a group keeps its golfers and turns its rounds into their scorer\'s own', async () => {
    await open('groups', 'wed');
    await page.click('#gDel'); await settle();
    assert.strictEqual((await db.doc('groups/wed').get()).exists, false);
    assert.strictEqual((await db.doc('rounds/r1').get()).data().groupId, null);
    assert.deepStrictEqual((await db.doc('golfers/ghin:1').get()).data().poolGroupIds, ['dir']);
    assert.deepStrictEqual((await db.doc('users/uid_mike').get()).data().groupIds, ['dir']);
    assert.strictEqual((await db.doc('invites/inv1').get()).exists, false);
  });
});

describe('users, rounds, invitations', () => {
  test('link an account to a golfer — and away from its old one', async () => {
    await open('users', 'uid_brian');
    await page.selectOption('#uG', 'ghin:2');
    await page.click('#uGSave'); await settle();
    assert.strictEqual((await db.doc('users/uid_brian').get()).data().myGolferId, 'ghin:2');
    assert.strictEqual((await db.doc('golfers/ghin:2').get()).data().claimedByUid, 'uid_brian');
    assert.strictEqual((await db.doc('golfers/ghin:1').get()).data().claimedByUid, null);
  });

  test('move a round into a group, then delete it', async () => {
    await open('rounds', 'r1');
    await page.selectOption('#rG', 'dir');
    await page.click('#rGSave'); await settle();
    assert.strictEqual((await db.doc('rounds/r1').get()).data().groupId, 'dir');
    await open('rounds', 'r1');
    await page.click('#rDel'); await settle();
    assert.strictEqual((await db.doc('rounds/r1').get()).exists, false);
  });

  test('revoke an invitation', async () => {
    await db.doc('invites/inv2').set({ groupId: 'dir', email: 'sam@x.com', invitedByUid: 'uid_brian', status: 'pending' });
    await page.click('#rf'); await settle();
    await open('invites', 'inv2');
    await page.click('#iRev'); await settle();
    assert.strictEqual((await db.doc('invites/inv2').get()).data().status, 'revoked');
    await page.close();
  });
});

describe('courses', () => {
  test('the built-in list is read out of the app itself', async () => {
    await signIn('uid_brian', { admin: true });
    await page.waitForSelector('.tab');
    await open('courses');
    const rows = await page.evaluate(() => [...document.querySelectorAll('tr.row')].map((r) => r.dataset.id));
    assert.ok(rows.length >= 28, 'all 28 built-in courses: ' + rows.length);
    assert.ok(rows.includes('b:el macero'));
  });

  test('a stroke index used twice is refused, and nothing is saved', async () => {
    await page.click('tr.row[data-id="b:el macero"]');
    assert.strictEqual(await page.locator('#cTees tr').count(), 8, 'El Macero\'s eight tees come with it');
    await page.fill('[data-si="0"]', '1');                 // hole 4 is already 1
    assert.strictEqual(await page.locator('[data-si].bad').count(), 2, 'both clashing boxes are marked');
    await page.click('#cSave'); await settle();
    assert.match(await page.textContent('#cProblems'), /uses 1 twice and never 15/);
    assert.strictEqual((await db.collection('courses').get()).size, 0);
  });

  test('fixed, it saves a database version with par, stroke index and tees', async () => {
    await page.fill('[data-si="0"]', '15');
    await page.fill('#cTees tr:nth-child(4) .tr', '72.3');  // White re-rated
    await page.click('#cSave'); await settle();
    const docs = (await db.collection('courses').get()).docs;
    assert.strictEqual(docs.length, 1);
    const c = docs[0].data();
    assert.strictEqual(docs[0].id, 'el-macero-cc');
    assert.deepStrictEqual(c.hcp, [15,13,9,1,7,3,17,11,5,8,2,16,6,10,12,18,4,14]);
    assert.strictEqual(c.tees.length, 8);
    assert.deepStrictEqual([c.tees[3].name, c.tees[3].rating, c.tees[3].slope], ['White', 72.3, 129]);
    assert.strictEqual(await page.textContent('tr.row[data-id="b:el macero"] .pill'), 'edited');
  });

  test('a new course can be added', async () => {
    await page.click('#cNew');
    await page.fill('#cName', 'Wildhorse Test');
    for (let i = 0; i < 18; i++) await page.fill(`[data-si="${i}"]`, String(i + 1));
    await page.click('#cAddTee');
    await page.fill('#cTees tr:last-child .tn', 'Blue');
    await page.fill('#cTees tr:last-child .tr', '70.1');
    await page.fill('#cTees tr:last-child .ts', '121');
    await page.click('#cSave'); await settle();
    const c = (await db.doc('courses/wildhorse-test').get()).data();
    assert.deepStrictEqual([c.name, c.par.reduce((a, b) => a + b, 0), c.tees[0].slope], ['Wildhorse Test', 72, 121]);
  });

  test('a built-in course can be hidden from the app without editing it', async () => {
    await page.click('tr.row[data-id="b:mather"]');
    await page.click('#cHide'); await settle();
    const c = (await db.doc('courses/mather').get()).data();
    assert.deepStrictEqual([c.name, c.hidden], ['Mather', true]);
  });

  test('deleting a database version puts the built-in back', async () => {
    await page.click('tr.row[data-id="b:el macero"]');
    await page.click('#cDel'); await settle();
    assert.strictEqual((await db.doc('courses/el-macero-cc').get()).exists, false);
    assert.strictEqual(await page.textContent('tr.row[data-id="b:el macero"] td:last-child'), 'built-in');
    await page.close();
  });
});

