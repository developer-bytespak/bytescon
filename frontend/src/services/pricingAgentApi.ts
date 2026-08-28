// =============================================================
// §7.6 — Pricing Agent API client.
//
// Every figure here is COMPUTED BY THE BACKEND. The frontend never recalculates
// a total, a percentile, or a competitive-range verdict — §7 of the brief makes
// the backend pricing engine authoritative, and this client only reads it.
//
// There is deliberately no mutation method: the agent's API is read-only, and
// so is this client.
// =============================================================
import { api } from './api'

export type RangeState =
  | 'BELOW_HISTORICAL_RANGE'
  | 'WITHIN_HISTORICAL_RANGE'
  | 'ABOVE_HISTORICAL_RANGE'
  | 'EXTREME_OUTLIER'
  | 'INSUFFICIENT_DATA'

export type TemplateState = 'CURRENT' | 'EXPIRING_SOON' | 'STALE' | 'NO_EFFECTIVE_DATE' | 'INSUFFICIENT_DATA'

export type AmendmentImpactState =
  | 'NO_PRICING_IMPACT_IDENTIFIED'
  | 'POTENTIAL_PRICING_IMPACT'
  | 'PRICING_REVIEW_REQUIRED'
  | 'INSUFFICIENT_DATA'

export interface ScenarioAssessment {
  scenarioId: string
  name: string
  isPreferred: boolean
  totals: {
    directLabor: string
    fringe: string
    overhead: string
    odc: string
    subcontractor: string
    ga: string
    subtotalBeforeFee: string
    fee: string
    totalProposedPrice: string
  }
  totalsRecomputed: boolean
  rateStructure: { complete: boolean; state: 'COMPLETE' | 'INCOMPLETE_RATE_STRUCTURE'; warnings: string[] }
  rateDrift: Array<{
    rateType: string
    scenarioPercent: string
    templatePercent: string
    templateName: string
    state: 'RATE_REVIEW_REQUIRED'
    note: string
  }>
  benchmark: {
    cohortId: string | null
    status: string
    filterLevel: string
    /** Named relaxations, shown verbatim so a broadened filter is never hidden. */
    relaxedFilters: string[]
    cohortSize: number
    periodStart: string
    periodEnd: string
    p25: string | null
    median: string | null
    p75: string | null
    minimum: string | null
    maximum: string | null
    /** Null unless the cohort met the minimum. Never a placeholder. */
    proposedPricePercentile: number | null
    rangeState: RangeState
    summary: string
    sourceIds: string[]
    limitations: string[]
  }
  templateStatus: { state: TemplateState; staleItems: string[] }
}

export interface PricingAssessment {
  artifactId: string
  generatedAt: string
  opportunityId: string
  pricingWorkspaceId: string
  workspaceTitle: string
  workspaceStatus: string
  methodVersion: string
  preferredScenarioId: string | null
  preferredScenarioState: 'SELECTED' | 'NO_PREFERRED_SCENARIO'
  scenarios: ScenarioAssessment[]
  sensitivity: {
    status: string
    probabilityMode: string
    points: Array<{ scenarioId: string | null; label: string; price: string; probability: number }>
    sampleSize: number
    assumptions: string[]
    limitations: string[]
  }
  amendmentImpact: { status: AmendmentImpactState; evidence: string[]; reviewRequired: boolean }
  recommendedHumanActions: string[]
  warnings: string[]
  dataLimitations: string[]
}

export interface PricingAgentView {
  agentKey: 'PRICING'
  workspace: {
    id: string
    opportunityId: string
    title: string
    status: string
    ownerUserId: string | null
    preferredScenarioId: string | null
    opportunity: { id: string; title: string; agency: string; naicsCode: string; responseDeadline: string | null } | null
  }
  schedule: {
    isEnabled: boolean
    cronExpression: string | null
    nextRunAt: string | null
    lastRunAt: string | null
    lastSuccessfulRunAt: string | null
    lastFailureAt: string | null
    lastFailureMessage: string | null
    autonomyLevel: string
  } | null
  lastRun: {
    id: string
    status: string
    triggerType: string
    createdAt: string
    finishedAt: string | null
    outputSummary: string | null
    warnings: string[]
    limitations: string[]
    tokenInput: number
    tokenOutput: number
    estimatedCostUsd: string
  } | null
  /** null = the agent has not assessed this workspace yet. */
  assessment: PricingAssessment | null
  escalations: Array<{
    id: string
    severity: string
    status: string
    title: string
    reason: string
    recommendedAction: string | null
    createdAt: string
  }>
  policy: {
    policyVersion: string
    minimumCohortSize: number
    strongCohortSize: number
    lookbackMonths: number
    valueBandLowRatio: number
    valueBandHighRatio: number
    outlierIqrMultiplier: number
    riskWorkingDays: number
    nonComparableAwardTypes: string[]
    notes: string[]
  }
}

export interface CohortComposition {
  cohort: {
    id: string
    filterLevel: string
    relaxedFilters: string[]
    naics: string | null
    agency: string | null
    setAside: string | null
    periodStart: string
    periodEnd: string
    cohortSize: number
    sourceIds: string[]
    excludedSourceIds: string[]
    exclusionReasons: Array<{ awardId: string; reason: string }>
    minimumValue: string | null
    p25Value: string | null
    medianValue: string | null
    p75Value: string | null
    maximumValue: string | null
    distributionData: Array<{
      awardId: string
      agency: string
      naics: string | null
      setAside: string | null
      awardDate: string
      awardAmount: string
      contractNumber: string | null
      recipientName: string
      included: boolean
    }>
    dataSufficiency: string
    limitations: string[]
  }
  provenance: { sourceKind: string; note: string }
}

async function get<T>(url: string): Promise<T> {
  const res = await api.get(url)
  return res.data.data as T
}

export const pricingAgentApi = {
  assessment: (workspaceId: string) => get<PricingAgentView>(`/agents/pricing/assessment/${workspaceId}`),
  cohort: (cohortId: string) => get<CohortComposition>(`/agents/pricing/cohort/${cohortId}`),
}
