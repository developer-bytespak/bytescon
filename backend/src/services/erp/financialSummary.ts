// =============================================================
// §8.2 — ERP financial summary for one contract.
//
// Composition, not a new engine. Funding comes from `sumFunding`, actual from
// the same approved-time-plus-approved-cost rule the burn monitor uses, budget
// and commitments from `budgetVsActual`, receivables from the existing invoice
// records. Nothing here re-derives a figure that already has an owner.
//
// Three numbers are kept strictly apart because conflating them is how a
// contractor talks themselves into a cash-flow problem:
//
//   PIPELINE     — weighted value of work not yet won. Owned by portfolioValue.ts
//                  and deliberately ABSENT from this service.
//   BACKLOG      — awarded work not yet performed.
//   RECEIVABLES  — work performed and billed, not yet collected.
//
// Missing inputs are reported as null with a stated reason. A contract with no
// recorded ceiling has an unknown backlog, not a zero one.
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { D, money2, sumFunding } from '../contractFinance'
import { computeBudgetVsActual, type BudgetVsActualResult } from './budgetVsActual'

type Dec = Prisma.Decimal
const ZERO = new Prisma.Decimal(0)

export interface ContractFinancialSummary {
  contractId: string
  contractNumber: string
  /** Ceiling if recorded, else award value. Null when neither exists. */
  contractValue: string | null
  contractValueSource: 'CEILING' | 'AWARD' | null
  funded: string
  /** Null when no contract value is recorded — unfunded would be a guess. */
  unfunded: string | null
  budget: string | null
  actual: string
  committed: string
  remainingBudget: string | null
  fundedRemaining: string
  /** Awarded work not yet performed. Null when contract value is unknown. */
  backlog: string | null
  backlogBasis: string
  receivables: { billed: string; collected: string; outstanding: string }
  subcontractCommitments: { orderCount: number; committed: string; invoiced: string; posted: string }
  limitations: string[]
  budgetDetail: BudgetVsActualResult
}

/**
 * Backlog = contract value − actual cost incurred to date.
 *
 * Chosen deliberately over "value − billed": billing lags performance, so a
 * billing-based backlog overstates remaining work every time an invoice is late.
 * Floored at zero, because a contract cannot owe negative future work.
 */
export function computeBacklog(contractValue: Dec | null, actual: Dec): Dec | null {
  if (contractValue === null) return null
  const remaining = contractValue.minus(actual)
  return remaining.isNegative() ? ZERO : money2(remaining)
}

export async function computeContractFinancialSummary(
  consultingFirmId: string,
  contractId: string,
): Promise<ContractFinancialSummary> {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, consultingFirmId },
    select: { id: true, contractNumber: true, ceilingValue: true, awardValue: true },
  })
  if (!contract) throw new Error('Contract not found')

  const [funding, budgetDetail, invoices, orders] = await Promise.all([
    prisma.fundingTransaction.findMany({
      where: { consultingFirmId, contractId },
      select: { amount: true, isVoided: true },
    }),
    computeBudgetVsActual(consultingFirmId, contractId),
    prisma.contractInvoice.findMany({
      where: { consultingFirmId, contractId },
      select: { total: true, amountPaid: true, status: true },
    }),
    prisma.purchaseOrder.findMany({
      where: { consultingFirmId, contractId },
      select: {
        id: true, ceilingAmount: true, status: true,
        invoices: { select: { amount: true, status: true, postedContractCostId: true } },
      },
    }),
  ])

  const limitations: string[] = []

  const contractValue =
    contract.ceilingValue != null ? D(contract.ceilingValue)
      : contract.awardValue != null ? D(contract.awardValue)
        : null
  const contractValueSource = contract.ceilingValue != null ? 'CEILING' : contract.awardValue != null ? 'AWARD' : null
  if (contractValue === null) {
    limitations.push('No ceiling or award value is recorded on this contract, so unfunded value and backlog cannot be computed.')
  }

  const funded = sumFunding(funding)
  if (funding.length === 0) {
    limitations.push('No funding transactions are recorded, so funded value is zero by evidence rather than by assumption.')
  }

  const actual = D(budgetDetail.totals.actual)
  const committed = D(budgetDetail.totals.committed)
  const unfunded = contractValue ? money2(contractValue.minus(funded)) : null
  const fundedRemaining = money2(funded.minus(actual))
  const backlog = computeBacklog(contractValue, actual)

  if (!budgetDetail.hasBudget) {
    limitations.push('No active budget exists, so remaining budget and variance are not reported.')
  }

  // Receivables — money owed TO the firm. Kept entirely apart from the vendor
  // invoices below, which are money the firm owes.
  const billed = invoices.reduce((s, i) => s.plus(D(i.total)), ZERO)
  const collected = invoices.reduce((s, i) => s.plus(D(i.amountPaid)), ZERO)

  // Subcontract commitments — accounts payable side.
  const committingOrders = orders.filter((o) => o.status === 'APPROVED' || o.status === 'PARTIALLY_RECEIVED')
  const poInvoiced = orders.flatMap((o) => o.invoices).filter((i) => i.status !== 'REJECTED')
    .reduce((s, i) => s.plus(D(i.amount)), ZERO)
  const poPosted = orders.flatMap((o) => o.invoices).filter((i) => i.postedContractCostId)
    .reduce((s, i) => s.plus(D(i.amount)), ZERO)

  return {
    contractId: contract.id,
    contractNumber: contract.contractNumber,
    contractValue: contractValue ? contractValue.toFixed(2) : null,
    contractValueSource,
    funded: funded.toFixed(2),
    unfunded: unfunded ? unfunded.toFixed(2) : null,
    budget: budgetDetail.totals.budget,
    actual: actual.toFixed(2),
    committed: committed.toFixed(2),
    remainingBudget: budgetDetail.totals.remaining,
    fundedRemaining: fundedRemaining.toFixed(2),
    backlog: backlog ? backlog.toFixed(2) : null,
    backlogBasis:
      'Backlog is contract value less actual cost incurred. It is awarded work not yet performed — it is not pipeline, and it is not receivables.',
    receivables: {
      billed: money2(billed).toFixed(2),
      collected: money2(collected).toFixed(2),
      outstanding: money2(billed.minus(collected)).toFixed(2),
    },
    subcontractCommitments: {
      orderCount: committingOrders.length,
      committed: committed.toFixed(2),
      invoiced: money2(poInvoiced).toFixed(2),
      posted: money2(poPosted).toFixed(2),
    },
    limitations,
    budgetDetail,
  }
}
