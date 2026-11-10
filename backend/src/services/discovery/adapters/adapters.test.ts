// =============================================================
// §6.1A — Source adapters.
//
// Every adapter is exercised against representative provider fixtures, with no
// live network call. This is the "production-ready adapter contract + complete
// tests using representative provider fixtures" the spec requires for sources
// that cannot be verified live from this environment.
//
// Live-provider verification is tracked separately on
// OpportunitySourceConfig.verification, which sourceSync only sets to
// LIVE_VERIFIED after a real provider round-trip.
// =============================================================
import { describe, it, expect, vi } from 'vitest'
import axios from 'axios'
import { SourceCategory, SourceDataQuality } from '@prisma/client'
import { listAdapters, getAdapter, parseSourceDate, parseSourceAmount, completenessOf, deriveDataQuality } from '../sourceAdapter'
import { registerBuiltInAdapters } from './index'
import { __testing as grantsTesting } from './grantsGovAdapter'
import { normalizeForecastRow, parseCsv, extractRows } from './agencyForecastAdapter'
import { normalizeFeedRow, extractFeedRows, parseRssItems, __testing as feedTesting } from './feedAdapterFactory'
import { normalizeSamRecord } from './samGovAdapter'

registerBuiltInAdapters()

describe('adapter registry', () => {
  it('registers one adapter per required source category', () => {
    const categories = listAdapters().map((a) => a.category)
    for (const required of [
      SourceCategory.SAM_GOV,
      SourceCategory.CONTRACT_AWARDS,
      SourceCategory.AGENCY_FORECAST,
      SourceCategory.GRANTS_GOV,
      SourceCategory.STATE_LOCAL,
      SourceCategory.SUBCONTRACTING_BOARD,
    ]) {
      expect(categories, `missing adapter for ${required}`).toContain(required)
    }
  })

  it('never shows customers an internal setting or field name (B29)', () => {
    for (const adapter of listAdapters()) {
      expect(adapter.coverageNote, adapter.key).not.toMatch(/configJson|maxRecords|[A-Z][A-Z0-9]+_[A-Z0-9_]+/)
    }
  })

  it('gives every adapter an honest coverage note', () => {
    for (const adapter of listAdapters()) {
      expect(adapter.coverageNote.length, adapter.key).toBeGreaterThan(30)
    }
  })

  it('never claims universal state/local or subcontracting-board coverage', () => {
    expect(getAdapter('state_local')!.coverageNote).toMatch(/not, and does not claim to be, national/i)
    expect(getAdapter('subcontracting_board')!.coverageNote).toMatch(/no broad subcontracting-board coverage is claimed/i)
  })
})

describe('adapter configuration is optional, never mandatory', () => {
  const env = (config: Record<string, unknown> = {}, firmApiKey: string | null = null) => ({
    getEnv: () => undefined,
    config,
    baseUrl: null,
    firmApiKey,
  })

  it('reports NOT_CONFIGURED — not an error — when the firm has no SAM key, even if the server has a shared one', () => {
    const shared = { ...env(), getEnv: (k: string) => (k === 'SAM_API_KEY' ? 'platform-key' : undefined) }
    const result = getAdapter('sam_gov')!.configure(shared)
    expect(result.state).toBe('NOT_CONFIGURED')
    expect(result.reason).toMatch(/your own SAM.gov key/)
  })

  it('tells customers how to enable it, without internal setting names (B28)', () => {
    const adapter = getAdapter('sam_gov')!
    expect(adapter.coverageNote).toContain('own SAM.gov key')
    expect(adapter.coverageNote).not.toContain('SAM_API_KEY')
    expect(adapter.configure(env()).reason).not.toContain('SAM_API_KEY')
  })

  it('pages by page number, 1,000 a page, at most 3 pages a run, daily', async () => {
    const adapter = getAdapter('sam_gov')!
    const records = Array.from({ length: 1000 }, (_, i) => ({ noticeId: `n${i}`, title: `Notice ${i}`, postedDate: '2026-11-01', responseDeadLine: '2026-12-01' }))
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({ data: { totalRecords: 2500, opportunitiesData: records } } as never)
    const page = await adapter.fetchPage(env({}, 'firm-key'), { mode: 'FULL', pageToken: '1', timeoutMs: 5000, now: new Date('2026-11-11T00:00:00Z') })
    expect(spy.mock.calls[0][1]).toMatchObject({ params: { api_key: 'firm-key', limit: 1000, offset: 1 } })
    expect(page.nextPageToken).toBe('2')
    spy.mockResolvedValue({ data: { totalRecords: 2500, opportunitiesData: records.slice(0, 500) } } as never)
    expect((await adapter.fetchPage(env({}, 'firm-key'), { mode: 'FULL', pageToken: '2', timeoutMs: 5000, now: new Date() })).nextPageToken).toBeNull()
    expect(adapter.maxPagesPerRun).toBe(3)
    expect(adapter.runIntervalMinutes).toBe(24 * 60)
    spy.mockRestore()
  })

  it('is READY once a firm-level SAM key exists', () => {
    expect(getAdapter('sam_gov')!.configure(env({}, 'firm-key')).state).toBe('READY')
  })

  it('reports NOT_CONFIGURED for a feed adapter with no feed URL', () => {
    for (const key of ['state_local', 'subcontracting_board', 'agency_forecast']) {
      const result = getAdapter(key)!.configure(env())
      expect(result.state, key).toBe('NOT_CONFIGURED')
      expect(result.reason, key).toBeTruthy()
    }
  })

  it('is READY for a feed adapter once a feed URL is configured', () => {
    expect(getAdapter('state_local')!.configure(env({ feedUrl: 'https://data.example.gov/bids.json' })).state).toBe('READY')
  })

  it('needs no credential for Grants.gov or award history', () => {
    expect(getAdapter('grants_gov')!.configure(env()).state).toBe('READY')
    expect(getAdapter('contract_awards')!.configure(env()).state).toBe('READY')
  })
})

describe('shared normalization helpers', () => {
  it('anchors a bare date to UTC midnight', () => {
    expect(parseSourceDate('2027-03-15')?.toISOString()).toBe('2027-03-15T00:00:00.000Z')
  })
  it('returns null rather than guessing for unusable values', () => {
    expect(parseSourceDate('')).toBeNull()
    expect(parseSourceDate('not a date')).toBeNull()
    expect(parseSourceAmount('n/a')).toBeNull()
    expect(parseSourceAmount('')).toBeNull()
  })
  it('parses currency-formatted amounts', () => {
    expect(parseSourceAmount('$1,250,000.50')).toBe(1250000.5)
    expect(parseSourceAmount(42)).toBe(42)
  })
  it('reports completeness as a fraction of populated fields', () => {
    expect(completenessOf(['a', null, '', 'b'])).toBe(0.5)
    expect(completenessOf([])).toBe(0)
  })
  it('reports PARTIAL when a required field is absent', () => {
    expect(deriveDataQuality([true, true])).toBe(SourceDataQuality.OK)
    expect(deriveDataQuality([true, false])).toBe(SourceDataQuality.PARTIAL)
  })
})

describe('SAM.gov adapter normalization', () => {
  const NOW = new Date('2026-06-01T00:00:00Z')

  it('normalizes a representative SAM search record', () => {
    const record = normalizeSamRecord({
      noticeId: 'abc123',
      solicitationNumber: 'W15P7T-27-R-0001',
      title: 'Enterprise cybersecurity support',
      department: 'DEPT OF DEFENSE',
      subTier: 'DEPT OF THE ARMY',
      office: 'ACC-APG',
      naicsCode: '541512',
      classificationCode: 'D310',
      typeOfSetAside: 'SDVOSBC',
      type: 'Solicitation',
      postedDate: '2026-05-01',
      responseDeadLine: '2026-07-01T17:00:00-04:00',
      uiLink: 'https://sam.gov/opp/abc123',
      placeOfPerformance: { city: { name: 'Aberdeen' }, state: { code: 'MD' } },
    }, NOW)!

    expect(record.externalId).toBe('abc123')
    expect(record.agency).toBe('DEPT OF DEFENSE')
    expect(record.setAsideType).toBe('SDVOSB')
    expect(record.placeOfPerformance).toBe('Aberdeen, MD')
    expect(record.sourceUrl).toBe('https://sam.gov/opp/abc123')
    expect(record.dataQuality).toBe(SourceDataQuality.OK)
  })

  it('flags PARTIAL when the record has no explicit response deadline', () => {
    const record = normalizeSamRecord({
      noticeId: 'x', title: 'A notice', department: 'GSA', naicsCode: '541512', archiveDate: '2026-08-01',
    }, NOW)!
    expect(record.dataQuality).toBe(SourceDataQuality.PARTIAL)
    // It falls back to the archive date rather than inventing a deadline.
    expect(record.responseDeadline?.toISOString().slice(0, 10)).toBe('2026-08-01')
  })

  it('rejects a record with no id or title rather than fabricating one', () => {
    expect(normalizeSamRecord({ title: 'No id' }, NOW)).toBeNull()
    expect(normalizeSamRecord({ noticeId: 'x' }, NOW)).toBeNull()
  })
})

describe('Grants.gov adapter normalization', () => {
  it('normalizes a representative Search2 hit', () => {
    const record = grantsTesting.normalizeHit({
      id: 350123,
      number: 'HHS-2027-ACF-001',
      title: 'Community Services Block Grant',
      agencyName: 'Department of Health and Human Services',
      openDate: '2026-05-01',
      closeDate: '2026-08-15',
      awardCeiling: '500000',
      awardFloor: '100000',
      alnist: ['93.569'],
      oppStatus: 'posted',
    }, 'https://api.grants.gov/v1/api')!

    expect(record.externalId).toBe('350123')
    expect(record.noticeType).toBe('Grant Opportunity')
    expect(record.estimatedValue).toBe(500000)
    expect(record.estimatedValueMin).toBe(100000)
    expect(record.responseDeadline?.toISOString().slice(0, 10)).toBe('2026-08-15')
    expect(record.sourceUrl).toContain('grants.gov')
    // Assistance listings are NOT coerced into a NAICS code.
    expect(record.naicsCode).toBeNull()
    expect((record.sourceMetadata as Record<string, unknown>).assistanceListings).toEqual(['93.569'])
  })

  it('flags PARTIAL when a grant has no close date', () => {
    const record = grantsTesting.normalizeHit({ id: '1', title: 'Grant', agencyName: 'HHS' }, 'x')!
    expect(record.dataQuality).toBe(SourceDataQuality.PARTIAL)
  })

  const NOW = new Date('2026-11-10T12:00:00Z')
  const yearOn = new Date(NOW.getTime() + 365 * 86_400_000).toISOString()

  it('labels a posted grant with no close date as rolling, open for a year from this fetch', () => {
    const record = grantsTesting.normalizeHit({ id: '2', title: 'Rural Health Outreach', agencyName: 'HHS', oppStatus: 'posted' }, 'x', NOW)!
    expect(record.title).toBe('Rolling: Rural Health Outreach')
    expect(record.noticeType).toBe('Grant Opportunity')
    expect(record.responseDeadline?.toISOString()).toBe(yearOn)
    expect((record.sourceMetadata as Record<string, unknown>).deadlineLabel).toBe('Rolling: no closing date')
    expect(record.description).toMatch(/^Rolling: no closing date\./)
  })

  it('labels a forecast as not open yet, and keeps a real close date when it has one', () => {
    const plain = grantsTesting.normalizeHit({ id: '3', title: 'Water Grants', agencyName: 'EPA', oppStatus: 'forecasted', docType: 'forecast' }, 'x', NOW)!
    expect(plain.title).toBe('Forecast: Water Grants')
    expect(plain.noticeType).toBe('Grant Forecast')
    expect(plain.responseDeadline?.toISOString()).toBe(yearOn)
    expect((plain.sourceMetadata as Record<string, unknown>).deadlineLabel).toBe('Forecast: not open yet')
    const dated = grantsTesting.normalizeHit({ id: '4', title: 'Bridge Grants', agencyName: 'DOT', oppStatus: 'forecasted', closeDate: '2027-03-01' }, 'x', NOW)!
    expect(dated.title).toBe('Forecast: Bridge Grants')
    expect(dated.responseDeadline?.toISOString().slice(0, 10)).toBe('2027-03-01')
    expect((dated.sourceMetadata as Record<string, unknown>).deadlineLabel).toBeNull()
  })

  it('asks for posted and forecasted grants 1,000 at a time, every 6 hours', async () => {
    const spy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { errorcode: 0, data: { hitCount: 1461, oppHits: Array.from({ length: 1000 }, (_, i) => ({ id: i, title: `G${i}`, agencyName: 'HHS', closeDate: '2027-01-01' })) } } } as never)
    const adapter = getAdapter('grants_gov')!
    const page = await adapter.fetchPage({ getEnv: () => undefined, config: {}, baseUrl: null, firmApiKey: null }, { mode: 'FULL', timeoutMs: 5000, now: NOW })
    expect(spy.mock.calls[0][1]).toMatchObject({ rows: 1000, startRecordNum: 0, oppStatuses: 'forecasted|posted' })
    expect(page.nextPageToken).toBe('1000')
    expect(adapter.runIntervalMinutes).toBe(360)
    spy.mockRestore()
  })
})

describe('Agency forecast adapter normalization', () => {
  const defaults = { agency: null, feedUrl: 'https://agency.gov/forecast.json' }

  it('normalizes a JSON forecast row through the default column map', () => {
    const record = normalizeForecastRow({
      'Forecast ID': 'FY27-1234',
      Title: 'Base operations support services',
      Agency: 'Department of Veterans Affairs',
      'Sub Agency': 'VHA',
      'Anticipated Solicitation Date': '2027-01-15',
      'Anticipated Award Date': '2027-06-01',
      'Fiscal Year': 'FY 2027',
      NAICS: '561210 - Facilities Support',
      'Set Aside': 'SDVOSB',
      'Estimated Value': '$12,500,000',
      Incumbent: 'Existing Vendor LLC',
    }, {}, defaults)!

    expect(record.kind).toBe('FORECAST')
    expect(record.externalId).toBe('FY27-1234')
    expect(record.fiscalYear).toBe(2027)
    expect(record.naicsCode).toBe('561210')
    expect(record.estimatedValue).toBe(12500000)
    expect(record.incumbentName).toBe('Existing Vendor LLC')
    expect(record.anticipatedSolicitationDate?.toISOString().slice(0, 10)).toBe('2027-01-15')
    expect(record.dataQuality).toBe(SourceDataQuality.OK)
  })

  it('never invents an incumbent the source did not supply', () => {
    const record = normalizeForecastRow({ Title: 'X', Agency: 'GSA' }, {}, defaults)!
    expect(record.incumbentName).toBeNull()
  })

  it('builds a deterministic surrogate id when the feed has none', () => {
    const row = { Title: 'Base operations support', Agency: 'GSA', 'Anticipated Solicitation Date': '2027-01-15' }
    const a = normalizeForecastRow(row, {}, defaults)!
    const b = normalizeForecastRow(row, {}, defaults)!
    expect(a.externalId).toBe(b.externalId)
    expect(a.externalId).toContain('gsa')
  })

  it('rejects a row with no title or agency', () => {
    expect(normalizeForecastRow({ Title: 'X' }, {}, { agency: null, feedUrl: 'x' })).toBeNull()
  })

  it('parses a CSV forecast export, including quoted fields', () => {
    const rows = parseCsv('Forecast ID,Title,Agency,Estimated Value\nFY27-1,"Support, logistics",GSA,"$1,000"\n')
    expect(rows).toHaveLength(1)
    expect(rows[0].Title).toBe('Support, logistics')
    const record = normalizeForecastRow(rows[0], {}, defaults)!
    expect(record.estimatedValue).toBe(1000)
  })

  it('accepts an array, an envelope or CSV text', () => {
    expect(extractRows([{ a: 1 }], 'application/json')).toHaveLength(1)
    expect(extractRows({ records: [{ a: 1 }, { b: 2 }] }, 'application/json')).toHaveLength(2)
    expect(extractRows('a,b\n1,2\n', 'text/csv')).toHaveLength(1)
    expect(extractRows('nonsense', 'text/plain')).toEqual([])
  })
})

describe('Generic official-feed adapter normalization', () => {
  const defaults = {
    agency: null, jurisdiction: 'State of Example',
    noticeType: 'State/Local Solicitation',
    feedUrl: 'https://data.example.gov/bids.json',
    sourceLabel: 'state_local_feed',
  }

  it('normalizes an Open Data style JSON row', () => {
    const record = normalizeFeedRow({
      bid_id: 'BID-2027-01',
      title: 'Roadway resurfacing',
      agency: 'Department of Transportation',
      close_date: '2027-04-01',
      estimated_value: '2500000',
      set_aside: 'Local small business preference',
      url: { url: 'https://bids.example.gov/BID-2027-01' },
    }, feedTesting.GENERIC_FIELD_MAP, defaults)!

    expect(record.externalId).toBe('BID-2027-01')
    expect(record.responseDeadline?.toISOString().slice(0, 10)).toBe('2027-04-01')
    expect(record.sourceUrl).toBe('https://bids.example.gov/BID-2027-01')
    // A local preference programme is NOT a federal set-aside.
    expect(record.setAsideType).toBe('NONE')
    expect((record.sourceMetadata as Record<string, unknown>).localPreference).toBe('Local small business preference')
  })

  it('falls back to the configured jurisdiction when a row omits the agency', () => {
    const record = normalizeFeedRow({ title: 'Bid', close_date: '2027-04-01' }, feedTesting.GENERIC_FIELD_MAP, defaults)!
    expect(record.agency).toBe('State of Example')
  })

  it('parses an RSS bid feed', () => {
    const items = parseRssItems(`<?xml version="1.0"?><rss><channel>
      <item><guid>RFP-77</guid><title>Janitorial services</title>
        <description>Bids due 2027-05-01</description>
        <link>https://bids.example.gov/77</link><pubDate>2027-03-01</pubDate></item>
    </channel></rss>`)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Janitorial services')
    expect(items[0].link).toBe('https://bids.example.gov/77')
  })

  it('extracts rows from an array, an envelope and a CKAN wrapper', () => {
    expect(extractFeedRows([{ a: 1 }], 'JSON')).toHaveLength(1)
    expect(extractFeedRows({ results: [{ a: 1 }] }, 'JSON')).toHaveLength(1)
    expect(extractFeedRows({ result: { records: [{ a: 1 }, { b: 2 }] } }, 'JSON')).toHaveLength(2)
    expect(extractFeedRows('not json', 'JSON')).toEqual([])
  })

  it('flags PARTIAL when a feed row has no deadline', () => {
    const record = normalizeFeedRow({ title: 'Bid', agency: 'DOT' }, feedTesting.GENERIC_FIELD_MAP, defaults)!
    expect(record.dataQuality).toBe(SourceDataQuality.PARTIAL)
  })

  it('produces a deterministic surrogate id when the feed omits one', () => {
    const row = { title: 'Roadway resurfacing', agency: 'DOT' }
    const a = normalizeFeedRow(row, feedTesting.GENERIC_FIELD_MAP, defaults)!
    const b = normalizeFeedRow(row, feedTesting.GENERIC_FIELD_MAP, defaults)!
    expect(a.externalId).toBe(b.externalId)
  })
})

describe('multi-jurisdiction feed list (configJson.feeds)', () => {
  const env = (config: Record<string, unknown>) => ({
    getEnv: () => undefined,
    config,
    baseUrl: null,
    firmApiKey: null,
  })
  const args = (pageToken: string | null = null) => ({ pageToken, timeoutMs: 5000, now: new Date('2026-09-11T00:00:00Z'), mode: 'FULL' as const })
  const feeds = [
    { feedUrl: 'https://a.example.gov/bids.json', jurisdiction: 'Delaware' },
    { feedUrl: 'https://b.example.gov/bids.json', jurisdiction: 'Mesa, AZ', fieldMap: { title: ['contract_description'] } },
  ]

  it('is READY with a feeds list and no top-level feedUrl', () => {
    expect(getAdapter('state_local')!.configure(env({ feeds })).state).toBe('READY')
  })

  it('fetches one feed per page and namespaces externalIds per jurisdiction', async () => {
    const axios = (await import('axios')).default
    const vi = (await import('vitest')).vi
    const spy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: JSON.stringify([{ id: '2027038', title: 'Road salt', agency: 'DE OMB', due_date: '2027-01-05' }]) } as never)
      .mockResolvedValueOnce({ data: JSON.stringify([{ id: '2027038', contract_description: 'Chiller maintenance', agency: 'City of Mesa', due_date: '2027-02-01' }]) } as never)
    try {
      const adapter = getAdapter('state_local')!
      const page0 = await adapter.fetchPage(env({ feeds }), args())
      expect(page0.records).toHaveLength(1)
      expect(page0.records[0].externalId).toBe('delaware:2027038')
      expect(page0.nextPageToken).toBe('1')

      const page1 = await adapter.fetchPage(env({ feeds }), args(page0.nextPageToken))
      expect(page1.records[0].externalId).toBe('mesaaz:2027038')
      expect(page1.records[0].title).toBe('Chiller maintenance')
      expect(page1.nextPageToken).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('a broken feed costs only its own page, not the run', async () => {
    const axios = (await import('axios')).default
    const vi = (await import('vitest')).vi
    const spy = vi.spyOn(axios, 'get').mockRejectedValueOnce(new Error('ECONNREFUSED'))
    try {
      const page0 = await getAdapter('state_local')!.fetchPage(env({ feeds }), args())
      expect(page0.records).toHaveLength(0)
      expect(page0.nextPageToken).toBe('1')
    } finally {
      spy.mockRestore()
    }
  })
})
