// =============================================================
// §7.8 — Finance domain events.
//
// Three events, each emitted from the CANONICAL write path inside the same
// transaction as the business mutation, so a rolled-back write emits nothing.
//
// BILLING_PERIOD_CLOSED IS DELIBERATELY ABSENT
// ------------------------------------------------------------
// The Section 7 plan lists it as a Finance trigger. The codebase has no
// contract billing-period close: `Contract` carries no billing frequency,
// there is no period-close operation, and every `billingCycle` field in the
// schema belongs to the platform's own SaaS subscriptions, which have nothing
// to do with contract invoicing.
//
// Emitting a BILLING_PERIOD_CLOSED event anyway would mean inventing a
// business fact to satisfy a plan document — an event that fires when nothing
// in the business has actually closed. Instead the monthly cycle is driven by
// the schedule, and the billing period is derived from the last closed
// calendar month (see `invoiceBuilder.lastClosedMonth`), gated by an
// existing-invoice check so it is idempotent regardless of cadence. The
// registry's `subscribedEventTypes` reflects this: three events, not four.
// =============================================================
import type { Prisma } from '@prisma/client'
import { emitAgentEvent } from '../outbox'

export const INVOICE_PAID = 'INVOICE_PAID'
export const TIME_ENTRY_SUBMITTED = 'TIME_ENTRY_SUBMITTED'
export const CONTRACT_COST_ADDED = 'CONTRACT_COST_ADDED'

export const FINANCE_EVENT_TYPES = [INVOICE_PAID, TIME_ENTRY_SUBMITTED, CONTRACT_COST_ADDED] as const

export const CONTRACT_ENTITY_TYPE = 'Contract'
export const INVOICE_ENTITY_TYPE = 'ContractInvoice'
export const TIME_ENTRY_ENTITY_TYPE = 'TimeEntry'

/**
 * Did applying a payment actually take the invoice to PAID?
 *
 * Pure, so the rule is testable without a database. A partial payment is not a
 * paid invoice, and re-saving an already-paid invoice is not a new event.
 */
export function isInvoiceNowPaid(fromStatus: string, toStatus: string): boolean {
  return toStatus === 'PAID' && fromStatus !== 'PAID'
}

/**
 * An invoice reached PAID through the canonical payment path.
 *
 * Emitted ONLY from payment application in `routes/contractFinance.ts`. The
 * Finance Agent cannot cause this event: it never records a payment and never
 * sets a status, so PAID is always the consequence of a person recording money
 * that actually arrived.
 */
export function emitInvoicePaid(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    contractId: string
    invoiceId: string
    invoiceNumber: string
    paymentId: string
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: INVOICE_PAID,
      entityType: CONTRACT_ENTITY_TYPE,
      entityId: args.contractId,
      payload: {
        invoiceId: args.invoiceId,
        invoiceNumber: args.invoiceNumber,
        paymentId: args.paymentId,
      },
      // Keyed on the invoice: an invoice reaching PAID is a single fact, even
      // if the last payment is voided and re-recorded.
      dedupeKey: `${INVOICE_PAID}:${args.consultingFirmId}:${args.invoiceId}`,
    },
    tx,
  )
}

/**
 * A person submitted a time entry for approval.
 *
 * Refreshes readiness and billing-readiness. It deliberately does NOT generate
 * an invoice: one person submitting one day of time is not a billing event,
 * and invoicing on it would produce a stream of single-line invoices.
 */
export function emitTimeEntrySubmitted(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    contractId: string
    timeEntryId: string
    workDate: Date
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: TIME_ENTRY_SUBMITTED,
      entityType: CONTRACT_ENTITY_TYPE,
      entityId: args.contractId,
      payload: {
        timeEntryId: args.timeEntryId,
        workDate: args.workDate.toISOString(),
      },
      // Keyed on the entry. Submit → reject → resubmit is a new submission, so
      // the timestamp keeps it from being swallowed as a duplicate.
      dedupeKey: `${TIME_ENTRY_SUBMITTED}:${args.consultingFirmId}:${args.timeEntryId}:${Date.now()}`,
    },
    tx,
  )
}

/**
 * A cost was recorded against a contract.
 *
 * Emitted on CREATION only. An edit that changes nothing must not fire, and an
 * edit in general is not a new cost — the cost already exists and the agent has
 * already seen it.
 */
export function emitContractCostAdded(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    contractId: string
    contractCostId: string
    category: string
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: CONTRACT_COST_ADDED,
      entityType: CONTRACT_ENTITY_TYPE,
      entityId: args.contractId,
      payload: {
        contractCostId: args.contractCostId,
        category: args.category,
      },
      dedupeKey: `${CONTRACT_COST_ADDED}:${args.consultingFirmId}:${args.contractCostId}`,
    },
    tx,
  )
}
