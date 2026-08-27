/* Bunch Bets service worker.
 *
 * Why this exists: the app hard-gates on being installed to the home screen, and
 * an installed PWA with no service worker cannot cold-start without a network.
 * That is precisely the situation the app is built for — a phone on a golf course.
 *
 * Strategy
 *   navigations / index.html      network-first with a short timeout, cache fallback
 *   same-origin static assets     cache-first, refreshed in the background
 *   Firebase SDK + Google Fonts   cache-first (URLs are version-pinned)
 *   analytics, weather, geo, QR   never touched — straight to network, fail silently
 *   Realtime Database             never touched (and websockets bypass SW anyway)
 *
 * Kill switch, in order of preference:
 *   1. Open the app with ?nosw=1 — the page unregisters the worker and clears caches.
 *      No deploy required; works even if this file is broken.
 *   2. Delete sw.js from the deploy. A 404 on the update check drops the registration.
 *
 * The cache name carries ?v= from the registration URL, which is APP_VERSION. Each
 * release therefore lands in a fresh cache and old ones are dropped on activate.
 */

const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE = `bunchbets-${VERSION}`;
const NET_TIMEOUT_MS = 3000;

// The shell is stored under one stable key. Note './index.html' is NOT precached:
// Cloudflare Pages 308-redirects /index.html to /, and Cache.put() rejects a
// redirected Response, so adding it silently fails and leaves no shell at all.
const SHELL = './';

const PRECACHE = [
  './',
  './manifest.webmanifest',
  './manifest.beta.webmanifest',
  './BunchBets180.png',
  './BunchBets1024.png',
  './BunchBetsBeta180.png',
  './favicon-16.png',
  './favicon-32.png',
  'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.0/firebase-database-compat.js',
];

// Hosts whose responses must never be served from cache: stale analytics is
// pointless, stale weather is wrong, and a stale QR code points at a dead game.
const NEVER_CACHE = [
  'googletagmanager.com',
  'google-analytics.com',
  'ipapi.co',
  'open-meteo.com',
  'api.qrserver.com',
  'firebaseio.com',
  'firebasedatabase.app',
];

const CACHEABLE_THIRD_PARTY = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Added one at a time: a single unreachable CDN URL must not fail the install
    // and leave the app with no offline shell at all.
    await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})));
    // The shell is the one entry that actually matters. If cache.add could not
    // store it (redirect, offline, quota) fetch and store it the hard way.
    if (!(await cache.match(SHELL))) {
      try { await store(cache, SHELL, await fetch(SHELL, { cache: 'reload' })); } catch (e) {}
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('bunchbets-') && k !== CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Once true, this worker stops intercepting anything. Set by the KILL teardown so
// its own fetch handler cannot re-create the caches it is in the middle of deleting.
let KILLED = false;

self.addEventListener('message', (event) => {
  const data = event.data || {};

  // Sent only after the user taps "Reload" on the update banner.
  if (data.type === 'SKIP_WAITING') self.skipWaiting();

  // Full teardown (?nosw=1). Page-side teardown cannot win this race: unregistering
  // does not stop the active worker from controlling open pages, so it keeps serving
  // fetches and re-creating the cache. Doing it in here is the only ordering that
  // holds — stop intercepting, drop caches, unregister, then send clients to a clean
  // URL where they will come up uncontrolled.
  if (data.type === 'STATUS' && event.ports && event.ports[0]) {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const keys = await cache.keys();
      event.ports[0].postMessage({
        version: VERSION,
        shellCached: !!(await cache.match(SHELL)),
        entries: keys.length,
      });
    })());
  }

  if (data.type === 'KILL') {
    event.waitUntil((async () => {
      KILLED = true;
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('bunchbets-')).map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => {
        try { c.navigate(c.url.split('?')[0] + '?swremoved=1'); } catch (e) {}
      });
    })());
  }
});

function neverCache(url) {
  return NEVER_CACHE.some((host) => url.hostname === host || url.hostname.endsWith('.' + host));
}

// Cache.put() throws on a redirected Response, which is exactly what a request for
// /index.html returns on Cloudflare Pages. Rebuild those as a plain 200 so they can
// be stored — otherwise the shell silently never caches.
async function store(cache, key, response) {
  if (!response || !response.ok) return;
  try {
    if (response.redirected || response.type === 'opaqueredirect') {
      const body = await response.clone().blob();
      await cache.put(key, new Response(body, { status: 200, statusText: 'OK', headers: response.headers }));
    } else {
      await cache.put(key, response.clone());
    }
  } catch (e) { /* quota, opaque response, etc. — never break the response itself */ }
}

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('sw-timeout')), NET_TIMEOUT_MS)),
    ]);
    await store(cache, cacheKey || request, response);
    return response;
  } catch (err) {
    // Offline, or the network is slower than the timeout. Serve the shell.
    const hit = (await cache.match(cacheKey || request)) ||
                (await cache.match(SHELL)) ||
                (await cache.match('./index.html'));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) {
    // Refresh in the background so the next launch is current.
    fetch(request).then((r) => store(cache, request, r)).catch(() => {});
    return hit;
  }
  const response = await fetch(request);
  await store(cache, request, response);
  return response;
}

// Auth flows and the auth probe must never be served from cache: a stale page or a
// cached redirect handler breaks sign-in in ways that are miserable to diagnose.
const BYPASS_PATHS = ['/auth-probe', '/cloud-test', '/__/auth'];

self.addEventListener('fetch', (event) => {
  if (KILLED) return;
  const request = event.request;
  if (request.method !== 'GET') return;
  if (BYPASS_PATHS.some((p) => request.url.indexOf(p) !== -1)) return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return;
  if (neverCache(url)) return;

  const isShell = request.mode === 'navigate' ||
                  (url.origin === self.location.origin &&
                   (url.pathname === '/' || url.pathname.endsWith('/index.html')));

  if (isShell) {
    // Always cache the shell under one stable key — navigations carry query strings
    // (?dev=1, ?join=CODE, cache-busters) and the host may redirect /index.html to /,
    // either of which would otherwise fragment or defeat the cache.
    event.respondWith(networkFirst(request, SHELL));
    return;
  }

  if (url.origin === self.location.origin || CACHEABLE_THIRD_PARTY.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
});
