/**
 * Group standings.
 *
 * The thing worth guarding here is not the layout, it is the two rules that
 * make the numbers mean anything (doc 08 §3):
 *
 *   Money belongs to one group's settlement and nowhere else. If a money figure
 *   can ever reach the screen from rounds outside the group, "up $340 in the
 *   Saturday group" quietly becomes arithmetic about people who never played
 *   each other, and nobody can tell by looking.
 *
 *   Scoring average counts completed 18-hole rounds only. A nine included as a
 *   36 flatters everyone, permanently, and is invisible.
 *
 * Both are the kind of wrong that never throws. So they are asserted against
 * hand-computed totals rather than against whatever the code happens to produce.
 *
 * Run with the repo served over http:
 *   python3 -m http.server 8130
 *   node backend/browser/standings.test.mjs
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
  { id: 'ghin:1506580', name: 'Brian Bunch', aliases: [] },
  { id: 'ghin:1236530', name: 'Brian Casey', aliases: [] },
  { id: 'ghin:1586673', name: 'Gary Nunes', aliases: [] },
];

// Hand-computed expectations, so a change in aggregate() cannot quietly
// redefine what "right" means:
//
//   2026: r1 + r2          2025: r3            group total
//   Bunch   +10 -5 = +5      +100              money 105, 3 rounds, 1 win
//                            gross 80, 82      (r2 is nine holes -> no gross)
//   Casey   -10 +5 = -5       -100             money -105
//   Gary      (r2 only) +0                     money 0, gross null
const ROUNDS = [
  { id: 'r1', groupId: 'nunes', date: '2026-05-02T16:00:00.000Z', courseName: 'El Macero',
    golferIds: ['ghin:1506580', 'ghin:1236530'],
    results: {
      'ghin:1506580': { name: 'Brian Bunch', money: 10, gross: 80, holes: 18 },
      'ghin:1236530': { name: 'Brian Casey', money: -10, gross: 74, holes: 18 },
    } },
  // A nine. Money is real and counts; the score must not.
  { id: 'r2', groupId: 'nunes', date: '2026-06-14T16:00:00.000Z', courseName: 'El Macero',
    golferIds: ['ghin:1506580', 'ghin:1236530', 'guest:gary'],
    results: {
      'ghin:1506580': { name: 'Brian Bunch', money: -5, gross: null, holes: 9 },
      'ghin:1236530': { name: 'Brian Casey', money: 5, gross: null, holes: 9 },
      'guest:gary': { name: 'Gary', money: 0, gross: null, holes: 9 },
    } },
  { id: 'r3', groupId: 'nunes', date: '2025-08-01T16:00:00.000Z', courseName: 'El Macero',
    golferIds: ['ghin:1506580', 'ghin:1236530'],
    results: {
      'ghin:1506580': { name: 'Brian Bunch', money: 100, gross: 82, holes: 18 },
      'ghin:1236530': { name: 'Brian Casey', money: -100, gross: 78, holes: 18 },
    } },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });

async function open({ user = { uid: 'u1', email: 'b@x.com' }, groups = [{ id: 'nunes', name: 'Nunes' }],
                     rounds = ROUNDS, throws = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('bunchbets-installed', 'true'));
  await page.goto(ORIGIN + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const w = document.getElementById('wizardOverlay'); if (w) w.remove();
    const n = document.querySelector('.whats-new-overlay'); if (n) n.remove();
  });

  // The real aggregate(), straight out of the shipped module — the arithmetic
  // under test is the arithmetic that runs in production.
  await page.evaluate(async ([u, g, rs, thr, pool, origin]) => {
    const mod = await import(origin + '/js/cloud.js');
    const api = mod.default;
    window._bb.Cloud.user = u;
    window._bb.Cloud.groups = g;
    window._bb.Cloud.pool = pool;
    window._bb.Cloud.api = {
      aggregate: api.aggregate.bind(api),
      groupRounds: async () => {
        if (thr) { const e = new Error('denied'); e.code = thr; throw e; }
        return rs;
      },
    };
  }, [user, groups, rounds, throws, POOL, ORIGIN]);

  await page.evaluate(() => window._bb.UI.showStandings());
  await page.waitForTimeout(400);
  return { page, ctx, errs };
}

const read = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#standBody .stand-row')].slice(1).map((r) => ({
    name: r.querySelector('.stand-name').textContent.trim(),
    cells: [...r.querySelectorAll('.stand-n')].map((c) => c.textContent.trim()),
  }));
  const b = document.getElementById('standBody');
  return {
    rows,
    table: b.querySelector('.stand-table') ? b.querySelector('.stand-table').textContent : '',
    text: b.textContent,
    seasons: [...b.querySelectorAll('.stand-season')].map((x) => x.textContent.trim()),
    activeSeason: (b.querySelector('.stand-season.on') || {}).textContent,
    activeTab: (b.querySelector('.stand-tab.on') || {}).textContent,
  };
});

// --------------------------------------------------------------------------
console.log('\nmoney — the default view, scoped to one group and one season\n');
{
  const { page, ctx, errs } = await open();
  const v = await read(page);

  check('opens on money', v.activeTab, 'Money');
  check('and on the most recent season', v.activeSeason, '2026');
  check('older seasons are offered', v.seasons, ['2026', '2025', 'All time']);

  // 2026 only: Bunch +10 -5 = +5, Casey -10 +5 = -5, Gary 0.
  check('leader first', v.rows[0].name, 'Brian Bunch');
  check('  rounds / wins / net', v.rows[0].cells, ['2', '1', '$5']);
  // Ordered by money: Bunch +5, Gary 0, Casey -5.
  check('a guest still appears — the round is real', v.rows[1].name.indexOf('Gary') === 0, true);
  check('  and is marked, not silently merged', /unlinked/.test(v.rows[1].name), true);
  check('loser shown negative, and last', v.rows[2].cells[2], '-$5');
  check('the round count is stated', /2 round\(s\) in 2026/.test(v.text), true);
  check('and the scope is stated in words', /only counted inside/.test(v.text), true);

  // The rule that matters: 2025's $100 must be nowhere on screen.
  check('LAST SEASON’S MONEY IS NOT IN THIS SEASON', /100/.test(v.table), false);

  await page.click('.stand-season:nth-child(2)');      // 2025
  const y25 = await read(page);
  check('switching season switches the money', y25.rows[0].cells[2], '$100');
  check('  and the round count', /1 round\(s\) in 2025/.test(y25.text), true);

  await page.click('.stand-season:last-child');        // All time
  const all = await read(page);
  check('all time adds the seasons up', all.rows[0].cells, ['3', '2', '$105']);
  check('  and says so without a season', /3 round\(s\)\./.test(all.text), true);

  check('no page errors', errs, []);
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\nscoring — a different kind of number, kept apart from the money\n');
{
  const { page, ctx, errs } = await open();
  await page.click('.stand-tab:last-child');
  await page.waitForTimeout(150);
  const v = await read(page);

  check('on the scoring tab', v.activeTab, 'Scoring');

  // 2026 has one complete 18 for each of Bunch (80) and Casey (74); r2 is nine.
  check('lowest average first', v.rows[0].name, 'Brian Casey');
  check('  18s / best / avg', v.rows[0].cells, ['1', '74', '74.0']);
  check('THE NINE IS NOT COUNTED AS A ROUND', v.rows[1].cells[0], '1');
  check('nobody with a completed 18 sorts last', v.rows[2].name.indexOf('Gary') === 0, true);
  check('  and shows a dash, not a zero', v.rows[2].cells.slice(1), ['—', '—']);
  check('the rule is stated on screen', /completed 18-hole rounds only/.test(v.text), true);

  // Money has no business on this tab: mixing them is how a scoring leaderboard
  // ends up carrying a cross-group money figure.
  check('NO MONEY ANYWHERE IN THE SCORING TABLE', /\$/.test(v.table), false);

  await page.click('.stand-season:last-child');        // All time
  const all = await read(page);
  check('all time averages the completed rounds', all.rows[0].cells, ['2', '74', '76.0']);

  check('no page errors', errs, []);
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\nthe unlinked nudge\n');
{
  const { page, ctx } = await open();
  const v = await read(page);
  check('says how many are unlinked', /1 player\(s\) above are not linked/.test(v.text), true);
  await page.click('#standLink');
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => {
    const h = [...document.querySelectorAll('.history-header h2')].map((x) => x.textContent);
    return h;
  });
  check('and opens the linking screen', opened.indexOf('Link names') >= 0, true);
  check('  replacing standings rather than stacking on it', opened.indexOf('Standings'), -1);
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\nnothing to show — each case says which one it is\n');
{
  const a = await open({ user: null });
  check('signed out asks you to sign in', /Sign in to see your group standings/.test(await a.page.textContent('#standBody')), true);
  await a.ctx.close();

  const b = await open({ groups: [] });
  check('no group explains what a group is for', /not in a group yet/.test(await b.page.textContent('#standBody')), true);
  await b.ctx.close();

  const c = await open({ rounds: [] });
  check('no rounds names the group', /No rounds in Nunes yet/.test(await c.page.textContent('#standBody')), true);
  await c.ctx.close();

  const d = await open({ throws: 'permission-denied' });
  const t = await d.page.textContent('#standBody');
  check('a denied read reports the code', /Could not load standings: permission-denied/.test(t), true);
  check('  rather than an empty leaderboard', /stand-row/.test(await d.page.innerHTML('#standBody')), false);
  await d.ctx.close();
}

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
