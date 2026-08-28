// =============================================================
// mapSetAside coverage — locks in the SAM.gov enum audit (PROMPT §8.1 #8)
// so future edits to the matcher can't silently regress mappings.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'
import { mapSetAside, resolveResponseDeadline, isRetryableSamError, requestSamPage } from './samApi'

vi.mock('axios', () => ({ default: { get: vi.fn() } }))

describe('mapSetAside — SAM.gov code path', () => {
  it.each([
    // Total / partial small business
    ['SBA',      'TOTAL_SMALL_BUSINESS'],
    ['SBP',      'SMALL_BUSINESS'],
    ['RSB',      'SMALL_BUSINESS'],

    // 8(a)
    ['8A',       'SBA_8A'],
    ['8AN',      'SBA_8A'],

    // SDVOSB (set-aside + sole-source)
    ['SDVOSBC',  'SDVOSB'],
    ['SDVOSBS',  'SDVOSB'],

    // VOSB (the previously-missing class — was falling to NONE)
    ['VSA',      'VOSB'],
    ['VSS',      'VOSB'],
    ['VOSB',     'VOSB'],

    // WOSB / EDWOSB
    ['WOSB',     'WOSB'],
    ['WOSBSS',   'WOSB'],
    ['EDWOSB',   'EDWOSB'],
    ['EDWOSBSS', 'EDWOSB'],

    // HUBZone (codes — were falling to NONE before the fix)
    ['HZC',      'HUBZONE'],
    ['HZS',      'HUBZONE'],

    // Indian / Buy Indian
    ['IEE',      'INDIAN'],
    ['BICIV',    'INDIAN'],
    ['ISBEE',    'INDIAN'],
  ])('maps %s -> %s', (code, expected) => {
    expect(mapSetAside(code)).toBe(expected)
  })
})

describe('mapSetAside — descriptive label fallback', () => {
  it.each([
    ['Total Small Business Set-Aside',                    'TOTAL_SMALL_BUSINESS'],
    ['Service-Disabled Veteran-Owned Small Business',     'SDVOSB'],
    ['Veteran-Owned Small Business',                      'VOSB'],
    ['Woman-Owned Small Business',                        'WOSB'],
    ['Economically Disadvantaged Women-Owned',            'EDWOSB'],
    ['HUBZone Set-Aside',                                 'HUBZONE'],
    ['Hub Zone',                                          'HUBZONE'],
    ['8(a) Set-Aside',                                    'SBA_8A'],
    ['Indian Economic Enterprise',                        'INDIAN'],
    ['Native American-Owned',                             'INDIAN'],
    ['Small Business Set-Aside',                          'SMALL_BUSINESS'],
  ])('maps %s -> %s', (label, expected) => {
    expect(mapSetAside(label)).toBe(expected)
  })

  // Specificity — EDWOSB must beat plain WOSB when both substrings are present
  it('prefers EDWOSB over WOSB when label contains both', () => {
    expect(mapSetAside('Economically Disadvantaged Women-Owned Small Business (EDWOSB)')).toBe('EDWOSB')
  })

  // Specificity — SDVOSB must beat plain VOSB
  it('prefers SDVOSB over VOSB when label contains service-disabled', () => {
    expect(mapSetAside('Service-Disabled Veteran-Owned Small Business')).toBe('SDVOSB')
  })
})

describe('mapSetAside — edge cases', () => {
  it('returns NONE for null / undefined / empty', () => {
    expect(mapSetAside(null)).toBe('NONE')
    expect(mapSetAside(undefined)).toBe('NONE')
    expect(mapSetAside('')).toBe('NONE')
  })

  it('returns NONE for unrecognized strings', () => {
    expect(mapSetAside('FULL_AND_OPEN')).toBe('NONE')
    expect(mapSetAside('xyz')).toBe('NONE')
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(mapSetAside(' sba ')).toBe('TOTAL_SMALL_BUSINESS')
    expect(mapSetAside('hzc')).toBe('HUBZONE')
    expect(mapSetAside('8AN')).toBe('SBA_8A')
  })
})

describe('resolveResponseDeadline — no placeholder-now() pollution', () => {
  const now = new Date('2026-07-08T06:00:00.000Z')

  it('uses the real SAM responseDeadLine when present', () => {
    const d = resolveResponseDeadline(
      { responseDeadLine: '2026-08-01T17:00:00.000Z', archiveDate: '2026-08-15' },
      now,
    )
    expect(d.toISOString()).toBe('2026-08-01T17:00:00.000Z')
  })

  it('falls back to archiveDate when responseDeadLine is absent (not now())', () => {
    const d = resolveResponseDeadline(
      { responseDeadLine: null, archiveDate: '2026-08-15T00:00:00.000Z' },
      now,
    )
    expect(d.toISOString()).toBe('2026-08-15T00:00:00.000Z')
    expect(d.getTime()).not.toBe(now.getTime())
  })

  it('falls back to now() only when neither date is present', () => {
    expect(resolveResponseDeadline({}, now).getTime()).toBe(now.getTime())
    expect(
      resolveResponseDeadline({ responseDeadLine: null, archiveDate: null }, now).getTime(),
    ).toBe(now.getTime())
  })
})

describe('isRetryableSamError — quota-safe classification', () => {
  it('retries timeouts, network errors, and 5xx', () => {
    expect(isRetryableSamError({ code: 'ECONNABORTED' })).toBe(true) // client timeout
    expect(isRetryableSamError({ message: 'socket hang up' })).toBe(true) // no response
    expect(isRetryableSamError({ response: { status: 500 } })).toBe(true)
    expect(isRetryableSamError({ response: { status: 503 } })).toBe(true)
  })

  it('does NOT retry 429 (burns the daily quota) or auth/other 4xx', () => {
    expect(isRetryableSamError({ response: { status: 429 } })).toBe(false)
    expect(isRetryableSamError({ response: { status: 401 } })).toBe(false)
    expect(isRetryableSamError({ response: { status: 403 } })).toBe(false)
    expect(isRetryableSamError({ response: { status: 400 } })).toBe(false)
  })
})

describe('requestSamPage — retry/backoff', () => {
  const mockedGet = vi.mocked(axios.get)
  beforeEach(() => mockedGet.mockReset())

  it('returns immediately on success (single call)', async () => {
    mockedGet.mockResolvedValueOnce({ data: { opportunitiesData: [] } } as any)
    const res = await requestSamPage({ offset: 0 }, { baseDelayMs: 0 })
    expect(res).toEqual({ data: { opportunitiesData: [] } })
    expect(mockedGet).toHaveBeenCalledTimes(1)
  })

  it('retries a timeout, then succeeds', async () => {
    const timeout = Object.assign(new Error('timeout of 90000ms exceeded'), { code: 'ECONNABORTED' })
    mockedGet.mockRejectedValueOnce(timeout).mockResolvedValueOnce({ data: { ok: true } } as any)
    const res = await requestSamPage({ offset: 0 }, { baseDelayMs: 0 })
    expect(res).toEqual({ data: { ok: true } })
    expect(mockedGet).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 429 — one call, rethrows to preserve quota messaging', async () => {
    const quota = Object.assign(new Error('rate limited'), { response: { status: 429 } })
    mockedGet.mockRejectedValueOnce(quota)
    await expect(requestSamPage({ offset: 0 }, { baseDelayMs: 0 })).rejects.toThrow('rate limited')
    expect(mockedGet).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxAttempts on persistent 5xx', async () => {
    const err502 = Object.assign(new Error('bad gateway'), { response: { status: 502 } })
    mockedGet
      .mockRejectedValueOnce(err502)
      .mockRejectedValueOnce(err502)
      .mockRejectedValueOnce(err502)
    await expect(
      requestSamPage({ offset: 0 }, { maxAttempts: 3, baseDelayMs: 0 }),
    ).rejects.toThrow('bad gateway')
    expect(mockedGet).toHaveBeenCalledTimes(3)
  })
})
