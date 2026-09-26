/**
 * The promise being tested: archiving a round is a LOCAL operation that the
 * cloud can never break.
 *
 * A round is the only thing in this app that cannot be reconstructed — the
 * money is settled off it and nobody re-enters eighteen holes. So the local
 * save happens first, the cloud write is fire-and-forget, and a failure there
 * must be invisible to the round.
 *
 * Run with the repo served over http:
 *   python3 -m http.server 8130
 *   node backend/browser/cloud-archive.test.mjs
 */
import { chromium } from 'playwright';

const ORIGIN = 'http://127.0.0.1:8130';
const card = (v) => { const a = new Array(18).fill(null); v.forEach((x, i) => (a[i] = x)); return a; };
const full = card(Array(18).fill(4));

const seed = {
  tab: 'scores',
  players: [
    { id: 'p1', name: 'Brian Bunch', handicap: 7 },
    { id: 'p2', name: 'Brian Casey', handicap: 5 },
  ],
  games: [{ id: 'g1', gameType: 'nassau', gross: { p1: full, p2: full },
            teamA: ['p1'], teamB: ['p2'], junkValue: { front: 2, back: 2 } }],
  course: { name: 'El Macero', hcp: [15,13,9,1,7,3,17,11,5,8,2,16,6,10,12,18,4,14],
            par: [4,5,3,4,5,4,3,4,4,4,4,3,4,4,5,3,4,5] },
  startingHole: 0,
  lastActiveDate: null,
};

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}` + (ok ? '' : `\n          got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });

async function archiveRound(label, { blockEverything = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept());
  if (blockEverything) {
    // Nothing external resolves: no SDK, no Firebase, no analytics. The harshest
    // version of "on the course with one bar".
    await page.route('**://**', (route) =>
      route.request().url().startsWith(ORIGIN) ? route.continue() : route.abort());
  }

  // Seeded before the app runs, and only on the first load. Loading once,
  // writing, and reloading raced the blank round the first load saves on a
  // timer, which sometimes replaced this seed and left nothing to archive.
  await ctx.addInitScript((s) => {
    if (sessionStorage.getItem('__bbSeeded')) return;
    sessionStorage.setItem('__bbSeeded', '1');
    localStorage.setItem('nassauV28_complete', JSON.stringify(s));
    localStorage.setItem('bunchbets-installed', 'true');
    localStorage.removeItem('bunchbets_history');
  }, seed);
  await page.goto(ORIGIN + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const w = document.getElementById('wizardOverlay'); if (w) w.remove();
    const n = document.querySelector('.whats-new-overlay'); if (n) n.remove();
  });

  // "New Round" is what archives the current one.
  await page.evaluate(() => { document.getElementById('menuToggle').click(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.getElementById('resetBtn').click(); });
  await page.waitForTimeout(1500);

  const hist = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('bunchbets_history') || '[]'); } catch (e) { return 'UNPARSEABLE'; }
  });
  console.log(`\n${label}`);
  check('the round was archived locally', Array.isArray(hist) && hist.length, 1);
  if (Array.isArray(hist) && hist[0]) {
    check('with both players', (hist[0].players || []).length, 2);
    check('and their scores', Object.keys((hist[0].games || [{}])[0].gross || {}).length, 2);
    check('and the settlement', typeof hist[0].playerNet, 'object');
    check('not marked synced (nobody is signed in)', hist[0].cloudId, undefined);
  }
  check('no errors from app code', errs.filter((m) => !/network|fetch|ERR_|Failed to load|auth\//i.test(m)), []);
  await ctx.close();
}

await archiveRound('signed out, normal network');
await archiveRound('signed out, EVERY external request blocked', { blockEverything: true });

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
