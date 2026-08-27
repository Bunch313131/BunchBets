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

const PRECACHE = [
  './',
  './index.html',
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

// The page sends this only after the user taps "Reload" on the update banner.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function neverCache(url) {
  return NEVER_CACHE.some((host) => url.hostname === host || url.hostname.endsWith('.' + host));
}

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('sw-timeout')), NET_TIMEOUT_MS)),
    ]);
    if (response && response.ok) cache.put(cacheKey || request, response.clone());
    return response;
  } catch (err) {
    // Offline, or the network is slower than the timeout. Serve the shell.
    const hit = (await cache.match(cacheKey || request)) ||
                (await cache.match('./index.html')) ||
                (await cache.match('./'));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) {
    // Refresh in the background so the next launch is current.
    fetch(request).then((r) => { if (r && r.ok) cache.put(request, r.clone()); }).catch(() => {});
    return hit;
  }
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return;
  if (neverCache(url)) return;

  const isShell = request.mode === 'navigate' ||
                  (url.origin === self.location.origin &&
                   (url.pathname === '/' || url.pathname.endsWith('/index.html')));

  if (isShell) {
    // Always cache the shell under a stable key — navigations carry query strings
    // (?dev=1, ?join=CODE, cache-busters) that would otherwise fragment the cache.
    event.respondWith(networkFirst(request, './index.html'));
    return;
  }

  if (url.origin === self.location.origin || CACHEABLE_THIRD_PARTY.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
});
