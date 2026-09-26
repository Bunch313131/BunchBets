/**
 * Smoke the LIVE beta deployment, not the working copy.
 *
 * Everything else in backend/browser tests a local build. This asks the one
 * question the local suite cannot: did what was pushed actually arrive, and
 * does it open. It reads the version off the page, so a stale Cloudflare cache
 * or a deploy that never ran reads as a failure rather than a pass.
 *
 * It goes through the SPLASH rather than setting `Wizard.step`. That is the
 * whole point of it: the sign-in screen is rendered behind the curtain as well
 * as in front of it, so a build where the curtain reveals the wrong screen
 * still passes every test that sets the step directly — which is exactly what
 * happened, and why the sign-in screen was unreachable on a real launch while
 * the suite was green.
 *
 * Deliberately NOT named *.test.mjs: it needs the network and a deploy to have
 * finished, so it is run on purpose after a push, not as part of the sweep.
 *
 *   node backend/browser/live-beta.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Not named URL: that shadows the global URL constructor used just below.
const SITE = 'https://bunchbets-beta.pages.dev/';

// The version to expect is read out of the WORKING COPY, not typed in here.
// Hardcoding it means editing this file every release, and the edit that gets
// forgotten turns the one check that proves the deploy arrived into a check
// that proves it did not — while reporting a pass for the previous release.
const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const WANT = (fs.readFileSync(path.join(REPO, 'index.html'), 'utf8')
  .match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
if (!WANT) { console.error('could not read APP_VERSION out of index.html'); process.exit(1); }
let fail = 0;
const check = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${l}` + (ok ? '' : `\n          got  ${JSON.stringify(g)}\n          want ${JSON.stringify(w)}`)); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(SITE + '?dev=1', { waitUntil: 'load' });
await page.waitForTimeout(2500);

check(`the live beta is serving ${WANT}, the version in the working copy`,
  await page.evaluate(() => window.BB_BUILD_MARKER), WANT);
check('it is beta, so the new flow is on',
  await page.evaluate(() => !!(window._bb && window._bb.NEW_WIZARD)), true);

// Through the splash the way a real launch goes, not by setting step directly —
// which is exactly how the unreachable sign-in screen got missed before.
const tapped = await page.evaluate(() => {
  const el = document.querySelector('.wizard-splash');
  if (!el) return false;
  el.click();
  return true;
});
check('the splash was there to tap through', tapped, true);
await page.waitForTimeout(2200);
check('a real launch lands on home',
  await page.evaluate(() => window._bb.Wizard.step), 'home');
check('  offering a new round, a live one, and past ones',
  await page.evaluate(() => ['#wizNewRound', '#wizJoin', '#wizHistory'].map((q) => !!document.querySelector(q))),
  [true, true, true]);
// Tees come on their own screen, after the course is committed, and name it.
// Checked here as well as locally because a stale cached index.html would
// serve the old screens while reporting the new version in the menu.
await page.click('#wizNewRound');
await page.waitForTimeout(800);
check('the course screen has no tees on it', await page.locator('.wz-tee-btn').count(), 0);
await page.click('#wizNext');
await page.waitForTimeout(800);
check('the tee screen is headed with the course',
  (await page.textContent('.wizard-header h2')).trim(), await page.evaluate(() => window._bb.State.data.course.name));

check('no page errors', errs, []);
console.log(fail ? `\n${fail} FAILURES` : '\nlive beta looks right');
await browser.close();
process.exit(fail ? 1 : 0);
