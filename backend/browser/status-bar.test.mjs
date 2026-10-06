/**
 * The iOS status bar, and the colour it is filled with.
 *
 * Brian, on two different apps of his at once: "we are still getting that weird
 * shading at the top of the screen... its a white gradient that comes down from
 * the top and extends past the cutout. worth noting that its on the pheasant
 * app as well. almost like the ios is handling something differently now."
 *
 * He was right that it was iOS. Safari 26 ("Liquid Glass") stopped painting a
 * fixed colour behind the status bar and started SAMPLING the page pixels
 * beneath it, falling back to a white wash when it cannot read a flat colour
 * there. Under `black-translucent` the page draws into that strip, and this
 * app's header gives it nothing flat to sample: a repeating gradient over
 * var(--card), which is rgba() on Midnight. Both of his apps set
 * viewport-fit=cover with a translucent status bar, which is why both showed it.
 *
 * The fix is to stop putting content up there — `default` insets the web view
 * below an opaque bar — and then to keep that bar the same colour as the header
 * it now sits against.
 *
 * WHAT THIS CAN AND CANNOT DO. Headless Chromium has no iOS status bar, so
 * nothing here proves the shading is gone; only Brian's phone can say that, and
 * only after deleting and re-adding the home-screen icon, because an existing
 * install keeps the old style. What it does prove is the two things that are
 * checkable and that would silently rot: that the translucent style has not
 * crept back, and that every theme paints the bar to match its own header
 * rather than leaving the hardcoded black that was there before.
 *
 * Run with the repo served over http:
 *   python3 -m http.server 8130
 *   node backend/browser/status-bar.test.mjs
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
// A panel TALLER than the web view, which is the whole situation an opaque
// status bar creates: screen.height 960, the window the app actually gets 900.
// Without this the two are identical in headless and "--app-height is the
// window, not the panel" passes whichever one the app reads — a green tick over
// the exact regression.
const ctx = await browser.newContext({
  viewport: { width: 420, height: 900 },
  screen: { width: 420, height: 960 },
  serviceWorkers: 'block',
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.route('**://**', (r) => r.request().url().startsWith(ORIGIN) ? r.continue() : r.abort());
await page.goto(ORIGIN + '/index.html?dev=1', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('bunchbets-installed', 'true'));
await page.goto(ORIGIN + '/index.html?dev=1', { waitUntil: 'load' });
await page.waitForTimeout(900);
await page.evaluate(() => {
  const w = document.getElementById('wizardOverlay'); if (w) w.remove();
  const n = document.querySelector('.whats-new-overlay'); if (n) n.remove();
});

console.log('\nthe app does not draw into the status bar\n');

const meta = (n) => page.evaluate((nn) => {
  const el = document.querySelector(`meta[name="${nn}"]`);
  return el ? el.getAttribute('content') : null;
}, n);

const style = await meta('apple-mobile-web-app-status-bar-style');
check('the status bar style is not translucent', /translucent/.test(style || ''), false);
check('  it is default, so iOS insets the web view below an opaque bar', style, 'default');
// cover still governs the home indicator, the landscape side insets, and the
// browser case. Dropping it with the style change would break all three.
check('viewport-fit=cover is kept',
  /viewport-fit=cover/.test(await meta('viewport') || ''), true);

console.log('\nthe bar is filled to match the header, on every theme\n');

// Every theme must define a flat opaque colour. A gradient or an rgba() here
// is exactly what Safari could not sample, and theme-color will not take one
// either — it would silently leave the previous theme's colour in place.
const THEMES = ['classic', 'augusta', 'midnight', 'tour'];
const seen = {};
for (const theme of THEMES) {
  for (const light of [false, true]) {
    const got = await page.evaluate(({ t, l }) => {
      const root = document.documentElement;
      root.dataset.theme = t;
      root.classList.toggle('light-mode', l);
      window._bb.UI.syncStatusBarColor();
      const el = document.querySelector('meta[name="theme-color"]');
      return {
        v: getComputedStyle(root).getPropertyValue('--status-bar').trim(),
        meta: el ? el.getAttribute('content') : null,
      };
    }, { t: theme, l: light });
    const key = `${theme}/${light ? 'light' : 'dark'}`;
    seen[key] = got.v;
    check(`${key.padEnd(17)} defines one`, !!got.v, true);
    check(`  flat and opaque`, /^#[0-9a-f]{6}$/i.test(got.v), true);
    check(`  and reaches theme-color`, got.meta, got.v);
  }
}

// Eight themes sharing one colour would pass every check above while putting a
// black bar over a green header — the bug this was written to end.
check('the eight are not all the same colour', new Set(Object.values(seen)).size > 1, true);

console.log('\nit follows the user, not just the first paint\n');

const followed = await page.evaluate(() => {
  const root = document.documentElement;
  const el = document.querySelector('meta[name="theme-color"]');
  const read = () => el.getAttribute('content');
  root.dataset.theme = 'augusta'; root.classList.remove('light-mode');
  window._bb.UI.syncStatusBarColor();
  const augustaDark = read();
  // The light/dark switch, which changes --status-bar without changing theme.
  root.classList.add('light-mode');
  window._bb.UI.syncStatusBarColor();
  const augustaLight = read();
  // And a swatch change, which changes it without touching light/dark.
  root.dataset.theme = 'tour';
  window._bb.UI.syncStatusBarColor();
  const tourLight = read();
  return { augustaDark, augustaLight, tourLight };
});
check('dark Augusta paints the bar its own green', followed.augustaDark, '#0f4d26');
check('  light mode moves it', followed.augustaLight !== followed.augustaDark, true);
check('  and so does changing theme', followed.tourLight !== followed.augustaLight, true);
check('  none of them is the old hardcoded black',
  [followed.augustaDark, followed.augustaLight, followed.tourLight].includes('#000000'), false);

console.log('\nthe app is the size of the window it is in\n');

// The regression 7.20 caused. The body is pinned to --app-height with
// overflow:hidden, and that was set from screen.height — the whole physical
// panel. True while the app drew under a translucent status bar; ~50px too tall
// the moment iOS started insetting the web view below an opaque one. The header
// went off the top and the nav off the bottom.
//
// Headless Chromium has no status bar, so the inset itself cannot be
// reproduced. What can be is the shape of the fault: an --app-height taller
// than the window clips the chrome at both ends. So assert the source it is
// read from, and then assert the consequence directly by forcing a bad value.
const h = await page.evaluate(() => ({
  app: parseInt(getComputedStyle(document.documentElement).getPropertyValue('--app-height'), 10),
  inner: window.innerHeight,
  screen: window.screen.height,
  body: Math.round(document.body.getBoundingClientRect().height),
}));
check('--app-height is the window, not the panel', h.app, h.inner);
check('  and the body fits inside the window', h.body <= h.inner, true);
// The context above makes them differ on purpose. If they were equal the check
// above would pass whichever value the app read, which is no check at all.
check('  (panel and window really do differ here, so that proved something)',
  h.screen - h.inner, 60);

const clipped = await page.evaluate(() => {
  const root = document.documentElement;
  const before = root.style.getPropertyValue('--app-height');
  root.style.setProperty('--app-height', (window.innerHeight + 60) + 'px');
  const nav = document.querySelector('.bottom-nav');
  const r = nav ? nav.getBoundingClientRect() : null;
  const off = !!r && r.bottom > window.innerHeight + 1;
  root.style.setProperty('--app-height', before);
  return { hadNav: !!r, off };
});
check('a too-tall --app-height really does push the chrome off screen',
  clipped.hadNav && clipped.off, true);

check('no page errors', errs, []);
console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
