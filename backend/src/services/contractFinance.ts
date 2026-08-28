// =============================================================
// Contract finance calculations (Section 5 Module 9)
//
// The BACKEND is the authoritative source for every financial figure. All money
// math uses Prisma.Decimal (decimal.js) — never JS floating point. Pure +
// clock-injected so funding totals, expenditure recognition, burn, and depletion
// are deterministically unit-testable.
//
// Documented formulas:
//   fundedTotal          = Σ funding_transactions.amount WHERE NOT isVoided
//   recognizedExpended   = Σ approved TimeEntry.billingAmount + Σ approved ContractCost.amount
//   remainingFunded      = fundedTotal − recognizedExpended
//   remainingCeiling     = ceiling − recognizedExpended
//   fundedPct            = clamp( recognizedExpended / fundedTotal , 0..1 )
//   burnRatePerDay       = recognizedExpended / spanDays   (span = earliest expenditure → now)
//   estimatedDepletion   = now + (remainingFunded / burnRatePerDay) days
//     — suppressed unless: expended>0, spanDays>=MIN_SPAN, burn>0, remainingFunded>0, dates valid
// =============================================================
import { Prisma } from '@prisma/client'

type Dec = Prisma.Decimal
export const D = (v: Prisma.Decimal | number | string | null | undefined): Dec => new Prisma.Decimal(v ?? 0)
const DAY_MS = 24 * 60 * 60 * 1000
const MIN_SPAN_DAYS = 7 // burn rate below this window is too noisy to project from

/** Round a Decimal to 2 dp (money) — explicit rounding at the boundary only. */
export const money2 = (d: Dec): Dec => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)

export function sumFunding(txns: Array<{ amount: Prisma.Decimal | number; isVoided: boolean }>): Dec {
  return txns.filter((t) => !t.isVoided).reduce((s, t) => s.plus(D(t.amount)), D(0))
}

export function recognizedExpenditure(
  approvedTime: Array<{ billingAmount: Prisma.Decimal | number | string | null }>,
  approvedCosts: Array<{ amount: Prisma.Decimal | number | string }>,
): Dec {
  const labor = approvedTime.reduce((s, t) => s.plus(D(t.billingAmount)), D(0))
  const costs = approvedCosts.reduce((s, c) => s.plus(D(c.amount)), D(0))
  return money2(labor.plus(costs))
}

/** billing/cost amount = hours × rate, decimal-safe, rounded to cents. */
export function lineAmount(hours: Prisma.Decimal | number | string, rate: Prisma.Decimal | number | string | null | undefined): Dec | null {
  if (rate == null) return null
  return money2(D(hours).times(D(rate)))
}

export interface RateLike {
  categoryName: string
  rateType: string
  billingRate: Prisma.Decimal | number | null
  costRate: Prisma.Decimal | number | null
  effectiveStart: Date | null
  effectiveEnd: Date | null
  isActive: boolean
}

/** Pick the rate whose effective window contains workDate for the category. */
export function rateForWorkDate(rates: RateLike[], categoryName: string, workDate: Date, rateType = 'BILLING'): RateLike | null {
  const t = workDate.getTime()
  const matches = rates.filter(
    (r) =>
      r.isActive &&
      r.categoryName === categoryName &&
      r.rateType === rateType &&
      (r.effectiveStart == null || r.effectiveStart.getTime() <= t) &&
      (r.effectiveEnd == null || r.effectiveEnd.getTime() >= t),
  )
  if (matches.length === 0) return null
  // Prefer the most specific (latest-starting) effective window.
  return matches.sort((a, b) => (b.effectiveStart?.getTime() ?? 0) - (a.effectiveStart?.getTime() ?? 0))[0]
}

/** True when two effective windows overlap (open-ended = infinite). */
export function periodsOverlap(aStart: Date | null, aEnd: Date | null, bStart: Date | null, bEnd: Date | null): boolean {
  const aS = aStart?.getTime() ?? -Infinity
  const aE = aEnd?.getTime() ?? Infinity
  const bS = bStart?.getTime() ?? -Infinity
  const bE = bEnd?.getTime() ?? Infinity
  return aS <= bE && bS <= aE
}

export type FinancialWarning = 'NONE' | 'FUNDING_LOW' | 'CEILING_LOW' | 'DEPLETION_BEFORE_END'

export interface BurnInput {
  funded: Dec
  ceiling: Dec | null
  expended: Dec
  expenditureDates: Date[] // dates of recognized expenditure events (approved)
  now: Date
  endDate: Date | null
  fundingLowThresholdPct?: number // default 0.9
}

export interface BurnResult {
  funded: string
  ceiling: string | null
  expended: string
  remainingFunded: string
  remainingCeiling: string | null
  fundedPct: number
  expendedPct: number
  burnRatePerDay: string | null
  avgMonthlyBurn: string | null
  estimatedDepletionDate: string | null
  depletionBeforeEnd: boolean | null
  insufficientData: boolean
  reason: string | null
  warning: FinancialWarning
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export function computeBurn(input: BurnInput): BurnResult {
  const { funded, ceiling, expended, expenditureDates, now, endDate } = input
  const remainingFunded = funded.minus(expended)
  const remainingCeiling = ceiling ? ceiling.minus(expended) : null
  const expendedPct = funded.gt(0) ? clamp01(Number(expended.div(funded))) : 0
  const fundedPct = expendedPct

  // Burn requires ≥1 expenditure event and a span of at least MIN_SPAN_DAYS.
  let burnRatePerDay: Dec | null = null
  let avgMonthlyBurn: Dec | null = null
  let estimatedDepletionDate: Date | null = null
  let depletionBeforeEnd: boolean | null = null
  let insufficientData = false
  let reason: string | null = null

  if (expenditureDates.length === 0 || expended.lte(0)) {
    insufficientData = true
    reason = 'No recognized expenditure yet'
  } else {
    const earliest = Math.min(...expenditureDates.map((d) => d.getTime()))
    const spanDays = (now.getTime() - earliest) / DAY_MS
    if (!Number.isFinite(spanDays) || spanDays < MIN_SPAN_DAYS) {
      insufficientData = true
      reason = `Expenditure history too short (< ${MIN_SPAN_DAYS} days) to project a burn rate`
    } else {
      burnRatePerDay = money2(expended.div(D(spanDays)))
      avgMonthlyBurn = money2(burnRatePerDay.times(30))
      if (burnRatePerDay.gt(0) && remainingFunded.gt(0)) {
        const daysLeft = Number(remainingFunded.div(burnRatePerDay))
        if (Number.isFinite(daysLeft)) {
          estimatedDepletionDate = new Date(now.getTime() + daysLeft * DAY_MS)
          if (endDate) depletionBeforeEnd = estimatedDepletionDate.getTime() < endDate.getTime()
        }
      } else if (remainingFunded.lte(0)) {
        reason = 'Funded amount already fully expended'
      }
    }
  }

  const lowPct = input.fundingLowThresholdPct ?? 0.9
  let warning: FinancialWarning = 'NONE'
  if (depletionBeforeEnd) warning = 'DEPLETION_BEFORE_END'
  else if (remainingCeiling && ceiling && ceiling.gt(0) && Number(expended.div(ceiling)) >= lowPct) warning = 'CEILING_LOW'
  else if (funded.gt(0) && expendedPct >= lowPct) warning = 'FUNDING_LOW'

  return {
    funded: funded.toFixed(2),
    ceiling: ceiling ? ceiling.toFixed(2) : null,
    expended: expended.toFixed(2),
    remainingFunded: remainingFunded.toFixed(2),
    remainingCeiling: remainingCeiling ? remainingCeiling.toFixed(2) : null,
    fundedPct: Math.round(fundedPct * 1000) / 1000,
    expendedPct: Math.round(expendedPct * 1000) / 1000,
    burnRatePerDay: burnRatePerDay ? burnRatePerDay.toFixed(2) : null,
    avgMonthlyBurn: avgMonthlyBurn ? avgMonthlyBurn.toFixed(2) : null,
    estimatedDepletionDate: estimatedDepletionDate ? estimatedDepletionDate.toISOString() : null,
    depletionBeforeEnd,
    insufficientData,
    reason,
    warning,
  }
}

// ---- Receivables ageing (from unpaid invoice balances) ----
export interface AgingInvoice { dueDate: Date | null; outstanding: Dec }
export interface AgingBuckets {
  current: string; d1_30: string; d31_60: string; d61_90: string; d90plus: string; totalOutstanding: string
  // §7.8 split the old open-ended 90+ bucket. `d90plus` is retained and still
  // equals d91_120 + d120plus, so every existing caller keeps working.
  d91_120: string; d120plus: string
}

/** The one place ageing boundaries are defined. */
export type AgingBucketKey = 'CURRENT' | 'D1_30' | 'D31_60' | 'D61_90' | 'D91_120' | 'D120_PLUS'

/** Whole days a balance is past due. Zero or negative means not yet due. */
export function overdueDays(dueDate: Date | null, now: Date): number {
  if (!dueDate) return 0
  return Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS)
}

/**
 * Which bucket a given overdue age falls in.
 *
 * Boundaries are inclusive at the top of each band: exactly 30 days overdue is
 * 1–30, and 31 is the next band. Centralised so the backend, the agent and the
 * UI can never disagree about what "60 days" means.
 */
export function agingBucketFor(days: number): AgingBucketKey {
  if (days <= 0) return 'CURRENT'
  if (days <= 30) return 'D1_30'
  if (days <= 60) return 'D31_60'
  if (days <= 90) return 'D61_90'
  if (days <= 120) return 'D91_120'
  return 'D120_PLUS'
}

export function receivablesAging(invoices: AgingInvoice[], now: Date): AgingBuckets {
  const b = { current: D(0), d1_30: D(0), d31_60: D(0), d61_90: D(0), d91_120: D(0), d120plus: D(0), total: D(0) }
  for (const inv of invoices) {
    if (inv.outstanding.lte(0)) continue
    b.total = b.total.plus(inv.outstanding)
    switch (agingBucketFor(overdueDays(inv.dueDate, now))) {
      case 'CURRENT': b.current = b.current.plus(inv.outstanding); break
      case 'D1_30': b.d1_30 = b.d1_30.plus(inv.outstanding); break
      case 'D31_60': b.d31_60 = b.d31_60.plus(inv.outstanding); break
      case 'D61_90': b.d61_90 = b.d61_90.plus(inv.outstanding); break
      case 'D91_120': b.d91_120 = b.d91_120.plus(inv.outstanding); break
      default: b.d120plus = b.d120plus.plus(inv.outstanding)
    }
  }
  return {
    current: b.current.toFixed(2), d1_30: b.d1_30.toFixed(2), d31_60: b.d31_60.toFixed(2),
    d61_90: b.d61_90.toFixed(2), d91_120: b.d91_120.toFixed(2), d120plus: b.d120plus.toFixed(2),
    d90plus: b.d91_120.plus(b.d120plus).toFixed(2), totalOutstanding: b.total.toFixed(2),
  }
}

/** Rate variance vs an expected baseline, explainable. */
export function rateVariance(applied: Prisma.Decimal | number, expected: Prisma.Decimal | number | null): {
  applied: string; expected: string | null; difference: string | null; variancePct: number | null; severity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH'
} {
  if (expected == null) return { applied: D(applied).toFixed(4), expected: null, difference: null, variancePct: null, severity: 'NONE' }
  const diff = D(applied).minus(D(expected))
  const pct = D(expected).eq(0) ? null : Number(diff.div(D(expected))) * 100
  const abs = pct == null ? 0 : Math.abs(pct)
  const severity = abs === 0 ? 'NONE' : abs < 5 ? 'LOW' : abs < 15 ? 'MEDIUM' : 'HIGH'
  return { applied: D(applied).toFixed(4), expected: D(expected).toFixed(4), difference: diff.toFixed(4), variancePct: pct == null ? null : Math.round(pct * 100) / 100, severity }
}
