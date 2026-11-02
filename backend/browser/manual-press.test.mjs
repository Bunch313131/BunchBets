/**
 * Nassau manual press, from the hole screen.
 *
 * The group's rules (8.4): only the team DOWN on the nine (over the holes
 * before this one) can press; the press counts from the hole being played to
 * the end of that nine, at that nine's stake; tapping it again takes it back.
 * It must reach the settlement, the running (through-hole) result, and the
 * hole-by-hole view the same way, since all three now read Game.buildSegment.
 *
 * Run with the repo served over http:
 *   python3 -m http.server 8130
 *   node backend/browser/manual-press.test.mjs
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
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.route('**://**', (r) => r.request().url().startsWith(ORIGIN) ? r.continue() : r.abort());
await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('bunchbets-installed', 'true'));
await page.goto(ORIGIN + '/index.html', { waitUntil: 'load' });
await page.waitForTimeout(900);
check('the page under test is this build', await page.evaluate(() => typeof window.BB_BUILD_MARKER), 'string');

// Four players, no handicaps; A = p1+p2, B = p3+p4. Front $5, back $10, 18 $5.
// Auto-presses OFF first, so the manual press is the only extra bet.
await page.evaluate(() => {
  const { State, Game, Wizard } = window._bb;
  Wizard.active = false; const w = document.getElementById('wizardOverlay'); if (w) w.remove();
  const n = document.querySelector('.whats-new-overlay'); if (n) n.remove();
  State.data.players = ['Al', 'Bo', 'Cy', 'Di'].map((name, i) => ({ id: 'p' + (i + 1), name, handicap: 0 }));
  const g = Game.create();
  Object.assign(g, { gameType: 'nassau', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], scoringMode: 'hi_low',
    stakes: { front: 5, back: 10, overall: 5 }, autoPress: { front: false, back: false, overall: false },
    withJunk: false, handicapMode: 'full' });
  State.data.players.forEach((p) => { g.gross[p.id] = Array(18).fill(null); g.junkCounts[p.id] = Array(18).fill(0); });
  Game.sanitize(g);
  State.data.games = [g];
  State.data.startingHole = 0;
  State.data._scoredHoles = {};
  // Holes 1-3: B wins both balls (A 5s, B 3s) -> A is 6 down after three.
  const score = (pos, a, b) => {
    g.gross.p1[pos] = a; g.gross.p2[pos] = a; g.gross.p3[pos] = b; g.gross.p4[pos] = b;
    State.data._scoredHoles[pos] = true;
  };
  for (let pos = 0; pos < 3; pos++) score(pos, 5, 3);
  window.__score = score;
});

const holeButtons = async (pos) => {
  await page.evaluate((p) => {
    const S = window._bb.State;
    S.data.tab = 'scores'; S.data.scoringView = 'hole'; S.data.scoringHole = p; window._bb.UI.render();
  }, pos);
  await page.waitForTimeout(80);
  return page.evaluate(() => [...document.querySelectorAll('.nassau-press')].map((b) =>
    ({ team: b.dataset.team, text: b.textContent, on: b.classList.contains('active') })));
};
const game = () => page.evaluate(() => window._bb.State.data.games[0].manualPresses);
const front = (maxHole) => page.evaluate((m) => {
  const { Game, State } = window._bb, g = State.data.games[0];
  const seg = m == null ? Game.computeResult(g).segments.front : Game.computeResultThroughHole(g, m).segments.front;
  return { payA: seg.payA, manual: seg.lines.filter((l) => l.manual).map((l) => [l.start, l.end, l.stake, l.pressedBy]) };
}, maxHole);

console.log('\nwho may press\n');
check('nobody on the first hole of a nine', await holeButtons(0), []);
const teamA = await page.evaluate(() => ['p1', 'p2'].map((p) => window._bb.UI.shortName(p)).join(' & '));
check('on hole 4, only team A (down 6), offered to press',
  await holeButtons(3), [{ team: 'A', text: 'Press: ' + teamA, on: false }]);
check('team B cannot press while ahead', await page.evaluate(() =>
  window._bb.Game.toggleManualPress(window._bb.State.data.games[0], 3, 'B')), false);

console.log('\npressing\n');
await page.evaluate(() => document.querySelector('.nassau-press[data-team="A"]').click());
await page.waitForTimeout(250);
check('tapping Press records it from THIS hole', await game(), [{ start: 3, by: 'A' }]);
const lit = await holeButtons(3);
check('  and the button shows it, lit', [lit.length, lit[0].on, /pressed/.test(lit[0].text)], [1, true, true]);
check('nothing on the back nine', (await holeButtons(9)).length, 0);

// Holes 4-9: A wins both balls every hole (+2 each, +12).
await page.evaluate(() => { for (let pos = 3; pos < 9; pos++) window.__score(pos, 3, 5); });

console.log('\nthe money\n');
// Main front bet: -6 then +12 = A +6, wins $5. Press from hole 4: +12, A wins $5.
check('front: main bet and press both to A, $5 each', await front(), { payA: 10, manual: [[3, 8, 5, 'A']] });
check('running result before the press hole has no press', (await front(2)).manual, []);
check('running result at the turn matches the final one', await front(8), await front());
check('the press counts toward the round total', await page.evaluate(() =>
  window._bb.Game.computeResult(window._bb.State.data.games[0]).teamTotals.front), 20);   // $10 x 2 players on B

console.log('\nthe hole-by-hole view\n');
const view = await page.evaluate(() => {
  const el = window._bb.UI.game();
  return el ? el.textContent.replace(/\s+/g, ' ') : '';
});
// "#4" then that hole's bets: the main bet -4, the press +2, marked *.
check('marks the press on its holes', /#4\s*-4\/\+2\*/.test(view), true);
check('  and says what it is', /\* Manual press: A from #4/.test(view), true);

console.log('\ntaking it back\n');
await holeButtons(3);
await page.evaluate(() => document.querySelector('.nassau-press[data-team="A"].active').click());
await page.waitForTimeout(250);
check('tapping the lit press removes it', await game(), []);
check('  and the money goes back to the main bet alone', (await front()).payA, 5);

console.log('\nwith auto-presses on\n');
await page.evaluate(() => {
  const g = window._bb.State.data.games[0];
  g.autoPress.front = true;
  window._bb.Game.toggleManualPress(g, 3, 'A');
});
const both = await page.evaluate(() => {
  const g = window._bb.State.data.games[0];
  const seg = window._bb.Game.computeResult(g).segments.front;
  return seg.lines.map((l) => (l.manual ? 'manual' : 'auto') + '@' + l.start);
});
check('the manual press sits beside the auto-press chain, not replacing it',
  both.includes('manual@3') && both.filter((x) => x.startsWith('auto')).length >= 2, true);
check('auto-press starts are unchanged by the manual press', await page.evaluate(() => {
  const { Game, State } = window._bb, g = State.data.games[0];
  const withIt = Game.computeResult(g).segments.front.lines.filter((l) => !l.manual).map((l) => l.start);
  const saved = g.manualPresses; g.manualPresses = [];
  const without = Game.computeResult(g).segments.front.lines.map((l) => l.start);
  g.manualPresses = saved;
  return JSON.stringify(withIt) === JSON.stringify(without);
}), true);

console.log('\nclearing scores\n');
// The menu's Clear Scores button, which confirms first (accepted here).
page.on('dialog', (d) => d.accept());
await page.evaluate(() => document.getElementById('clearBtn').click());
await page.waitForTimeout(300);
check('Clear Scores takes the manual presses away with the scores', await game(), []);
check('no page errors', errs, []);

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
