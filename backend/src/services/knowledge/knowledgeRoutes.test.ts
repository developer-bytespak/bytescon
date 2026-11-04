// =============================================================
// B14 — every Knowledge search result links to a page that exists.
//
// A "Capability narrative" result linked to /capability-narratives, which was
// never a route, so clicking it opened "page not found". The links live in the
// backend and the routes in the frontend, so nothing else catches a mismatch.
// =============================================================
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8')
const search = read('./knowledgeSearch.ts')
const app = read('../../../../frontend/src/App.tsx')
const navigation = read('../../../../frontend/src/navigation.ts')

const linkedRoutes = [...search.matchAll(/sourceRoute: '([^']+)'/g)].map((m) => m[1].split('?')[0])

/** `path="/library"` parents with their `path="capability"` children. */
function appRoutes(): Set<string> {
  const routes = new Set<string>()
  let parent = ''
  for (const line of app.split('\n')) {
    const path = line.match(/<Route path="([^"]+)"/)?.[1]
    if (!path) {
      if (line.includes('</Route>')) parent = ''
      continue
    }
    if (path.startsWith('/')) {
      routes.add(path)
      if (!line.trimEnd().endsWith('/>')) parent = path
    } else if (parent) {
      routes.add(`${parent}/${path}`)
    }
  }
  return routes
}

const redirects = new Set([...navigation.matchAll(/^\s*'(\/[^']+)': '\/[^']+',$/gm)].map((m) => m[1]))

describe('Knowledge search result links', () => {
  it('finds the links and the routes to compare', () => {
    expect(linkedRoutes.length).toBeGreaterThanOrEqual(6)
    expect(appRoutes().has('/library/capability')).toBe(true)
    expect(redirects.has('/knowledge')).toBe(true)
  })

  it('sends a capability narrative to the capability library', () => {
    expect(linkedRoutes).toContain('/library/capability')
    expect(linkedRoutes).not.toContain('/capability-narratives')
  })

  it.each([...new Set(linkedRoutes)])('%s is a real page or a known redirect', (route) => {
    expect(appRoutes().has(route) || redirects.has(route)).toBe(true)
  })
})
