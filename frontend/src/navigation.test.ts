// =============================================================
// Navigation model — hubs, legacy redirects and palette entries agree.
// =============================================================
import { describe, it, expect } from 'vitest'
import { HUBS, NAV_SECTIONS, LEGACY_REDIRECTS, hubTabPath, paletteEntries } from './navigation'

const hubTabPaths = new Set(
  Object.entries(HUBS).flatMap(([hub, def]) => def.tabs.map((t) => hubTabPath(hub, t.segment))),
)

describe('navigation model', () => {
  it('every legacy redirect lands on a real hub tab', () => {
    for (const [from, to] of Object.entries(LEGACY_REDIRECTS)) {
      expect(hubTabPaths.has(to), `${from} → ${to}`).toBe(true)
      expect(from).not.toBe(to)
    }
  })

  it('sidebar hubs reference the hub catalogue and paths are unique', () => {
    const seen = new Set<string>()
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        expect(seen.has(item.to), `duplicate ${item.to}`).toBe(false)
        seen.add(item.to)
        if (item.tabs) expect(HUBS[item.to]?.tabs).toBe(item.tabs)
      }
    }
    expect(NAV_SECTIONS[0].pinned).toBe(true)
  })

  it('keeps the sidebar short: no section beyond six top-level entries', () => {
    for (const section of NAV_SECTIONS) {
      expect(section.items.length, section.label).toBeLessThanOrEqual(6)
    }
    const total = NAV_SECTIONS.reduce((n, s) => n + s.items.length, 0)
    expect(total).toBeLessThanOrEqual(32)
  })

  it('palette lists pages and hub tabs with breadcrumb labels', () => {
    const entries = paletteEntries()
    expect(entries.some((e) => e.to === '/finance/receivables' && e.label === 'Finance › Receivables')).toBe(true)
    expect(entries.some((e) => e.to === '/templates' && e.label === 'Templates › My templates')).toBe(true)
    const admin = entries.find((e) => e.to === '/admin/metrics')
    expect(admin?.adminOnly).toBe(true)
    expect(admin?.platformAdminOnly).toBe(true)
  })
})
