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

  // Nothing external resolves. Without this, opening the players step warms the
  // real Firebase SDK, auth reports "nobody signed in", and Cloud.user is set
  // back to null — quietly undoing the stub these tests are built on. Every
  // cloud assertion below would then be passing for the wrong reason.
  await page.route('**://**', (route) =>
    route.request().url().startsWith(ORIGIN) ? route.continue() : route.abort());

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
console.log('\ncarrying a saved round forward\n');
{
  // A round saved before tees existed. Saved state replaces the default
  // wholesale, so without a migration the conversion would be dead for every
  // install that already has the app — which is all of them.
  const { page, ctx } = await boot();
  const c = await page.evaluate(() => ({
    tees: (window._bb.State.data.course.tees || []).length,
    teeName: window._bb.State.data.course.teeName,
    hcp: window._bb.State.data.course.hcp.join(','),
  }));
  check('the tee list is attached on load', c.tees, 8);
  check('  defaulting to White', c.teeName, 'White');
  check('  and the allocation in play is left exactly as saved',
    c.hcp, '15,13,9,1,7,3,17,11,5,8,2,16,6,10,12,18,4,14');
  await ctx.close();

  // The pre-March allocation, written to disk. GHIN has no record of it and
  // every net bet at El Macero depended on which side of that date you were on.
  const bad = [7,15,9,1,11,3,17,13,5,4,2,10,8,12,14,18,6,16];
  const ctx2 = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
  const p2 = await ctx2.newPage();
  await p2.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
  await p2.evaluate(([seed, badHcp]) => {
    localStorage.setItem('bunchbets-installed', 'true');
    localStorage.setItem('nassauV28_complete', JSON.stringify({ ...seed, presets: {
      'El Macero': { hcp: badHcp, par: seed.course.par },
      'El Macero New': { hcp: [15,13,9,1,7,3,17,11,5,8,2,16,6,10,12,18,4,14], par: seed.course.par },
      'My Muni': { hcp: badHcp.slice().reverse(), par: seed.course.par },
    } }));
  }, [PLAYED, bad]);
  await p2.goto(ORIGIN + '/index.html', { waitUntil: 'load' });
  await p2.waitForTimeout(800);
  const pre = await p2.evaluate(() => ({
    elMacero: window._bb.State.presets['El Macero'].hcp.join(','),
    hasNew: 'El Macero New' in window._bb.State.presets,
    muni: window._bb.State.presets['My Muni'].hcp.join(','),
  }));
  check('a saved El Macero carrying the bad allocation is corrected',
    pre.elMacero, '15,13,9,1,7,3,17,11,5,8,2,16,6,10,12,18,4,14');
  check('  and the workaround preset it forced is dropped', pre.hasNew, false);
  check('someone else\u2019s own course is NOT touched', pre.muni, bad.slice().reverse().join(','));
  await ctx2.close();
}

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
  // El Macero White, 72.0/129, is the seeded default. The whole point of the
  // tee: an index converts to a course handicap exactly, so nothing is guessed
  // and nothing is left blank.
  check('Gary\u2019s 10.4 index fills as the 12 he plays off',
    r.find((x) => x.name === 'Gary Nunes').handicap, 12);
  check('  Bunch\u2019s 7.0 as an 8', r.find((x) => x.name === 'Brian Bunch').handicap, 8);
  check('  and Tyler\u2019s +0.3 as a 0, not a 1',
    r.find((x) => x.name === 'Tyler Bryan').handicap, 0);
  check('none of them is the raw index rounded',
    r.filter((x) => x.index).map((x) => x.handicap === Math.round(parseFloat(x.index))), [false, false, true]);

  // A course with no rating on file must still refuse to invent a number.
  const unrated = await page.evaluate(() => {
    window._bb.State.data.course.tees = [];
    return window._bb.Wizard.pickerRoster();
  });
  check('with no rated tee, a stranger gets no handicap at all',
    unrated.find((x) => x.name === 'Gary Nunes').handicap, undefined);
  check('  but someone this phone has played keeps his number',
    unrated.find((x) => x.name === 'Brian Bunch').handicap, 8);
  // Through the alias: the card says "Tyler", the roster says "Tyler Bryan".
  check('  found by alias, not just full name',
    unrated.find((x) => x.name === 'Tyler Bryan').handicap, 0);
  await page.evaluate(() => { window._bb.State.data.course = JSON.parse(JSON.stringify(window._bb.State.presets)) && window._bb.State.data.course; });

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
console.log('\nthe tee is pickable, and it moves the numbers\n');
{
  const POOL = [
    { id: 'ghin:1506580', name: 'Brian Bunch', currentIndex: '7.0', aliases: ['Bunch'] },
    { id: 'ghin:9857501', name: 'Timothy Mar', currentIndex: '18.7', aliases: ['Tim'] },
  ];
  const { page, ctx, errs } = await boot({
    cloud: { user: { uid: 'u', email: 'b@x.com' }, groups: [{ id: 'nunes', name: 'Nunes' }], pool: POOL },
  });
  await page.evaluate(() => {
    window._bb.Wizard.data.players = [
      { name: 'Brian Bunch', handicap: 8, hcpFromTee: true, index: '7.0' },
      { name: 'Timothy Mar', handicap: 21, hcpFromTee: true, index: '18.7' },
      { name: 'Visiting Steve', handicap: 20 },        // no index, typed by hand
    ];
    window._bb.Wizard.active = true;
    window._bb.Wizard.step = 'players';
    window._bb.Wizard.render();
  });
  await page.waitForTimeout(300);

  check('the tee is on screen', await page.locator('#wizardTee').count(), 1);
  check('  showing all eight', await page.locator('#wizardTee option').count(), 8);
  check('  set to White', await page.inputValue('#wizardTee'), 'White');
  check('  with its rating and slope stated',
    /6499 yds \u00b7 72 \/ 129/.test(await page.textContent('.wiz-tee')), true);

  // Blue is 137 against White's 129, so every derived handicap goes up.
  await page.selectOption('#wizardTee', 'Blue');
  await page.waitForTimeout(250);
  const moved = await page.evaluate(() => window._bb.Wizard.data.players.map((p) => p.handicap));
  check('moving to Blue re-derives the handicaps it filled', moved.slice(0, 2), [8, 23]);
  check('  and leaves a hand-typed one alone', moved[2], 20);
  check('the course remembers the tee', await page.evaluate(() => window._bb.State.data.course.teeName), 'Blue');

  // A number typed over is the player's, and the tee must not take it back.
  // 15 is deliberately a number NO tee would produce for an 18.7 — the range
  // across all eight is 19 to 23. An assertion that happens to match what the
  // recompute would have written proves nothing, and the first version of this
  // used 19, which is exactly what Gold derives.
  await page.evaluate(() => {
    const el = document.querySelectorAll('.wizard-player-row input[data-field="handicap"]')[1];
    el.focus(); el.value = '15'; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur();
  });
  await page.waitForTimeout(120);
  check('typing over a handicap releases it from the tee',
    await page.evaluate(() => window._bb.Wizard.data.players[1].hcpFromTee), false);
  await page.selectOption('#wizardTee', 'Gold');
  await page.waitForTimeout(250);
  const held = await page.evaluate(() => window._bb.Wizard.data.players.map((p) => p.handicap));
  check('  so changing tees again does NOT revert it', held[1], 15);
  check('    and 15 is not what Gold would have derived',
    await page.evaluate(() => window._bb.Game.courseHandicap('18.7',
      window._bb.Game.selectedTee(window._bb.State.data.course))), 19);
  check('  while the untouched one still follows the tee', held[0], 7);

  // The pool is cloud state and is empty while the SDK loads or after a sign
  // out. Re-deriving from it would mean changing tees in that window silently
  // did nothing, so the index rides on the player instead.
  await page.evaluate(() => { window._bb.Cloud.user = null; window._bb.Cloud.pool = []; });
  await page.selectOption('#wizardTee', 'Aggie');
  await page.waitForTimeout(250);
  check('re-deriving does not need the pool', await page.evaluate(() => window._bb.Wizard.data.players[0].handicap), 9);

  check('no page errors', errs, []);
  await ctx.close();
}

console.log('\na course with no ratings switches the conversion off\n');
{
  const { page, ctx } = await boot({
    cloud: { user: { uid: 'u', email: 'b@x.com' }, groups: [{ id: 'nunes', name: 'Nunes' }],
             pool: [{ id: 'ghin:1586673', name: 'Gary Nunes', currentIndex: '10.4' }] },
  });
  // Picking a different course must not leave El Macero's ratings attached —
  // every handicap would then come off the wrong slope, silently.
  // Through the actual course step, not by calling setCourseTees directly:
  // the wiring in that handler is the thing that was missing, and a test that
  // calls the helper itself would pass with the handler empty.
  await page.evaluate(() => {
    window._bb.Wizard.active = true;
    window._bb.Wizard.step = 'course';
    window._bb.Wizard.render();
  });
  await page.waitForTimeout(400);
  const picked = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.wizard-course-card')];
    const del = cards.find((c) => c.dataset.course === 'Del Paso');
    if (!del) return null;
    del.click();
    document.getElementById('wizardCourseNext').click();
    return true;
  });
  check('Del Paso was selectable in the course list', picked, true);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    tees: (window._bb.State.data.course.tees || []).length,
    teeName: window._bb.State.data.course.teeName,
    gary: window._bb.Wizard.pickerRoster().find((x) => x.name === 'Gary Nunes'),
  }));
  check('the course actually changed', await page.evaluate(() => window._bb.State.data.course.name), 'Del Paso');
  check('the old course\u2019s tees are gone', after.tees, 0);
  check('  and no tee is selected', after.teeName, null);
  check('so no handicap is derived', after.gary.handicap === undefined, true);
  check('  and it is not marked as coming from a tee', !!after.gary.fromTee, false);

  await page.evaluate(() => { window._bb.Wizard.active = true; window._bb.Wizard.step = 'players'; window._bb.Wizard.render(); });
  await page.waitForTimeout(250);
  check('the screen says why', /No ratings on file for Del Paso/.test(await page.textContent('.wiz-tee')), true);
  check('  and offers no tee to pick', await page.locator('#wizardTee').count(), 0);
  await ctx.close();
}

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
