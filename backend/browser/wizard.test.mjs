/**
 * The wizard: starting a round, and who is offered to play it.
 *
 * Three behaviours, all of which failed silently rather than loudly:
 *
 *   A new game must start on hole 1 with nothing scored. finish() reset two
 *   per-round flags and forgot three others, so "Start New Game" opened on hole
 *   18 — and, worse, carried _scoredHoles across, which is the flag separating
 *   "displayed as par" from "the player actually made par". A brand-new round
 *   settled eighteen holes of nobody's scores the moment it opened.
 *
 *   Tapping a number field must select it. Landing the caret beside the old
 *   digit turns 8 into 78 or 87 depending on where the tap fell.
 *
 *   The picker must offer the group, and must NOT invent a course handicap from
 *   a GHIN index — the two are different numbers and the gap is 1-2 strokes.
 *
 * Run with the repo served over http:
 *   python3 -m http.server 8130
 *   node backend/browser/wizard.test.mjs
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

const card = (v) => { const a = new Array(18).fill(null); v.forEach((x, i) => (a[i] = x)); return a; };
const full = card(Array(18).fill(4));

// A finished round, exactly as it sits in storage when someone opens the wizard
// again: parked on the last hole, every hole marked as genuinely scored.
const PLAYED = {
  tab: 'scores',
  scoringHole: 17,
  _scoredHoles: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [i, true])),
  _clearedHoles: { 5: true },
  pressWizardShown: true,
  roundCompleteShown: true,
  players: [
    { id: 'p1', name: 'Brian Bunch', handicap: 8 },
    { id: 'p2', name: 'Brian Casey', handicap: 6 },
  ],
  games: [{ id: 'g1', gameType: 'nassau', gross: { p1: full, p2: full },
            teamA: ['p1'], teamB: ['p2'], junkValue: { front: 2, back: 2 } }],
  course: { name: 'El Macero', hcp: [15,13,9,1,7,3,17,11,5,8,2,16,6,10,12,18,4,14],
            par: [4,5,3,4,5,4,3,4,4,4,4,3,4,4,5,3,4,5] },
  startingHole: 0,
  lastActiveDate: null,
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });

async function boot({ seed = PLAYED, cloud = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept());

  await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => {
    localStorage.setItem('nassauV28_complete', JSON.stringify(s));
    localStorage.setItem('bunchbets-installed', 'true');
    localStorage.setItem('bunchbets_roster', JSON.stringify([
      { name: 'Brian Bunch', handicap: 8 },
      { name: 'Visiting Steve', handicap: 20 },
    ]));
  }, seed);
  await page.goto(ORIGIN + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const w = document.getElementById('wizardOverlay'); if (w) w.remove();
    const n = document.querySelector('.whats-new-overlay'); if (n) n.remove();
  });
  if (cloud) await page.evaluate((c) => Object.assign(window._bb.Cloud, c), cloud);
  return { page, ctx, errs };
}

// --------------------------------------------------------------------------
console.log('\na new game is a new round — every per-round tracker goes with it\n');
{
  const { page, ctx, errs } = await boot();

  const before = await page.evaluate(() => ({
    hole: window._bb.State.data.scoringHole,
    scored: Object.keys(window._bb.State.data._scoredHoles || {}).length,
  }));
  check('the finished round really is parked on 18', before.hole, 17);
  check('  with all 18 holes marked scored', before.scored, 18);

  // "Start New Game" — the path that did not clear any of this.
  await page.evaluate(() => {
    window._bb.Wizard.data.players = [{ name: 'Brian Bunch', handicap: 8 },
                                      { name: 'Brian Casey', handicap: 6 }];
    window._bb.Wizard.data.games = [window._bb.Wizard.createGameData()];
    window._bb.Wizard.finish();
  });
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({
    hole: window._bb.State.data.scoringHole,
    scored: Object.keys(window._bb.State.data._scoredHoles || {}).length,
    cleared: Object.keys(window._bb.State.data._clearedHoles || {}).length,
    press: window._bb.State.data.pressWizardShown,
    done: window._bb.State.data.roundCompleteShown,
  }));
  check('opens on hole 1', after.hole, 0);
  check('NOTHING is scored yet — this one moves money', after.scored, 0);
  check('no hole is still marked cleared', after.cleared, 0);
  check('the press wizard will fire again', after.press, false);
  check('and the round is not already complete', after.done, false);

  // The visible consequence: the header says hole 1, not 18.
  const header = await page.evaluate(() => {
    const el = document.querySelector('.hole-nav-info .hole-num');
    return el ? el.textContent.trim() : '(no scoring view)';
  });
  check('the scoring view agrees', header, 'Hole 1');

  check('no page errors', errs, []);
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\ntapping a number selects it, so typing replaces\n');
{
  const { page, ctx } = await boot();
  await page.evaluate(() => { window._bb.State.data.tab = 'setup'; window._bb.UI.render(); });
  await page.waitForTimeout(300);

  const probe = await page.evaluate(async () => {
    const inputs = [...document.querySelectorAll('input')];
    const num = inputs.find((i) => (i.type === 'tel' || i.type === 'number') && i.value && !i.readOnly);
    if (!num) return { none: true };
    num.focus();
    await new Promise((r) => setTimeout(r, 50));
    return {
      value: num.value,
      start: num.selectionStart,
      end: num.selectionEnd,
      type: num.type,
    };
  });
  check('a numeric field exists to test', !probe.none, true);
  if (!probe.none) {
    check('the whole value is selected on focus',
      [probe.start, probe.end], [0, probe.value.length]);
  }

  // A text field must NOT be selected: the name box filters a dropdown on what
  // is typed, and selecting it would make the first keystroke erase the name.
  await page.evaluate(() => {
    // Seeded deliberately: an empty box cannot demonstrate "not selected", and a
    // check that quietly skips reads as coverage while proving nothing.
    window._bb.Wizard.data.players = [{ name: 'Brian Bunch', handicap: 8 }];
    window._bb.Wizard.active = true;
    window._bb.Wizard.step = 'players';
    window._bb.Wizard.render();
  });
  await page.waitForTimeout(300);
  const text = await page.evaluate(async () => {
    const el = document.querySelector('.wizard-player-row input[data-field="name"]');
    if (!el) return { none: true };
    el.focus();
    await new Promise((r) => setTimeout(r, 60));
    return { value: el.value, start: el.selectionStart, end: el.selectionEnd };
  });
  check('the name box was found with a value in it', !text.none && text.value.length > 0, true);
  check('  and is NOT selected — its first keystroke must not wipe the name',
    text.start === 0 && text.end === text.value.length, false);
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\nthe picker offers the group, and never invents a course handicap\n');
{
  const POOL = [
    { id: 'ghin:1506580', name: 'Brian Bunch', currentIndex: '7.0' },
    { id: 'ghin:1586673', name: 'Gary Nunes', currentIndex: '10.4' },
    { id: 'ghin:326845', name: 'Tyler Bryan', currentIndex: '+0.3' },
  ];
  const { page, ctx, errs } = await boot({
    cloud: { user: { uid: 'u', email: 'b@x.com' }, groups: [{ id: 'nunes', name: 'Nunes' }], pool: POOL },
  });

  const r = await page.evaluate(() => window._bb.Wizard.pickerRoster());
  check('the group comes first', r.slice(0, 3).map((x) => x.name),
    ['Brian Bunch', 'Gary Nunes', 'Tyler Bryan']);
  check('  each with a live index', r.slice(0, 3).map((x) => x.index), ['7.0', '10.4', '+0.3']);
  check('a guest from this phone is still offered', r.map((x) => x.name).includes('Visiting Steve'), true);
  check('  and is not duplicated by the pool', r.filter((x) => x.name === 'Brian Bunch').length, 1);

  // The rule that keeps the money right: an index is not a course handicap.
  // Gary is a 10.4 who plays off 12; filling 10 would be a stroke and a half
  // short on every net bet, with nothing on screen to say so.
  const gary = r.find((x) => x.name === 'Gary Nunes');
  check('a pool-only golfer gets NO handicap guessed from his index',
    gary.handicap === undefined || gary.handicap === null, true);
  check('  but one this phone has played before keeps his number',
    r.find((x) => x.name === 'Brian Bunch').handicap, 8);

  await page.evaluate(() => { window._bb.Wizard.active = true; window._bb.Wizard.step = 'players'; window._bb.Wizard.render(); });
  await page.waitForTimeout(300);
  const strip = await page.textContent('.wiz-cloud');
  check('the step says whose group it is', /Nunes/.test(strip), true);
  check('  and how many are available', /3 golfer\(s\)/.test(strip), true);
  check('no sign-in button while signed in', await page.locator('#wizardSignIn').count(), 0);

  check('no page errors', errs, []);
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\nsigned out, the step still works — sign-in is offered, not required\n');
{
  const { page, ctx, errs } = await boot();
  await page.evaluate(() => { window._bb.Wizard.active = true; window._bb.Wizard.step = 'players'; window._bb.Wizard.render(); });
  await page.waitForTimeout(300);

  check('the prompt is here, not three taps away in the menu',
    await page.locator('#wizardSignIn').count(), 1);
  check('  and says what signing in buys',
    /current GHIN indexes/.test(await page.textContent('.wiz-cloud')), true);

  const r = await page.evaluate(() => window._bb.Wizard.pickerRoster().map((x) => x.name));
  check('this phone’s own names still work signed out', r, ['Brian Bunch', 'Visiting Steve']);
  check('nothing is blocked — Next is live',
    await page.locator('#wizardPlayersNext').isEnabled(), true);

  check('no page errors', errs, []);
  await ctx.close();
}

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
