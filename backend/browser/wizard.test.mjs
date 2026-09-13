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
console.log('\ntapping a number clears it, so typing replaces\n');
{
  const { page, ctx } = await boot();
  await page.evaluate(() => {
    window._bb.Wizard.data.players = [{ name: 'Brian Bunch', handicap: 8 }];
    window._bb.Wizard.active = true;
    window._bb.Wizard.step = 'players';
    window._bb.Wizard.render();
  });
  await page.waitForTimeout(300);

  const sel = '.wizard-player-row input[data-field="handicap"]';
  const focused = await page.evaluate(async (s) => {
    const el = document.querySelector(s);
    if (!el) return { none: true };
    el.focus();
    await new Promise((r) => setTimeout(r, 60));
    return { value: el.value, placeholder: el.placeholder };
  }, sel);
  check('the field is emptied', focused.value, '');
  check('  and the old number is ghosted behind it', focused.placeholder, '8');

  // No selection UI at all is the point: iOS draws drag handles and a copy bar
  // over a two-character number, which is what this replaced.
  const selected = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return el.selectionStart !== el.selectionEnd;
  }, sel);
  check('nothing is selected, so iOS has no handles to draw', selected, false);

  // Typing replaces outright rather than landing beside the old digit.
  await page.fill(sel, '12');
  await page.evaluate((s) => document.querySelector(s).blur(), sel);
  await page.waitForTimeout(80);
  check('typing replaces', await page.inputValue(sel), '12');
  check('  and reaches state', await page.evaluate(() => window._bb.Wizard.data.players[0].handicap), 12);

  // Tapping in and back out without typing must leave the number alone.
  await page.evaluate(async (s) => {
    const el = document.querySelector(s); el.focus();
    await new Promise((r) => setTimeout(r, 40)); el.blur();
  }, sel);
  await page.waitForTimeout(80);
  check('tapping in and out changes nothing', await page.inputValue(sel), '12');
  check('  including in state', await page.evaluate(() => window._bb.Wizard.data.players[0].handicap), 12);

  // The nasty one: type, delete it again, leave. The field's own oninput has
  // already recorded the empty box as a zero, so restoring the display without
  // telling it would show 12 while state said 0.
  await page.evaluate(async (s) => {
    const el = document.querySelector(s); el.focus();
    await new Promise((r) => setTimeout(r, 40));
    el.value = '9'; el.dispatchEvent(new Event('input', { bubbles: true }));
    el.value = '';  el.dispatchEvent(new Event('input', { bubbles: true }));
    el.blur();
  }, sel);
  await page.waitForTimeout(80);
  check('emptying it and leaving restores the number', await page.inputValue(sel), '12');
  check('  AND state agrees — no silent zero', await page.evaluate(() => window._bb.Wizard.data.players[0].handicap), 12);

  // A text field must NOT be selected: the name box filters a dropdown on what
  // is typed, and selecting it would make the first keystroke erase the name.
  const text = await page.evaluate(async () => {
    const el = document.querySelector('.wizard-player-row input[data-field="name"]');
    if (!el) return { none: true };
    el.focus();
    await new Promise((r) => setTimeout(r, 60));
    return { value: el.value, placeholder: el.placeholder };
  });
  check('the name box was found with a value in it', !text.none && text.value.length > 0, true);
  check('  and is left alone — clearing it would strand the roster dropdown',
    text.value, 'Brian Bunch');
  await ctx.close();
}

// --------------------------------------------------------------------------
console.log('\nthe picker offers the group, and never invents a course handicap\n');
{
  const POOL = [
    { id: 'ghin:1506580', name: 'Brian Bunch', currentIndex: '7.0', aliases: ['Bunch'] },
    { id: 'ghin:1586673', name: 'Gary Nunes', currentIndex: '10.4', aliases: ['Gary'] },
    { id: 'ghin:326845', name: 'Tyler Bryan', currentIndex: '+0.3', aliases: ['Tyler'] },
  ];
  const { page, ctx, errs } = await boot({
    cloud: { user: { uid: 'u', email: 'b@x.com' }, groups: [{ id: 'nunes', name: 'Nunes' }], pool: POOL },
  });
  // A round in local history, written the way the group actually writes cards:
  // short names, and the handicap they really played off.
  await page.evaluate(() => localStorage.setItem('bunchbets_history', JSON.stringify([
    { id: 'r1', date: '2026-09-11T00:00:00.000Z',
      players: [{ id: 'p1', name: 'Bunch', handicap: 8 }, { id: 'p2', name: 'Tyler', handicap: 0 }],
      games: [], playerNet: {} },
  ])));

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
  check('a golfer never played here gets NO handicap guessed from his index',
    gary.handicap === undefined || gary.handicap === null, true);
  check('  but one this phone has played before keeps his number',
    r.find((x) => x.name === 'Brian Bunch').handicap, 8);
  // Found through the alias, not the full name. The card says "Tyler"; the
  // roster says "Tyler Bryan". Matching on the full name alone finds nothing and
  // returns no handicap at all — which is exactly what it did.
  check('and one whose card name is a SHORT name is still found',
    r.find((x) => x.name === 'Tyler Bryan').handicap, 0);

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
