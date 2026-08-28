// =============================================================
// §8.5 — What the service worker is allowed to keep.
//
// This suite reads the worker source and asserts its refusals directly. A
// service worker is the one piece of the frontend that outlives the session
// that installed it, so "does it cache the API?" is not a question to answer
// by reading the file once and hoping.
// =============================================================
import { describe, it, expect } from 'vitest'

// Loaded through Vite rather than the filesystem, so the suite type-checks in
// a browser-targeted project with no Node types.
const rawModules = import.meta.glob('../../public/{service-worker.js,manifest.webmanifest}', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>

const entry = (name: string): string => {
  const key = Object.keys(rawModules).find((k) => k.endsWith(name))
  if (!key) throw new Error(`${name} was not found — the PWA layer must ship it`)
  return rawModules[key]
}

const source = entry('service-worker.js')
const manifest = JSON.parse(entry('manifest.webmanifest')) as {
  display: string; start_url: string; name: string; background_color: string; icons: unknown[]
}

describe('service worker', () => {
  it('refuses to cache anything under /api', () => {
    expect(source).toContain("url.pathname.startsWith('/api')")
    expect(source).toMatch(/if \(isApiRequest\(url\)[\s\S]{0,80}\) return/)
  })

  it('caches only the shell asset types, never a document body or a data payload', () => {
    const match = /isCacheableAsset\(url\) \{[\s\S]*?return (\/[^\n]+)\.test/.exec(source)
    expect(match).not.toBeNull()
    const pattern = match![1]
    for (const extension of ['js', 'css', 'svg', 'png', 'woff2?', 'webmanifest']) {
      expect(pattern).toContain(extension)
    }
    for (const forbidden of ['pdf', 'docx', 'xlsx', 'json']) {
      expect(pattern).not.toContain(forbidden)
    }
  })

  it('never caches a cross-origin response', () => {
    expect(source).toContain("url.origin !== self.location.origin")
  })

  it('handles only GET, so no mutation is ever replayed from a cache', () => {
    expect(source).toContain("request.method !== 'GET'")
  })

  it('serves navigations network-first, so a deploy is picked up', () => {
    expect(source).toMatch(/request\.mode === 'navigate'[\s\S]{0,200}fetch\(request\)\.catch/)
  })

  it('names no credential, token or storage key anywhere', () => {
    for (const forbidden of ['token', 'Authorization', 'localStorage', 'bytescon_auth', 'password']) {
      expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })
})

describe('web app manifest', () => {
  it('is installable, and opens on the dashboard rather than a public page', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/dashboard')
    expect(manifest.name).toContain('Bytescon')
    expect(manifest.icons.length).toBeGreaterThan(0)
  })

  it('matches the application background so there is no white flash', () => {
    expect(manifest.background_color).toBe('#061019')
  })
})
