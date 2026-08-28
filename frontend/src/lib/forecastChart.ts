// Defensive transforms for the revenue forecast chart (Section 4 #9).
//
// The chart previously fed the raw API array straight into Recharts and
// formatted the X axis with `period.split('-')[0].slice(2)`. A missing or
// malformed `period` (invalid/absent date) threw inside the tick formatter and
// took down the whole Analytics page. These pure helpers normalize the data and
// format labels safely, and are unit-tested independently of Recharts.

export interface ForecastMonth {
  period: string
  expected: number
  p10: number
  p50: number
  p90: number
  opportunityCount: number
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const safeNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Coerce the API payload into a clean, chart-safe array: drop non-array input,
 * skip entries without a valid YYYY-MM period, and force every metric to a
 * finite number (null/undefined/NaN → 0). Never throws.
 */
export function normalizeForecast(data?: ForecastMonth[] | null): ForecastMonth[] {
  if (!Array.isArray(data)) return []
  return data
    .filter((m) => m && typeof m.period === 'string' && PERIOD_RE.test(m.period))
    .map((m) => ({
      period: m.period,
      expected: safeNum(m.expected),
      p10: safeNum(m.p10),
      p50: safeNum(m.p50),
      p90: safeNum(m.p90),
      opportunityCount: safeNum(m.opportunityCount),
    }))
}

/**
 * True when there is at least one month with a positive projected value. An
 * all-zero series is technically renderable but reads as a broken/flat chart,
 * so callers show an explanatory empty state instead.
 */
export function hasRenderableForecast(data: ForecastMonth[]): boolean {
  return data.some((m) => m.expected > 0 || m.p10 > 0 || m.p50 > 0 || m.p90 > 0)
}

/** Format a YYYY-MM period as "Mon YY"; returns the raw value if malformed. */
export function formatPeriodLabel(period: unknown): string {
  if (typeof period !== 'string' || !PERIOD_RE.test(period)) return String(period ?? '')
  const [year, month] = period.split('-')
  return `${MONTHS[parseInt(month, 10) - 1]} ${year.slice(2)}`
}
