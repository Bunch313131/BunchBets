/* Headless browser check for the service worker. Not shipped to users; lives here
 * because re-deriving it is more work than keeping it.
 *
 *   git clone --branch staging <repo> bbtest && cd bbtest
 *   python3 -m http.server 8080 --bind 127.0.0.1 &
 *   npm i playwright && node tools/sw-test.js
 *
 * Covers: worker activates and controls the page; a cold reload with the network
 * off still boots the app; a navigation carrying an unseen query string is still
 * served from cache; and ?nosw=1 fully removes the worker and its caches.
 *
 * The CDN stubs below matter — with outbound CDN traffic blocked, subresource
 * fetches hang and the document never leaves readyState 'loading', so the load
 * event never fires and every result is a false negative.
 */
const { chromium } = require('playwright');
const URL = process.env.SW_TEST_URL || 'http://127.0.0.1:8080/index.html';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
                                          args: ['--headless=new'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  await ctx.route(/^https:\/\/(www\.gstatic\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|www\.googletagmanager\.com)\//,
    r => r.fulfill({ status: 200, contentType: r.request().url().includes('css') ? 'text/css' : 'application/javascript', body: '/*stub*/' }));
  await ctx.route(/^https:\/\/(ipapi\.co|api\.open-meteo\.com|api\.qrserver\.com)\//, r => r.abort());

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('  pageerror: ' + e.message));

  console.log('--- 1. first load, online; wait for the worker to activate ---');
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  const ready = await page.evaluate(async () => {
    const t0 = Date.now(); const r = await navigator.serviceWorker.ready;
    return { ms: Date.now() - t0, state: r.active && r.active.state, script: r.active && r.active.scriptURL };
  });
  console.log('   activated after', ready.ms, 'ms |', ready.state);
  console.log('   controlled:', await page.evaluate(() => !!navigator.serviceWorker.controller));

  console.log('\n--- 2. cold reload with network OFFLINE ---');
  await ctx.setOffline(true);
  let ok = true;
  try { await page.goto(URL, { waitUntil: 'load', timeout: 25000 }); } catch (e) { ok = false; }
  await page.waitForTimeout(3000);
  console.log('   navigation OK:', ok);
  console.log('   page state   :', JSON.stringify(await page.evaluate(() => ({
    title: document.title, header: !!document.querySelector('header'),
    betaBadge: !!document.querySelector('.beta-badge'),
    appBooted: typeof window.LiveSync === 'object',
    navButtons: document.querySelectorAll('nav button, .nav-btn, footer button').length,
  })).catch(e => ({ err: e.message.split('\n')[0] }))));

  console.log('\n--- 3. offline navigation carrying an unseen query string ---');
  let ok2 = true;
  try { await page.goto(URL + '?join=ABCD&t=' + Date.now(), { waitUntil: 'load', timeout: 20000 }); } catch (e) { ok2 = false; }
  console.log('   served from cache:', ok2);

  await ctx.setOffline(false);
  console.log('\n--- 4. ?nosw=1 kill switch ---');
  await page.goto(URL + '?nosw=1', { waitUntil: 'commit', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(9000);
  console.log('   final URL:', page.url());
  console.log('   state    :', JSON.stringify(await page.evaluate(async () => ({
    controller: !!navigator.serviceWorker.controller,
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    caches: (await caches.keys()).filter(k => k.indexOf('bunchbets-') === 0).length,
  }))));

  console.log('\n--- page errors ---');
  console.log(errors.length ? errors.join('\n') : '   none');
  await browser.close();
})();
