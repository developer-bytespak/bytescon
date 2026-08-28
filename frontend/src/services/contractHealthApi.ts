// =============================================================
// §7.1 — Contract Administration health API client.
//
// Every health figure below is COMPUTED BY THE BACKEND and rendered as-is. The
// frontend never recalculates health, burn, remaining funding or option
// windows — the agent's persisted artifact is authoritative.
// =============================================================
import { api } from './api'

export type ContractHealthState = 'HEALTHY' | 'ATTENTION' | 'CRITICAL' | 'INSUFFICIENT_DATA'

export type FundingThresholdState =
  | 'OK' | 'FUNDING_WARNING' | 'FUNDING_CRITICAL'
  | 'CEILING_WARNING' | 'CEILING_CRITICAL'
  | 'DEPLETION_BEFORE_END' | 'INSUFFICIENT_DATA'

export type PopState = 'ACTIVE' | 'APPROACHING_END' | 'EXPIRED' | 'OPTION_WINDOW' | 'NOT_STARTED' | 'INSUFFICIENT_DATA'

export type OptionDateBasis = 'EXERCISE_DEADLINE' | 'DECISION_DATE' | 'INTERNAL_RECOMMENDATION' | 'NONE'

export interface PortfolioContractRow {
  contractId: string
  contractNumber: string
  title: string
  status: string
  endDate: string | null
  ownerUserId: string | null
  /** null = the agent has not assessed this contract yet. Never rendered as healthy. */
  health: ContractHealthState | null
  summary: string | null
  assessedAt: string | null
  artifactId: string | null
  runId: string | null
  overdueDeliverables: number
  dueSoonDeliverables: number
  fundingThresholdState: FundingThresholdState | null
  fundedRemaining: string | null
  ceilingRemaining: string | null
  openOptionWindows: number
  popState: PopState | null
  popDaysRemaining: number | null
}

export interface ContractHealthPortfolio {
  agentKey: string
  schedule: {
    isEnabled: boolean
    nextRunAt: string | null
    lastSuccessfulRunAt: string | null
    autonomyLevel: string
    cronExpression: string | null
  } | null
  lastRun: {
    id: string
    status: string
    createdAt: string
    finishedAt: string | null
    outputSummary: string | null
    triggerType: string
  } | null
  totals: {
    monitoredContracts: number
    assessedContracts: number
    HEALTHY: number
    ATTENTION: number
    CRITICAL: number
    INSUFFICIENT_DATA: number
    overdueDeliverables: number
    dueSoonDeliverables: number
    openOptionWindows: number
    popApproaching: number
    fundingWarnings: number
    openEscalations: number
  }
  contracts: PortfolioContractRow[]
  escalations: Array<{
    id: string
    severity: string
    title: string
    entityType: string | null
    entityId: string | null
    createdAt: string
  }>
  policy: Record<string, unknown>
}

export interface DeliverableOpenItem {
  id: string
  name: string
  cdrlNumber: string | null
  dueDate: string | null
  status: string
  derivedStatus: string
  ownerUserId: string | null
  reviewerUserId: string | null
  isOverdue: boolean
  isDueSoon: boolean
  reminderLevel: string | null
  reminderReason: string | null
  lastReminderAt: string | null
  lastEscalationAt: string | null
}

export interface OptionWindow {
  optionPeriodId: string
  label: string
  exerciseStatus: string
  startDate: string | null
  endDate: string | null
  optionValue: string | null
  effectiveDecisionDate: string | null
  dateBasis: OptionDateBasis
  /** True = a derived internal recommendation, NOT a contractual deadline. */
  isInternalRecommendation: boolean
  workingDaysUntilDecision: number | null
  state: 'FUTURE' | 'OPEN' | 'PAST' | 'CLOSED' | 'INSUFFICIENT_DATA'
  ownerUserId: string | null
  reasons: string[]
}

export interface ContractHealthDetail {
  contract: {
    id: string
    contractNumber: string
    title: string
    status: string
    ownerUserId: string | null
    startDate: string | null
    endDate: string | null
  }
  health: null | {
    artifactId: string
    runId: string
    assessedAt: string
    confidenceState: string
    isHumanVerified: boolean
    summary: string | null
    overallHealth: ContractHealthState
    generatedAt: string
    clinCount: number
    warnings: string[]
    dataLimitations: string[]
    deliverables: {
      total: number
      dueSoon: number
      overdue: number
      awaitingReview: number
      unowned: number
      openItems: DeliverableOpenItem[]
      remindersSent: number
      escalationsSent: number
    }
    funding: {
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
      projectedFundingExhaustion: string | null
      projectedCeilingExhaustion: string | null
      depletionBeforeEnd: boolean | null
      thresholdState: FundingThresholdState
      insufficientData: boolean
      reasons: string[]
    }
    options: {
      total: number
      upcomingDecisionWindows: OptionWindow[]
      openWindowCount: number
      missingOwnerCount: number
    }
    periodOfPerformance: {
      startDate: string | null
      endDate: string | null
      state: PopState
      daysRemaining: number | null
      reasons: string[]
    }
    modifications: {
      recent: Array<{
        modificationId: string
        modNumber: string
        status: string
        isUnresolved: boolean
        fundingChange: string | null
        ceilingChange: string | null
        projectedFundedValue: string | null
        note: string
      }>
      unresolvedImpacts: Array<{ modificationId: string; modNumber: string }>
    }
  }
  lastRun: {
    id: string
    status: string
    triggerType: string
    createdAt: string
    finishedAt: string | null
    outputSummary: string | null
    confidenceState: string | null
    dataSufficiency: string | null
    warnings: string[]
    limitations: string[]
    tokenInput: number
    tokenOutput: number
    estimatedCostUsd: string | number
  } | null
  escalations: Array<{
    id: string
    severity: string
    status: string
    title: string
    reason: string
    recommendedAction: string | null
    entityType: string | null
    entityId: string | null
    createdAt: string
  }>
  policy: Record<string, unknown>
}

async function get<T>(url: string): Promise<T> {
  const res = await api.get(url)
  return res.data.data as T
}

export const contractHealthApi = {
  getPortfolio: () => get<ContractHealthPortfolio>('/contract-health/portfolio'),
  getContract: (contractId: string) => get<ContractHealthDetail>(`/contract-health/${contractId}`),
}
