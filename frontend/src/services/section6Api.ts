// =============================================================
// §6 — API client for the four-pillar enhancement endpoints.
//
// Uses the shared `api` axios instance so auth, 401 handling and paywall
// events behave exactly as everywhere else. All types mirror the backend
// responses; nothing is recomputed on the client — the backend stays the
// single source of truth for every score, state and aggregate.
// =============================================================
import { api } from './api'

// -------------------------------------------------------------
// Shared
// -------------------------------------------------------------

export type EligibilityState =
  | 'ELIGIBLE' | 'POSSIBLY_ELIGIBLE' | 'NOT_ELIGIBLE'
  | 'EXPIRING_BEFORE_DEADLINE' | 'INSUFFICIENT_DATA'

export type ExpiryState =
  | 'VALID' | 'EXPIRES_BEFORE_SUBMISSION' | 'EXPIRES_BEFORE_AWARD'
  | 'EXPIRES_DURING_BASE_PERIOD' | 'EXPIRES_DURING_OPTION_PERIOD'
  | 'EXPIRED' | 'NO_EXPIRY' | 'INSUFFICIENT_DATA'

export type ConfidenceState = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA'

async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res = await api.get(url, { params })
  return res.data.data as T
}
async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await api.post(url, body ?? {})
  return res.data.data as T
}

// -------------------------------------------------------------
// §6.1A — sources
// -------------------------------------------------------------

export interface AdapterInfo {
  key: string
  displayName: string
  category: string
  produces: 'OPPORTUNITY' | 'FORECAST'
  supportsIncremental: boolean
  coverageNote: string
  isDelegated: boolean
}

export interface SourceConfig {
  id: string
  adapterKey: string
  displayName: string
  category: string
  isEnabled: boolean
  baseUrl: string | null
  authEnvKey: string | null
  configJson: Record<string, unknown>
  lastRunAt: string | null
  lastSuccessfulSync: string | null
  lastFailureAt: string | null
  lastFailureMessage: string | null
  consecutiveFailures: number
  dataQuality: 'OK' | 'PARTIAL' | 'STALE' | 'ERROR' | 'UNVERIFIED'
  verification: 'LIVE_VERIFIED' | 'CONTRACT_ONLY' | 'NOT_CONFIGURED'
  stalenessHours: number
  coverageNote: string | null
  freshness: { isStale: boolean; ageHours: number | null; label: string }
  lastRun: SyncRun | null
}

export interface SyncRun {
  id: string
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED'
  mode: 'FULL' | 'INCREMENTAL'
  recordsFetched: number
  recordsCreated: number
  recordsUpdated: number
  recordsSkipped: number
  errorCount: number
  errorMessage: string | null
  rateLimited: boolean
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
}

export const discoveryApi = {
  listAdapters: () => get<AdapterInfo[]>('/discovery/adapters'),
  listSources: () => get<SourceConfig[]>('/discovery/sources'),
  createSource: (body: Record<string, unknown>) => post<SourceConfig>('/discovery/sources', body),
  updateSource: async (id: string, body: Record<string, unknown>) => {
    const res = await api.put(`/discovery/sources/${id}`, body)
    return res.data.data as SourceConfig
  },
  syncSource: (id: string, mode: 'FULL' | 'INCREMENTAL' = 'INCREMENTAL') =>
    post<{ status: string; recordsCreated: number; recordsUpdated: number; errorMessage: string | null }>(`/discovery/sources/${id}/sync`, { mode }),
  listRuns: (id: string) => get<SyncRun[]>(`/discovery/sources/${id}/runs`),

  // §6.1B
  listForecasts: (params?: Record<string, unknown>) =>
    get<{ items: Forecast[]; total: number; page: number; pageSize: number; recordKind: string; disclaimer: string }>('/discovery/forecasts', params),
  getForecast: (id: string) => get<Forecast>(`/discovery/forecasts/${id}`),
  linkForecasts: () => post<{ examined: number; autoLinked: number; flaggedForReview: number }>('/discovery/forecasts/link'),
  decideForecastLink: (id: string, body: { decision: 'CONFIRM' | 'REJECT'; opportunityId?: string; reason?: string }) =>
    post<Forecast>(`/discovery/forecasts/${id}/link-decision`, body),

  // §6.1C
  listRecompetes: (params?: Record<string, unknown>) =>
    get<{ signals: RecompeteSignal[]; disclaimer: string }>('/discovery/recompetes', params),
  detectRecompetes: () => post<{ created: number; updated: number; skippedVerified: number }>('/discovery/recompetes/detect'),
  decideRecompete: async (id: string, body: { verification: 'VERIFIED' | 'CORRECTED' | 'DISMISSED'; reason?: string }) => {
    const res = await api.patch(`/discovery/recompetes/${id}`, body)
    return res.data.data as RecompeteSignal
  },

  // §6.1D
  listNotices: (params?: Record<string, unknown>) => get<PreSolicitationNotice[]>('/discovery/notices', params),

  // §6.1E
  listCapabilities: () => get<FirmCapability[]>('/discovery/capabilities'),
  createCapability: (body: Record<string, unknown>) => post<FirmCapability>('/discovery/capabilities', body),
  verifyCapability: (id: string, verification: 'VERIFIED' | 'REJECTED' | 'UNVERIFIED') =>
    post<FirmCapability>(`/discovery/capabilities/${id}/verify`, { verification }),
  archiveCapability: (id: string) => post<FirmCapability>(`/discovery/capabilities/${id}/archive`),

  // §6.1E/F
  getMatch: (opportunityId: string) => get<OpportunityMatch>(`/discovery/match/${opportunityId}`),
  refreshMatch: (opportunityId: string) => post<OpportunityMatch>(`/discovery/match/${opportunityId}/refresh`),
}

export interface Forecast {
  id: string
  externalId: string
  agency: string
  subAgency: string | null
  title: string
  description: string | null
  anticipatedSolicitationDate: string | null
  anticipatedAwardDate: string | null
  fiscalYear: number | null
  naicsCode: string | null
  psc: string | null
  setAsideExpectation: string | null
  contractVehicle: string | null
  estimatedValue: string | null
  incumbentName: string | null
  placeOfPerformance: string | null
  sourceUrl: string | null
  completeness: number
  dataQuality: string
  lastSeenAt: string
  lastSyncedAt: string | null
  linkState: 'UNLINKED' | 'AUTO_LINKED' | 'REVIEW_REQUIRED' | 'HUMAN_CONFIRMED' | 'HUMAN_REJECTED'
  linkEvidence: string | null
  linkConfidence: number | null
  linkedOpportunity: { id: string; title: string; responseDeadline: string } | null
  versions?: Array<{ versionNo: number; changedKeys: string[]; observedAt: string }>
}

export interface RecompeteSignal {
  id: string
  incumbentName: string | null
  agency: string | null
  contractNumber: string | null
  naicsCode: string | null
  popEndDate: string | null
  finalPossibleEndDate: string | null
  optionPeriodCount: number
  optionPeriodsRemaining: number
  windowStart: string | null
  windowEnd: string | null
  leadDays: number
  evidence: unknown
  confidence: 'CONFIRMED' | 'PROBABLE' | 'AMBIGUOUS' | 'NOT_AVAILABLE'
  confidenceReason: string | null
  detectionMethod: string
  lastCalculatedAt: string
  verification: 'UNVERIFIED' | 'VERIFIED' | 'CORRECTED' | 'DISMISSED'
  dismissedReason: string | null
  originalWindowStart: string | null
  originalWindowEnd: string | null
}

export interface PreSolicitationNotice {
  id: string
  title: string
  agency: string
  noticeType: string | null
  presolicitationKind: string | null
  responseDeadline: string
  postedDate: string | null
  sourceUrl: string | null
  source: string
  sourceLastSeenAt: string | null
  dataQuality: string
  naicsCode: string
  setAsideType: string
  amendmentCount: number
  ownerUserId: string | null
  match: { overallScore: number; eligibility: EligibilityState; eligibilityReason: string; hasSufficientData: boolean } | null
  classification: {
    kind: string | null
    label: string
    basis: string
    whyEarlyResponseMayMatter: string | null
    priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  }
}

export interface FirmCapability {
  id: string
  name: string
  category: string
  description: string | null
  keywords: string[]
  naicsCodes: string[]
  pscCodes: string[]
  geographies: string[]
  contractVehicles: string[]
  concurrentCapacity: number | null
  capacityNote: string | null
  verification: 'UNVERIFIED' | 'VERIFIED' | 'REJECTED'
  isArchived: boolean
}

export interface OpportunityMatch {
  id: string
  overallScore: number
  capabilityScore: number | null
  naicsScore: number | null
  pscScore: number | null
  certificationScore: number | null
  pastPerformanceScore: number | null
  geographyScore: number | null
  vehicleScore: number | null
  keywordScore: number | null
  matchedCapabilityIds: string[]
  missingCapabilities: string[]
  capacityWarning: string | null
  evidence: {
    dimensions: MatchDimension[]
    /** §7.2 — BASE, or PURSUIT_ADJUSTED when an ADMIN applied a learned weighting. */
    weightProfile?: 'BASE' | 'PURSUIT_ADJUSTED'
    appliedPursuitSignalId?: string | null
    /** The same evidence scored under the unadjusted Section 6 weighting. */
    baseOverallScore?: number
    learnedAdjustmentNote?: string
  }
  dataLimitations: string[]
  hasSufficientData: boolean
  eligibility: EligibilityState
  eligibilityReason: string
  eligibilityEvidence: {
    evidence: Array<{ source: string; detail: string }>
    requiredCertKeys: string[]
    partnerCoverage: Array<{ partnerId: string; partnerName: string; certKey: string }>
    disclaimer: string
  }
  expiringCertificationIds: string[]
  matchMethod: string
  methodVersion: string
  calculatedAt: string
}

export interface MatchDimension {
  key: string
  score: number | null
  weight: number
  evidence: string
  absentReason?: string
}

// -------------------------------------------------------------
// §6.2 — scoring intelligence
// -------------------------------------------------------------

export interface ExplainedScore {
  rawScore: number
  finalScore: number
  scoreType: 'RAW' | 'CALIBRATED' | 'FALLBACK'
  modelVersion: string
  factors: Array<{ key: string; label: string; contribution: number | null; direction: string; explanation: string }>
  positiveDrivers: Array<{ label: string; contribution: number | null }>
  negativeDrivers: Array<{ label: string; contribution: number | null }>
  missingInputs: string[]
  dataQuality: { completeness: number; sufficiency: string; note: string }
  calibration: {
    applied: 'TENANT' | 'GLOBAL' | 'NONE'
    tenantVersion: number | null
    tenantSampleSize: number | null
    tenantBrier: number | null
    tenantBaselineBrier: number | null
    reason: string
  }
  interval: {
    lower: number | null
    point: number
    upper: number | null
    available: boolean
    confidence: ConfidenceState
    reason: string
    method: string
    binSampleSize: number
    tenantSampleSize: number
    unavailableLabel: string | null
  }
  lastCalculatedAt: string
  explanation: string
}

export interface PortfolioSummary {
  activeOpportunityCount: number
  totalNominalValue: number
  weightedExpectedValue: number
  lowerExpectedValue: number | null
  upperExpectedValue: number | null
  intervalPartial: boolean
  byValueType: Record<string, { count: number; nominal: number; expected: number }>
  byAgency: Array<{ key: string; count: number; nominal: number; expected: number }>
  byNaics: Array<{ key: string; count: number; nominal: number; expected: number }>
  byPipelineStage: Array<{ key: string; count: number; nominal: number; expected: number }>
  byOwner: Array<{ key: string; count: number; nominal: number; expected: number }>
  byPeriod: Array<{ key: string; count: number; nominal: number; expected: number }>
  highValueHighUncertainty: PortfolioRow[]
  concentration: { agencyHhi: number | null; naicsHhi: number | null; topAgencyShare: number | null; interpretation: string }
  upcomingDeadlines: Array<{ opportunityId: string; title: string; responseDeadline: string; daysRemaining: number }>
  capacityConflicts: Array<{ date: string; count: number; opportunityIds: string[] }>
  exclusions: Array<{ opportunityId: string; title: string; reason: string }>
  rows: PortfolioRow[]
  methodVersion: string
  calculatedAt: string
  valueHierarchy: Array<{ key: string; type: string; description: string }>
}

export interface PortfolioRow {
  opportunityId: string
  title: string
  agency: string
  naicsCode: string
  value: number
  valueSource: string
  valueType: string
  probability: number
  probabilityLower: number | null
  probabilityUpper: number | null
  expectedValue: number
  expectedValueLower: number | null
  expectedValueUpper: number | null
  pipelineStage: string | null
  ownerUserId: string | null
  responseDeadline: string
  eligibility: EligibilityState | null
  intervalAvailable: boolean
}

export interface CalibrationStatus {
  featureEnabled: boolean
  active: { id: string; version: number; sampleSize: number; activatedAt: string | null; brierScore: number | null; baselineBrierScore: number | null; isStale: boolean } | null
  versions: Array<{
    id: string; version: number; state: string; sampleSize: number; holdoutSize: number
    brierScore: number | null; baselineBrierScore: number | null; improvement: number | null
    activationReason: string | null; rejectionReason: string | null; createdAt: string
  }>
  verifiedSampleCount: number
  note: string
}

export interface CompetitorStat {
  id: string
  competitorName: string
  agency: string | null
  naicsCode: string | null
  observedAwards: number
  comparableAwardPool: number
  confirmedWins: number
  confirmedLosses: number
  confirmedBids: number
  confirmedWinRate: number | null
  observedAwardShare: number | null
  basis: string
  basisLabel: string
  isIncumbent: boolean
  sampleSize: number
  confidence: string
  explanation: string
  lastRefreshedAt: string
}

export interface RetentionStat {
  id: string
  incumbentName: string
  agency: string | null
  naicsCode: string | null
  similarAwardCount: number
  retainedCount: number
  lostRecompeteCount: number
  retentionRate: number | null
  agencyRetentionRate: number | null
  basis: string
  sampleSize: number
  confidence: string
  explanation: string
  lastRefreshedAt: string
}

export interface SensitivityAnalysis {
  id: string
  benchmarkValue: string | null
  benchmarkSource: string | null
  basePrice: string | null
  baseProbability: number | null
  points: Array<{
    label: string; price: string; pricePosition: number; percentOfBenchmark: number
    probability: number; lower: number | null; upper: number | null; isBase: boolean
  }>
  assumptions: string[]
  validity: 'CALIBRATED' | 'UNVALIDATED_SCENARIO_ANALYSIS' | 'INSUFFICIENT_DATA'
  isMonotonic: boolean
  sampleSize: number
  calculatedAt: string
}

export interface GapAssessment {
  confirmedCoverage: string[]
  partialCoverage: string[]
  missingCapabilities: string[]
  missingCertifications: string[]
  missingEligibility: string[]
  capacityGaps: string[]
  geographyGaps: string[]
  vehicleGaps: string[]
  partnerRecommendations: Array<{
    partnerId: string; partnerName: string; gapCloseScore: number
    closes: string[]; remainingGaps: string[]; worksharConsiderations: string[]; why: string
  }>
  limitations: string[]
  calculatedAt?: string
}

export const scoringApi = {
  getScore: (opportunityId: string) => get<ExplainedScore>(`/scoring-intel/score/${opportunityId}`),
  getCalibration: () => get<CalibrationStatus>('/scoring-intel/calibration'),
  fitCalibration: () => post<{ activated: boolean; reason: string; sampleSize: number; brierScore: number | null; baselineBrierScore: number | null }>('/scoring-intel/calibration/fit'),
  rollbackCalibration: () => post<{ restoredId: string | null; reason: string }>('/scoring-intel/calibration/rollback'),
  listRetention: () => get<{ stats: RetentionStat[]; note: string }>('/scoring-intel/incumbent-retention'),
  listCompetitors: () => get<{ stats: CompetitorStat[]; basisLabels: Record<string, string>; note: string }>('/scoring-intel/competitors'),
  refreshEvidence: () => post<{ retention: unknown; competitors: unknown }>('/scoring-intel/evidence/refresh'),
  getSensitivity: (opportunityId: string) => get<SensitivityAnalysis | null>(`/scoring-intel/pricing-sensitivity/${opportunityId}`),
  runSensitivity: (opportunityId: string, body: { percentAdjustments?: number[]; extraScenarios?: Array<{ name: string; totalPrice: string }> }) =>
    post<SensitivityAnalysis>(`/scoring-intel/pricing-sensitivity/${opportunityId}`, body),
  getGaps: (opportunityId: string) => get<GapAssessment | null>(`/scoring-intel/gaps/${opportunityId}`),
  refreshGaps: (opportunityId: string) => post<GapAssessment>(`/scoring-intel/gaps/${opportunityId}/refresh`),
  getPortfolio: (params?: Record<string, unknown>) => get<PortfolioSummary>('/scoring-intel/portfolio', params),
}

// -------------------------------------------------------------
// §6.3 — requirements intelligence
// -------------------------------------------------------------

export interface ExtractionJob {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'
  progressPercent: number
  progressStage: string | null
  parseMethod: string
  extractorVersion: string
  sourceHash: string | null
  attempt: number
  maxAttempts: number
  requirementsCreated: number
  requirementsSkipped: number
  clausesCreated: number
  milestonesCreated: number
  mappingsCreated: number
  unresolvedCount: number
  parseWarnings: string[]
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface LmCoverage {
  instructions: Array<{ id: string; section: string; text: string; mappedCount: number; proposalSectionId: string | null }>
  evaluations: Array<{ id: string; section: string; text: string; mappedCount: number }>
  unmappedInstructions: Array<{ id: string; section: string; text: string }>
  unmappedEvaluations: Array<{ id: string; section: string; text: string }>
  mappings: Array<{
    id: string; instructionSourceSection: string; evaluationSourceSection: string | null
    confidence: number; verification: 'UNVERIFIED' | 'CONFIRMED' | 'REJECTED'
    reviewRequired: boolean; reviewReason: string | null; relationshipExplanation: string | null
    proposalSectionId: string | null; origin: string
  }>
  gaps: string[]
  proposalCoverage: { mappedToProposalSection: number; total: number }
}

export interface ClauseObligation {
  id: string
  clauseNumber: string
  clauseTitle: string | null
  clauseSet: string
  sourceSection: string | null
  sourcePageNumber: number | null
  evidenceText: string | null
  applicability: string
  flowDownStatus: 'EXPLICIT_FLOWDOWN' | 'CONDITIONAL_FLOWDOWN' | 'NO_EXPLICIT_FLOWDOWN_FOUND' | 'REVIEW_REQUIRED'
  flowDownCondition: string | null
  affectedPartnerIds: string[]
  ownerUserId: string | null
  dueDate: string | null
  complianceStatus: string
  legalReviewRequired: boolean
  legalReviewedAt: string | null
  isManuallyVerified: boolean
}

export interface RequirementRow {
  id: string
  section: string
  sectionType: string
  requirementText: string
  status: string
  workflowState: string
  isMandatory: boolean
  ownerUserId: string | null
  reviewerUserId: string | null
  dueDate: string | null
  completionPercent: number
  isBlocked: boolean
  blockerReason: string | null
  verificationStatus: string
  isManuallyVerified: boolean
  reviewRequired: boolean
  reviewReason: string | null
  lmRole: string | null
  evidenceText: string | null
  sourcePageNumber: number | null
  extractionMethod: string
  extractionConfidence: number
  events: Array<{ action: string; fromValue: string | null; toValue: string | null; createdAt: string }>
}

export interface ValidationCheck {
  id: string
  checkKey: string
  checkLabel: string
  outcome: 'PASSED' | 'FAILED' | 'NOT_APPLICABLE' | 'MANUAL_REQUIRED' | 'UNSUPPORTED'
  method: 'AUTOMATED' | 'MANUAL' | 'UNSUPPORTED'
  expected: string | null
  actual: string | null
  evidence: string | null
  message: string
  isMandatory: boolean
  isBlocking: boolean
  validatorVersion: string
  runId: string
  performedAt: string
}

export interface StandingDocumentHealth {
  id: string
  name: string
  category: string
  expiryDate: string | null
  expiryState: ExpiryState
  expiryMessage: string
  approvedForReuse: boolean
  verification: string
  usageCount: number
  sourceSystem: string | null
  currentVersionNo: number
}

export interface DocumentVersion {
  id: string
  versionNo: number
  fileName: string | null
  fileType: string | null
  fileSize: number | null
  pageCount: number | null
  changeNote: string | null
  isCurrent: boolean
  createdAt: string
  uploadedByUserId: string | null
}

export const requirementsApi = {
  runExtraction: (opportunityId: string, body?: { documentId?: string | null; text?: string }) =>
    post<{ jobId: string; status: string; requirementsCreated: number; warnings: string[]; error?: string | null }>(`/requirements-intel/extraction/${opportunityId}`, body),
  listExtractionJobs: (opportunityId: string) => get<ExtractionJob[]>(`/requirements-intel/extraction/${opportunityId}`),
  cancelExtraction: (jobId: string) => post<{ cancelled: boolean }>(`/requirements-intel/extraction/job/${jobId}/cancel`),

  getLm: (opportunityId: string) => get<LmCoverage>(`/requirements-intel/lm/${opportunityId}`),
  deriveLm: (opportunityId: string) => post<{ created: number }>(`/requirements-intel/lm/${opportunityId}/derive`),
  decideMapping: async (id: string, body: { decision: 'CONFIRM' | 'REJECT'; reason?: string }) => {
    const res = await api.patch(`/requirements-intel/lm/mapping/${id}`, body)
    return res.data.data
  },
  createMapping: (body: { opportunityId: string; instructionRequirementId: string; evaluationRequirementId: string; reason?: string }) =>
    post('/requirements-intel/lm/mapping', body),

  listClauses: (opportunityId: string) => get<{ clauses: ClauseObligation[]; disclaimer: string }>(`/requirements-intel/clauses/${opportunityId}`),
  updateClause: async (id: string, body: Record<string, unknown>) => {
    const res = await api.patch(`/requirements-intel/clauses/${id}`, body)
    return res.data.data as ClauseObligation
  },

  listRequirements: (opportunityId: string) =>
    get<{ requirements: RequirementRow[]; summary: RequirementSummary | null; workflowStates: string[]; allowedTransitions: Record<string, string[]> }>(`/requirements-intel/requirements/${opportunityId}`),
  transitionRequirement: (id: string, body: { toStatus: string; note?: string }) =>
    post<RequirementRow>(`/requirements-intel/requirements/${id}/transition`, body),
  assignRequirement: (id: string, body: { ownerUserId?: string | null; reviewerUserId?: string | null; dueDate?: string | null }) =>
    post<RequirementRow>(`/requirements-intel/requirements/${id}/assign`, body),

  listDocuments: (params?: Record<string, unknown>) =>
    get<{ documents: StandingDocumentHealth[]; expiryLabels: Record<ExpiryState, string>; evaluatedAgainstOpportunityId: string | null }>('/requirements-intel/documents', params),
  createDocument: (body: Record<string, unknown>) => post('/requirements-intel/documents', body),
  syncDocuments: () => post<{ created: number; updated: number; note: string }>('/requirements-intel/documents/sync'),
  approveDocument: (id: string, approved: boolean) => post(`/requirements-intel/documents/${id}/approve`, { approved }),
  archiveDocument: (id: string) => post(`/requirements-intel/documents/${id}/archive`),
  documentUsage: (id: string) => get<{ links: Array<Record<string, unknown>> }>(`/requirements-intel/documents/${id}/usage`),
  documentVersions: (id: string) =>
    get<{ document: { id: string; name: string; currentVersionNo: number }; versions: DocumentVersion[] }>(
      `/requirements-intel/documents/${id}/versions`,
    ),
  /** A new version resets approval on purpose — the file people vetted has changed. */
  createDocumentVersion: (id: string, body: Record<string, unknown>) =>
    post(`/requirements-intel/documents/${id}/version`, body),

  validationCatalogue: () => get<Array<{ key: string; label: string; automatable: boolean; note?: string }>>('/requirements-intel/validation/catalogue'),
  runValidation: (submissionId: string) =>
    post<{ runId: string; passed: number; failed: number; manualRequired: number; unsupported: number; blockingFailures: number; readinessBlocked: boolean; checks: ValidationCheck[] }>(`/requirements-intel/validation/${submissionId}/run`),
  getValidation: (submissionId: string) =>
    get<{ latestRunId: string | null; latest: ValidationCheck[]; history: ValidationCheck[] }>(`/requirements-intel/validation/${submissionId}`),
  recordManualCheck: (submissionId: string, body: { checkKey: string; outcome: 'PASSED' | 'FAILED'; note: string; checklistItemId?: string | null }) =>
    post(`/requirements-intel/validation/${submissionId}/manual`, body),

  getExpiry: (opportunityId: string, optionCoverageRequired = false) =>
    get<{
      lifecycle: Record<string, unknown>
      optionCoverageRequired: boolean
      items: Array<{ id: string; name: string; kind: string; expiryDate: string | null; state: ExpiryState; label: string; message: string; isBlocking: boolean; sourceLink: string | null }>
      labels: Record<ExpiryState, string>
      note: string
    }>(`/requirements-intel/expiry/${opportunityId}`, { optionCoverageRequired }),
}

export interface RequirementSummary {
  total: number
  byStatus: Record<string, number>
  overdue: number
  unassigned: number
  blocked: number
  averageCompletion: number
}

// -------------------------------------------------------------
// §6.4 — milestones
// -------------------------------------------------------------

export interface TimelineItem {
  id: string
  milestoneType: string
  title: string
  description: string | null
  startAt: string | null
  endAt: string | null
  isAllDay: boolean
  timeZone: string
  origin: string
  sourceEvidence: string | null
  sourceSection: string | null
  isMandatory: boolean
  isInternal: boolean
  status: string
  priority: string
  ownerUserId: string | null
  backupOwnerUserId: string | null
  isLocked: boolean
  lockReason: string | null
  reminderLeadDays: number[]
  remindersEnabled: boolean
  amendmentImpact: string | null
  completedAt: string | null
  derived: { isOverdue: boolean; isAtRisk: boolean; daysRemaining: number | null; bucket: string }
}

export interface Timeline {
  items: TimelineItem[]
  buckets: {
    upcoming: TimelineItem[]
    overdue: TimelineItem[]
    atRisk: TimelineItem[]
    completed: TimelineItem[]
    amendmentChanged: TimelineItem[]
    unscheduled: TimelineItem[]
  }
  counts: Record<string, number>
  earliest: string | null
  latest: string | null
  milestoneTypes: string[]
}

export interface ScheduleRunResult {
  runId: string
  versionNo: number
  isPreview: boolean
  isFeasible: boolean
  infeasibilityReason: string | null
  phases: Array<{ key: string; label: string; milestoneType: string; start: string; end: string; isOverdue: boolean; optional: boolean; dependsOn: string | null }>
  overdueCount: number
  lockedPreserved: number
  completedPreserved: number
  milestonesCreated: number
  milestonesUpdated: number
  multiplier: number
}

export interface AmendmentRevision {
  id: string
  revisionNo: number
  amendmentNumber: string | null
  documentName: string | null
  contentHash: string
  diffSummary: { summary: string; comparable: boolean } | null
  changedDeadlines: unknown
  changedRequirements: unknown
  changedClauses: unknown
  humanReviewRequired: boolean
  acknowledgedAt: string | null
  createdAt: string
  impacts: Array<{
    id: string; area: string; targetLabel: string | null; impact: string
    recommendedAction: string | null; reviewRequired: boolean
    acknowledgedAt: string | null; dismissedReason: string | null
  }>
}

export interface ReminderLog {
  id: string
  level: string
  channel: string
  isEscalation: boolean
  acknowledgedAt: string | null
  snoozedUntil: string | null
  sentAt: string
  milestone: { id: string; title: string; endAt: string | null; opportunityId: string; status: string }
}

export const milestonesApi = {
  getTimeline: (opportunityId: string) => get<Timeline>(`/milestones/timeline/${opportunityId}`),
  createMilestone: (body: Record<string, unknown>) => post<TimelineItem>('/milestones', body),
  updateMilestone: async (id: string, body: Record<string, unknown>) => {
    const res = await api.patch(`/milestones/${id}`, body)
    return res.data.data as TimelineItem
  },
  getCalendar: (params?: Record<string, unknown>) => get<TimelineItem[]>('/milestones/calendar', params),

  getSchedule: (opportunityId: string) =>
    get<{ runs: Array<Record<string, unknown>>; templates: Array<Record<string, unknown>>; defaultPhases: Array<Record<string, unknown>> }>(`/milestones/schedule/${opportunityId}`),
  generateSchedule: (opportunityId: string, body: { preview?: boolean; templateId?: string | null; overrideReason?: string | null }) =>
    post<ScheduleRunResult>(`/milestones/schedule/${opportunityId}`, body),
  getComplexity: (opportunityId: string) =>
    get<{ inputs: Record<string, number>; multiplier: number }>(`/milestones/schedule/${opportunityId}/complexity`),
  getHolidays: (year?: number) =>
    get<{ year: number; federal: Array<{ date: string; name: string }>; custom: Array<{ id: string; date: string; name: string }> }>('/milestones/holidays', { year }),

  listAmendments: (opportunityId: string) =>
    get<{ revisions: AmendmentRevision[]; note: string }>(`/milestones/amendments/${opportunityId}`),
  recordAmendment: (opportunityId: string, body: { text: string; amendmentNumber?: string | null; documentName?: string | null }) =>
    post<{ revisionId: string | null; revisionNo: number | null; isNew: boolean; impactsCreated: number; message: string }>(`/milestones/amendments/${opportunityId}`, body),
  acknowledgeRevision: (id: string) => post<{ impactsAcknowledged: number }>(`/milestones/amendments/revision/${id}/acknowledge`),
  dismissImpact: (id: string, reason: string) => post(`/milestones/amendments/impact/${id}/dismiss`, { reason }),

  listReminders: (params?: Record<string, unknown>) => get<ReminderLog[]>('/milestones/reminders', params),
  acknowledgeReminder: (id: string) => post(`/milestones/reminders/${id}/acknowledge`),
  snoozeReminder: (id: string, until: string) => post(`/milestones/reminders/${id}/snooze`, { until }),
}

/** Absolute URL for the ICS export, so the browser can download it directly. */
export function icsExportUrl(mineOnly = false): string {
  const base = import.meta.env.VITE_API_URL || 'http://localhost:3001'
  return `${base}/api/milestones/calendar.ics${mineOnly ? '?mineOnly=true' : ''}`
}
