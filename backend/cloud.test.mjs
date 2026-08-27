/**
 * Integration test: the real cloud module, running in a real browser, against
 * the Auth and Firestore emulators with the real security rules loaded.
 *
 * The rules unit tests (rules.test.js) assert the rules against queries *I*
 * wrote by hand. This asserts them against the queries the actual client makes
 * — which is the only way to find out whether those assumptions were right.
 *
 * Prereqs:
 *   firebase emulators:start --only firestore,auth --project bb-test
 *   node seed.js --csv <roster> --group "El Macero Saturday" --owner-uid uid_brian --emulator --commit
 *   python3 -m http.server 8099   (serving apptest/)
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { execFileSync } from 'node:child_process';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8181';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';

// ?sdk=/vendor uses locally cached SDK copies (a sandbox may not reach a CDN);
// ?emulator points the module at the Auth and Firestore emulators.
const URL = 'http://127.0.0.1:8099/cloud-test.html?sdk=/vendor&emulator=1';
const GROUP = 'el-macero-saturday';

let browser, adminAuth;

before(async () => {
  // Hermetic: the emulator persists between runs, so a previous run that
  // accepted an invitation would make this one fail for the wrong reason.
  await fetch('http://127.0.0.1:8181/emulator/v1/projects/bb-test/databases/(default)/documents',
              { method: 'DELETE' });
  execFileSync('node', ['seed.js', '--csv', process.env.BB_ROSTER || '/home/claude/roster_fixed.csv',
                        '--group', 'El Macero Saturday', '--owner-uid', 'uid_brian',
                        '--emulator', '--commit'], { stdio: 'ignore' });
  initializeApp({ projectId: 'bb-test' });
  adminAuth = getAuth();
  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });
});
after(async () => { await browser?.close(); });

/** A signed-in page with a VERIFIED email — the rules refuse unverified. */
async function signedInPage(uid, email) {
  // Emails are unique in Auth, and these tests deliberately reuse one address
  // across uids to exercise repeat onboarding — so clear both first.
  try { await adminAuth.deleteUser(uid); } catch (e) {}
  try { const ex = await adminAuth.getUserByEmail(email); await adminAuth.deleteUser(ex.uid); } catch (e) {}
  await adminAuth.createUser({ uid, email, emailVerified: true, displayName: email.split('@')[0] });
  const token = await adminAuth.createCustomToken(uid);

  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  await page.evaluate(async (t) => {
    await firebase.app('bbcloud').auth().signInWithCustomToken(t);
    await new Promise((r) => {
      const off = firebase.app('bbcloud').auth().onAuthStateChanged((u) => { if (u) { off(); r(); } });
    });
  }, token);
  page.__errs = errs;
  return page;
}

describe('cloud module against real rules', () => {
  test('sign-in bootstraps a user document', async () => {
    const page = await signedInPage('uid_fresh', 'nobody@example.com');
    const doc = await page.evaluate(() => window.cloud.ensureUserDoc());
    assert.equal(doc.email, 'nobody@example.com');
    assert.deepEqual(doc.groupIds, []);
    assert.equal(doc.myGolferId, null);
    await page.close();
  });

  test('pending invitations are found by verified email', async () => {
    const page = await signedInPage('uid_eric2', 'ericj@mac.com');
    await page.evaluate(() => window.cloud.ensureUserDoc());
    const invites = await page.evaluate(() => window.cloud.pendingInvites());
    assert.equal(invites.length, 1, 'exactly one seeded invitation');
    assert.equal(invites[0].groupId, 'el-macero-saturday');
    assert.equal(invites[0].golferId, 'ghin:8658986');
    await page.close();
  });

  test('accepting joins the group AND claims the seeded golfer', async () => {
    const page = await signedInPage('uid_brian2', 'bunch3131@gmail.com');
    await page.evaluate(() => window.cloud.ensureUserDoc());
    const res = await page.evaluate(async () => {
      const [inv] = await window.cloud.pendingInvites();
      return window.cloud.acceptInvite(inv.id);
    });
    assert.equal(res.groupId, GROUP);
    assert.equal(res.golferId, 'ghin:1506580');

    const after = await page.evaluate(async () => ({
      user: await window.cloud.myUserDoc(),
      golfer: await window.cloud.myGolfer(),
      groups: await window.cloud.myGroups(),
    }));
    assert.deepEqual(after.user.groupIds, [GROUP]);
    assert.equal(after.user.myGolferId, 'ghin:1506580');
    assert.equal(after.golfer.claimedByUid, 'uid_brian2', 'the seeded record is now his');
    assert.equal(after.golfer.name, 'Brian Bunch', 'and it carries the seeded data');
    assert.equal(after.groups.length, 1);
    assert.ok(after.groups[0].memberUids.includes('uid_brian2'));
    await page.close();
  });

  test('the group pool is readable once you are a member', async () => {
    const page = await signedInPage('uid_pool', 'andy@jacksontempledistilling.com');
    await page.evaluate(async () => {
      await window.cloud.ensureUserDoc();
      const [inv] = await window.cloud.pendingInvites();
      if (!inv) throw new Error('no pending invitation — test fixtures are not isolated');
      await window.cloud.acceptInvite(inv.id);
    });
    const pool = await page.evaluate((g) => window.cloud.groupPool(g), GROUP);
    assert.ok(pool.length >= 16, `pool has the regulars (${pool.length})`);
    const unclaimed = pool.filter((p) => p.claimedByUid == null).length;
    assert.ok(unclaimed > 10, 'most of the pool has no account — golfers, not users');
    await page.close();
  });

  test('a non-member cannot read the pool', async () => {
    const page = await signedInPage('uid_outsider', 'outsider@example.com');
    await page.evaluate(() => window.cloud.ensureUserDoc());
    const result = await page.evaluate(async (g) => {
      try { await window.cloud.groupPool(g); return 'ALLOWED'; }
      catch (e) { return e.code || e.message; }
    }, GROUP);
    assert.match(result, /permission-denied/, 'rules deny it from real client code');
    await page.close();
  });

  test('rounds: save, then read back by both query paths', async () => {
    const page = await signedInPage('uid_rounds', 'ianbolnik@comcast.net');
    await page.evaluate(async () => {
      await window.cloud.ensureUserDoc();
      const [inv] = await window.cloud.pendingInvites();
      if (!inv) throw new Error('no pending invitation — test fixtures are not isolated');
      await window.cloud.acceptInvite(inv.id);
    });
    const out = await page.evaluate(async (g) => {
      const id = await window.cloud.saveRound({
        groupId: g, date: '2026-08-27', courseName: 'El Macero CC',
        golferIds: ['ghin:8658986', 'ghin:1506580'],
        results: { 'ghin:8658986': { money: 12, gross: 78 }, 'ghin:1506580': { money: -12, gross: 74 } },
      });
      return { id, mine: (await window.cloud.myRounds()).length, group: (await window.cloud.groupRounds(g)).length };
    }, GROUP);
    assert.ok(out.id);
    assert.ok(out.mine >= 1, 'personal-history query works');
    assert.ok(out.group >= 1, 'group-stats query works');
    await page.close();
  });

  test('a non-member cannot read the group’s rounds', async () => {
    const page = await signedInPage('uid_outsider2', 'outsider2@example.com');
    await page.evaluate(() => window.cloud.ensureUserDoc());
    const result = await page.evaluate(async (g) => {
      try { await window.cloud.groupRounds(g); return 'ALLOWED'; }
      catch (e) { return e.code || e.message; }
    }, GROUP);
    assert.match(result, /permission-denied/);
    await page.close();
  });

  test('aggregate turns rounds into standings', async () => {
    const page = await signedInPage('uid_stats', 'stats@example.com');
    const stats = await page.evaluate(() => window.cloud.aggregate([
      { results: { a: { money: 10, gross: 80 }, b: { money: -10, gross: 75 } } },
      { results: { a: { money: -4, gross: 84 }, b: { money: 4, gross: 77 } } },
    ]));
    const a = stats.find((s) => s.golferId === 'a');
    const b = stats.find((s) => s.golferId === 'b');
    assert.equal(a.money, 6); assert.equal(a.rounds, 2); assert.equal(a.scoringAvg, 82);
    assert.equal(b.money, -6); assert.equal(b.best, 75);
    assert.equal(stats[0].golferId, 'a', 'sorted by money');
    await page.close();
  });

  test('handicap index parsing survives NH and plus handicaps', async () => {
    const page = await signedInPage('uid_idx', 'idx@example.com');
    const r = await page.evaluate(() => ({
      nh: window.cloud.parseIndex('NH'),
      plus: window.cloud.parseIndex('+2.8'),
      normal: window.cloud.parseIndex('13.5'),
      empty: window.cloud.parseIndex(null),
      junk: window.cloud.parseIndex('  '),
    }));
    assert.equal(r.nh, null, 'NH is not a handicap');
    assert.equal(r.plus, -2.8, 'a plus handicap is a negative index');
    assert.equal(r.normal, 13.5);
    assert.equal(r.empty, null);
    assert.equal(r.junk, null);
    await page.close();
  });
});
