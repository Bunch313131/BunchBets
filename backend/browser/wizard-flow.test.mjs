/**
 * The redesigned setup flow, walked the way a person walks it.
 *
 * Seven screens, each answering one question, with the group's normal round
 * already filled in. What matters is not that each screen renders — it is that
 * the ROUND THAT COMES OUT THE FAR END matches what was chosen on the way
 * through. A wizard that looks right and produces the wrong teams, the wrong
 * stakes or a round that thinks it has already been played is the failure mode
 * this whole session has been about.
 *
 * So every assertion here is made against State after Play, not against the
 * screens.
 *
 * It also pins the gate: production must still get the old wizard. The new flow
 * is beta-only until it has been played with, because a setup screen is the one
 * place a surprise costs somebody a round rather than a reload.
 *
 * Run with the repo served over http:
 *   python3 -m http.server 8130
 *   node backend/browser/wizard-flow.test.mjs
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

const POOL = [
  { id: 'ghin:326845', name: 'Tyler Bryan', currentIndex: '+0.3' },
  { id: 'ghin:1236530', name: 'Brian Casey', currentIndex: '5.5' },
  { id: 'ghin:1506580', name: 'Brian Bunch', currentIndex: '7.0' },
  { id: 'ghin:8311822', name: 'Kenneth Bernard', currentIndex: '10.8' },
  { id: 'ghin:9857501', name: 'Timothy Mar', currentIndex: '18.7' },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });

async function open(host = ORIGIN) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept());

  // ORDER MATTERS, and getting it wrong made this whole section meaningless.
  //
  // Playwright runs handlers most-recently-registered FIRST, and route.continue()
  // sends the request to the network rather than falling through to another
  // handler. With the catch-all registered last it ran first, continued every
  // bunchbets.com request straight out to the real internet, and the "does
  // production still get the old wizard" checks were testing the LIVE SITE —
  // which is genuinely the old wizard, so they passed no matter what this build
  // did. A mutation that turned the new flow on everywhere survived untouched.
  //
  // So: catch-all first (it ends up last), host rewrite last (it runs first).
  await page.route('**://**', (r) => r.request().url().startsWith(host) ? r.continue() : r.abort());
  if (host !== ORIGIN) {
    await page.route(host + '/**', async (route) => {
      const u = new URL(route.request().url());
      const r = await fetch(ORIGIN + u.pathname + u.search).catch(() => null);
      if (!r) return route.abort();
      route.fulfill({ status: r.status, body: Buffer.from(await r.arrayBuffer()),
        headers: { 'content-type': r.headers.get('content-type') || 'text/html' } });
    });
  }

  await page.goto(host + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('bunchbets-installed', 'true'));
  await page.goto(host + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => { const n = document.querySelector('.whats-new-overlay'); if (n) n.remove(); });
  return { page, ctx, errs };
}

const heading = (page) => page.evaluate(() => document.querySelector('.wizard-header h2')?.textContent || '(none)');

/** Walk signin -> review with a given lineup, and press Play. */
async function walk(page, players) {
  await page.evaluate((pool) => {
    Object.assign(window._bb.Cloud, { user: { uid: 'u', email: 'b@x.com' },
      groups: [{ id: 'nunes', name: 'Nunes' }], pool });
    const W = window._bb.Wizard;
    W.active = true; W.step = 'signin';
    W.data.players = []; W.data.games = [W.createGameData()];
    W.currentGameIndex = 0;
    W.render();
  }, POOL);
  await page.waitForTimeout(400);

  const seen = [];
  seen.push(await heading(page));
  await page.click('#wizNext'); await page.waitForTimeout(600);            // -> course
  seen.push(await heading(page));
  const teeOnCourse = await page.locator('#wizardCourseTee #wizardTee').count();
  await page.click('#wizardCourseNext'); await page.waitForTimeout(600);   // -> players
  seen.push(await heading(page));

  await page.evaluate((ps) => { window._bb.Wizard.data.players = ps; window._bb.Wizard.render(); }, players);
  await page.waitForTimeout(400);
  await page.click('#wizardPlayersNext'); await page.waitForTimeout(600);  // -> games
  seen.push(await heading(page));
  await page.click('#wizNext'); await page.waitForTimeout(600);            // -> teams (or stakes)
  seen.push(await heading(page));
  return { seen, teeOnCourse };
}

// --------------------------------------------------------------------------
console.log('\nlaunching on beta lands on sign-in, not on the course\n');
{
  // Through the SPLASH, the way a launch actually goes. Setting Wizard.step
  // directly skips the curtain — and the curtain reveals a screen that is
  // pre-rendered behind it, which was revealing the course no matter what the
  // step said. The sign-in screen existed and was unreachable.
  const { page, ctx, errs } = await open();
  await page.evaluate(() => { const s = document.querySelector('.wizard-splash'); if (s) s.click(); });
  await page.waitForTimeout(1900);
  check('the first screen is sign-in', await heading(page), "Who's keeping score?");
  check('  and only one screen is mounted',
    await page.evaluate(() => document.querySelectorAll('.wizard-header h2').length), 1);
  check('no page errors', errs, []);
  await ctx.close();
}

console.log('\nfive players — the whole flow, and the round it produces\n');
{
  const { page, ctx, errs } = await open();
  const { seen, teeOnCourse } = await walk(page, [
    { name: 'Tyler Bryan', handicap: 0 }, { name: 'Brian Casey', handicap: 6 },
    { name: 'Brian Bunch', handicap: 8 }, { name: 'Kenneth Bernard', handicap: 12 },
    { name: 'Timothy Mar', handicap: 21 },
  ]);

  check('the screens come in order', seen,
    ["Who's keeping score?", 'Select Course', "Who's Playing?", 'What are we playing?', 'Three matches']);
  check('the tee is on the course screen, where it belongs', teeOnCourse, 1);
  check('  and no longer on the players screen', await page.locator('.wiz-tee').count(), 0);
  check('three matches are laid out', await page.locator('.wizard-content .card').count(), 3);

  await page.click('#wizNext'); await page.waitForTimeout(600);
  check('then the money', await heading(page), 'Playing for?');
  await page.fill('#wizFront', '5'); await page.fill('#wizBack', '5'); await page.fill('#wizOverall', '5');
  await page.fill('#wizJunkFront', '4'); await page.fill('#wizJunkBack', '4');

  // Turn junk OFF and back ON, so that hardwiring it either way is visible.
  // Without this, a build that ignored the toggle entirely passed every check.
  await page.uncheck('#wizJunk'); await page.waitForTimeout(200);
  check('unticking junk hides its values',
    await page.evaluate(() => document.getElementById('wizJunkVals').style.display), 'none');
  await page.click('#wizNext'); await page.waitForTimeout(500);
  check('  and it reaches the round as off',
    await page.evaluate(() => window._bb.Wizard.data.games.every((g) => g.withJunk === false)), true);
  check('  with its values zeroed rather than left lying around',
    await page.evaluate(() => window._bb.Wizard.data.games[0].junkValue), { front: 0, back: 0 });
  await page.evaluate(() => { window._bb.Wizard.step = 'stakes'; window._bb.Wizard.render(); });
  await page.waitForTimeout(400);
  await page.check('#wizJunk'); await page.waitForTimeout(200);
  await page.fill('#wizJunkFront', '4'); await page.fill('#wizJunkBack', '4');

  await page.click('#wizNext'); await page.waitForTimeout(600);
  check('then review', await heading(page), 'Ready');
  const review = (await page.textContent('.wizard-content')).replace(/\s+/g, ' ');
  check('  naming the course and tee', /El Macero · White/.test(review), true);
  check('  the lineup', /5 playing/.test(review), true);
  check('  the game, properly named', /Nassau/.test(review), true);
  check('  NOT the raw type string', /nassau/.test(review), false);
  check('  and the stakes', /\$5 \/ \$5 \/ \$5/.test(review), true);

  await page.click('#wizPlay'); await page.waitForTimeout(900);

  // Everything below is the actual round, which is the only thing that matters.
  const round = await page.evaluate(() => {
    const S = window._bb.State.data;
    return {
      open: !!document.getElementById('wizardOverlay'),
      games: S.games.map((g) => g.gameType),
      teams: S.games.map((g) => g.teamA.join('+') + ' v ' + g.teamB.join('+')),
      stakes: S.games[0].stakes,
      junk: S.games[0].junkValue,
      withJunk: S.games.every((g) => g.withJunk),
      mode: S.games[0].handicapMode,
      hole: S.scoringHole,
      scored: Object.keys(S._scoredHoles || {}).length,
      tee: S.course.teeName,
      players: S.players.map((p) => p.name + ' ' + p.handicap),
    };
  });

  check('the wizard closes', round.open, false);
  check('three nassau games', round.games, ['nassau', 'nassau', 'nassau']);
  check('the pair stays together, against each other pair', round.teams,
    ['p1+p5 v p2+p3', 'p1+p5 v p2+p4', 'p1+p5 v p3+p4']);
  check('the stakes are what was typed', round.stakes, { front: 5, back: 5, overall: 5 });
  check('junk is on, at what was typed', [round.withJunk, round.junk], [true, { front: 4, back: 4 }]);
  check('team delta, the way this group plays', round.mode, 'team_delta');
  check('the tee is carried onto the round', round.tee, 'White');
  check('five players with their handicaps', round.players.length, 5);
  check('it starts on hole 1', round.hole, 0);
  check('with NOTHING scored', round.scored, 0);

  check('no page errors', errs, []);
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\nfour players — one match, and the pairing that balances\n');
{
  const { page, ctx, errs } = await open();
  const { seen } = await walk(page, [
    { name: 'Tyler Bryan', handicap: 0 }, { name: 'Brian Casey', handicap: 6 },
    { name: 'Brian Bunch', handicap: 8 }, { name: 'Kenneth Bernard', handicap: 12 },
  ]);
  check('the teams screen is singular', seen[4], 'Teams?');
  check('  and shows one match', await page.locator('.wizard-content .card').count(), 1);

  await page.click('#wizNext'); await page.waitForTimeout(500);
  await page.click('#wizNext'); await page.waitForTimeout(500);
  await page.click('#wizPlay'); await page.waitForTimeout(900);

  const r = await page.evaluate(() => {
    const S = window._bb.State.data;
    return { n: S.games.length, teams: S.games[0].teamA.join('+') + ' v ' + S.games[0].teamB.join('+') };
  });
  check('one game', r.n, 1);
  check('lowest with highest', r.teams, 'p1+p4 v p2+p3');
  check('no page errors', errs, []);
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\nturning a game on and off\n');
{
  const { page, ctx } = await open();
  await walk(page, [
    { name: 'Tyler Bryan', handicap: 0 }, { name: 'Brian Casey', handicap: 6 },
    { name: 'Brian Bunch', handicap: 8 }, { name: 'Kenneth Bernard', handicap: 12 },
  ]);
  await page.evaluate(() => { window._bb.Wizard.step = 'games'; window._bb.Wizard.render(); });
  await page.waitForTimeout(400);

  const types = () => page.evaluate(() => window._bb.Wizard.data.games.map((g) => g.gameType));
  await page.click('.wizard-option[data-type="skins"]'); await page.waitForTimeout(300);
  check('skins joins the round', await types(), ['nassau', 'skins']);
  check('  with everybody in it',
    await page.evaluate(() => window._bb.Wizard.data.games.find((g) => g.gameType === 'skins').skinsPlayers.length), 4);

  await page.click('.wizard-option[data-type="nassau"]'); await page.waitForTimeout(300);
  check('nassau comes off', await types(), ['skins']);
  await page.click('#wizNext'); await page.waitForTimeout(500);
  check('with no team game, teams is skipped entirely', await heading(page), 'Playing for?');

  await page.evaluate(() => { window._bb.Wizard.step = 'games'; window._bb.Wizard.render(); });
  await page.waitForTimeout(300);
  await page.click('.wizard-option[data-type="nassau"]'); await page.waitForTimeout(300);
  const back = await page.evaluate(() => {
    const g = window._bb.Wizard.data.games.find((x) => x.gameType === 'nassau');
    return g.teamA.join('+') + ' v ' + g.teamB.join('+');
  });
  // Re-proposed from the CURRENT lineup rather than left arranged for whoever
  // was playing when it was last on.
  check('turning it back on re-proposes the teams', back, 'p1+p4 v p2+p3');
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\nproduction keeps the wizard its users know\n');
{
  const { page, ctx, errs } = await open('https://bunchbets.com');
  // Driven click by click rather than inside one page.evaluate: the wizard
  // re-renders as it goes, and a long-running evaluate loses its execution
  // context the moment that happens.
  // The wizard opens by itself on a fresh install, so there is no menu to go
  // through — and trying would fail anyway, since the overlay covers it.
  //
  // The splash is dismissed in the page rather than clicked through Playwright:
  // it draws a full-bleed particle canvas over itself, which intercepts pointer
  // events and makes a real click retry until it times out.
  await page.evaluate(() => { const s = document.querySelector('.wizard-splash'); if (s) s.click(); });
  await page.waitForTimeout(1900);
  // Proof that this page is the LOCAL build. Without it, a routing mistake sends
  // these assertions to the live site, where they pass for reasons that have
  // nothing to do with the code under test.
  check('the page under test is this build, not the live site',
    await page.evaluate(() => typeof window.BB_BUILD_MARKER), 'string');
  const prod = await heading(page);
  check('the splash goes straight to the course, not to sign-in', prod, 'Select Course');
  check('  and there is no new-flow footer', await page.locator('#wizNext').count(), 0);
  check('  nor a tee row on the course screen', await page.locator('#wizardCourseTee #wizardTee').count(), 0);
  check('no page errors', errs, []);
  await ctx.close();
}

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
