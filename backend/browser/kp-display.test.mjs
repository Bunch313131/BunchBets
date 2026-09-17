/**
 * The KP breakdown, on every screen that shows it.
 *
 * `UI.kpParts` was defined on `History` in 7.11 and called from `UI` in six
 * places. Every one of them threw "UI.kpParts is not a function" from the
 * moment it shipped — both result panels, the round detail, the text share and
 * the image share — and it survived four releases because the whole suite,
 * `verify-kp.mjs` included, tested `Game.kpTeamSplit`: the arithmetic, which was
 * perfectly correct, rather than any screen that displays it. The first person
 * to meet it was Brian, on the course, sharing a finished round.
 *
 * So this exercises the SCREENS, with a round that has KP money in it. A test
 * that stops at the maths cannot see a helper hung on the wrong object.
 *
 * Run with the repo served over http:
 *   python3 -m http.server 8130
 *   node backend/browser/kp-display.test.mjs
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

// A finished four-ball with KP money on it, in the shape the app stores.
const card = (v) => { const a = new Array(18).fill(null); v.forEach((x, i) => (a[i] = x)); return a; };
const PAR = [4,5,3,4,5,4,3,4,4,4,4,3,4,4,5,3,4,5];
const ROUND = {
  tab: 'match',
  scoringHole: 17,
  _scoredHoles: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [i, true])),
  players: [
    { id: 'p1', name: 'Brian Bunch', handicap: 0 },
    { id: 'p2', name: 'Joe Silvestri', handicap: 0 },
    { id: 'p3', name: 'Greg Eddy', handicap: 0 },
    { id: 'p4', name: 'Ron Peters', handicap: 7 },
  ],
  games: [{
    id: 'g1', gameType: 'nassau',
    teamA: ['p1', 'p2'], teamB: ['p3', 'p4'],
    teamSize: 2, handicapMode: 'team_delta', withJunk: true,
    stakes: { front: 2, back: 5, overall: 2 },
    junkValue: { front: 1, back: 2 },
    autoPress: { front: true, back: true, overall: false },
    gross: {
      p1: card(PAR.map((p) => p)),
      p2: card(PAR.map((p) => p + 1)),
      p3: card(PAR.map((p) => p + 1)),
      p4: card(PAR.map((p) => p + 1)),
    },
    // KP on the par 3s, to the A side. This is the money the panels must show.
    //
    // The shape matters: `kpData[hole].ranking` is the closest-to-pin order,
    // and the closest man in the match must make GROSS par to convert. p1 is
    // carded at par on every hole, so he converts; a fixture that got this
    // wrong would produce no KP money and every screen below would then pass by
    // rendering nothing — which is why the "really does have KP money" check
    // sits in front of them.
    // An ARRAY of 18, not an object keyed by hole: Game.sanitize() keeps it
    // only if Array.isArray, and silently replaces an object with eighteen
    // nulls — which is how the first version of this fixture produced a round
    // with no KP money in it at all.
    kpData: (() => { const a = new Array(18).fill(null);
      [2, 6, 11, 15].forEach((h) => { a[h] = { ranking: ['p1'] }; }); return a; })(),
    strokesCount: { p1: 0, p2: 0, p3: 0, p4: 0 },
  }],
  course: { name: 'El Macero', par: PAR,
            hcp: [15,13,9,1,7,3,17,11,5,8,2,16,6,10,12,18,4,14] },
  startingHole: 0,
  lastActiveDate: null,
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();

// Every uncaught error, wherever it comes from. The bug under test is an
// exception thrown inside a render, which leaves a blank panel rather than
// anything a "does the text look right" assertion would notice.
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
// Not the aborted external requests: this run blocks everything off-origin on
// purpose, and those are the test's own doing, not the app's.
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/ERR_FAILED|ERR_BLOCKED|Failed to load resource/.test(t)) return;
  errs.push('console: ' + t);
});
page.on('dialog', (d) => d.accept());
await page.route('**://**', (r) => r.request().url().startsWith(ORIGIN) ? r.continue() : r.abort());

await page.goto(ORIGIN + '/index.html?dev=1', { waitUntil: 'domcontentloaded' });
await page.evaluate((s) => {
  localStorage.setItem('nassauV28_complete', JSON.stringify(s));
  localStorage.setItem('bunchbets-installed', 'true');
}, ROUND);
await page.goto(ORIGIN + '/index.html?dev=1', { waitUntil: 'load' });
await page.waitForTimeout(900);
await page.evaluate(() => {
  const w = document.getElementById('wizardOverlay'); if (w) w.remove();
  const n = document.querySelector('.whats-new-overlay'); if (n) n.remove();
});

console.log('\nthe helper is reachable from where it is called\n');

check('UI.kpParts exists on UI',
  await page.evaluate(() => typeof window._bb.UI.kpParts), 'function');
check('  and not on History, where it used to be',
  await page.evaluate(() => typeof window._bb.History.kpParts), 'undefined');

// It has to come back with rows for this round, or the screens below would
// pass by rendering nothing at all.
//
// Caught rather than thrown: when this breaks it is because kpParts is missing,
// and an uncaught throw here kills the run before the per-screen checks — which
// are the part that says WHICH screens a user would find broken.
const parts = await page.evaluate(() => {
  try {
    const g = window._bb.State.data.games[0];
    const res = window._bb.Game.computeResult(g);
    return window._bb.UI.kpParts(res.teamTotals, 2).map((r) => r.label);
  } catch (e) { return ['THREW: ' + String(e && e.message || e)]; }
});
check('this round really does have KP money to show',
  parts.length > 0 && !/^THREW/.test(parts[0]), true);
if (/^THREW/.test(parts[0] || '')) console.log('          ' + parts[0]);
// p1 wins all four par 3s, so this round carries a SWEEP as well as the hole
// money — the two lines 7.11 was written to separate, and the pair that had
// never once been rendered.
check('  and it is broken into its parts', parts, ['KP', 'Sweeps']);

console.log('\nthe two shares — the paths a nassau round actually reaches\n');

// Where the KP breakdown is reachable, for a nassau round, is the two shares.
// The third site is a game-detail panel that this round does not open.
//
// An earlier draft of this looped over four tabs asserting "renders without
// throwing", and every one of them PASSED with kpParts back on History — they
// never reached it, and the "KP:" in their text is the status bar's single
// figure, not the breakdown. Assertions that pass on the broken code are worse
// than no assertions: they are a green tick over the exact bug. They are gone.

// Text share: the builder, called the way share() calls it.
const shareText = await page.evaluate(() => {
  try {
    const g = window._bb.State.data.games[0];
    const res = window._bb.Game.computeResult(g);
    const rows = window._bb.UI.kpParts(res.teamTotals, (g.teamA || []).length || 1);
    return { ok: true, labels: rows.map((r) => r.label) };
  } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
});
check('the share text builds its KP lines', shareText.ok, true);
if (!shareText.ok) console.log('          ' + shareText.err);
check('  with the bonus on its own line', shareText.labels, ['KP', 'Sweeps']);

// Image share: the exact call that failed on Brian's phone.
//
// shareImage() catches its own errors and shows a toast, so awaiting it tells
// you nothing — the first version of this check passed on the broken build for
// precisely that reason. What a user sees is the toast, so that is what is
// asserted: the red bar that said "Share image failed: this.kpParts is not a
// function".
const imgErrs = [];
const onMsg = (m) => { if (m.type() === 'error') imgErrs.push(m.text()); };
page.on('console', onMsg);
await page.evaluate(async () => {
  try { await window._bb.UI.shareImage(); } catch (e) { console.error('threw: ' + (e && e.message || e)); }
});
await page.waitForTimeout(600);
const toast = await page.evaluate(() =>
  ((document.body.innerText || '').match(/Share image failed[^\n]*/) || [''])[0]);
page.off('console', onMsg);
check('Share image reports no failure to the user', toast, '');
check('  and nothing about kpParts on the console',
  imgErrs.filter((t) => /kpParts/.test(t)), []);

console.log('\nswitching game type saves and repaints\n');

// Game.sanitizeGame never existed either — the real function is Game.sanitize —
// so every type switch but Vegas threw before it could save or re-render. The
// type was set on the object and then abandoned.
check('Game.sanitize exists', await page.evaluate(() => typeof window._bb.Game.sanitize), 'function');
check('  and Game.sanitizeGame never did',
  await page.evaluate(() => typeof window._bb.Game.sanitizeGame), 'undefined');
const switched = await page.evaluate(() => {
  try {
    const g = window._bb.State.data.games[0];
    g.gameType = 'skins'; g.withJunk = false;
    window._bb.Game.sanitize(g);
    return { ok: true, type: g.gameType, skins: Array.isArray(g.skinsPlayers) };
  } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
});
check('switching to skins normalises rather than throwing', switched.ok, true);
check('  the type took', switched.type, 'skins');
check('  and the type’s own player list exists', switched.skins, true);

console.log('');
check('no uncaught errors anywhere in this run', errs, []);

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
