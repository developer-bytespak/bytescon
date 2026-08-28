// =============================================================
// laborRates service — unit tests (MOCKED axios, no network)
//
// Covers: request param construction (page/page_size/keyword + optional
// api_key), OpenSearch hits.hits[]._source → normalized transform,
// hits.total {value,relation} handling, price summary, keyword guard, and
// HTTP error surfacing. No live api.gsa.gov call.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../config/config', () => ({
  config: {
    dataGov: { apiKey: 'TEST_KEY', gsaBaseUrl: 'https://api.gsa.gov' },
  },
}))

import {
  laborRatesService,
  normalizeLaborRatesResponse,
  mapLaborRateSource,
  summarizeLaborRates,
} from './laborRates'

const get = vi.fn()
;(laborRatesService as any).client = { get }

// Confirmed OpenSearch-shaped CALC v3 response (abbreviated).
const source = (over: Record<string, unknown> = {}) => ({
  vendor_name: 'T47 INTERNATIONAL, INC.',
  labor_category: 'Program Manager',
  current_price: 100,
  next_year_price: 102.5,
  second_year_price: 105,
  min_years_experience: 5,
  education_level: 'Bachelors',
  security_clearance: false,
  idv_piid: '47QRAA22D004N',
  schedule: 'MAS',
  business_size: 'S',
  worksite: 'Customer_Facility',
  contract_start: '2022-01-18',
  contract_end: '2027-01-17',
  ...over,
})

const okResponse = {
  data: {
    took: 5,
    hits: {
      total: { value: 8765, relation: 'eq' },
      hits: [
        { _id: '1', _source: source({ current_price: 100 }) },
        { _id: '2', _source: source({ labor_category: 'Sr PM', current_price: 200 }) },
        { _id: '3', _source: source({ labor_category: 'Jr PM', current_price: 150 }) },
      ],
    },
  },
}

describe('mapLaborRateSource', () => {
  it('maps a full _source record', () => {
    const r = mapLaborRateSource(source())!
    expect(r.laborCategory).toBe('Program Manager')
    expect(r.currentPrice).toBe(100)
    expect(r.nextYearPrice).toBe(102.5)
    expect(r.minYearsExperience).toBe(5)
    expect(r.securityClearance).toBe(false)
    expect(r.idvPiid).toBe('47QRAA22D004N')
  })

  it('drops a record with no usable current_price', () => {
    expect(mapLaborRateSource(source({ current_price: null }))).toBeNull()
    expect(mapLaborRateSource(source({ current_price: 'n/a' }))).toBeNull()
  })
})

describe('summarizeLaborRates', () => {
  it('computes min/max/avg/median', () => {
    const s = summarizeLaborRates([
      mapLaborRateSource(source({ current_price: 100 }))!,
      mapLaborRateSource(source({ current_price: 200 }))!,
      mapLaborRateSource(source({ current_price: 150 }))!,
    ])!
    expect(s.count).toBe(3)
    expect(s.minPrice).toBe(100)
    expect(s.maxPrice).toBe(200)
    expect(s.avgPrice).toBeCloseTo(150, 6)
    expect(s.medianPrice).toBe(150)
  })

  it('returns null for an empty set', () => {
    expect(summarizeLaborRates([])).toBeNull()
  })
})

describe('normalizeLaborRatesResponse', () => {
  it('reads hits.hits[]._source and hits.total.value', () => {
    const r = normalizeLaborRatesResponse(okResponse.data, 'program manager', 1, 20)
    expect(r.total).toBe(8765)
    expect(r.rates).toHaveLength(3)
    expect(r.summary!.minPrice).toBe(100)
    expect(r.summary!.maxPrice).toBe(200)
  })

  it('tolerates a numeric hits.total and empty hits', () => {
    const r = normalizeLaborRatesResponse({ hits: { total: 0, hits: [] } }, 'x', 1, 20)
    expect(r.total).toBe(0)
    expect(r.rates).toEqual([])
    expect(r.summary).toBeNull()
  })
})

describe('laborRatesService.getLaborRates (mocked axios)', () => {
  beforeEach(() => get.mockReset())

  it('calls the v3 ceilingrates path with page/page_size/keyword + api_key', async () => {
    get.mockResolvedValueOnce(okResponse)
    const r = await laborRatesService.getLaborRates({ keyword: 'program manager', pageSize: 10 })

    const [path, opts] = get.mock.calls[0]
    expect(path).toBe('/acquisition/calc/v3/api/ceilingrates/')
    expect(opts.params).toEqual({
      page: 1,
      page_size: 10,
      keyword: 'program manager',
      api_key: 'TEST_KEY',
    })
    expect(r.rates).toHaveLength(3)
    expect(r.total).toBe(8765)
  })

  it('clamps page_size to 100 and defaults page to 1', async () => {
    get.mockResolvedValueOnce(okResponse)
    await laborRatesService.getLaborRates({ keyword: 'engineer', pageSize: 9999 })
    expect(get.mock.calls[0][1].params.page_size).toBe(100)
    expect(get.mock.calls[0][1].params.page).toBe(1)
  })

  it('throws when no keyword is given', async () => {
    await expect(laborRatesService.getLaborRates({ keyword: '  ' })).rejects.toThrow(/keyword/i)
    expect(get).not.toHaveBeenCalled()
  })

  it('surfaces an HTTP error', async () => {
    get.mockRejectedValueOnce({ response: { status: 500, data: { error: { message: 'boom' } } } })
    await expect(laborRatesService.getLaborRates({ keyword: 'engineer' })).rejects.toThrow(
      /HTTP 500.*boom/
    )
  })
})
