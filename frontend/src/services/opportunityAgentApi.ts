// =============================================================
// §7.2 — Opportunity Agent API client.
//
// Every figure below is COMPUTED BY THE BACKEND and rendered as-is. The
// frontend never recalculates a match score, a learned weight, a source health
// state or a deadline — the agent's persisted OPPORTUNITY_BRIEF is
// authoritative, and applying a weighting is an ADMIN action against the API,
// never a client-side computation.
// =============================================================
import { api } from './api'

export type PursuitFeedbackStatus =
  | 'INSUFFICIENT_DATA' | 'PROPOSED' | 'APPLIED' | 'REVERTED' | 'SUPERSEDED'

export type WeightProfile = 'BASE' | 'PURSUIT_ADJUSTED'

export type SourceHealthState =
  | 'OK' | 'STALE' | 'FAILING' | 'NOT_CONFIGURED' | 'DISABLED' | 'NEVER_SYNCED'

export interface SourceHealthRow {
  sourceConfigId: string
  displayName: string
  adapterKey: string
  category: string
  isEnabled: boolean
  state: SourceHealthState
  verification: string
  dataQuality: string
  consecutiveFailures: number
  stalenessHours: number
  ageHours: number | null
  freshnessLabel: string
  lastSuccessfulSync: string | null
  lastFailureAt: string | null
  lastFailureMessage: string | null
  nextRunAt: string | null
}

export interface DimensionEvidence {
  dimension: string
  pursuedCount: number
  ignoredCount: number
  pursuedMean: number | null
  ignoredMean: number | null
  delta: number | null
  baseWeight: number
  adjustedWeight: number
  proposedWeight: number
  explanation: string
}

export interface PursuitFeedbackSignal {
  id: string
  status: PursuitFeedbackStatus
  algorithmVersion: string
  sampleSize: number
  pursuedSampleSize: number
  ignoredSampleSize: number
  minimumSampleSize: number
  confidenceState: string
  dataSufficiency: string
  baselineWeights: Record<string, number>
  proposedWeights: Record<string, number>
  evidence: { dimensions?: DimensionEvidence[]; insufficientReason?: string | null } | null
  summary: string | null
  generatedByRunId: string | null
  generatedAt: string
  appliedByUserId: string | null
  appliedAt: string | null
  revertedByUserId: string | null
  revertedAt: string | null
  supersededBySignalId: string | null
  supersededAt: string | null
}

export interface HighMatchRow {
  opportunityId: string
  title: string
  agency: string
  deadline: string | null
  source: string
  noticeType: string | null
  priority: 'HIGH' | 'CRITICAL'
  matchScore: number
  baseMatchScore: number | null
  weightProfile: string
  matchDimensions: Array<{ key: string; score: number | null; weight: number; baseWeight: number }>
  eligibility: string | null
  eligibilityReason: string | null
  certificationWarnings: string[]
  whyItMatched: string[]
  workingDaysToDeadline: number | null
  evidence: string[]
}

export interface PreSolicitationRow {
  opportunityId: string
  title: string
  agency: string
  noticeType: string | null
  kind: string
  label: string
  basis: string
  responseDeadline: string | null
  capabilityFit: number | null
  eligibility: string | null
  whyEarlyResponseMayMatter: string | null
}

export interface RecompeteRow {
  signalId: string
  sourceContractId: string | null
  incumbent: string | null
  agency: string | null
  contractNumber: string | null
  estimatedWindowStart: string | null
  estimatedWindowEnd: string | null
  confidence: string
  confidenceReason: string | null
  status: string
  requiresHumanAcceptance: boolean
}

export interface ForecastRow {
  forecastId: string
  title: string
  agency: string
  anticipatedSolicitationDate: string | null
  linkState: string
  linkedOpportunityId: string | null
  linkConfidence: number | null
  requiresHumanConfirmation: boolean
  note: string
}

export interface OpportunityBrief {
  artifactId: string
  runId: string
  generatedAt: string
  summary: string | null
  tenantSummary: {
    liveOpportunities: number
    newOpportunities: number
    changedOpportunities: number
    highPriorityMatches: number
    criticalMatches: number
    preSolicitationCount: number
    recompeteCount: number
    forecastCount: number
  }
  highMatchOpportunities: HighMatchRow[]
  preSolicitation: PreSolicitationRow[]
  recompetes: RecompeteRow[]
  forecasts: ForecastRow[]
  pursuitLearning: {
    status: string
    sampleSize: number
    pursuedSampleSize: number
    ignoredSampleSize: number
    minimumSampleSize: number
    confidence: string
    proposedAdjustmentId: string | null
    appliedAdjustmentId: string | null
    effectiveWeightProfile: WeightProfile
    reason: string
  }
  operations: {
    successfulSources: string[]
    failedSources: string[]
    staleSources: string[]
    notConfiguredSources: string[]
    successfulPhases: string[]
    failedPhases: string[]
  }
  warnings: string[]
  dataLimitations: string[]
}

export interface OpportunityAgentLatest {
  agentKey: 'OPPORTUNITY'
  schedule: {
    isEnabled: boolean
    scheduleType: string
    cronExpression: string | null
    intervalMinutes: number | null
    timezone: string
    nextRunAt: string | null
    lastRunAt: string | null
    lastSuccessfulRunAt: string | null
    lastFailureAt: string | null
    lastFailureMessage: string | null
    consecutiveFailures: number
    autonomyLevel: string
  } | null
  lastRun: {
    id: string
    status: string
    triggerType: string
    progressPercent: number
    progressStage: string | null
    createdAt: string
    finishedAt: string | null
    outputSummary: string | null
    confidenceState: string | null
    dataSufficiency: string | null
    warnings: string[]
    limitations: string[]
    errorMessage: string | null
    tokenInput: number
    tokenOutput: number
    estimatedCostUsd: string
  } | null
  lastSuccessfulRun: { id: string; finishedAt: string | null; outputSummary: string | null } | null
  /** null = the agent has not produced a brief yet. Never rendered as healthy. */
  brief: OpportunityBrief | null
  sourceHealth: SourceHealthRow[]
  sourceTotals: { total: number; healthy: number; failing: number; stale: number; notConfigured: number }
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
  learning: {
    effectiveWeightProfile: WeightProfile
    effectiveWeights: Record<string, number>
    appliedSignal: PursuitFeedbackSignal | null
    proposedSignal: PursuitFeedbackSignal | null
    insufficientSignal: PursuitFeedbackSignal | null
  }
  policy: {
    minimumSampleSize: number
    minimumClassSize: number
    maxWeightAdjustmentPct: number
    criticalMatchScore: number
    highMatchScore: number
    criticalDeadlineWorkingDays: number
    learnableDimensions: string[]
    baseWeights: Record<string, number>
    notes: string[]
  }
}

async function get<T>(url: string): Promise<T> {
  const res = await api.get(url)
  return res.data.data as T
}

export const opportunityAgentApi = {
  getLatest: () => get<OpportunityAgentLatest>('/agents/opportunity/latest'),
  listFeedback: () =>
    get<{ signals: PursuitFeedbackSignal[]; policy: OpportunityAgentLatest['policy'] }>(
      '/agents/opportunity/feedback',
    ),
  applyFeedback: async (id: string) => {
    const res = await api.post(`/agents/opportunity/feedback/${id}/apply`)
    return res.data.data as { signal: PursuitFeedbackSignal; matchesRefreshed: number }
  },
  revertFeedback: async (id: string) => {
    const res = await api.post(`/agents/opportunity/feedback/${id}/revert`)
    return res.data.data as {
      signal: PursuitFeedbackSignal
      restoredWeights: Record<string, number>
      matchesRefreshed: number
    }
  },
}
