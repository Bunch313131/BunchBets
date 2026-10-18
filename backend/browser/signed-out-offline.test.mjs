/**
 * Accounts are on for everyone from 8.2, and signing in is optional. This
 * proves the optional part, on PRODUCTION, with the network gone: a round can
 * be set up through the new setup, scored and settled by someone who has never
 * signed in, and nothing breaks because Firebase is unreachable.
 *
 * Every request that is not for the app itself is ABORTED, which is harsher
 * than a slow course connection: the auth SDK, Firestore, the course fetch and
 * the live-sync database all fail outright. The app may ask for them (Home warms
 * the sign-in SDK); it must not care that they never come.
 *
 * Scores go in through the hole screen's own stepper buttons, not by writing
 * State directly, so the path is the one a thumb takes.
 *
 * Run with the repo served over http:
 *   python3 -m http.server 8130
 *   node backend/browser/signed-out-offline.test.mjs
 */
import { chromium } from 'playwright';

const ORIGIN = 'http://127.0.0.1:8130';
const HOST = 'https://bunchbets.com';

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}` +
    (ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`));
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [], blocked = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('dialog', (d) => d.accept());

// Catch-all registered FIRST so it runs LAST (see wizard-flow.test.mjs): every
// request off the production host is cut, and the host itself is served from
// this checkout.
await page.route('**://**', (r) => {
  if (r.request().url().startsWith(HOST)) return r.continue();
  blocked.push(new URL(r.request().url()).hostname);
  return r.abort('internetdisconnected');
});
await page.route(HOST + '/**', async (route) => {
  const u = new URL(route.request().url());
  const r = await fetch(ORIGIN + u.pathname + u.search).catch(() => null);
  if (!r) return route.abort();
  route.fulfill({ status: r.status, body: Buffer.from(await r.arrayBuffer()),
    headers: { 'content-type': r.headers.get('content-type') || 'text/html' } });
});

// ?dev exposes window._bb for the assertions; it changes nothing else.
await page.goto(HOST + '/index.html?dev', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('bunchbets-installed', 'true'));
await page.goto(HOST + '/index.html?dev', { waitUntil: 'load' });
await page.waitForTimeout(900);
await page.evaluate(() => { const n = document.querySelector('.whats-new-overlay'); if (n) n.remove(); });

const heading = () => page.evaluate(() => document.querySelector('.wizard-header h2')?.textContent || '(none)');
const tap = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);

console.log('\nproduction, signed out, network blocked\n');
check('the page under test is this build, not the live site',
  await page.evaluate(() => typeof window.BB_BUILD_MARKER), 'string');
check('it is production, not beta', await page.evaluate(() => window._bbBeta), false);

await page.evaluate(() => { const s = document.querySelector('.wizard-splash'); if (s) s.click(); });
await page.waitForTimeout(1900);
check('Home', await heading(), 'Let’s play');
check('  says not signed in, and offers it', await page.evaluate(() =>
  [/Not signed in/.test(document.querySelector('.wizard-content').textContent), !!document.getElementById('wizSignIn')]),
  [true, true]);
check('  nobody is signed in', await page.evaluate(() => !!window._bb.Cloud.user), false);

console.log('\nsetup, without signing in\n');
await tap('#wizNewRound'); await page.waitForTimeout(600);
check('course', await heading(), 'Where are we playing?');
await tap('#wizNext'); await page.waitForTimeout(600);
check('tees', await heading(), 'El Macero');
await tap('#wizNext'); await page.waitForTimeout(600);
check('players', await heading(), "Who's Playing?");
// Typed names, as someone with no group would enter them.
await page.evaluate(() => {
  const W = window._bb.Wizard;
  W.data.players = [{ name: 'Al', handicap: 4 }, { name: 'Bo', handicap: 8 },
                    { name: 'Cy', handicap: 12 }, { name: 'Di', handicap: 16 }];
  W.render();
});
await page.waitForTimeout(400);
await tap('#wizardPlayersNext'); await page.waitForTimeout(600);
check('games', await heading(), 'What are we playing?');
await tap('#wizNext'); await page.waitForTimeout(600);
await tap('#wizNext'); await page.waitForTimeout(600);           // teams -> stakes
check('stakes', await heading(), 'Playing for?');
await tap('#wizNext'); await page.waitForTimeout(600);
check('review', await heading(), 'Ready');
await tap('#wizPlay'); await page.waitForTimeout(900);
check('the round starts', await page.evaluate(() =>
  [!!document.getElementById('wizardOverlay'), window._bb.State.data.players.length, window._bb.State.data.games[0].gameType]),
  [false, 4, 'nassau']);

console.log('\nscoring, through the hole screen\n');
// Al takes par everywhere; Bo one over; Cy and Di bogey-or-worse on alternate
// holes. Taps only: "Take" accepts the shown par, "One more" adds a stroke.
for (let pos = 0; pos < 18; pos++) {
  await page.evaluate((p) => {
    const S = window._bb.State;
    S.data.tab = 'scores'; S.data.scoringView = 'hole'; S.data.scoringHole = p; window._bb.UI.render();
  }, pos);
  await page.waitForTimeout(60);
  await page.evaluate((p) => {
    // Each button closes over the score it was drawn with, so re-render
    // between taps, as the screen does between a thumb's taps.
    const render = () => window._bb.UI.render();
    const btn = (i, n) => document.querySelectorAll('.hole-player-row')[i].querySelectorAll('.score-step > button')[n];
    const plan = [0, 1, p % 2 ? 2 : 1, p % 2 ? 1 : 3];   // strokes over par per player
    plan.forEach((over, i) => {
      btn(i, 1).click(); render();                      // take par
      for (let k = 0; k < over; k++) { btn(i, 2).click(); render(); }
    });
  }, pos);
  await page.waitForTimeout(40);
}
const scored = await page.evaluate(() => {
  const S = window._bb.State.data, g = S.games[0];
  const tot = (pid) => g.gross[pid].reduce((a, b) => a + (b || 0), 0);
  return { holes: Object.keys(S._scoredHoles || {}).length, totals: S.players.map((p) => tot(p.id)) };
});
check('all 18 holes scored', scored.holes, 18);
check('  with the scores tapped in', scored.totals, [72, 90, 99, 108]);

console.log('\nsettling\n');
await page.evaluate(() => { window._bb.State.data.tab = 'settle'; window._bb.UI.render(); });
await page.waitForTimeout(400);
const settle = await page.evaluate(() => {
  const { Game, State } = window._bb;
  const net = {};
  State.data.games.forEach((g) => Object.entries(Game.computeGamePlayerNet(g))
    .forEach(([pid, v]) => { net[pid] = (net[pid] || 0) + v; }));
  const vals = Object.values(net);
  return { sum: Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100,
           moved: vals.some((v) => Math.abs(v) > 0.005),
           shown: /\$/.test(document.body.innerText) };
});
check('money changes hands', settle.moved, true);
check('  and nets to zero', settle.sum, 0);
check('the Settle tab shows it', settle.shown, true);

await page.evaluate(() => window._bb.History.archiveCurrent());
await page.waitForTimeout(300);
const saved = await page.evaluate(() => {
  const r = window._bb.History.load()[0];
  return r ? { players: r.players.length, cloudId: r.cloudId || null,
               net: Math.round(Object.values(r.playerNet).reduce((a, b) => a + b, 0) * 100) / 100 } : null;
});
check('the round is saved to Past rounds on the phone', saved && saved.players, 4);
check('  balanced', saved && saved.net, 0);
check('  and, signed out, never uploaded', saved && saved.cloudId, null);

console.log('\nnetwork\n');
// Everything off the production host was cut, so nothing reached Firebase by
// construction. Listed so a run shows what the app tried for and survived.
console.log('  requests cut: ' + ([...new Set(blocked)].join(', ') || 'none'));
check('no page errors', errs, []);

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
