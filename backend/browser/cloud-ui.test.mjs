import { chromium } from 'playwright';

const ORIGIN = 'http://127.0.0.1:8130';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}` + (ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`));
};

async function openApp(page, beforeMenu) {
  await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('bunchbets-installed', 'true'));
  await page.goto(ORIGIN + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  if (beforeMenu) await beforeMenu();
  await page.evaluate(() => {
    const w = document.getElementById('wizardOverlay'); if (w) w.remove();
    const n = document.querySelector('.whats-new-overlay'); if (n) n.remove();
    document.getElementById('menuToggle').click();
  });
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------- BETA
console.log('BETA (localhost is treated as beta)\n');
{
  // Service workers BLOCKED. The worker precaches gstatic and serves it
  // cache-first, and a service worker's fetch is not covered by page.route — so
  // the auth SDK arrived from cache no matter what the route said, roughly one
  // run in three depending on whether the worker had claimed the page yet.
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));

  // Block ONLY the two SDKs the account panel warms. This used to rely on the
  // sandbox having no route to the internet — an assumption the old comment
  // stated outright and which is simply false: the SDK usually arrived, and the
  // run failed roughly once in three for a reason unrelated to the code. A test
  // that flaky gets ignored, which is worse than not having it.
  //
  // Narrow on purpose. Blocking all of gstatic also kills firebase-app and
  // firebase-database, which the page loads at launch for live sharing, and
  // database-compat then throws INTERNAL with no app to attach to — trading a
  // flaky failure for a deterministic one that is still not about the code.
  await page.route('https://www.gstatic.com/**/firebase-auth-compat.js', (r) => r.abort());
  await page.route('https://www.gstatic.com/**/firebase-firestore-compat.js', (r) => r.abort());

  // The real promise is that a launch costs nothing for someone who never opens
  // the account panel. Check that BEFORE the menu, because opening it warms the
  // SDK on purpose — the popup has to open inside the user gesture (doc 17).
  let atLaunch = null;
  await openApp(page, async () => {
    atLaunch = await page.evaluate(() => ({
      authSdk: !!document.querySelector('script[src*="firebase-auth-compat"]'),
      fsSdk: !!document.querySelector('script[src*="firebase-firestore-compat"]'),
      bb: typeof window.BB,
    }));
  });
  check('launch fetches no auth SDK', atLaunch.authSdk, false);
  check('launch fetches no firestore SDK', atLaunch.fsSdk, false);
  check('launch does not import the cloud module', atLaunch.bb, 'undefined');

  const acct = await page.evaluate(() => {
    const el = document.getElementById('menuAccount');
    return {
      exists: !!el,
      hidden: el ? el.style.display === 'none' : null,
      title: el ? (el.querySelector('.menu-section-title') || {}).textContent : null,
      button: el ? (el.querySelector('#cloudSignIn') || {}).textContent : null,
      note: el ? (el.querySelector('.cloud-note') || {}).textContent : null,
    };
  });
  check('account panel is present', acct.exists, true);
  check('and visible on beta', acct.hidden, false);
  check('titled Account', acct.title, 'Account');
  check('offers Google sign-in', /Sign in with Google|Preparing sign-in/.test(acct.button || ''), true);
  check('says it is optional', /Optional/.test(acct.note || ''), true);

  // Opening the panel asks for the SDK, and the route above guarantees it cannot
  // arrive. Assert only that the request was made; whether warming actually
  // completes is cloud-popup.test.mjs's job, since that one serves the SDK
  // through route interception.
  const warmed = await page.evaluate(() => ({
    asked: !!document.querySelector('script[src*="firebase-auth-compat"]'),
    btn: (document.getElementById('cloudSignIn') || {}).textContent,
  }));
  check('opening the panel asks for the SDK', warmed.asked, true);
  check('button stays disabled while it cannot arrive', warmed.btn, 'Preparing sign-in\u2026');

  // The rest of the app must be untouched.
  const app = await page.evaluate(() => ({
    combo: !!document.getElementById('comboMenuBtn'),
    history: !!document.getElementById('historyMenuBtn'),
    host: !!document.getElementById('hostBtn'),
  }));
  check('Group Score still there', app.combo, true);
  check('Round History still there', app.history, true);
  check('Live sharing still there', app.host, true);

  await page.screenshot({ path: '/home/claude/cloud-beta.png' });
  check('no page errors', errs, []);
  await page.close();
}

// ------------------------------------------------------- PRODUCTION stays dark
console.log('\nPRODUCTION (bunchbets.com — must be completely dark)\n');
{
  // Service workers BLOCKED. The worker precaches gstatic and serves it
  // cache-first, and a service worker's fetch is not covered by page.route — so
  // the auth SDK arrived from cache no matter what the route said, roughly one
  // run in three depending on whether the worker had claimed the page yet.
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  // Serve the same build under the production hostname so IS_BETA is false.
  await page.route('https://bunchbets.com/**', async (route) => {
    const url = new URL(route.request().url());
    const upstream = await fetch(ORIGIN + url.pathname + url.search).catch(() => null);
    if (!upstream) return route.abort();
    route.fulfill({
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') || 'text/html' },
      body: Buffer.from(await upstream.arrayBuffer()),
    });
  });
  await page.goto('https://bunchbets.com/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('bunchbets-installed', 'true'));
  await page.goto('https://bunchbets.com/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const w = document.getElementById('wizardOverlay'); if (w) w.remove();
    const n = document.querySelector('.whats-new-overlay'); if (n) n.remove();
    document.getElementById('menuToggle').click();
  });
  await page.waitForTimeout(300);

  const prod = await page.evaluate(() => {
    const el = document.getElementById('menuAccount');
    return {
      hidden: el ? el.style.display === 'none' : null,
      empty: el ? el.innerHTML.trim() === '' : null,
      authSdk: !!document.querySelector('script[src*="firebase-auth-compat"]'),
      db: (document.body.innerHTML.match(/bunchbets-default-rtdb/) || []).length,
    };
  });
  check('account panel hidden on production', prod.hidden, true);
  check('and never rendered', prod.empty, true);
  check('no auth SDK fetched', prod.authSdk, false);
  await page.screenshot({ path: '/home/claude/cloud-prod.png' });
  check('no page errors', errs, []);
  await page.close();
}

// The module itself is covered by cloud_load_test.mjs, which serves the Firebase
// SDK through route interception. Loading it from gstatic here does not work:
// Chromium in this container has no route to the internet.

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
