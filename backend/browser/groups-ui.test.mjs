/**
 * Groups in the app: picking the group you play with, building one from the
 * directory, adding and removing golfers, the invite link, and joining from it.
 *
 * The cloud module is replaced by an in-memory stand-in with the same method
 * names, so this tests the SCREENS and what they ask for. That the requests
 * themselves are allowed is groups.test.mjs's job, against the real rules.
 *
 * Run with the repo served over http:
 *   python3 -m http.server 8130
 *   node backend/browser/groups-ui.test.mjs
 */
import { chromium } from 'playwright';

const ORIGIN = 'http://127.0.0.1:8130';
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}` +
    (ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`));
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });

/** The fake backend. Records every call so the test can see what was asked. */
function installFake() {
  const DIR = 'dir', WED = 'wed';
  const db = {
    groups: {
      [DIR]: { id: DIR, name: 'El Macero', ownerUid: 'uid_brian', memberUids: ['uid_brian', 'uid_me'] },
      [WED]: { id: WED, name: 'Wednesday', kind: 'group', ownerUid: 'uid_me', memberUids: ['uid_me'], joinCode: 'wedcode' },
      sat: { id: 'sat', name: 'Saturday', kind: 'group', ownerUid: 'uid_x', memberUids: ['uid_x'], joinCode: 'satcode' },
    },
    golfers: {
      'ghin:1': { name: 'Tyler Bryan', currentIndex: '+0.3', poolGroupIds: [DIR, WED] },
      'ghin:2': { name: 'Brian Casey', currentIndex: '5.5', poolGroupIds: [DIR] },
      'ghin:3': { name: 'Brian Bunch', currentIndex: '7.0', poolGroupIds: [DIR, WED] },
      'ghin:4': { name: 'Kenneth Bernard', currentIndex: '10.8', poolGroupIds: [DIR] },
      'ghin:5': { name: 'Timothy Mar', currentIndex: '18.7', poolGroupIds: [DIR] },
    },
    myGroups: [DIR, WED],
  };
  const calls = [];
  window.__calls = calls;
  window.__db = db;
  const me = 'uid_me';
  const pool = (gid) => Object.entries(db.golfers).filter(([, g]) => g.poolGroupIds.includes(gid))
    .map(([id, g]) => ({ id, ...g }));
  const api = {
    isDirectory: (g) => (g && g.kind) !== 'group',
    async ensureUserDoc() { return {}; },
    async myUserDoc() { return { groupIds: db.myGroups.slice() }; },
    async myGolfer() { return null; },
    async myGroups() { return db.myGroups.map((id) => ({ ...db.groups[id] })); },
    async pendingInvites() { return []; },
    async groupPool(gid) { return pool(gid); },
    async createGroup(name, ids) {
      calls.push(['createGroup', name, ids.slice().sort()]);
      const id = 'new1';
      db.groups[id] = { id, name, kind: 'group', ownerUid: me, memberUids: [me], joinCode: 'newcode' };
      db.myGroups.push(id);
      ids.forEach((g) => db.golfers[g].poolGroupIds.push(id));
      return id;
    },
    async addToGroup(gid, ids) { calls.push(['addToGroup', gid, ids.slice().sort()]); ids.forEach((g) => db.golfers[g].poolGroupIds.push(gid)); return ids.length; },
    async removeFromGroup(gid, id) { calls.push(['removeFromGroup', gid, id]); db.golfers[id].poolGroupIds = db.golfers[id].poolGroupIds.filter((x) => x !== gid); },
    async createGolfer(g, gids) { calls.push(['createGolfer', g.name, g.ghinNumber, g.currentIndex, gids]); db.golfers['guest:n'] = { name: g.name, currentIndex: g.currentIndex, poolGroupIds: gids.slice() }; return 'guest:n'; },
    async joinGroup(gid, code) {
      calls.push(['joinGroup', gid, code]);
      if (db.groups[gid].joinCode !== code) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
      db.groups[gid].memberUids.push(me); db.myGroups.push(gid); return db.groups[gid];
    },
    async joinCodeFor(gid) { const g = db.groups[gid]; return g.joinCode || (g.ownerUid === me ? 'made' : null); },
    async resetJoinCode(gid) { calls.push(['resetJoinCode', gid]); db.groups[gid].joinCode = 'reset'; return 'reset'; },
    async leaveGroup(gid) { calls.push(['leaveGroup', gid]); db.myGroups = db.myGroups.filter((x) => x !== gid); },
    async saveRound() { return 'r'; },
  };
  const C = window._bb.Cloud;
  C.api = api;
  C.user = { uid: me, email: 'me@x.com', displayName: 'Me' };
  return C.refreshProfile();
}

async function open(url = '/index.html') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem('__bbSeeded')) return;
    sessionStorage.setItem('__bbSeeded', '1');
    localStorage.setItem('bunchbets-installed', 'true');
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.route('**://**', (r) => r.request().url().startsWith(ORIGIN) ? r.continue() : r.abort());
  await page.goto(ORIGIN + url, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.evaluate(() => { const n = document.querySelector('.whats-new-overlay'); if (n) n.remove(); });
  await page.evaluate(installFake);
  await page.evaluate(() => { const W = window._bb.Wizard; W.active = true; W.step = 'home'; W.render(); });
  await page.waitForTimeout(300);
  return { page, ctx, errs };
}

const calls = (page) => page.evaluate(() => window.__calls.slice());
const chips = (page) => page.evaluate(() => [...document.querySelectorAll('.wizard-screen .wz-group-chip')]
  .map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')));

// --------------------------------------------------------------------------
console.log('\nhome: which group this round is for\n');
{
  const { page, ctx, errs } = await open();
  check('your groups are offered, a playing group ahead of the directory', await chips(page), ['El Macero', 'Wednesday*']);
  check('the account line counts everyone you can pick from',
    /5 golfer\(s\)/.test(await page.textContent('.wz-account')), true);

  // Players screen: Wednesday first, the rest of the directory after it.
  const roster = await page.evaluate(() => window._bb.Wizard.pickerRoster().map((r) => r.section + ':' + r.name));
  check('the players screen lists the group first, then everyone else',
    roster, ['Wednesday:Brian Bunch', 'Wednesday:Tyler Bryan',
             'Everyone else:Brian Casey', 'Everyone else:Kenneth Bernard', 'Everyone else:Timothy Mar']);

  await page.click('.wz-group-chip[data-gid="dir"]');
  await page.waitForTimeout(250);
  check('tapping a group makes it the one you play with', await chips(page), ['El Macero*', 'Wednesday']);
  check('  and it is remembered', await page.evaluate(() => localStorage.getItem('bb-active-group')), 'dir');
  check('  and the round is filed there',
    await page.evaluate(() => window._bb.Cloud.buildRound({ id: 'r1', players: [], games: [] }).groupId), 'dir');
  const one = await page.evaluate(() => window._bb.Wizard.pickerRoster().map((r) => r.section || null));
  check('with the directory active there is one list and no headings', [...new Set(one)], [null]);

  check('no page errors', errs, []);
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\nstarting a group from the directory\n');
{
  const { page, ctx, errs } = await open();
  await page.click('#wizGroups');
  await page.waitForTimeout(250);
  check('the groups screen lists both', await page.evaluate(() =>
    [...document.querySelectorAll('#groupsOverlay .grp-row .nm')].map((x) => x.textContent)), ['El Macero', 'Wednesday']);

  await page.click('#grpNew');
  await page.waitForTimeout(150);
  check('Start is off until there is a name', await page.isDisabled('#grpCreate'), true);
  await page.fill('#grpName', 'Saturday money game');
  await page.fill('#grpSearch', 'brian');
  check('search narrows the list', await page.evaluate(() =>
    [...document.querySelectorAll('#grpPick .wz-row')].filter((r) => r.style.display !== 'none').map((r) => r.textContent.trim())),
    ['Brian Bunch7.0', 'Brian Casey5.5']);
  await page.click('#grpPick .wz-row[data-id="ghin:2"]');
  await page.fill('#grpSearch', '');
  await page.dispatchEvent('#grpSearch', 'input');
  await page.click('#grpPick .wz-row[data-id="ghin:4"]');
  check('the button counts who is in it', (await page.textContent('#grpCreate')).trim(), 'Start group with 2');
  await page.click('#grpCreate');
  await page.waitForTimeout(400);

  check('it asks for the group with exactly those two', (await calls(page)).filter((c) => c[0] === 'createGroup'),
    [['createGroup', 'Saturday money game', ['ghin:2', 'ghin:4']]]);
  check('and opens it', (await page.textContent('#groupsOverlay h2')).trim(), 'Saturday money game');
  check('with its golfers', await page.evaluate(() =>
    [...document.querySelectorAll('#groupsOverlay .grp-row .nm')].map((x) => x.textContent)), ['Brian Casey', 'Kenneth Bernard']);
  check('and it becomes the group you play with',
    await page.evaluate(() => window._bb.Cloud.activeGroup().name), 'Saturday money game');

  // Add someone from the directory, and someone brand new.
  await page.click('#grpAddBtn');
  await page.waitForTimeout(200);
  check('only people not already in it are offered', await page.evaluate(() =>
    [...document.querySelectorAll('#grpPick .wz-row')].map((r) => r.dataset.id)), ['ghin:3', 'ghin:5', 'ghin:1']);
  await page.click('#grpPick .wz-row[data-id="ghin:5"]');
  await page.click('#grpAdd');
  await page.waitForTimeout(400);
  check('adding asks for exactly him', (await calls(page)).filter((c) => c[0] === 'addToGroup'),
    [['addToGroup', 'new1', ['ghin:5']]]);

  await page.click('#grpAddBtn');
  await page.waitForTimeout(200);
  await page.fill('#grpNewName', 'Gary Nunes');
  await page.fill('#grpNewIdx', '10.4');
  await page.click('#grpCreateGolfer');
  await page.waitForTimeout(400);
  check('a new golfer goes into the group AND the directory, so everyone can pick him',
    (await calls(page)).filter((c) => c[0] === 'createGolfer'), [['createGolfer', 'Gary Nunes', null, '10.4', ['new1', 'dir']]]);

  await page.click('#groupsOverlay [data-rm="ghin:4"]');
  await page.waitForTimeout(400);
  check('taking someone out asks for exactly that', (await calls(page)).filter((c) => c[0] === 'removeFromGroup'),
    [['removeFromGroup', 'new1', 'ghin:4']]);
  check('you run it, so you can kill old links; you cannot leave it',
    [await page.locator('#grpReset').count(), await page.locator('#grpLeave').count()], [1, 0]);

  check('no page errors', errs, []);
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\nthe directory: nobody is taken out of it\n');
{
  const { page, ctx } = await open();
  await page.evaluate(() => window._bb.UI.showGroups({ groupId: 'dir' }));
  await page.waitForTimeout(200);
  check('no remove buttons on the directory', await page.locator('#groupsOverlay [data-rm]').count(), 0);
  check('you do not run it, so you may leave it', await page.locator('#grpLeave').count(), 1);
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\nthe invite link, and joining from it\n');
{
  const { page, ctx } = await open();
  const url = await page.evaluate(() => window._bb.Cloud.shareLink('wed'));
  const u = new URL(url);
  check('the link carries the group, its code and its name',
    [u.searchParams.get('group'), u.searchParams.get('code'), u.searchParams.get('name')], ['wed', 'wedcode', 'Wednesday']);
  check('a member who does not run the directory gets no link for it',
    await page.evaluate(() => window._bb.Cloud.shareLink('dir')), null);
  await ctx.close();
}
{
  // Opened from the link. Not signed in yet when the page loads.
  const { page, ctx, errs } = await open('/index.html?group=sat&code=satcode&name=Saturday');
  check('the link is taken off the address bar', await page.evaluate(() => location.search), '');
  check('and kept for after sign-in', await page.evaluate(() => JSON.parse(localStorage.getItem('bb-pending-join')).id), 'sat');
  check('Home offers it', /invited to Saturday/.test((await page.textContent('.wz-join-banner')).replace(/\s+/g, ' ')), true);
  await page.click('#wizJoinGroup');
  await page.waitForTimeout(500);
  check('Join presents the code', (await calls(page)).filter((c) => c[0] === 'joinGroup'), [['joinGroup', 'sat', 'satcode']]);
  check('the banner goes', await page.locator('.wz-join-banner').count(), 0);
  check('and the new group is the one you play with', await chips(page), ['El Macero', 'Wednesday', 'Saturday*']);
  check('no page errors', errs, []);
  await ctx.close();
}
{
  const { page, ctx } = await open('/index.html?group=sat&code=stale&name=Saturday');
  await page.click('#wizJoinGroup');
  await page.waitForTimeout(500);
  check('an old link is refused plainly',
    await page.evaluate(() => window._bb.Cloud.status), 'That invite link no longer works. Ask for a new one.');
  check('  and not offered again', await page.locator('.wz-join-banner').count(), 0);
  await ctx.close();
}

console.log('\nan emailed invitation shows on Home, not only in the menu\n');
{
  const { page, ctx, errs } = await open();
  await page.evaluate(async () => {
    const C = window._bb.Cloud;
    window.__accepted = [];
    C.api.pendingInvites = async () => window.__accepted.length ? [] : [{ id: 'inv_gary', groupId: 'nunes', golferId: 'ghin:7', email: 'g@x.com', status: 'pending' }];
    C.api.acceptInvite = async (id) => { window.__accepted.push(id); return { groupId: 'dir', golferId: 'ghin:7' }; };
    await C.refreshProfile();
    window._bb.Wizard.render();
  });
  await page.waitForTimeout(300);
  const banner = (await page.textContent('.wz-join-banner')).replace(/\s+/g, ' ');
  check('Home offers it, by the group\'s name', /invited to Nunes/.test(banner), true);
  check('  and says it links their scores', /links you to your scores/.test(banner), true);
  await page.click('[data-accept="inv_gary"]');
  await page.waitForTimeout(500);
  check('Join accepts exactly that invitation', await page.evaluate(() => window.__accepted), ['inv_gary']);
  check('  and the banner goes', await page.locator('[data-accept]').count(), 0);
  check('no page errors', errs, []);
  await ctx.close();
}

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
