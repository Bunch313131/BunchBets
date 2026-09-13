/**
 * Exercise the app's own lazy loader end to end.
 *
 * Chromium in this container cannot reach the internet, so the Firebase compat
 * SDKs are fetched here (node can) and served to the page by route interception.
 * The page still requests the real gstatic URLs, so the loader under test is the
 * shipped one, not a stub.
 *
 * The trigger is the redirect flag: Cloud.boot() sees it, pays for the SDK, and
 * calls completeRedirect() — the exact path a phone takes coming back from
 * Google. No sign-in is needed to prove the wiring works.
 */
import { chromium } from 'playwright';

const ORIGIN = 'http://127.0.0.1:8130';
const BASE = 'https://www.gstatic.com/firebasejs/9.22.0/';
const FILES = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js', 'firebase-database-compat.js'];

const sdk = {};
for (const f of FILES) {
  const r = await fetch(BASE + f);
  sdk[f] = await r.text();
  console.log(`  fetched ${f.padEnd(34)} ${String(sdk[f].length).padStart(8)} bytes`);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });
// The service worker treats www.gstatic.com as cacheable and fetches it itself,
// and a service worker's fetch is not covered by page.route — so with the SW
// running, the interception silently misses and the SDK fails to load. Block it:
// the SW's own behaviour is verified separately, on a real phone.
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const logs = []; page.on('console', (m) => { if (m.type() === 'error' || /cloud/i.test(m.text())) logs.push(m.type() + ': ' + m.text().slice(0, 160)); });

await page.route('https://www.gstatic.com/firebasejs/9.22.0/*', (route) => {
  const name = route.request().url().split('/').pop();
  if (!sdk[name]) return route.abort();
  route.fulfill({ status: 200, headers: { 'content-type': 'application/javascript' }, body: sdk[name] });
});
// Firebase's own backends are unreachable here; let them fail fast rather than hang.
for (const host of ['https://identitytoolkit.googleapis.com/**', 'https://firestore.googleapis.com/**',
                    'https://securetoken.googleapis.com/**', 'https://*.firebaseio.com/**']) {
  await page.route(host, (route) => route.abort());
}

await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  localStorage.setItem('bunchbets-installed', 'true');
  localStorage.setItem('bb-cloud-redirect', '1');   // pretend we are back from Google
});
await page.goto(ORIGIN + '/index.html', { waitUntil: 'load' });
// The firestore compat bundle is 339KB; give the chain room, and poll rather
// than guess.
await page.waitForFunction(() => !!(window.BB && window.BB.cloud), { timeout: 20000 })
  .catch(() => console.log('  (BB.cloud never appeared within 20s)'));
await page.waitForTimeout(500);

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}` + (ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`));
};

const st = await page.evaluate(() => ({
  // Assert the SDK actually EVALUATED. A <script> tag proves only that we asked.
  authSdk: typeof firebase !== 'undefined' && typeof firebase.auth === 'function',
  fsSdk: typeof firebase !== 'undefined' && typeof firebase.firestore === 'function',
  bbCloud: typeof (window.BB && window.BB.cloud),
  hasSurface: !!(window.BB && window.BB.cloud && typeof window.BB.cloud.acceptInvite === 'function'),
  apps: typeof firebase !== 'undefined' ? firebase.apps.map((a) => a.name) : null,
  // cloud.js deliberately uses a NAMED app so it cannot collide with the default
  // one LiveSync creates (lazily, on host/join). Prove they coexist.
  coexist: (() => {
    try { firebase.initializeApp({ apiKey: 'x', databaseURL: 'https://x.firebaseio.com', projectId: 'x' }); }
    catch (e) { return 'default app threw: ' + e.message; }
    return firebase.apps.map((a) => a.name).sort().join(',');
  })(),
  redirectFlagCleared: localStorage.getItem('bb-cloud-redirect') === null,
  signedIn: !!(window.BB && window.BB.cloud && window.BB.cloud.isSignedIn && window.BB.cloud.isSignedIn()),
}));

console.log('\nthe loader ran:');
check('auth SDK loaded and evaluated', st.authSdk, true);
check('firestore SDK loaded and evaluated', st.fsSdk, true);
check('js/cloud.js imported', st.bbCloud, 'object');
check('full surface present', st.hasSurface, true);
check('cloud uses its own named app', st.apps, ['bbcloud']);
check('and a default app can still be created beside it', st.coexist, '[DEFAULT],bbcloud');
check('redirect flag consumed', st.redirectFlagCleared, true);
check('not signed in (no real redirect happened)', st.signedIn, false);

await page.evaluate(() => {
  const w = document.getElementById('wizardOverlay'); if (w) w.remove();
  const n = document.querySelector('.whats-new-overlay'); if (n) n.remove();
  document.getElementById('menuToggle').click();
});
await page.waitForTimeout(300);
const acct = await page.evaluate(() => {
  const el = document.getElementById('menuAccount');
  return { signIn: !!el.querySelector('#cloudSignIn'), text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) };
});
console.log('\nand the app is still usable:');
check('still offers sign-in after a failed round trip', acct.signIn, true);
console.log('  panel reads:', JSON.stringify(acct.text));

// Firebase logs its own network failures; only OUR code throwing is a problem.
const ours = errs.filter((m) => !/network|fetch|Failed to (get|load)|auth\/|unavailable|ERR_/i.test(m));
check('no errors from app code', ours, []);
if (errs.length) console.log('  (firebase network noise, expected here: ' + errs.length + ' messages)');

console.log('\nconsole:'); logs.slice(0, 12).forEach((l) => console.log('  ' + l));
await page.screenshot({ path: '/home/claude/cloud-loaded.png' });
console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
