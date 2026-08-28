// =============================================================
// resolveSourceUrl — Section 4 #2: never render a broken government link for demo
// or notice-id-less rows; surface a real link only when a valid source exists.
// =============================================================
import { describe, it, expect } from 'vitest'
import { resolveSourceUrl, sourceLinkLabel } from './samUrl'

const REAL_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' // 32-char hex, as the live feed issues

describe('resolveSourceUrl', () => {
  it('builds a notice link for a live row with a real 32-char hex notice id', () => {
    expect(resolveSourceUrl({ samNoticeId: REAL_ID })).toBe(`https://sam.gov/opp/${REAL_ID}/view`)
  })

  it('prefers a real sam.gov sourceUrl when present', () => {
    expect(
      resolveSourceUrl({ samNoticeId: REAL_ID, sourceUrl: 'https://sam.gov/opp/OTHER/view' }),
    ).toBe('https://sam.gov/opp/OTHER/view')
  })

  it('returns null for a demo row even if it carries a sam.gov-looking url', () => {
    expect(
      resolveSourceUrl({ isDemo: true, samNoticeId: 'demo-vets26-001', sourceUrl: 'https://sam.gov/opp/demo-vets26-001/view' }),
    ).toBeNull()
  })

  it('returns null when the notice id is a placeholder (would 404)', () => {
    expect(resolveSourceUrl({ samNoticeId: 'demo-vets26-001' })).toBeNull()
    expect(resolveSourceUrl({ samNoticeId: 'scw-demo-va-541512-NOTICE' })).toBeNull()
  })

  it('returns null when there is no notice id or url at all', () => {
    expect(resolveSourceUrl({})).toBeNull()
    expect(resolveSourceUrl({ samNoticeId: null, sourceUrl: null })).toBeNull()
  })

  it('rejects non-web sam.gov urls (e.g. api.sam.gov) and falls back to the notice id', () => {
    expect(
      resolveSourceUrl({ samNoticeId: REAL_ID, sourceUrl: 'https://api.sam.gov/opportunities/v2/OTHER' }),
    ).toBe(`https://sam.gov/opp/${REAL_ID}/view`)
  })

  it('returns the grants.gov record page for a Grants.gov row', () => {
    expect(
      resolveSourceUrl({
        source: 'GRANTS_GOV',
        samNoticeId: 'grants_gov:363552',
        sourceUrl: 'https://www.grants.gov/search-results-detail/363552',
      }),
    ).toBe('https://www.grants.gov/search-results-detail/363552')
  })

  it('never sends a Grants.gov row to a sam.gov link', () => {
    expect(
      resolveSourceUrl({ source: 'GRANTS_GOV', samNoticeId: REAL_ID, sourceUrl: 'https://sam.gov/opp/OTHER/view' }),
    ).toBeNull()
  })

  it('trusts the configured feed link for operator-configured sources, https only', () => {
    expect(
      resolveSourceUrl({ source: 'STATE_LOCAL', sourceUrl: 'https://data.cityofnewyork.us/bid/123' }),
    ).toBe('https://data.cityofnewyork.us/bid/123')
    expect(resolveSourceUrl({ source: 'STATE_LOCAL', sourceUrl: 'http://insecure.example/bid/1' })).toBeNull()
  })

  it('returns null for a demo row whatever its source', () => {
    expect(
      resolveSourceUrl({ isDemo: true, source: 'GRANTS_GOV', sourceUrl: 'https://www.grants.gov/search-results-detail/1' }),
    ).toBeNull()
  })
})

describe('sourceLinkLabel', () => {
  it('names the system that actually holds the record', () => {
    expect(sourceLinkLabel('SAM_GOV')).toBe('SAM.gov')
    expect(sourceLinkLabel('GRANTS_GOV')).toBe('Grants.gov')
    expect(sourceLinkLabel('STATE_LOCAL')).toBe('State / Local')
  })

  it('falls back to a neutral word when the source is unknown or absent', () => {
    expect(sourceLinkLabel(undefined)).toBe('source')
    expect(sourceLinkLabel('SOMETHING_NEW')).toBe('source')
  })
})
