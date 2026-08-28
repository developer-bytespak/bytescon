// =============================================================
// §8.5 — Service-worker registration.
//
// Registered only in a production build and only over a secure origin. In dev
// a service worker mostly serves stale bundles and confuses debugging, and on
// an insecure origin the browser refuses it anyway.
//
// Registration is deliberately silent on failure: an app that will not start
// because a cache could not be installed is a worse app than one that simply
// is not installable.
// =============================================================
export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  const isProduction = (import.meta as any).env?.PROD === true
  const isSecure = window.isSecureContext
  if (!isProduction || !isSecure) return

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => undefined)
  })
}

/**
 * Remove any previously installed worker and everything it cached.
 *
 * Called on sign-out. The shell holds no data, but a device that has changed
 * hands should keep nothing at all from the previous session.
 */
export async function unregisterServiceWorker(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map((r) => r.unregister()))
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    // Nothing to do: the caller is signing out either way.
  }
}
