// =============================================================
// §7.3 — Compliance Agent API client.
//
// Every compliance state below is COMPUTED BY THE BACKEND and rendered as-is.
// The frontend never decides whether something is BLOCKED, never computes an
// expiry, never derives bonding headroom, and never resolves a flow-down.
// =============================================================
import { api } from './api'

export type ComplianceOverallStatus =
  | 'COMPLIANT_CURRENT' | 'ATTENTION_REQUIRED' | 'HUMAN_REVIEW_REQUIRED' | 'BLOCKED' | 'INSUFFICIENT_DATA'

export type BondingState = 'SUFFICIENT' | 'INSUFFICIENT' | 'EXPIRED' | 'MISSING' | 'INSUFFICIENT_DATA'

export type ExpiryStatus = 'ACTIVE' | 'EXPIRING_SOON' | 'EXPIRED' | 'MISSING'

export interface BondingAssessment {
  recordId: string | null
  suretyName: string | null
  singleProjectLimit: string | null
  aggregateLimit: string | null
  committedAmount: string | null
  availableCapacity: string | null
  effectiveDate: string | null
  expiryDate: string | null
  daysUntilExpiry: number | null
  status: string | null
  state: BondingState
  reasons: string[]
}

export interface BondingRecord {
  id: string
  suretyName: string | null
  singleProjectLimit: string | null
  aggregateLimit: string | null
  committedAmount: string | null
  effectiveDate: string | null
  expiryDate: string | null
  status: 'ACTIVE' | 'EXPIRED' | 'ARCHIVED'
  evidenceReference: string | null
  notes: string | null
  recordedByUserId: string | null
  verifiedByUserId: string | null
  verifiedAt: string | null
  createdAt: string
  updatedAt: string
  assessment: BondingAssessment
}

export interface OpportunityComplianceRow {
  opportunityId: string
  pursuitId: string | null
  title: string
  agency: string
  responseDeadline: string | null
  workingDaysToDeadline: number | null
  pipelineStage: string | null
  matrix: {
    totalRequirements: number
    mandatoryRequirements: number
    verifiedRequirements: number
    unverifiedRequirements: number
    incompleteRequirements: number
    coveragePercent: number
  }
  lmCoverage: {
    instructions: number
    evaluationCriteria: number
    clearlyMapped: number
    reviewRequired: number
    unmapped: number
    gaps: string[]
  }
  clauses: { total: number; reviewRequired: number; verified: number; unresolvedFlowDowns: number }
  extraction: {
    latestJobId: string | null
    status: string | null
    progressPercent: number | null
    attempt: number | null
    maxAttempts: number | null
    parseWarnings: string[]
    aiEnhanced: boolean
    note: string
  }
  amendment: {
    latestRevisionId: string | null
    latestRevisionNo: number | null
    changedRequirements: number
    changedClauses: number
    changedLmCriteria: number
    unresolvedImpacts: number
    conflictsWithVerified: number
    workingDaysToDeadline: number | null
    humanReviewRequired: boolean
    analysisBasis: string
  } | null
  submission: {
    submissionId: string | null
    automatedPasses: number
    failures: number
    manualRequired: number
    unsupported: number
    blockers: string[]
  }
  certificationWarnings: string[]
  overallStatus: ComplianceOverallStatus
  statusReasons: string[]
}

export interface ComplianceStatus {
  artifactId: string
  runId: string
  generatedAt: string
  summary: string | null
  registration: {
    samStatus: string
    samExpiry: string | null
    samDaysUntilExpiry: number | null
    samExpiryStatus: string
    samDataFreshness: string
    certifications: Array<{ id: string; name: string; expiryDate: string | null; expiryStatus: ExpiryStatus; daysUntilExpiry: number | null }>
    insurance: Array<{ id: string; policyType: string; expiryDate: string | null; expiryStatus: ExpiryStatus; daysUntilExpiry: number | null }>
    bondingCapacity: BondingAssessment
  }
  documents: {
    reusable: number
    expiring: number
    expired: number
    missing: number
    items: Array<{ id: string; name: string; category: string; expiryState: string; expiryMessage: string; approvedForReuse: boolean }>
  }
  opportunities: OpportunityComplianceRow[]
  totals: {
    opportunitiesAssessed: number
    blocked: number
    humanReviewRequired: number
    attentionRequired: number
    compliant: number
    insufficientData: number
  }
  overallStatus: ComplianceOverallStatus
  statusReasons: string[]
  llm: { aiExtractionAvailable: boolean; budgetExhausted: boolean; note: string }
  warnings: string[]
  dataLimitations: string[]
}

export interface ComplianceAgentLatest {
  agentKey: 'COMPLIANCE'
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
  /** null = the agent has not produced a status yet. Never rendered as healthy. */
  status: ComplianceStatus | null
  registration: {
    sam: {
      status: string
      expiryDate: string | null
      daysUntilExpiry: number | null
      expiryStatus: ExpiryStatus
      withinEscalationWindow: boolean
      missing: boolean
      dataFreshness: string
    }
    certifications: Array<{ id: string; name: string; expiryDate: string | null; expiryStatus: ExpiryStatus; daysUntilExpiry: number | null }>
    insurance: Array<{ id: string; policyType: string; expiryDate: string | null; expiryStatus: ExpiryStatus; daysUntilExpiry: number | null }>
    bonding: BondingAssessment
    health: { active: number; expiringSoon: number; expired: number; missing: number; total: number }
    blockers: string[]
    attention: string[]
    insufficient: string[]
  }
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
    samExpiryEscalationDays: number
    amendmentDeadlineWorkingDays: number
    mandatoryGapBlockerWorkingDays: number
    minMappingSimilarity: number
    clearMappingSimilarity: number
    notes: string[]
  }
}

export interface OpportunityComplianceView {
  opportunity: { id: string; title: string; agency: string; responseDeadline: string | null }
  compliance: OpportunityComplianceRow | null
  generatedAt: string | null
  artifactId: string | null
  runId: string | null
  lastRun: ComplianceAgentLatest['lastRun']
  escalations: ComplianceAgentLatest['escalations']
  policy: ComplianceAgentLatest['policy']
}

export interface BondingInput {
  suretyName?: string | null
  singleProjectLimit?: string | null
  aggregateLimit?: string | null
  committedAmount?: string | null
  effectiveDate?: string | null
  expiryDate?: string | null
  status?: 'ACTIVE' | 'EXPIRED' | 'ARCHIVED'
  evidenceReference?: string | null
  notes?: string | null
}

async function get<T>(url: string): Promise<T> {
  const res = await api.get(url)
  return res.data.data as T
}

export const complianceAgentApi = {
  getLatest: () => get<ComplianceAgentLatest>('/agents/compliance/latest'),
  getOpportunity: (opportunityId: string) =>
    get<OpportunityComplianceView>(`/agents/compliance/opportunity/${opportunityId}`),
  listBonding: () => get<{ records: BondingRecord[] }>('/agents/compliance/bonding'),
  createBonding: async (input: BondingInput) => {
    const res = await api.post('/agents/compliance/bonding', input)
    return res.data.data as BondingRecord
  },
  updateBonding: async (id: string, input: BondingInput) => {
    const res = await api.put(`/agents/compliance/bonding/${id}`, input)
    return res.data.data as BondingRecord
  },
  archiveBonding: async (id: string) => {
    const res = await api.post(`/agents/compliance/bonding/${id}/archive`)
    return res.data.data as BondingRecord
  },
}
