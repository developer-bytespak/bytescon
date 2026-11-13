import { describe, it, expect, afterEach, vi } from 'vitest'
import { getGb107Config } from './config.gb107'

describe('GB-107 config', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('uses the SAM.gov default when the URL setting is empty (as in .env.example), not an empty URL', () => {
    vi.stubEnv('ENRICHMENT_NOTICEDESC_URL', '')
    vi.stubEnv('ENRICHMENT_SEARCH_URL', '  ')
    expect(getGb107Config().noticeDescUrl).toBe('https://api.sam.gov/prod/opportunities/v1/noticedesc')
    expect(getGb107Config().searchUrl).toBe('https://api.sam.gov/prod/opportunities/v2/search')
  })

  it('still honours a set URL', () => {
    vi.stubEnv('ENRICHMENT_NOTICEDESC_URL', 'https://sam.example.test/noticedesc')
    expect(getGb107Config().noticeDescUrl).toBe('https://sam.example.test/noticedesc')
  })
})
