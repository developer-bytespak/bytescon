// =============================================================
// perDiem service — unit tests (MOCKED axios, no network)
//
// Covers: request URL construction, raw→normalized transform (lodging by
// month, max lodging, M&IE), standard-CONUS / not-found handling, missing-key
// guard, and HTTP/error-body surfacing. The live api.data.gov key is never
// used — config.dataGov.apiKey is mocked and the axios client is replaced.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// config reads process.env at import time; mock it so no real key is needed
// and DATABASE_URL (required()) is never touched.
vi.mock('../config/config', () => ({
  config: {
    dataGov: { apiKey: 'TEST_KEY', gsaBaseUrl: 'https://api.gsa.gov' },
  },
}))

import {
  perDiemService,
  normalizePerDiemResponse,
  buildPerDiemPath,
} from './perDiem'

// Inject a mock axios client in place of the real one (private field), same
// pattern as usaSpending.test.ts.
const get = vi.fn()
;(perDiemService as any).client = { get }

// Confirmed GSA response shape (Albuquerque/NM/2025, abbreviated to 2 months).
const okResponse = {
  data: {
    request: null,
    errors: null,
    rates: [
      {
        oconusInfo: null,
        rate: [
          {
            months: {
              month: [
                { value: 144, number: 1, short: 'Jan', long: 'January' },
                { value: 158, number: 4, short: 'Apr', long: 'April' },
              ],
            },
            meals: 80,
            zip: null,
            county: 'Bernalillo',
            city: 'Albuquerque',
            standardRate: 'false',
          },
        ],
      },
    ],
    state: 'NM',
    year: 2025,
    isOconus: 'false',
  },
}

describe('buildPerDiemPath', () => {
  it('builds the city/state/year path and uppercases + encodes', () => {
    expect(buildPerDiemPath('Albuquerque', 'nm', 2025)).toBe(
      '/travel/perdiem/v2/rates/city/Albuquerque/state/NM/year/2025'
    )
  })

  it('url-encodes multi-word city names', () => {
    expect(buildPerDiemPath('San Diego', 'CA', 2026)).toBe(
      '/travel/perdiem/v2/rates/city/San%20Diego/state/CA/year/2026'
    )
  })
})

describe('normalizePerDiemResponse (pure transform)', () => {
  it('maps lodging by month, max lodging, and M&IE', () => {
    const r = normalizePerDiemResponse(okResponse.data, 'Albuquerque', 'NM', 2025)
    expect(r.city).toBe('Albuquerque')
    expect(r.state).toBe('NM')
    expect(r.year).toBe(2025)
    expect(r.county).toBe('Bernalillo')
    expect(r.isStandardRate).toBe(false)
    expect(r.lodgingByMonth).toEqual([
      { month: 1, short: 'Jan', long: 'January', lodging: 144 },
      { month: 4, short: 'Apr', long: 'April', lodging: 158 },
    ])
    expect(r.maxLodging).toBe(158)
    expect(r.mealsRate).toBe(80)
  })

  it('flags standard CONUS rate when GSA returns an empty rates array', () => {
    const r = normalizePerDiemResponse({ rates: [], errors: null }, 'Nowhere', 'zz', 2025)
    expect(r.isStandardRate).toBe(true)
    expect(r.lodgingByMonth).toEqual([])
    expect(r.maxLodging).toBeNull()
    expect(r.mealsRate).toBeNull()
    expect(r.state).toBe('ZZ')
  })

  it('respects an explicit standardRate="true" entry', () => {
    const raw = {
      rates: [{ rate: [{ months: { month: [] }, meals: 59, standardRate: 'true' }] }],
      state: 'TX',
      year: 2025,
    }
    const r = normalizePerDiemResponse(raw, 'Somewhere', 'TX', 2025)
    expect(r.isStandardRate).toBe(true)
    expect(r.mealsRate).toBe(59)
  })
})

describe('perDiemService.getPerDiemRates (mocked axios)', () => {
  beforeEach(() => get.mockReset())

  it('calls the correct path with api_key and normalizes the response', async () => {
    get.mockResolvedValueOnce(okResponse)
    const r = await perDiemService.getPerDiemRates('Albuquerque', 'NM', 2025)

    expect(get).toHaveBeenCalledTimes(1)
    const [calledPath, calledOpts] = get.mock.calls[0]
    expect(calledPath).toBe('/travel/perdiem/v2/rates/city/Albuquerque/state/NM/year/2025')
    expect(calledOpts).toEqual({ params: { api_key: 'TEST_KEY' } })

    expect(r.maxLodging).toBe(158)
    expect(r.mealsRate).toBe(80)
    expect(r.isStandardRate).toBe(false)
  })

  it('returns a standard-rate result when GSA has no city-specific rate', async () => {
    get.mockResolvedValueOnce({ data: { rates: [], errors: null } })
    const r = await perDiemService.getPerDiemRates('Nowheresville', 'ZZ', 2025)
    expect(r.isStandardRate).toBe(true)
    expect(r.maxLodging).toBeNull()
  })

  it('throws when both city and state are not provided', async () => {
    await expect(perDiemService.getPerDiemRates('', 'NM', 2025)).rejects.toThrow(/city and state/i)
    expect(get).not.toHaveBeenCalled()
  })

  it('surfaces an HTTP error', async () => {
    get.mockRejectedValueOnce({ response: { status: 403, data: { error: { message: 'OVER_RATE_LIMIT' } } } })
    await expect(perDiemService.getPerDiemRates('Albuquerque', 'NM', 2025)).rejects.toThrow(
      /HTTP 403.*OVER_RATE_LIMIT/
    )
  })

  it('surfaces a 200-with-errors body', async () => {
    get.mockResolvedValueOnce({ data: { rates: [], errors: 'Invalid year' } })
    await expect(perDiemService.getPerDiemRates('Albuquerque', 'NM', 2025)).rejects.toThrow(
      /Per Diem: Invalid year/
    )
  })
})
