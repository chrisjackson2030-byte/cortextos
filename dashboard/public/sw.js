/*
 * cortextOS Dashboard — service worker (PWA Phase 1, hand-rolled).
 *
 * Plain static JS served from /public as-is. NO build plugin (Turbopack never
 * touches it), so it sidesteps the @serwist/Next-16 webpack incompatibility.
 *
 * Caching strategy (security-first):
 *   - NetworkOnly  : /api/*  (incl. /api/auth), Server-Sent-Events, all non-GET.
 *                    NEVER read or write the cache for these. A logged-out client
 *                    must NEVER be served cached authed/user data. All dashboard
 *                    data is authed /api, so treating the whole /api surface as
 *                    NetworkOnly is the strictly-safest reading of the spec.
 *   - CacheFirst   : immutable static shell (/_next/static, icons, manifest,
 *                    public svgs) — content-hashed, non-sensitive.
 *   - NetworkFirst : same-origin HTML navigations — fresh when online (so the
 *                    logged-out redirect to /login always wins live); falls back
 *                    to the cached app shell only when the network is unreachable.
 */

// v2 (2026-06-03): CacheFirst on /_next/static poisoned the cache permanently —
// this dashboard runs `next dev` (Turbopack), where chunk names are PATH-based and
// STABLE across edits (NOT content-hashed like a prod build), so CacheFirst served
// stale JS forever (the dashboard "served old code for days" bug — e.g. the chart
// fix never reached the browser). Static shell is now NetworkFirst: fresh when
// online, cache only as an offline fallback. Version bump force-purges the bad v1 cache.
const VERSION = "v2";
const SHELL_CACHE = `ctx-shell-${VERSION}`;
const PAGE_CACHE = `ctx-pages-${VERSION}`;
const KEEP = new Set([SHELL_CACHE, PAGE_CACHE]);

// Take control fast so the SW governs the page on first load after install.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((n) => (KEEP.has(n) ? null : caches.delete(n))));
      await self.clients.claim();
    })()
  );
});

function isStaticShell(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/apple-icon.png" ||
    url.pathname === "/favicon.ico" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname.endsWith(".svg")
  );
}

function isNeverCache(url, request) {
  // All API (data is authed), auth, and Server-Sent-Events streams.
  if (url.pathname.startsWith("/api/")) return true;
  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/event-stream")) return true;
  return false;
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const resp = await fetch(request);
  if (resp && resp.ok && resp.type === "basic") {
    cache.put(request, resp.clone());
  }
  return resp;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await fetch(request);
    // Only cache successful same-origin HTML. Redirects (307→/login) and errors
    // are returned live but never stored, so cache can't replay an auth state.
    if (resp && resp.ok && resp.type === "basic") {
      cache.put(request, resp.clone());
    }
    return resp;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    const shell = await cache.match("/");
    if (shell) return shell;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Non-GET (POST/PUT/PATCH/DELETE) → straight to network, never cached.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Only manage same-origin traffic; let cross-origin pass through untouched.
  if (url.origin !== self.location.origin) return;

  // Hard NetworkOnly: authed API, auth, SSE. Do not intercept → browser fetches
  // live every time; nothing ever enters the cache.
  if (isNeverCache(url, request)) return;

  if (isStaticShell(url)) {
    // NetworkFirst (not CacheFirst): in `next dev` chunk names are stable across
    // edits, so CacheFirst would serve stale JS forever. Fresh online, cache offline.
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // HTML navigations (and anything else same-origin GET) → NetworkFirst.
  if (request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(networkFirst(request, PAGE_CACHE));
    return;
  }

  // Other same-origin GET assets → NetworkFirst into the page cache.
  event.respondWith(networkFirst(request, SHELL_CACHE));
});
