// =============================================================
// §7.7 — Proposal Agent API client.
//
// Every state here is COMPUTED BY THE BACKEND. The frontend never decides
// coverage, never scores relevance, never judges readiness, and never derives
// a draft state from text it happens to have.
//
// There is deliberately no approve method, no verify method, no select method
// and no submit method on the AGENT surface: the agent has no such endpoint.
// Section approval lives on the human proposal API, where it has always lived.
// =============================================================
import { api } from './api'

export type DraftState = 'NO_DRAFT' | 'SKELETON_ONLY' | 'AI_DRAFT_PENDING_REVIEW' | 'HUMAN_DRAFT' | 'APPROVED'
export type CoverageState = 'COVERED' | 'PARTIAL' | 'SKELETON_ONLY' | 'UNMAPPED' | 'HUMAN_REVIEW_REQUIRED'
export type SourceMaterialState = 'SUFFICIENT' | 'SOURCE_MATERIAL_REQUIRED'
export type OutlineCoverageState = 'COMPLETE' | 'GAPS_PRESENT' | 'NO_REQUIREMENTS'

export interface SectionStatus {
  sectionId: string
  title: string
  sectionNumber: string | null
  ownerUserId: string | null
  reviewerUserId: string | null
  currentVersionId: string | null
  currentVersionStatus: string
  draftState: DraftState
  sourceMaterialState: SourceMaterialState
  coverageState: CoverageState
  requirementIds: string[]
  mandatoryRequirementIds: string[]
  reviewState: string
  overdue: boolean
  /** An approved section. The agent may not write over it. */
  isLocked: boolean
}

export interface CycleSummary {
  cycleId: string
  cycleType: string
  status: string
  startedAt: string
  closedAt: string | null
  approverUserId: string | null
  workingDaysOpen: number | null
  isClosed: boolean
  hasStalled: boolean
  openComments: number
  blockerComments: number
  nextAction: string
}

export interface SectionReviewState {
  sectionId: string
  title: string
  status: string
  ownerUserId: string | null
  reviewerUserId: string | null
  submittedForReviewAt: string | null
  workingDaysInReview: number | null
  isOverdue: boolean
  reviewerAssignmentRequired: boolean
  dueDate: string | null
}

export interface ProposalStatus {
  artifactId: string
  generatedAt: string
  opportunityId: string
  proposalId: string
  methodVersion: string
  outline: {
    totalItems: number
    mandatoryRequirements: number
    mappedMandatoryRequirements: number
    unmappedMandatoryRequirements: Array<{ requirementId: string; section: string; reason: string }>
    coverageState: OutlineCoverageState
    ambiguities: string[]
  }
  sections: SectionStatus[]
  drafting: {
    providerAvailable: boolean
    sectionsReadyForDraft: number
    sectionsDrafted: number
    sectionsNeedingSourceMaterial: number
    limitations: string[]
  }
  capabilityLibrary: {
    narratives: number
    approvedVersions: number
    draftVersions: number
    narrativesWithoutApproval: number
    available: boolean
    detail: string
  }
  pastPerformance: {
    /** Candidates. A person still makes the final selection. */
    proposedSelections: Array<{ recordId: string; title: string; relevanceScore: number; confidence: string; explanation: string }>
    approvedSelections: Array<{ recordId: string; selectedByUserId: string | null }>
    adaptedDrafts: number
    unsupportedClaims: Array<{ recordId: string; claim: string; reason: string }>
  }
  compliance: {
    deterministicBlockers: string[]
    aiFindings: Array<{
      requirementId: string
      sectionId: string | null
      verdict: string
      evidence: Array<{ sourceType: string; sourceId: string; sourceReference: string | null; explanation: string }>
    }>
    uncoveredMandatoryRequirements: string[]
    legalReviewItems: string[]
    manualRequiredChecks: string[]
    /** Says in words that an AI finding never marks a requirement verified. */
    aiAdvisoryNote: string
  }
  reviewCycles: CycleSummary[]
  sectionReviews: SectionReviewState[]
  adherence: { score: number | null; state: string; limitations: string[] }
  submissionReadiness: { state: string; blockers: string[]; manualRequired: string[] }
  recommendedHumanActions: string[]
  warnings: string[]
  dataLimitations: string[]
  inputHash: string
}

export interface ProposalAgentView {
  agentKey: 'PROPOSAL'
  proposal: {
    id: string
    opportunityId: string
    title: string
    status: string
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
  /** null = the agent has not assessed this proposal yet. */
  status: ProposalStatus | null
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
    riskWindowWorkingDays: number
    maxSectionsDraftedPerRun: number
    reviewOverdueWorkingDays: number
    cycleStallWorkingDays: number
    cycleOrder: string[]
    minCapabilityRelevance: number
    maxSourcesPerSection: number
    notes: string[]
  }
}

export interface CapabilityNarrativeVersion {
  id: string
  versionNumber: number
  content: string
  contentHash: string
  status: 'DRAFT' | 'APPROVED' | 'ARCHIVED'
  sourceReferences: string[]
  approvedByUserId: string | null
  approvedAt: string | null
  createdAt: string
}

export interface CapabilityNarrative {
  id: string
  title: string
  category: string
  status: string
  capabilityKeys: string[]
  naicsCodes: string[]
  agencyTags: string[]
  tags: string[]
  currentApprovedVersionId: string | null
  createdByUserId: string | null
  updatedAt: string
  versions: CapabilityNarrativeVersion[]
}

async function get<T>(url: string): Promise<T> {
  const res = await api.get(url)
  return res.data.data as T
}

export const proposalAgentApi = {
  status: (proposalId: string) => get<ProposalAgentView>(`/agents/proposal/status/${proposalId}`),
  library: (includeArchived = false) =>
    get<{ narratives: CapabilityNarrative[] }>(
      `/agents/proposal/library${includeArchived ? '?includeArchived=true' : ''}`,
    ),
  createNarrative: async (body: Record<string, unknown>) => {
    const res = await api.post('/agents/proposal/library', body)
    return res.data.data as { narrative: CapabilityNarrative }
  },
  addVersion: async (narrativeId: string, body: { content: string; sourceReferences?: string[] }) => {
    const res = await api.post(`/agents/proposal/library/${narrativeId}/versions`, body)
    return res.data.data as { version: CapabilityNarrativeVersion }
  },
  /** ADMIN only. This is the human act that makes wording quotable. */
  approveVersion: async (versionId: string) => {
    const res = await api.post(`/agents/proposal/library/versions/${versionId}/approve`, {})
    return res.data.data as { version: CapabilityNarrativeVersion }
  },
  archiveNarrative: async (narrativeId: string) => {
    const res = await api.post(`/agents/proposal/library/${narrativeId}/archive`, {})
    return res.data.data as { narrative: CapabilityNarrative }
  },
}
