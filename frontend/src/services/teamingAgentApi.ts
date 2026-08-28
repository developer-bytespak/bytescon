// =============================================================
// §7.5 — Teaming Agent API client.
//
// Every figure here is COMPUTED BY THE BACKEND. The frontend never matches a
// partner, ranks a candidate, computes a rate, decides a risk state, or
// proposes a workshare.
//
// There is deliberately no send method and no execute method: the agent has no
// such endpoint, and neither does this client.
// =============================================================
import { api } from './api'

export type RiskState = 'ON_TRACK' | 'WATCH' | 'AT_RISK' | 'MISSED' | 'INSUFFICIENT_DATA'
export type DataSufficiency = 'INSUFFICIENT_DATA' | 'PARTIAL' | 'SUFFICIENT'
export type GapSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR'

export interface TeamingPlanGap {
  gapId: string
  requirement: string
  gapClass: string
  severity: GapSeverity
  evidence: string
  dataSufficiency: string
  /** A matched partner is proposed mitigation. It never closes the gap. */
  mitigationStatus: 'UNRESOLVED' | 'PROPOSED_MITIGATION' | 'HUMAN_APPROVED_ARRANGEMENT'
}

export interface PerformanceSummary {
  available: boolean
  sampleSize: number
  dataSufficiency: DataSufficiency
  /** Always a fraction, e.g. "8 of 10 (80%)" — never a bare percentage. */
  onTime: string
  acceptance: string
  detail: string
}

export interface TeamingPlanCandidate {
  partnerId: string
  name: string
  overallFit: number
  dimensions: Array<{ dimension: string; points: number; detail: string }>
  matchingCapabilities: string[]
  missingRequirements: string[]
  certifications: {
    claimed: string[]
    requiredForSetAside: string | null
    met: boolean
    detail: string
    /** UNVERIFIED_SELF_DECLARED | NONE_RECORDED — never "verified". */
    verificationState: string
  }
  geography: { level: string; detail: string }
  relevantExperience: { priorTeamedBids: number; priorWins: number; detail: string }
  performanceSummary: PerformanceSummary
  evidence: string
  limitations: string[]
  eligibilityState: 'POSSIBLY_ELIGIBLE' | 'INSUFFICIENT_DATA' | 'NOT_ESTABLISHED'
}

export interface ProposedWorkshare {
  status: 'SUPPLIED' | 'PROPOSED' | 'NOT_AVAILABLE'
  primePercent: number | null
  partnerPercent: number | null
  description: string | null
  rationale: string | null
  limitations: string[]
}

export interface TeamingPlan {
  artifactId: string
  generatedAt: string
  pursuitId: string
  opportunityId: string
  opportunityTitle: string
  methodVersion: string
  capabilityGaps: TeamingPlanGap[]
  partnerCandidates: TeamingPlanCandidate[]
  noSuitablePartner: boolean
  /** Present only when true. Describes the NETWORK, never the market. */
  noSuitablePartnerMessage: string | null
  proposedWorkshare: ProposedWorkshare
  drafts: Array<{
    draftId: string
    documentType: string
    status: string
    source: string
    legalReviewRequired: boolean
    executionAllowed: boolean
    banner: string
    partnerId: string
  }>
  outreachDrafts: Array<{
    draftId: string
    partnerId: string
    status: string
    source: string
    sendAllowed: boolean
    humanSendRequired: boolean
    subject: string | null
  }>
  subcontractingGoals: Array<{
    goalId: string
    goalType: string
    targetType: string
    target: string | null
    achieved: string | null
    remaining: string | null
    riskState: RiskState
    dataSufficiency: DataSufficiency
    dueDate: string | null
    workingDaysRemaining: number | null
    isHumanVerified: boolean
    source: string
    limitations: string[]
  }>
  obligationDeadlines: Array<{ goalId: string; dueDate: string; workingDaysRemaining: number | null; riskState: RiskState }>
  partnerPerformance: Array<{
    partnerId: string
    partnerName: string
    sampleSize: number
    dataSufficiency: DataSufficiency
    onTime: string
    acceptance: string
    declineDetected: boolean
    detail: string
  }>
  notifications: string[]
  escalations: string[]
  warnings: string[]
  dataLimitations: string[]
}

export interface TeamingAgentView {
  agentKey: 'TEAMING'
  pursuit: {
    id: string
    opportunityId: string
    pipelineStage: string
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
  /** null = the agent has not planned this pursuit yet. */
  plan: TeamingPlan | null
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
  policy: {
    policyVersion: string
    minimumPerformanceSample: number
    atRiskWorkingDays: number
    legalReviewBanner: string
    noSuitablePartnerMessage: string
    notes: string[]
  }
}

export interface SubcontractingGoalRow {
  id: string
  goalType: string
  category: string | null
  targetType: 'PERCENT' | 'AMOUNT'
  targetPercent: string | null
  targetAmount: string | null
  source: string
  sourceReference: string | null
  dueDate: string | null
  status: string
  isHumanVerified: boolean
  notes: string | null
  progress: Array<{
    id: string
    eligibleBaseAmount: string | null
    achievedAmount: string | null
    achievedPercent: string | null
    remainingAmount: string | null
    remainingPercent: string | null
    riskState: RiskState
    dataSufficiency: DataSufficiency
    workingDaysRemaining: number | null
    limitations: string[]
    calculatedAt: string
  }>
}

export interface PartnerPerformanceRow {
  id: string
  partnerId: string
  partner: { id: string; name: string }
  periodStart: string
  periodEnd: string
  engagementCount: number
  deliverablesDue: number
  deliverablesOnTime: number
  deliverablesLate: number
  deliverablesAccepted: number
  deliverablesRejected: number
  issuesRaised: number
  sampleSize: number
  dataSufficiency: DataSufficiency
  computedMetrics: {
    onTimeRate?: { numerator: number; denominator: number; percent: number | null }
    acceptanceRate?: { numerator: number; denominator: number; percent: number | null }
    issueRate?: { numerator: number; denominator: number; percent: number | null }
  }
  derivedLabel: string | null
  isHumanVerified: boolean
  humanNotes: string | null
}

async function get<T>(url: string): Promise<T> {
  const res = await api.get(url)
  return res.data.data as T
}

export const teamingAgentApi = {
  plan: (pursuitId: string) => get<TeamingAgentView>(`/agents/teaming/plan/${pursuitId}`),
  goals: (pursuitId?: string) =>
    get<{ goals: SubcontractingGoalRow[] }>(
      `/agents/teaming/goals${pursuitId ? `?pursuitId=${encodeURIComponent(pursuitId)}` : ''}`,
    ),
  performance: (partnerId?: string) =>
    get<{ records: PartnerPerformanceRow[] }>(
      `/agents/teaming/performance${partnerId ? `?partnerId=${encodeURIComponent(partnerId)}` : ''}`,
    ),
  createGoal: async (body: Record<string, unknown>) => {
    const res = await api.post('/agents/teaming/goals', body)
    return res.data.data as { goal: SubcontractingGoalRow }
  },
  updateGoal: async (id: string, body: Record<string, unknown>) => {
    const res = await api.patch(`/agents/teaming/goals/${id}`, body)
    return res.data.data as { goal: SubcontractingGoalRow }
  },
}
