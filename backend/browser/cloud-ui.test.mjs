import { chromium } from 'playwright';

const ORIGIN = 'http://127.0.0.1:8130';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}` + (ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`));
};

async function openApp(page) {
  await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('bunchbets-installed', 'true'));
  await page.goto(ORIGIN + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(900);
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
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await openApp(page);

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
  check('offers Google sign-in', acct.button, 'Sign in with Google');
  check('says it is optional', /Optional/.test(acct.note || ''), true);

  // Nothing should have been fetched for a signed-out user who never taps it.
  const loaded = await page.evaluate(() => ({
    authSdk: !!document.querySelector('script[src*="firebase-auth-compat"]'),
    fsSdk: !!document.querySelector('script[src*="firebase-firestore-compat"]'),
    bb: typeof window.BB,
  }));
  check('auth SDK NOT loaded when signed out', loaded.authSdk, false);
  check('firestore SDK NOT loaded when signed out', loaded.fsSdk, false);
  check('cloud module not imported either', loaded.bb, 'undefined');

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
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
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

/*
 * Run with the repo served over http (a module import needs a real origin):
 *   python3 -m http.server 8130   # from the repo root
 *   node backend/browser/cloud-ui.test.mjs
 */
