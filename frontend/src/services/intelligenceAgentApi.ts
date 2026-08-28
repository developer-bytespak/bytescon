// =============================================================
// §7.9 — Intelligence Agent API client.
//
// Every statistic here is COMPUTED BY THE BACKEND. The frontend renders; it
// never calculates a win rate, an interval, an HHI or a score. A rate that
// arrives as `null` means the backend refused to state one, and the UI must
// say so rather than substituting a zero.
//
// There is deliberately no method that changes a decision, a pursuit, a weight
// or a price: the agent has no such endpoint, and neither does this client.
// The only writes are dismiss and acknowledge, which act on the advice itself.
// =============================================================
import { api } from './api'

export type DataSufficiency = 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT_DATA'
export type SegmentType = 'OVERALL' | 'AGENCY' | 'NAICS' | 'CONTRACT_VEHICLE' | 'SET_ASIDE' | 'VALUE_BAND'
export type ScoreState = 'SCORED' | 'EXPLORATORY' | 'INSUFFICIENT_DATA'
export type TrendState = 'IMPROVING' | 'STABLE' | 'DECLINING' | 'INSUFFICIENT_DATA'
export type ConcentrationState = 'CONCENTRATED' | 'MODERATE' | 'DIVERSIFIED' | 'INSUFFICIENT_DATA'
export type RecommendationStatus = 'ACTIVE' | 'SUPERSEDED' | 'DISMISSED'

export interface WinLossSegmentView {
  segmentType: SegmentType
  segmentKey: string
  segmentLabel: string
  wins: number
  losses: number
  pending: number
  sampleSize: number
  minimumSampleSize: number
  /** Null below the minimum sample. Never render this as 0%. */
  winRate: number | null
  intervalLower: number | null
  intervalUpper: number | null
  dataSufficiency: DataSufficiency
  sourceOutcomeIds: string[]
  limitations: string[]
  algorithmVersion: string
  inputHash: string
}

export interface OutcomeTrendView {
  state: TrendState
  method: string
  periods: Array<{ period: string; wins: number; losses: number; sampleSize: number; winRate: number | null; ema: number | null }>
  periodsWithSufficientSample: number
  consecutiveDecline: boolean
  changePercent: number | null
  limitations: string[]
}

export interface CaptureRecommendationView {
  segmentType: SegmentType
  segmentKey: string
  segmentLabel: string
  score: number | null
  scoreState: ScoreState
  rank: number | null
  rationale: string
  evidence: Record<string, unknown>
  sampleSize: number
  dataSufficiency: DataSufficiency
  inputHash: string
  algorithmVersion: string
}

export interface RoadmapItemView {
  gapKey: string
  gapLabel: string
  category: string
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR'
  recommendation: string
  affectedOpportunityCount: number
  affectedPursuitCount: number
  knownAffectedValue: number
  unknownValueCount: number
  partnerCoverageCount: number
  partnerNames: string[]
  sourceGapIds: string[]
  evidence: string[]
  dataSufficiency: DataSufficiency
  limitations: string[]
}

export interface PortfolioIntelligence {
  artifactId: string
  generatedAt: string
  methodVersion: string
  analysisPeriod: { start: string; end: string; lookbackMonths: number }
  outcomeSummary: {
    confirmedWins: number
    confirmedLosses: number
    pending: number
    confirmedSampleSize: number
    minimumSampleSize: number
    additionalOutcomesNeeded: number
    dataSufficiency: DataSufficiency
    winRate: number | null
    intervalLower: number | null
    intervalUpper: number | null
    intervalMethod: string
    rateBasis: 'CONFIRMED_WIN_RATE' | 'INSUFFICIENT_DATA'
    duplicatesCollapsed: number
    nonContestExcluded: number
  }
  segments: {
    agencies: WinLossSegmentView[]
    naics: WinLossSegmentView[]
    vehicles: WinLossSegmentView[]
    setAsides: WinLossSegmentView[]
    valueBands: WinLossSegmentView[]
  }
  trends: { overall: OutcomeTrendView | null; method: string; limitations: string[] }
  concentration: {
    basis: string
    hhi: number | null
    state: ConcentrationState
    threshold: number
    dominantSegments: Array<{ key: string; share: number; expectedValue: number }>
    limitations: string[]
  }
  comparablePublicBenchmark: {
    status: string
    /** Always names PUBLIC award records. Never another customer's data. */
    sourceDescription: string
    cohortSize: number
    minimumCohortSize: number
    cohortRules: string[]
    sourceIds: string[]
    relaxedFilters: string[]
    statistics: Record<string, string | null>
    rateBasis: 'OBSERVED_AWARD_SHARE' | 'INSUFFICIENT_DATA'
    benchmarkHash: string | null
    limitations: string[]
  }
  captureFocus: CaptureRecommendationView[]
  capabilityRoadmap: {
    items: RoadmapItemView[]
    totalGapsObserved: number
    distinctGaps: number
    nonRecurringGaps: number
    limitations: string[]
  }
  outcomeDataQuality: {
    submittedWithoutOutcome: number
    overdueWithoutOutcome: number
    state: 'OK' | 'OUTCOME_DATA_INCOMPLETE'
    detail: string
  }
  notifications: string[]
  escalations: string[]
  advisoryOnly: Record<string, number>
  warnings: string[]
  /** Always present, even when empty. */
  dataLimitations: string[]
  inputHash: string
}

export interface IntelligencePolicy {
  algorithmVersion: string
  minimumSampleSize: number
  minimumTrendPeriods: number
  minimumGapRecurrence: number
  minimumPublicCohortSize: number
  concentrationThreshold: number
  analysisLookbackMonths: number
  intervalMethod: string
  maxRecommendations: number
  valueBands: Array<{ key: string; label: string }>
  confirmedOutcomes: string[]
  nonContestOutcomes: string[]
  notes: string[]
}

export interface IntelligenceAgentView {
  agentKey: 'INTELLIGENCE'
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
  /** null = the agent has not analysed this firm yet. */
  intelligence: PortfolioIntelligence | null
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
  policy: IntelligencePolicy
}

export interface StoredRecommendation {
  id: string
  segmentType: SegmentType
  segmentKey: string
  segmentLabel: string
  score: string | null
  scoreState: ScoreState
  rank: number | null
  rationale: string
  evidence: Record<string, unknown>
  sampleSize: number
  dataSufficiency: DataSufficiency
  status: RecommendationStatus
  dismissedByUserId: string | null
  dismissedAt: string | null
  dismissReason: string | null
  createdAt: string
}

async function get<T>(url: string): Promise<T> {
  const res = await api.get(url)
  return res.data.data as T
}

export const intelligenceAgentApi = {
  portfolio: () => get<IntelligenceAgentView>('/agents/intelligence/portfolio'),
  segments: (segmentType?: SegmentType) =>
    get<{ segments: Array<WinLossSegmentView & { id: string }>; policy: IntelligencePolicy }>(
      `/agents/intelligence/segments${segmentType ? `?segmentType=${segmentType}` : ''}`,
    ),
  recommendations: (status: RecommendationStatus | 'ALL' = 'ACTIVE') =>
    get<{ recommendations: StoredRecommendation[]; policy: IntelligencePolicy }>(
      `/agents/intelligence/recommendations?status=${status}`,
    ),
  /** ADMIN. Declines the advice. Changes no measurement and no pursuit. */
  dismiss: async (id: string, reason: string) => {
    const res = await api.post(`/agents/intelligence/recommendations/${id}/dismiss`, { reason })
    return res.data.data as { recommendation: StoredRecommendation }
  },
  acknowledge: async (id: string) => {
    const res = await api.post(`/agents/intelligence/recommendations/${id}/acknowledge`, {})
    return res.data.data as { recommendation: StoredRecommendation; acknowledged: boolean }
  },
}

/**
 * Render a rate the backend computed.
 *
 * A null rate is NOT 0% — it means the backend declined to state one. Every
 * caller must pass through here so that distinction cannot be lost in a
 * template.
 */
export function formatRate(rate: number | null | undefined): string {
  if (rate == null) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

/** The sentence shown wherever a sample is too small. Uses backend numbers. */
export function insufficientSampleMessage(sampleSize: number, minimumSampleSize: number): string {
  const needed = Math.max(0, minimumSampleSize - sampleSize)
  return `${sampleSize} confirmed outcome${sampleSize === 1 ? ' is' : 's are'} available. ` +
    `${minimumSampleSize} are required before a win-rate conclusion is reported` +
    (needed > 0 ? ` — ${needed} more needed.` : '.')
}
