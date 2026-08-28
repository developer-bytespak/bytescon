// =============================================================
// §7.1 — Burn monitor.
//
// Deliberately NOT a second financial engine. Every figure comes from the
// Section 5 `computeBurn` formulas via the shared finance query layer; this
// module only adds the agent's threshold banding and honest data-sufficiency
// reporting on top.
//
// All money stays in Prisma.Decimal end to end. The only Number conversions are
// for percentage banding, which is a ratio and never a money value.
//
// FUNDED REMAINING and CEILING REMAINING are distinct throughout and are never
// collapsed into one figure.
// =============================================================
import { Prisma } from '@prisma/client'
import { loadContractBurn, type ContractBurnContract } from '../../contractFinanceQueries'
import {
  fundingBand,
  thresholdStateToHealth,
  type ContractHealthState,
  type FundingThresholdState,
} from './policy'
import type { EvidenceRef } from '../types'

export interface BurnAssessment {
  funded: string
  ceiling: string | null
  expended: string
  fundedRemaining: string
  ceilingRemaining: string | null
  fundedConsumedPct: number
  ceilingConsumedPct: number | null
  burnRatePerDay: string | null
  avgMonthlyBurn: string | null
  observationDays: number | null
  expenditureEventCount: number
  fundingTransactionCount: number
  projectedFundingExhaustion: string | null
  projectedCeilingExhaustion: string | null
  depletionBeforeEnd: boolean | null
  thresholdState: FundingThresholdState
  health: ContractHealthState
  insufficientData: boolean
  reasons: string[]
  evidence: EvidenceRef[]
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Assesses one contract's funding position.
 *
 * Projection guards are inherited from `computeBurn` (expended > 0, span >= 7
 * days, burn > 0, remaining > 0). When any guard fails this returns
 * INSUFFICIENT_DATA with explicit reasons rather than inventing a date.
 */
export async function assessBurn(
  consultingFirmId: string,
  contract: ContractBurnContract,
  now: Date = new Date(),
): Promise<BurnAssessment> {
  const { burn, inputs } = await loadContractBurn(consultingFirmId, contract, now)

  const reasons: string[] = []
  if (burn.reason) reasons.push(burn.reason)

  const funded = new Prisma.Decimal(burn.funded)
  const expended = new Prisma.Decimal(burn.expended)
  const ceiling = burn.ceiling ? new Prisma.Decimal(burn.ceiling) : null

  // Ratios only — never used to derive a money figure.
  const fundedConsumedPct = funded.gt(0) ? Number(expended.div(funded)) : 0
  const ceilingConsumedPct = ceiling && ceiling.gt(0) ? Number(expended.div(ceiling)) : null

  // Worst of the two bands wins; ceiling is checked independently of funding
  // because a contract can be inside its funding but near its ceiling.
  const fundedState = funded.gt(0) ? fundingBand(fundedConsumedPct, 'FUNDING') : 'INSUFFICIENT_DATA'
  const ceilingState = ceilingConsumedPct === null ? 'OK' : fundingBand(ceilingConsumedPct, 'CEILING')

  // Severity ordering matters: a contract that is BOTH ~fully consumed and
  // projected to deplete early must report the critical band, not the softer
  // depletion finding. Critical bands therefore outrank DEPLETION_BEFORE_END,
  // which in turn outranks a plain warning.
  const ranked: FundingThresholdState[] = [ceilingState, fundedState]
  const critical = ranked.find((s) => s === 'CEILING_CRITICAL' || s === 'FUNDING_CRITICAL')
  const warning = ranked.find((s) => s === 'CEILING_WARNING' || s === 'FUNDING_WARNING')

  let thresholdState: FundingThresholdState
  if (critical) thresholdState = critical
  else if (burn.depletionBeforeEnd) thresholdState = 'DEPLETION_BEFORE_END'
  else if (warning) thresholdState = warning
  else thresholdState = fundedState === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT_DATA' : 'OK'

  if (funded.lte(0)) reasons.push('No funding has been obligated on this contract yet.')
  if (!ceiling) reasons.push('No contract ceiling is recorded, so ceiling remaining cannot be reported.')

  const observationDays = inputs.expenditureDates.length
    ? Math.floor((now.getTime() - Math.min(...inputs.expenditureDates.map((d) => d.getTime()))) / DAY_MS)
    : null

  // Ceiling exhaustion uses the same burn rate but the ceiling remaining, and
  // is suppressed under exactly the same guards.
  let projectedCeilingExhaustion: string | null = null
  if (burn.burnRatePerDay && burn.remainingCeiling) {
    const rate = new Prisma.Decimal(burn.burnRatePerDay)
    const remaining = new Prisma.Decimal(burn.remainingCeiling)
    if (rate.gt(0) && remaining.gt(0)) {
      const daysLeft = Number(remaining.div(rate))
      if (Number.isFinite(daysLeft)) {
        projectedCeilingExhaustion = new Date(now.getTime() + daysLeft * DAY_MS).toISOString()
      }
    }
  }

  const evidence: EvidenceRef[] = [
    {
      sourceType: 'FundingTransaction',
      sourceId: contract.id,
      sourceLocator: `contract:${contract.id}/funding`,
      retrievedAt: now.toISOString(),
      note: `${inputs.fundingTransactionCount} non-voided funding transaction(s) summed to ${burn.funded}.`,
    },
    {
      sourceType: 'ApprovedExpenditure',
      sourceId: contract.id,
      sourceLocator: `contract:${contract.id}/time+costs`,
      retrievedAt: now.toISOString(),
      note: `${inputs.expenditureEventCount} approved time/cost record(s) recognised as ${burn.expended}.`,
    },
  ]

  return {
    funded: burn.funded,
    ceiling: burn.ceiling,
    expended: burn.expended,
    fundedRemaining: burn.remainingFunded,
    ceilingRemaining: burn.remainingCeiling,
    fundedConsumedPct: Math.round(fundedConsumedPct * 10000) / 10000,
    ceilingConsumedPct: ceilingConsumedPct === null ? null : Math.round(ceilingConsumedPct * 10000) / 10000,
    burnRatePerDay: burn.burnRatePerDay,
    avgMonthlyBurn: burn.avgMonthlyBurn,
    observationDays,
    expenditureEventCount: inputs.expenditureEventCount,
    fundingTransactionCount: inputs.fundingTransactionCount,
    projectedFundingExhaustion: burn.estimatedDepletionDate,
    projectedCeilingExhaustion,
    depletionBeforeEnd: burn.depletionBeforeEnd,
    thresholdState,
    health: burn.insufficientData && thresholdState === 'OK' ? 'INSUFFICIENT_DATA' : thresholdStateToHealth(thresholdState),
    insufficientData: burn.insufficientData,
    reasons,
    evidence,
  }
}

/** Stable per (contract, threshold band) so an unchanged condition never re-escalates. */
export function burnEscalationDedupeHint(contractId: string, state: FundingThresholdState): string {
  return `contract-burn:${contractId}:${state}`
}
