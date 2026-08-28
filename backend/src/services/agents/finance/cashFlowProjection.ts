// =============================================================
// §7.8 — Cash flow projection.
//
// TWO THINGS THIS MODULE REFUSES TO DO
// ------------------------------------------------------------
// 1. It never reports a "cash position". The platform stores no opening cash
//    balance anywhere — there is no bank account model and no cash-on-hand
//    field. Net flow can be computed from real records; an ending balance
//    cannot, and inventing an opening balance to produce one would be a
//    fabricated number in a financial report.
//
// 2. It never mixes pipeline expected value with contracted receivables.
//    `revenueForecaster.forecastRevenue` is a Monte Carlo over UNAWARDED
//    opportunities weighted by win probability — it was built for pipeline
//    revenue, not invoice collection timing, so it is reused ONLY for the
//    separately labelled PIPELINE_EXPECTED_VALUE class and never folded into
//    money a customer already owes.
//
// Everything contracted is deterministic: real invoices, real outstanding
// balances, real due dates, real approved costs.
// =============================================================
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { D, money2 } from '../../contractFinance'

export const CASHFLOW_METHOD_VERSION = 'finance-cashflow-v1'

/** Default look-ahead. Long enough to be useful, short enough to be defensible. */
export const DEFAULT_HORIZON_MONTHS = 6

/**
 * Paid invoices needed before payment timing is modelled statistically.
 *
 * Below this, the projection places a receivable on its due date and says so,
 * rather than inventing a collection lag from two data points.
 */
export const MIN_PAYMENTS_FOR_TIMING = 6

/** Paid invoices needed before a confidence band is offered at all. */
export const MIN_PAYMENTS_FOR_BANDS = 10

/**
 * Every amount is tagged with what kind of money it is. A reader must never
 * have to guess whether a figure is owed, expected, or merely hoped for.
 */
export type CashFlowSourceClass =
  /** An invoice already sent to the customer with a balance outstanding. */
  | 'CONTRACTED_RECEIVABLE'
  /** Approved but not yet invoiced work — contracted, not yet billed. */
  | 'CONTRACTED_EXPECTED_BILLING'
  /** Approved costs the firm has incurred and expects to pay out. */
  | 'KNOWN_COST'
  /** Unawarded pipeline, probability-weighted. Not owed to anyone. */
  | 'PIPELINE_EXPECTED_VALUE'

export interface CashFlowLine {
  sourceClass: CashFlowSourceClass
  direction: 'RECEIPT' | 'DISBURSEMENT'
  amount: string
  expectedDate: string
  reference: string
  sourceId: string | null
  /** True when the date is a real recorded date rather than an estimate. */
  dateIsRecorded: boolean
}

export interface CashFlowInputs {
  /** Live receivables: submitted or partially paid, with a balance. */
  outstandingInvoices: Array<{
    id: string
    invoiceNumber: string
    total: Prisma.Decimal
    amountPaid: Prisma.Decimal
    dueDate: Date | null
    invoiceDate: Date | null
    status: string
  }>
  /** Approved, uninvoiced work — contracted revenue not yet billed. */
  unbilledApproved: Array<{ contractId: string; amount: Prisma.Decimal }>
  /** Approved costs not yet settled. */
  knownCosts: Array<{ id: string; amount: Prisma.Decimal; incurredDate: Date | null; category: string }>
  /** Historical lag, in days, between invoice due date and payment received. */
  historicalPaymentLagDays: number[]
  /** Probability-weighted pipeline, already computed by revenueForecaster. */
  pipelineByMonth: Array<{ month: string; expectedValue: number }>
  now: Date
  horizonMonths: number
}

export interface CashFlowResult {
  methodVersion: string
  periodStart: string
  periodEnd: string
  horizonMonths: number
  projectedReceipts: string
  projectedDisbursements: string
  netCashFlow: string
  /**
   * Deliberately NOT "cash position". With no opening balance recorded, a net
   * flow is the only honest headline.
   */
  netCashFlowLabel: string
  confidenceLower: string | null
  confidenceUpper: string | null
  confidenceState: 'BANDED' | 'DETERMINISTIC_ONLY' | 'INSUFFICIENT_DATA'
  sourceBreakdown: Record<CashFlowSourceClass, { receipts: string; disbursements: string; count: number }>
  lines: CashFlowLine[]
  paymentTiming: {
    sampleSize: number
    medianLagDays: number | null
    modelled: boolean
    detail: string
  }
  openingCashBalanceAvailable: false
  dataSufficiency: 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT_DATA'
  inputHash: string
  limitations: string[]
}

/** The one phrase permitted for a negative result, per §7.8. */
export const NEGATIVE_NET_FLOW_STATE = 'PROJECTED_NEGATIVE_NET_CASH_FLOW'
export const POSITIVE_NET_FLOW_STATE = 'PROJECTED_POSITIVE_NET_CASH_FLOW'

export const NO_OPENING_BALANCE_LIMITATION =
  'The platform records no opening cash balance, so this is a projection of NET CASH FLOW, not a cash position. An ending balance cannot be derived without knowing what the firm starts with.'

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000)

const emptyBucket = () => ({ receipts: D(0), disbursements: D(0), count: 0 })

/**
 * Project cash movement.
 *
 * Pure and deterministic: the same inputs always produce the same hash, the
 * same amounts and the same bands. There is no randomness anywhere in the
 * contracted path.
 */
export function projectCashFlow(input: CashFlowInputs): CashFlowResult {
  const limitations: string[] = [NO_OPENING_BALANCE_LIMITATION]
  const lines: CashFlowLine[] = []
  const horizonEnd = new Date(Date.UTC(
    input.now.getUTCFullYear(),
    input.now.getUTCMonth() + input.horizonMonths,
    input.now.getUTCDate(),
  ))

  // ---- payment timing -----------------------------------------------------
  const lagSample = input.historicalPaymentLagDays
  const medianLag = median(lagSample)
  const timingModelled = lagSample.length >= MIN_PAYMENTS_FOR_TIMING && medianLag !== null
  const appliedLag = timingModelled ? medianLag! : 0

  if (!timingModelled) {
    limitations.push(
      `Only ${lagSample.length} settled invoice(s) are available, below the ${MIN_PAYMENTS_FOR_TIMING} needed to model collection timing. Receivables are projected on their due date with no collection lag applied.`,
    )
  }

  // ---- contracted receivables --------------------------------------------
  for (const inv of input.outstandingInvoices) {
    const outstanding = D(inv.total).minus(D(inv.amountPaid))
    if (outstanding.lte(0)) continue
    const base = inv.dueDate ?? inv.invoiceDate
    if (!base) {
      limitations.push(`Invoice ${inv.invoiceNumber} has neither a due date nor an invoice date, so it cannot be placed on the timeline and is excluded from the projection.`)
      continue
    }
    const expected = addDays(base, appliedLag)
    if (expected > horizonEnd) continue
    lines.push({
      sourceClass: 'CONTRACTED_RECEIVABLE',
      direction: 'RECEIPT',
      amount: outstanding.toFixed(2),
      expectedDate: expected.toISOString(),
      reference: `Invoice ${inv.invoiceNumber}`,
      sourceId: inv.id,
      dateIsRecorded: inv.dueDate != null && appliedLag === 0,
    })
  }

  // ---- contracted but not yet billed --------------------------------------
  for (const u of input.unbilledApproved) {
    if (D(u.amount).lte(0)) continue
    // Billed at the end of the current month, then collected after the lag.
    const billing = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth() + 1, 0))
    const expected = addDays(billing, appliedLag)
    if (expected > horizonEnd) continue
    lines.push({
      sourceClass: 'CONTRACTED_EXPECTED_BILLING',
      direction: 'RECEIPT',
      amount: D(u.amount).toFixed(2),
      expectedDate: expected.toISOString(),
      reference: `Approved uninvoiced work on contract ${u.contractId}`,
      sourceId: u.contractId,
      dateIsRecorded: false,
    })
  }

  // ---- known costs ---------------------------------------------------------
  for (const c of input.knownCosts) {
    if (D(c.amount).lte(0)) continue
    const expected = c.incurredDate ?? input.now
    if (expected > horizonEnd) continue
    lines.push({
      sourceClass: 'KNOWN_COST',
      direction: 'DISBURSEMENT',
      amount: D(c.amount).toFixed(2),
      expectedDate: expected.toISOString(),
      reference: `Approved ${c.category} cost`,
      sourceId: c.id,
      dateIsRecorded: c.incurredDate != null,
    })
  }

  // ---- pipeline, kept strictly apart --------------------------------------
  for (const p of input.pipelineByMonth) {
    if (!(p.expectedValue > 0)) continue
    const monthDate = new Date(`${p.month}-01T00:00:00.000Z`)
    if (Number.isNaN(monthDate.getTime()) || monthDate > horizonEnd) continue
    lines.push({
      sourceClass: 'PIPELINE_EXPECTED_VALUE',
      direction: 'RECEIPT',
      // Pipeline arrives from a probabilistic model, so it is rounded to cents
      // once here and never treated as an authoritative receivable.
      amount: money2(D(p.expectedValue)).toFixed(2),
      expectedDate: monthDate.toISOString(),
      reference: `Probability-weighted pipeline for ${p.month} — not contracted, not owed`,
      sourceId: null,
      dateIsRecorded: false,
    })
  }

  // ---- totals --------------------------------------------------------------
  const breakdown: Record<CashFlowSourceClass, ReturnType<typeof emptyBucket>> = {
    CONTRACTED_RECEIVABLE: emptyBucket(),
    CONTRACTED_EXPECTED_BILLING: emptyBucket(),
    KNOWN_COST: emptyBucket(),
    PIPELINE_EXPECTED_VALUE: emptyBucket(),
  }
  for (const l of lines) {
    const b = breakdown[l.sourceClass]
    b.count += 1
    if (l.direction === 'RECEIPT') b.receipts = b.receipts.plus(D(l.amount))
    else b.disbursements = b.disbursements.plus(D(l.amount))
  }

  // Headline receipts are CONTRACTED ONLY. Pipeline is reported in the
  // breakdown so a reader can see it, but it never inflates the net figure a
  // person would plan cash against.
  const contractedReceipts = breakdown.CONTRACTED_RECEIVABLE.receipts.plus(breakdown.CONTRACTED_EXPECTED_BILLING.receipts)
  const disbursements = breakdown.KNOWN_COST.disbursements
  const net = contractedReceipts.minus(disbursements)

  if (breakdown.PIPELINE_EXPECTED_VALUE.receipts.gt(0)) {
    limitations.push(
      `Pipeline expected value of $${breakdown.PIPELINE_EXPECTED_VALUE.receipts.toFixed(2)} is shown separately and is EXCLUDED from projected receipts and net cash flow. It is probability-weighted value from unawarded opportunities, not money any customer owes.`,
    )
  }

  // ---- confidence ----------------------------------------------------------
  let confidenceState: CashFlowResult['confidenceState'] = 'INSUFFICIENT_DATA'
  let lower: Prisma.Decimal | null = null
  let upper: Prisma.Decimal | null = null

  if (lines.length === 0) {
    limitations.push('No invoices, approved costs or unbilled work fall within the horizon, so there is nothing to project.')
  } else if (lagSample.length >= MIN_PAYMENTS_FOR_BANDS && medianLag !== null) {
    // Band from the observed spread of collection lag, applied to the receipts
    // that are actually subject to it. Deterministic — no simulation.
    const sorted = [...lagSample].sort((a, b) => a - b)
    const p10 = sorted[Math.floor(sorted.length * 0.1)]
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
    const spread = Math.max(0, p90 - p10)
    // A wider collection spread means more of the horizon's receipts may land
    // outside it. Expressed as a proportion of a 30-day month, capped at 100%.
    const atRisk = Math.min(1, spread / 30)
    const swing = money2(contractedReceipts.times(atRisk).div(2))
    lower = money2(net.minus(swing))
    upper = money2(net.plus(swing))
    confidenceState = 'BANDED'
  } else {
    confidenceState = 'DETERMINISTIC_ONLY'
    limitations.push(
      `Confidence bands need at least ${MIN_PAYMENTS_FOR_BANDS} settled invoices to measure collection spread; ${lagSample.length} are available. Deterministic amounts are reported without a band rather than with an invented one.`,
    )
  }

  const dataSufficiency = lines.length === 0
    ? 'INSUFFICIENT_DATA'
    : confidenceState === 'BANDED' ? 'SUFFICIENT' : 'PARTIAL'

  // ---- hash ----------------------------------------------------------------
  const material = {
    horizon: input.horizonMonths,
    lag: appliedLag,
    sample: lagSample.length,
    lines: lines
      .map((l) => `${l.sourceClass}:${l.direction}:${l.amount}:${l.expectedDate}:${l.sourceId ?? ''}`)
      .sort(),
  }
  const inputHash = createHash('sha256').update(JSON.stringify(material)).digest('hex')

  const fmt = (b: ReturnType<typeof emptyBucket>) => ({
    receipts: b.receipts.toFixed(2),
    disbursements: b.disbursements.toFixed(2),
    count: b.count,
  })

  return {
    methodVersion: CASHFLOW_METHOD_VERSION,
    periodStart: input.now.toISOString(),
    periodEnd: horizonEnd.toISOString(),
    horizonMonths: input.horizonMonths,
    projectedReceipts: contractedReceipts.toFixed(2),
    projectedDisbursements: disbursements.toFixed(2),
    netCashFlow: net.toFixed(2),
    netCashFlowLabel: net.lt(0) ? NEGATIVE_NET_FLOW_STATE : POSITIVE_NET_FLOW_STATE,
    confidenceLower: lower ? lower.toFixed(2) : null,
    confidenceUpper: upper ? upper.toFixed(2) : null,
    confidenceState,
    sourceBreakdown: {
      CONTRACTED_RECEIVABLE: fmt(breakdown.CONTRACTED_RECEIVABLE),
      CONTRACTED_EXPECTED_BILLING: fmt(breakdown.CONTRACTED_EXPECTED_BILLING),
      KNOWN_COST: fmt(breakdown.KNOWN_COST),
      PIPELINE_EXPECTED_VALUE: fmt(breakdown.PIPELINE_EXPECTED_VALUE),
    },
    lines: lines.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate)),
    paymentTiming: {
      sampleSize: lagSample.length,
      medianLagDays: medianLag,
      modelled: timingModelled,
      detail: timingModelled
        ? `Collection timing modelled from ${lagSample.length} settled invoice(s); median lag ${medianLag} day(s) after the due date.`
        : `Collection timing not modelled — ${lagSample.length} settled invoice(s) is below the ${MIN_PAYMENTS_FOR_TIMING} required. Receivables are placed on their due date.`,
    },
    openingCashBalanceAvailable: false,
    dataSufficiency,
    inputHash,
    limitations,
  }
}

/**
 * Wording for a projected negative net flow.
 *
 * Says NET CASH FLOW, never "cash position", because without an opening
 * balance the projection genuinely cannot speak to whether the firm runs out
 * of money — only to whether more goes out than comes in.
 */
export function negativeNetFlowReason(result: CashFlowResult): string {
  return (
    `Over the next ${result.horizonMonths} month(s), projected contracted receipts of $${result.projectedReceipts} are ` +
    `less than known disbursements of $${result.projectedDisbursements}, a projected net cash flow of $${result.netCashFlow}. ` +
    NO_OPENING_BALANCE_LIMITATION
  )
}
