// =============================================================
// §7.8 — Receivables ageing for the Finance Agent.
//
// Bucket boundaries are NOT redefined here. `agingBucketFor` and `overdueDays`
// come from the canonical `contractFinance` service, so the agent, the finance
// route and the UI can never disagree about what "60 days overdue" means.
//
// What this module adds is per-invoice detail the aggregate cannot carry:
// which invoice, how overdue, how much is genuinely outstanding, and the dedupe
// identity that stops a daily sweep re-notifying about an unchanged balance.
//
// A DRAFT invoice is NOT a receivable. Nobody owes money on a document that has
// not been sent — counting it would overstate what the firm is owed, which is
// the single most misleading thing a receivables report can do.
// =============================================================
import { Prisma } from '@prisma/client'
import { D, agingBucketFor, overdueDays, receivablesAging, type AgingBucketKey } from '../../contractFinance'

export const AGEING_METHOD_VERSION = 'finance-ageing-v1'

/**
 * Statuses that represent money genuinely owed to the firm.
 *
 * DRAFT and READY_FOR_REVIEW are internal work in progress. APPROVED but not
 * yet SUBMITTED is also excluded: the agency has not been asked to pay, so it
 * cannot be late. VOIDED is not owed. Only SUBMITTED, PARTIALLY_PAID and the
 * legacy OVERDUE marker describe a live receivable.
 */
export const RECEIVABLE_STATUSES = ['SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE'] as const

/** Statuses the agent must never present as a receivable, stated explicitly. */
export const NON_RECEIVABLE_STATUSES = ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'PAID', 'VOIDED'] as const

/** Past this age a receivable is escalated. Product policy, not a legal rule. */
export const ESCALATION_OVERDUE_DAYS = 90

export const BUCKET_LABEL: Record<AgingBucketKey, string> = {
  CURRENT: 'Current',
  D1_30: '1–30 days',
  D31_60: '31–60 days',
  D61_90: '61–90 days',
  D91_120: '91–120 days',
  D120_PLUS: '120+ days',
}

export interface ReceivableInvoiceInput {
  id: string
  invoiceNumber: string
  contractId: string
  status: string
  invoiceDate: Date | null
  dueDate: Date | null
  total: Prisma.Decimal
  amountPaid: Prisma.Decimal
  customerName: string | null
}

export interface AgedReceivable {
  invoiceId: string
  invoiceNumber: string
  contractId: string
  status: string
  customerName: string | null
  dueDate: string | null
  /** Whole days past due. Never negative — a future due date reads as 0. */
  overdueDays: number
  bucket: AgingBucketKey
  bucketLabel: string
  total: string
  amountPaid: string
  outstanding: string
  /** True when no due date exists, so ageing cannot be asserted. */
  dueDateUnknown: boolean
  /**
   * Stable across sweeps while nothing material changes. It folds in the
   * outstanding amount, so a partial payment that leaves the invoice in the
   * same bucket still counts as a new fact worth surfacing once.
   */
  dedupeKey: string
}

export interface AgeingResult {
  asOf: string
  methodVersion: string
  buckets: {
    current: string
    days1to30: string
    days31to60: string
    days61to90: string
    days91to120: string
    days120Plus: string
    totalOutstanding: string
  }
  receivables: AgedReceivable[]
  /** Receivables past the escalation threshold, most overdue first. */
  severelyOverdue: AgedReceivable[]
  invoicesWithoutDueDate: number
  excludedNonReceivable: number
  dataSufficiency: 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT_DATA'
  limitations: string[]
}

/**
 * Age a set of invoices.
 *
 * Pure: takes rows, returns a report. The caller is responsible for having
 * scoped the query to one tenant — this function is given no means to widen it.
 */
export function ageReceivables(invoices: ReceivableInvoiceInput[], now: Date): AgeingResult {
  const limitations: string[] = []
  const receivable = invoices.filter((i) => (RECEIVABLE_STATUSES as readonly string[]).includes(i.status))
  const excludedNonReceivable = invoices.length - receivable.length

  const aged: AgedReceivable[] = []
  let withoutDueDate = 0

  for (const inv of receivable) {
    const outstanding = D(inv.total).minus(D(inv.amountPaid))
    if (outstanding.lte(0)) continue

    const days = overdueDays(inv.dueDate, now)
    const bucket = agingBucketFor(days)
    if (!inv.dueDate) withoutDueDate += 1

    aged.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      contractId: inv.contractId,
      status: inv.status,
      customerName: inv.customerName,
      dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
      overdueDays: Math.max(0, days),
      bucket,
      bucketLabel: BUCKET_LABEL[bucket],
      total: D(inv.total).toFixed(2),
      amountPaid: D(inv.amountPaid).toFixed(2),
      outstanding: outstanding.toFixed(2),
      dueDateUnknown: inv.dueDate == null,
      dedupeKey: `receivable-ageing:${inv.id}:${bucket}:${outstanding.toFixed(2)}`,
    })
  }

  const buckets = receivablesAging(
    aged.map((a) => ({ dueDate: a.dueDate ? new Date(a.dueDate) : null, outstanding: D(a.outstanding) })),
    now,
  )

  if (withoutDueDate > 0) {
    limitations.push(
      `${withoutDueDate} outstanding invoice(s) have no due date recorded, so they are reported as current rather than overdue. ` +
        'The platform has no payment-term policy to fall back on, and assuming one would invent an overdue date.',
    )
  }

  const dataSufficiency = aged.length === 0
    ? 'INSUFFICIENT_DATA'
    : withoutDueDate > 0 ? 'PARTIAL' : 'SUFFICIENT'

  return {
    asOf: now.toISOString(),
    methodVersion: AGEING_METHOD_VERSION,
    buckets: {
      current: buckets.current,
      days1to30: buckets.d1_30,
      days31to60: buckets.d31_60,
      days61to90: buckets.d61_90,
      days91to120: buckets.d91_120,
      days120Plus: buckets.d120plus,
      totalOutstanding: buckets.totalOutstanding,
    },
    receivables: aged.sort((a, b) => b.overdueDays - a.overdueDays),
    severelyOverdue: aged
      .filter((a) => a.overdueDays > ESCALATION_OVERDUE_DAYS)
      .sort((a, b) => b.overdueDays - a.overdueDays),
    invoicesWithoutDueDate: withoutDueDate,
    excludedNonReceivable,
    dataSufficiency,
    limitations,
  }
}

/**
 * Wording for a severely overdue receivable.
 *
 * States the observable fact and nothing more. The agent has no basis to say
 * the agency will not pay, that the invoice is disputed, or that the money is
 * at risk — it knows only how many days have passed.
 */
export function overdueEscalationReason(r: AgedReceivable): string {
  return (
    `Invoice ${r.invoiceNumber} has an outstanding balance of $${r.outstanding} and is more than ` +
    `${ESCALATION_OVERDUE_DAYS} days past its due date (${r.overdueDays} days). ` +
    'This is an internal follow-up prompt: the agent does not contact the customer, alter the invoice, or write off the balance.'
  )
}
