/**
 * The sign-in sheet: Google, or an email and password.
 *
 * The cloud module is replaced with a stand-in, so this tests what the SCREEN
 * does — which call it makes, what it says when that fails, and that someone
 * signed up but unverified is told what that means. email-auth.test.mjs covers
 * the same flows against the real module and the real rules.
 *
 * Run with the repo served over http:
 *   python3 -m http.server 8130
 *   node backend/browser/signin-ui.test.mjs
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

function installFake() {
  const calls = [];
  window.__calls = calls;
  const err = (code) => { const e = new Error(code); e.code = code; return e; };
  const C = window._bb.Cloud;
  C.api = {
    isDirectory: () => true,
    currentUser: () => C.user,
    async signInWithEmail(email, pw) {
      calls.push(['in', email]);
      if (pw !== 'right') throw err('auth/invalid-credential');
      return { uid: 'u1' };
    },
    async signUpWithEmail(email, pw, name) {
      calls.push(['up', email, name]);
      if (email === 'taken@x.com') throw err('auth/email-already-in-use');
      if (pw.length < 6) throw err('auth/weak-password');
      return { uid: 'u2' };
    },
    async sendPasswordReset(email) { calls.push(['reset', email]); },
    async signInWithGoogle() { calls.push(['google']); return new Promise(() => {}); },
    async refreshVerified() { calls.push(['refreshVerified']); return window.__verified === true; },
    async resendVerification() { calls.push(['resend']); },
    async ensureUserDoc() { return {}; }, async myUserDoc() { return { groupIds: [] }; },
    async myGolfer() { return null; }, async myGroups() { return []; },
    async pendingInvites() { return []; }, async groupPool() { return []; },
  };
  C.user = null;
}

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem('__bbSeeded')) return;
    sessionStorage.setItem('__bbSeeded', '1');
    localStorage.setItem('bunchbets-installed', 'true');
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.route('**://**', (r) => r.request().url().startsWith(ORIGIN) ? r.continue() : r.abort());
  await page.goto(ORIGIN + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.evaluate(() => { const n = document.querySelector('.whats-new-overlay'); if (n) n.remove(); });
  await page.evaluate(installFake);
  await page.evaluate(() => { const W = window._bb.Wizard; W.active = true; W.step = 'home'; W.render(); });
  await page.waitForTimeout(300);
  return { page, ctx, errs };
}
const calls = (page) => page.evaluate(() => window.__calls.slice());
const msg = (page) => page.textContent('#siMsg');

console.log('\nthe sign-in sheet\n');
{
  const { page, ctx, errs } = await open();
  await page.click('#wizSignIn');
  await page.waitForTimeout(200);
  check('Home’s Sign in opens a sheet with Google and email',
    [await page.locator('#siGoogle').count(), await page.locator('#siEmail').count()], [1, 1]);

  await page.fill('#siEmail', 'pat@x.com');
  await page.fill('#siPass', 'wrong');
  await page.click('#siGo');
  await page.waitForTimeout(200);
  check('a wrong password is said plainly', await msg(page),
    'That email and password don’t match. Try again, or reset your password.');
  check('  and the sheet stays open to try again', await page.locator('#signInSheet').count(), 1);

  await page.click('#siForgot');
  await page.waitForTimeout(200);
  check('forgot password sends to the email typed', (await calls(page)).filter((c) => c[0] === 'reset'), [['reset', 'pat@x.com']]);
  check('  and does not say whether the account exists', await msg(page),
    'If there’s an account for that email, a reset link is on its way.');

  await page.fill('#siPass', 'right');
  await page.click('#siGo');
  await page.waitForTimeout(200);
  check('the right password signs in and closes the sheet', await page.locator('#signInSheet').count(), 0);
  check('no page errors', errs, []);
  await ctx.close();
}
{
  const { page, ctx } = await open();
  await page.evaluate(() => window._bb.UI.showSignIn('in'));
  await page.fill('#siEmail', 'new@x.com');
  await page.click('#siTabUp');
  await page.waitForTimeout(100);
  check('switching to New account keeps the email typed', await page.inputValue('#siEmail'), 'new@x.com');
  await page.fill('#siPass', 'longenough');
  await page.click('#siGo');
  await page.waitForTimeout(100);
  check('a new account needs a name', await msg(page), 'Put in your name, as the group knows you.');
  check('  and nothing was sent without one', (await calls(page)).filter((c) => c[0] === 'up').length, 0);
  await page.fill('#siName', 'Pat Doe');
  await page.fill('#siPass', '123');
  await page.click('#siGo');
  await page.waitForTimeout(200);
  check('a short password is explained', await msg(page), 'Use a password of at least 6 characters.');
  await page.fill('#siEmail', 'taken@x.com');
  await page.fill('#siPass', 'longenough');
  await page.click('#siGo');
  await page.waitForTimeout(200);
  check('an email that already has an account points at Google too', /already an account.*Google/.test(await msg(page)), true);
  await page.fill('#siEmail', 'new@x.com');
  await page.click('#siGo');
  await page.waitForTimeout(200);
  check('a good sign-up asks with the name', (await calls(page)).filter((c) => c[0] === 'up').pop(), ['up', 'new@x.com', 'Pat Doe']);
  check('  and closes', await page.locator('#signInSheet').count(), 0);
  await ctx.close();
}
{
  const { page, ctx } = await open();
  await page.evaluate(() => window._bb.UI.showSignIn('in'));
  await page.click('#siGoogle');
  await page.waitForTimeout(150);
  check('Continue with Google goes straight to the Google popup', (await calls(page)).some((c) => c[0] === 'google'), true);
  await ctx.close();
}

console.log('\nsigned up but not verified\n');
{
  const { page, ctx, errs } = await open();
  await page.evaluate(() => {
    const C = window._bb.Cloud;
    C.user = { uid: 'u2', email: 'new@x.com', emailVerified: false, displayName: 'Pat Doe' };
    C.render(); window._bb.Wizard.render();
  });
  await page.waitForTimeout(200);
  check('Home says to verify', /Verify your email/.test(await page.textContent('.wz-account')), true);
  await page.click('#wizVerified');
  await page.waitForTimeout(200);
  check('"I’ve done it" asks the server', (await calls(page)).filter((c) => c[0] === 'refreshVerified').length >= 1, true);
  check('  and until it is, the reminder stays', await page.locator('#wizVerified').count(), 1);

  const menu = await page.evaluate(() => document.getElementById('menuAccount').textContent.replace(/\s+/g, ' '));
  check('the menu explains what verifying is for', /emailed invitations can’t find you \(invite links still work\)/.test(menu), true);
  await page.evaluate(() => document.getElementById('cloudResend').click());
  await page.waitForTimeout(100);
  check('  and can send the email again', (await calls(page)).filter((c) => c[0] === 'resend').length, 1);

  await page.evaluate(() => {
    window.__verified = true;
    const C = window._bb.Cloud;
    C.api.refreshVerified = async () => { C.user = { ...C.user, emailVerified: true }; return true; };
  });
  await page.click('#wizVerified');
  await page.waitForTimeout(300);
  check('once verified the reminder goes', await page.locator('#wizVerified').count(), 0);
  check('no page errors', errs, []);
  await ctx.close();
}
{
  const { page, ctx } = await open();
  const btns = await page.evaluate(() => { window._bb.Cloud.render();
    return [...document.querySelectorAll('#menuAccount button')].map((b) => b.id); });
  check('signed out, the menu offers Google and email', btns.slice(0, 2), ['cloudSignIn', 'cloudEmailSignIn']);
  await ctx.close();
}

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
