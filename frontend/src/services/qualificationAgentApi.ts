// =============================================================
// §7.4 — Qualification Agent API client.
//
// Every figure below is COMPUTED BY THE BACKEND. The frontend never scores a
// scorecard, calibrates a probability, derives a confidence interval, decides
// what is borderline, or writes a decision. Accept and reject post to the
// backend, which routes them through the one canonical human decision path.
// =============================================================
import { api } from './api'

export type RecommendationResult =
  | 'RECOMMEND_BID' | 'RECOMMEND_NO_BID' | 'BORDERLINE_REVIEW' | 'INSUFFICIENT_DATA'

export type RecommendationStrength = 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE'
export type RecommendationStatus = 'ACTIVE' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED'
export type FinalDecision = 'BID' | 'NO_BID' | 'CONDITIONAL' | 'DEFERRED'

export interface QualificationRecommendation {
  id: string
  pursuitId: string
  opportunityId: string
  agentRunId: string | null
  version: number
  algorithmVersion: string
  recommendation: RecommendationResult
  strength: RecommendationStrength
  rawProbability: number | null
  finalProbability: number | null
  /** RAW | CALIBRATED | FALLBACK — rendered verbatim, never relabelled. */
  probabilityMode: string | null
  calibrationnote: string | null
  confidenceLower: number | null
  confidenceUpper: number | null
  confidenceState: string
  dataSufficiency: string
  scorecardScore: number | null
  isBorderline: boolean
  borderlineReasons: string[]
  capabilityGapSeverity: string | null
  capacityState: string | null
  incumbentEvidence: IncumbentEvidence | null
  competitorEvidence: CompetitorEvidence[] | null
  pricingEvidence: PricingEvidence | null
  complianceEvidence: ComplianceEvidence | null
  narrative: string
  dataLimitations: string[]
  proposedPriority: string | null
  status: RecommendationStatus
  supersedesId: string | null
  supersededAt: string | null
  acceptedByUserId: string | null
  acceptedAt: string | null
  rejectedByUserId: string | null
  rejectedAt: string | null
  humanDecision: string | null
  createdAt: string
}

export interface IncumbentEvidence {
  available: boolean
  name: string | null
  retentionNumerator: number | null
  retentionDenominator: number | null
  retentionRatePct: number | null
  basisLabel: string
  sampleSize: number
  limitation: string | null
}

export interface CompetitorEvidence {
  name: string
  awardsObserved: number
  totalObserved: number
  observedAwardSharePct: number | null
  /** TRUE only when the denominator is confirmed bid participation. */
  isConfirmedWinRate: boolean
  basisLabel: string
}

export interface PricingEvidence {
  availability: string
  validity: string | null
  detail: string
}

export interface ComplianceEvidence {
  available: boolean
  overallStatus: string | null
  blockers: number
  humanReviewItems: number
  detail: string
}

export interface QualificationBrief {
  artifactId: string
  runId: string
  generatedAt: string
  summary: string | null
  recommendation: {
    result: RecommendationResult
    strength: RecommendationStrength
    borderline: boolean
    reasonCodes: string[]
    reasons: string[]
    version: number
    recommendationId: string | null
  }
  scorecard: {
    total: number | null
    complete: boolean
    recommendation: string | null
    criteria: Array<{ key: string; weight: number; score: number | null; contribution: number | null; required: boolean; evidence: string | null }>
    missingRequiredKeys: string[]
    note: string
  }
  probability: {
    raw: number | null
    final: number | null
    mode: string | null
    calibrationStatus: string | null
    calibrationReason: string | null
    sampleSize: number | null
    intervalLower: number | null
    intervalUpper: number | null
    intervalAvailable: boolean
    intervalUnavailableLabel: string | null
    confidenceState: string
    /** Whether the CALIBRATION CURVE has enough samples — not evidence sufficiency. */
    calibrationSampleSufficiency: string
    dataSufficiency: string
    modelVersion: string
  }
  capability: { matchScore: number | null; severity: string; gaps: string[]; criticalGaps: string[] }
  capacity: { state: string; conflicts: string[]; detail: string }
  pastPerformance: { relevantRecords: number; records: Array<{ id: string; title: string; agency: string | null; relevance: string }>; limitations: string[] }
  incumbent: IncumbentEvidence
  competitors: CompetitorEvidence[]
  competitorLimitation: string | null
  pricing: PricingEvidence
  compliance: ComplianceEvidence
  stageContradiction: { contradicts: boolean; reason: string | null }
  proposedPriority: string | null
  narrative: string
  warnings: string[]
  dataLimitations: string[]
}

export interface QualificationAgentView {
  agentKey: 'QUALIFICATION'
  pursuit: {
    id: string
    opportunityId: string
    pipelineStage: string
    priority: string
    ownerUserId: string | null
    opportunity: { id: string; title: string; agency: string; responseDeadline: string | null }
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
  /** null = the agent has not qualified this pursuit yet. */
  recommendation: QualificationRecommendation | null
  brief: QualificationBrief | null
  gateReview: { id: string; name: string; status: string; reviewerUserId: string | null; dueDate: string | null; comments: string | null } | null
  /** The HUMAN decision, kept separate so the two are never conflated. */
  humanDecision: {
    id: string
    status: string
    finalDecision: string | null
    decidedByUserId: string | null
    decidedAt: string | null
    isOverride: boolean
    overrideReason: string | null
  } | null
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
    decisionBoundary: number
    borderlineLower: number
    borderlineUpper: number
    maxUsefulIntervalWidth: number
    notes: string[]
  }
}

async function get<T>(url: string): Promise<T> {
  const res = await api.get(url)
  return res.data.data as T
}

export const qualificationAgentApi = {
  get: (pursuitId: string) => get<QualificationAgentView>(`/agents/qualification/${pursuitId}`),
  history: (pursuitId: string) =>
    get<{ versions: QualificationRecommendation[] }>(`/agents/qualification/${pursuitId}/history`),
  accept: async (id: string, body: { decision?: FinalDecision; overrideReason?: string; reviewerComments?: string }) => {
    const res = await api.post(`/agents/qualification/recommendation/${id}/accept`, body)
    return res.data.data as { recommendation: QualificationRecommendation }
  },
  reject: async (id: string, body: { decision: FinalDecision; overrideReason?: string; reviewerComments?: string }) => {
    const res = await api.post(`/agents/qualification/recommendation/${id}/reject`, body)
    return res.data.data as { recommendation: QualificationRecommendation }
  },
}
