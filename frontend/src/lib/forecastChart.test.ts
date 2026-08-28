// =============================================================
// Section 4 #9 — forecast data transforms must be total: never throw on
// malformed/partial/empty input, and cleanly signal the all-zero case.
// =============================================================
import { describe, it, expect } from 'vitest'
import { normalizeForecast, hasRenderableForecast, formatPeriodLabel, type ForecastMonth } from './forecastChart'

const month = (over: Partial<ForecastMonth>): ForecastMonth => ({
  period: '2026-08', expected: 0, p10: 0, p50: 0, p90: 0, opportunityCount: 0, ...over,
})

describe('normalizeForecast', () => {
  it('returns [] for non-array / null / undefined input', () => {
    expect(normalizeForecast(undefined)).toEqual([])
    expect(normalizeForecast(null)).toEqual([])
    expect(normalizeForecast('nope' as unknown as ForecastMonth[])).toEqual([])
  })

  it('drops entries with a missing or malformed period', () => {
    const out = normalizeForecast([
      month({ period: '2026-08', expected: 100 }),
      month({ period: 'garbage', expected: 200 }),
      month({ period: '2026-13', expected: 300 }), // invalid month
      { expected: 400 } as unknown as ForecastMonth, // no period
    ])
    expect(out.map((m) => m.period)).toEqual(['2026-08'])
  })

  it('coerces null/undefined/NaN metrics to 0 (no NaN reaches the chart)', () => {
    const out = normalizeForecast([
      month({ period: '2026-08', expected: NaN, p10: undefined as unknown as number, p90: null as unknown as number }),
    ])
    expect(out[0]).toMatchObject({ expected: 0, p10: 0, p90: 0 })
    expect(Number.isNaN(out[0].expected)).toBe(false)
  })
})

describe('hasRenderableForecast', () => {
  it('false for empty or all-zero series', () => {
    expect(hasRenderableForecast([])).toBe(false)
    expect(hasRenderableForecast([month({}), month({ period: '2026-09' })])).toBe(false)
  })
  it('true when any month has a positive value', () => {
    expect(hasRenderableForecast([month({}), month({ period: '2026-09', p90: 50 })])).toBe(true)
  })
})

describe('formatPeriodLabel', () => {
  it('formats a valid YYYY-MM as "Mon YY"', () => {
    expect(formatPeriodLabel('2026-08')).toBe('Aug 26')
    expect(formatPeriodLabel('2026-01')).toBe('Jan 26')
  })
  it('never throws on malformed input', () => {
    expect(() => formatPeriodLabel(undefined)).not.toThrow()
    expect(() => formatPeriodLabel('')).not.toThrow()
    expect(formatPeriodLabel('bad')).toBe('bad')
  })
})
