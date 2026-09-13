/** The button must be disabled until the SDK is warm, then enabled — that is the
 *  whole reason the popup survives the user gesture. */
import { chromium } from 'playwright';
const O='http://127.0.0.1:8130', BASE='https://www.gstatic.com/firebasejs/9.22.0/';
const sdk={}; for (const f of ['firebase-app-compat.js','firebase-auth-compat.js','firebase-firestore-compat.js','firebase-database-compat.js']) sdk[f]=await (await fetch(BASE+f)).text();
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--headless=new'] });
const ctx = await b.newContext({ viewport:{width:420,height:900}, serviceWorkers:'block' });
const page = await ctx.newPage();
const errs=[]; page.on('pageerror', e=>errs.push(e.message));
// Served from memory, the SDK "downloads" in under a frame and the disabled
// state is gone before it can be observed. Delay the two on-demand bundles so
// the transition is actually testable — this is what a phone network does anyway.
await page.route(BASE+'*', async r => {
  const n=r.request().url().split('/').pop();
  if (!sdk[n]) return r.abort();
  if (/auth-compat|firestore-compat/.test(n)) await new Promise(res=>setTimeout(res,700));
  return r.fulfill({status:200,headers:{'content-type':'application/javascript'},body:sdk[n]});
});
for (const h of ['https://identitytoolkit.googleapis.com/**','https://firestore.googleapis.com/**','https://securetoken.googleapis.com/**'])
  await page.route(h, r=>r.abort());

await page.goto(O+'/index.html',{waitUntil:'domcontentloaded'});
await page.evaluate(()=>localStorage.setItem('bunchbets-installed','true'));
await page.goto(O+'/index.html',{waitUntil:'load'});
await page.waitForTimeout(900);
await page.evaluate(()=>{const w=document.getElementById('wizardOverlay');if(w)w.remove();
  const n=document.querySelector('.whats-new-overlay');if(n)n.remove();});

let fail=0; const check=(l,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w); if(!ok)fail++;
  console.log(`  ${ok?'ok  ':'FAIL'}  ${l}`+(ok?'':`\n          got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));};

// Nothing loaded before the menu is opened.
check('no SDK before the menu opens', await page.evaluate(()=>typeof window.BB), 'undefined');

await page.evaluate(()=>document.getElementById('menuToggle').click());
await page.waitForTimeout(150);
const early = await page.evaluate(()=>{const btn=document.getElementById('cloudSignIn');
  return {label:btn.textContent, disabled:btn.disabled};});
check('button is disabled while the SDK warms', early.disabled, true);
check('and says so', early.label, 'Preparing sign-in…');

await page.waitForFunction(()=>{const b=document.getElementById('cloudSignIn'); return b && !b.disabled;}, {timeout:20000})
  .catch(()=>console.log('  (button never enabled)'));
const late = await page.evaluate(()=>{const btn=document.getElementById('cloudSignIn');
  return {label:btn.textContent, disabled:btn.disabled, sdk:typeof (window.BB&&window.BB.cloud)};});
check('enabled once the SDK is in hand', late.disabled, false);
check('label flips to the real thing', late.label, 'Sign in with Google');
check('and the module is loaded', late.sdk, 'object');

// The whole point: by tap time, no await stands between the click and window.open.
check('api is already resolved at tap time', await page.evaluate(()=>!!(window.BB&&window.BB.cloud&&window.BB.cloud.isSignedIn)), true);
check('no page errors', errs.filter(m=>!/network|fetch|ERR_|auth\//i.test(m)), []);
await page.screenshot({path:'/home/claude/cloud-popup.png'});
console.log(fail?`\n${fail} FAILURES`:'\nall checks passed');
await b.close(); process.exit(fail?1:0);
