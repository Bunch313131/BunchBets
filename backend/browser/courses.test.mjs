/**
 * Courses from the database, as the APP sees them.
 *
 * The admin page writes `courses/{id}`; the app fetches the collection with one
 * plain REST request (no Firebase SDK), keeps it on the phone, and lays it over
 * the built-in list. That request is answered here with a fixture, so this
 * checks the app's side: the merge, what it refuses, the tees that come with a
 * course, and that a course is still there offline once it has been fetched.
 *
 * Run with the repo served over http:
 *   python3 -m http.server 8130
 *   node backend/browser/courses.test.mjs
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

/** A plain value as Firestore REST's typed JSON. */
const enc = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
};
const docOf = (id, fields) => ({ name: `projects/bunchbets-test/databases/(default)/documents/courses/${id}`,
  fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)])) });

const EM_PAR = [4,5,3,4,5,4,3,4,4,4,4,3,4,4,5,3,4,5];
const EM_SI = [15,13,9,1,7,3,17,11,5,8,2,16,6,10,12,18,4,14];
const SI = [...Array(18).keys()].map((i) => i + 1);
const FIXTURE = { documents: [
  // GHIN-pulled El Macero: tees only, with par and allocation per tee; a women's tee too.
  docOf('el-macero-cc', { name: 'El Macero CC', ghinCourseId: '7796', tees: [
    { name: 'White', gender: 'Male', yardage: 6499, par: 72, rating: 72.5, slope: 130, parArr: EM_PAR, hcpArr: EM_SI },
    { name: 'Blue', gender: 'Male', yardage: 6855, par: 72, rating: 73.1, slope: 137, parArr: EM_PAR, hcpArr: EM_SI },
    { name: 'Red', gender: 'Female', yardage: 5849, par: 72, rating: 74.9, slope: 138 },
  ] }),
  docOf('test-links', { name: 'Test Links', par: Array(18).fill(4), hcp: SI, lat: 38.6, lng: -121.4,
    tees: [{ name: 'Tips', gender: 'Male', yardage: 7000, par: 72, rating: 74, slope: 140 }] }),
  // A stroke index with 1 twice: never offered, it would put strokes on the wrong holes.
  docOf('bad-si', { name: 'Bad SI', par: Array(18).fill(4), hcp: [1, 1, ...SI.slice(2)], tees: [] }),
  docOf('mather', { name: 'Mather', hidden: true }),
] };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new'] });
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
let online = true, requests = 0;
// Catch-all first (it runs last), the Firestore answer after it (it runs first).
await page.route('**://**', (r) => r.request().url().startsWith(ORIGIN) ? r.continue() : r.abort());
await page.route('https://firestore.googleapis.com/**', (r) => {
  requests++;
  if (!online) return r.abort();
  const u = new URL(r.request().url());
  if (!/\/documents\/courses$/.test(u.pathname) || !u.searchParams.get('key')) return r.fulfill({ status: 404, body: '{}' });
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE) });
});

await page.goto(ORIGIN + '/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1200);
await page.evaluate(() => { const n = document.querySelector('.whats-new-overlay'); if (n) n.remove(); });

console.log('\nthe course list\n');
const names = () => page.evaluate(() => window._bb.Courses.list().map((c) => c.name));
check('one request, with the API key and no SDK', [requests, await page.evaluate(() => !!(window.firebase && window.firebase.firestore))], [1, false]);
const list = await names();
check('a course added in the database is offered', list.includes('Test Links'), true);
check('one with a broken stroke index is not', list.includes('Bad SI'), false);
check('a hidden built-in is gone', list.includes('Mather'), false);
check('the rest of the built-ins are still there', list.includes('Del Paso CC') && list.includes('Wildhorse'), true);
check('GHIN\'s "El Macero CC" lays over the built-in, not beside it',
  list.filter((n) => /el macero/i.test(n)), ['El Macero CC']);

const em = await page.evaluate(() => window._bb.Courses.find('El Macero'));
check('its par and stroke index come from its men\'s tee', [em.par.join(','), em.hcp.join(',')], [EM_PAR.join(','), EM_SI.join(',')]);
check('men\'s tees only, with the database ratings', em.tees.map((t) => t.name + ' ' + t.rating + '/' + t.slope), ['White 72.5/130', 'Blue 73.1/137']);
check('and "El Macero" (the saved round\'s name) gets them too',
  await page.evaluate(() => window._bb.Game.teesFor('El Macero').map((t) => t.name)), ['White', 'Blue']);

console.log('\npicking it in setup\n');
await page.evaluate(() => { const W = window._bb.Wizard; W.active = true; W.step = 'course'; W.data.selectedCourse = null; W.render(); });
await page.waitForTimeout(300);
check('the picker lists it', await page.locator('.wz-row[data-course="Test Links"]').count(), 1);
check('and not the hidden one', await page.locator('.wz-row[data-course="Mather"]').count(), 0);
await page.click('.wz-row[data-course="Test Links"]');
await page.click('#wizNext');
await page.waitForTimeout(300);
const round = await page.evaluate(() => { const c = window._bb.State.data.course; return { name: c.name, par: c.par.reduce((a, b) => a + b, 0), hcp: c.hcp.join(','), tee: c.teeName }; });
check('Next commits its par and stroke index', round, { name: 'Test Links', par: 72, hcp: SI.join(','), tee: 'Tips' });
check('and the tee screen offers its tees', await page.evaluate(() => [...document.querySelectorAll('.wz-tee-btn')].map((b) => b.dataset.tee)), ['Tips']);

console.log('\noffline\n');
online = false;
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1200);
check('with no connection the fetched courses are still there', (await names()).includes('Test Links'), true);
check('  still minus the hidden one', (await names()).includes('Mather'), false);

check('no page errors', errs, []);
console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
await browser.close();
process.exit(fail ? 1 : 0);
