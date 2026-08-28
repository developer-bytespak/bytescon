/*
 * §8.5 — Service worker.
 *
 * WHAT THIS CACHES: the application shell — the HTML document and the built,
 * content-hashed JS and CSS. That is enough to make the app installable and to
 * make it open instantly on a phone.
 *
 * WHAT THIS NEVER CACHES, and why the rule is written as a refusal rather than
 * an omission: anything under /api. A federal contractor's phone holds
 * contract values, invoices, evaluation notes, personnel records and partner
 * pricing. A cached API response outlives the session that fetched it, is
 * readable by anyone who later holds the device, and survives a revoked
 * account. So every /api request goes to the network, every time, and a
 * failure is a failure rather than a stale answer presented as a fresh one.
 *
 * There is deliberately no offline fallback page for authenticated data: an
 * app that shows yesterday's deadline as though it were today's is worse than
 * one that says it cannot reach the server.
 */
const SHELL_CACHE = 'bytescon-shell-v1'
const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

function isApiRequest(url) {
  return url.pathname.startsWith('/api')
}

function isCacheableAsset(url) {
  return /\.(?:js|css|woff2?|svg|png|webmanifest)$/.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Never this origin's API, and never anything cross-origin: a third party's
  // response is not ours to keep.
  if (isApiRequest(url) || url.origin !== self.location.origin) return

  if (isCacheableAsset(url)) {
    // Built assets carry a content hash in the filename, so a cache hit is
    // always the file that hash refers to.
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })),
    )
    return
  }

  if (request.mode === 'navigate') {
    // Network first, so a deployed change is picked up; the cached shell is
    // only a fallback when the network is gone. It carries no data of its own.
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((cached) => cached || Response.error())),
    )
  }
})
