// =============================================================
// §7.8 — Draft invoice assembly.
//
// This module is an EXTRACTION, not a second engine. The eligibility rules and
// line-amount arithmetic below were previously inline in
// `routes/contractFinance.ts` POST /:contractId/invoices; that route now calls
// these functions, so the human path and the agent path cannot diverge.
//
// The canonical rules, unchanged:
//   · eligible time  = APPROVED and invoicedInvoiceId IS NULL
//   · eligible cost  = APPROVED and invoicedInvoiceId IS NULL
//   · a labour line uses the SNAPSHOT `billingAmount` computed at approval,
//     never a re-derivation from today's rate table
//   · sources are stamped with invoicedInvoiceId in the same transaction,
//     which is what makes double-invoicing impossible
//
// Everything here is Decimal. No float ever touches an authoritative amount.
// =============================================================
import { Prisma } from '@prisma/client'
import { D, money2 } from '../../contractFinance'

export const INVOICE_BUILD_METHOD_VERSION = 'finance-invoice-build-v1'

/** The only status a source record may hold to be billable. */
export const BILLABLE_SOURCE_STATUS = 'APPROVED'

/** The only status the agent may ever create. */
export const AGENT_INVOICE_STATUS = 'DRAFT'

export interface BillingPeriod {
  start: Date
  end: Date
}

export interface EligibleTimeEntry {
  id: string
  clinId: string | null
  laborCategory: string
  hours: Prisma.Decimal
  workDate: Date
  appliedBillingRate: Prisma.Decimal | null
  billingAmount: Prisma.Decimal | null
}

export interface EligibleCost {
  id: string
  clinId: string | null
  category: string
  description: string | null
  amount: Prisma.Decimal
  incurredDate: Date | null
}

export interface DraftLine {
  consultingFirmId: string
  /**
   * Carried down from the source record, never re-chosen here. The government
   * bills by CLIN, and a line whose CLIN disagrees with the time entry behind
   * it is the discrepancy an incurred-cost audit looks for.
   */
  clinId: string | null
  kind: string
  description: string
  quantity?: Prisma.Decimal | null
  rate?: Prisma.Decimal | null
  amount: Prisma.Decimal
  sourceTimeEntryId?: string | null
  sourceCostId?: string | null
}

export interface AssembledInvoice {
  lines: DraftLine[]
  subtotal: Prisma.Decimal
  total: Prisma.Decimal
  timeEntryIds: string[]
  costIds: string[]
  /** Records skipped because they carry no amount a person can be billed for. */
  unbillable: Array<{ recordType: 'TimeEntry' | 'ContractCost'; recordId: string; reason: string }>
}

// -------------------------------------------------------------
// Eligibility
// -------------------------------------------------------------

/**
 * The canonical eligible-time filter.
 *
 * A period is optional: the human route allows an open-ended invoice. The agent
 * always supplies one, because an unbounded sweep would pull in records the
 * firm has not finished entering.
 */
export function eligibleTimeWhere(
  consultingFirmId: string,
  contractId: string,
  period?: BillingPeriod,
): Prisma.TimeEntryWhereInput {
  const where: Prisma.TimeEntryWhereInput = {
    consultingFirmId,
    contractId,
    status: BILLABLE_SOURCE_STATUS,
    invoicedInvoiceId: null,
  }
  if (period) where.workDate = { gte: period.start, lte: period.end }
  return where
}

export function eligibleCostWhere(
  consultingFirmId: string,
  contractId: string,
  period?: BillingPeriod,
): Prisma.ContractCostWhereInput {
  const where: Prisma.ContractCostWhereInput = {
    consultingFirmId,
    contractId,
    status: BILLABLE_SOURCE_STATUS,
    invoicedInvoiceId: null,
  }
  if (period) where.incurredDate = { gte: period.start, lte: period.end }
  return where
}

// -------------------------------------------------------------
// Line assembly
// -------------------------------------------------------------

/**
 * Turn eligible source records into invoice lines.
 *
 * Every line carries the id of the record it came from. A line with no source
 * is only ever the explicit fee, which is a human-supplied input rather than a
 * narrative the agent invented.
 */
export function assembleInvoice(args: {
  consultingFirmId: string
  times: EligibleTimeEntry[]
  costs: EligibleCost[]
  feeAmount?: Prisma.Decimal | number | string | null
}): AssembledInvoice {
  const { consultingFirmId, times, costs } = args
  const lines: DraftLine[] = []
  const unbillable: AssembledInvoice['unbillable'] = []
  const timeEntryIds: string[] = []
  const costIds: string[] = []
  let subtotal = D(0)

  for (const t of times) {
    // An approved entry with no rate on its work date was costed as null. The
    // canonical route bills it at zero; the agent records WHY, because a
    // silent zero-dollar labour line is how an unbilled month goes unnoticed.
    const amount = t.billingAmount ?? D(0)
    if (t.billingAmount == null) {
      unbillable.push({
        recordType: 'TimeEntry',
        recordId: t.id,
        reason: `No billing rate was in effect for "${t.laborCategory}" on the work date, so this entry carries no billable amount.`,
      })
    }
    subtotal = subtotal.plus(amount)
    timeEntryIds.push(t.id)
    lines.push({
      consultingFirmId,
      clinId: t.clinId ?? null,
      kind: 'LABOR',
      description: `${t.laborCategory} — ${t.hours} hrs`,
      quantity: t.hours,
      rate: t.appliedBillingRate ?? null,
      amount,
      sourceTimeEntryId: t.id,
    })
  }

  for (const c of costs) {
    subtotal = subtotal.plus(D(c.amount))
    costIds.push(c.id)
    lines.push({
      consultingFirmId,
      clinId: c.clinId ?? null,
      kind: c.category === 'SUBCONTRACTOR' ? 'SUBCONTRACTOR' : 'ODC',
      description: c.description ?? c.category,
      amount: D(c.amount),
      sourceCostId: c.id,
    })
  }

  const fee = D(args.feeAmount ?? 0)
  if (fee.gt(0)) {
    subtotal = subtotal.plus(fee)
    // A fee spans the invoice rather than one CLIN, so it stays unattributed
    // instead of being assigned to whichever CLIN happened to be first.
    lines.push({ consultingFirmId, clinId: null, kind: 'FEE', description: 'Fee', amount: fee })
  }

  return {
    lines,
    subtotal: money2(subtotal),
    total: money2(subtotal),
    timeEntryIds,
    costIds,
    unbillable,
  }
}

// -------------------------------------------------------------
// Billing periods
// -------------------------------------------------------------

/**
 * The most recent CLOSED calendar month relative to `now`.
 *
 * The platform has no contract billing-frequency field and no billing-period
 * close operation (see the §7.8 report). A calendar month that has already
 * ended is the one period definition that is unambiguous, reproducible and
 * never invents a business rule the firm did not configure.
 */
export function lastClosedMonth(now: Date): BillingPeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999))
  return { start, end }
}

/** Stable identity for one contract's billing period. */
export function billingPeriodKey(contractId: string, period: BillingPeriod): string {
  return `${contractId}:${period.start.toISOString().slice(0, 10)}:${period.end.toISOString().slice(0, 10)}`
}

/**
 * Does an invoice already cover this contract and period?
 *
 * A VOIDED invoice does not count — voiding releases its sources precisely so
 * they can be re-invoiced, so treating it as coverage would strand the work.
 */
export function periodAlreadyInvoiced(
  existing: Array<{ status: string; periodStart: Date | null; periodEnd: Date | null }>,
  period: BillingPeriod,
): boolean {
  return existing.some(
    (inv) =>
      inv.status !== 'VOIDED' &&
      inv.periodStart != null &&
      inv.periodEnd != null &&
      inv.periodStart.getTime() === period.start.getTime() &&
      inv.periodEnd.getTime() === period.end.getTime(),
  )
}

/**
 * Next invoice number for a firm.
 *
 * Same derivation as the canonical route. The unique(firm, invoiceNumber)
 * constraint is what actually guards a race; this only picks a candidate.
 */
export function nextInvoiceNumber(existingCount: number): string {
  return `INV-${String(existingCount + 1).padStart(5, '0')}`
}
