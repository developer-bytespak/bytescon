// =============================================================
// §7.1 — Contract finance data loading.
//
// `contractFinance.ts` is deliberately pure and clock-injected, so it holds the
// formulas but never touches the database. This module is the single place the
// authoritative burn INPUTS are queried, so the Section 5 finance API and the
// Contract Administration Agent cannot drift into two different definitions of
// "funded" or "expended".
//
// The query shape is lifted verbatim from `GET /api/contract-finance/:id/summary`
// — approved time and approved costs only; voided funding excluded by
// `sumFunding`.
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import { computeBurn, recognizedExpenditure, sumFunding, type BurnResult } from './contractFinance'

export interface ContractBurnContract {
  id: string
  ceilingValue: Prisma.Decimal | null
  endDate: Date | null
}

export interface BurnInputs {
  funded: Prisma.Decimal
  expended: Prisma.Decimal
  expenditureDates: Date[]
  /** Number of approved expenditure events — used for honest data-sufficiency reporting. */
  expenditureEventCount: number
  fundingTransactionCount: number
}

/**
 * Loads the authoritative funding/expenditure inputs for one contract.
 * Tenant-scoped on every query — never trust a contract id alone.
 */
export async function loadBurnInputs(consultingFirmId: string, contractId: string): Promise<BurnInputs> {
  const [funding, approvedTime, approvedCosts] = await Promise.all([
    prisma.fundingTransaction.findMany({
      where: { consultingFirmId, contractId },
      select: { amount: true, isVoided: true },
    }),
    prisma.timeEntry.findMany({
      where: { consultingFirmId, contractId, status: 'APPROVED' },
      select: { billingAmount: true, decidedAt: true, workDate: true },
    }),
    prisma.contractCost.findMany({
      where: { consultingFirmId, contractId, status: 'APPROVED' },
      select: { amount: true, approvedAt: true, incurredDate: true },
    }),
  ])

  const expenditureDates = [
    ...approvedTime.map((t) => t.workDate),
    ...approvedCosts.map((c) => c.incurredDate ?? c.approvedAt).filter((d): d is Date => !!d),
  ]

  return {
    funded: sumFunding(funding),
    expended: recognizedExpenditure(approvedTime, approvedCosts),
    expenditureDates,
    expenditureEventCount: approvedTime.length + approvedCosts.length,
    fundingTransactionCount: funding.filter((f) => !f.isVoided).length,
  }
}

/**
 * Full burn result for one contract, using the same formulas the Section 5
 * finance API serves. `now` is injected so the agent's output is deterministic
 * under test.
 */
export async function loadContractBurn(
  consultingFirmId: string,
  contract: ContractBurnContract,
  now: Date = new Date(),
): Promise<{ burn: BurnResult; inputs: BurnInputs }> {
  const inputs = await loadBurnInputs(consultingFirmId, contract.id)
  const burn = computeBurn({
    funded: inputs.funded,
    ceiling: contract.ceilingValue,
    expended: inputs.expended,
    expenditureDates: inputs.expenditureDates,
    now,
    endDate: contract.endDate,
  })
  return { burn, inputs }
}
