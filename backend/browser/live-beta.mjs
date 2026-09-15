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
const URL = 'https://bunchbets-beta.pages.dev/';
let fail = 0;
const check = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${l}` + (ok ? '' : `\n          got  ${JSON.stringify(g)}\n          want ${JSON.stringify(w)}`)); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL + '?dev=1', { waitUntil: 'load' });
await page.waitForTimeout(2500);

check('the live beta is serving 7.17',
  await page.evaluate(() => window.BB_BUILD_MARKER), '7.17');
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
check('a real launch lands on sign-in',
  await page.evaluate(() => window._bb.Wizard.step), 'signin');
check('  with the skip offered, not a gate',
  (await page.textContent('#wizNext')).trim(), 'Continue without an account');
check('no page errors', errs, []);
console.log(fail ? `\n${fail} FAILURES` : '\nlive beta looks right');
await browser.close();
process.exit(fail ? 1 : 0);
