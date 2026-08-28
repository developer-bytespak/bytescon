// =============================================================
// §7.3 — Compliance Agent handler.
//
// A plain async function on the §7.0 AgentContext/AgentResult contract. It owns
// no queue, no worker, no scheduler and no reaper.
//
// OPTIONAL LLM, MANDATORY DETERMINISM
// Unlike §7.1 and §7.2 this agent sits next to an AI-assisted feature, so it is
// explicitly dual-mode:
//   * Every compliance check it performs itself is DETERMINISTIC — registration,
//     certification, insurance, bonding, document expiry, L/M coverage, clause
//     obligations, amendment re-check and pre-submission validation all run with
//     no provider configured.
//   * The canonical §6.3A extraction pipeline it invokes is itself deterministic.
//     AI-enhanced extraction is a SEPARATE, pre-existing path; where it has not
//     run, the agent says so as a data limitation rather than failing.
// The agent therefore never fails merely because no LLM key exists, and it holds
// no prompt text of its own.
//
// LOOP SAFETY
// `phasesForRun` gives an EXTRACTION_COMPLETED-triggered run no RUN_EXTRACTION
// phase, so processing that event can never start another extraction and can
// never emit another EXTRACTION_COMPLETED. Asserted by test.
//
// HUMAN TRUTH IS NEVER REWRITTEN. The agent does not verify a requirement,
// approve a clause, clear legalReviewRequired, accept an ambiguous mapping,
// acknowledge an amendment, change a registration, renew a certification, touch
// insurance or bonding, or waive a submission blocker.
// =============================================================
import { ExtractionJobStatus, MappingVerification, Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import type {
  AgentExecutionContext,
  AgentHandlerResult,
  EvidenceRef,
  ProposedArtifact,
  ProposedEscalation,
} from '../types'
import { workingDaysBetween } from '../../milestones/workingDays'
import { buildWorkingCalendar } from '../workingCalendar'
import { runExtraction } from '../../requirements/extractionPipeline'
import { getLmCoverage } from '../../requirements/lmMapping'
import { getLibraryHealth } from '../../standingDocuments'
import { assessRegistration, certificationsExpiringBeforeDeadline, type RegistrationWatchResult } from './registrationWatch'
import { recheckAmendmentCompliance, type AmendmentRecheckResult } from './amendmentRecheck'
import {
  DOCUMENT_ENTITY_TYPE,
  EXTRACTION_JOB_ENTITY_TYPE,
  AMENDMENT_ENTITY_TYPE,
  emitExtractionCompleted,
} from './complianceEvents'
import { PURSUIT_ENTITY_TYPE } from '../opportunity/opportunityEvents'
import {
  ACTIVE_PURSUIT_STAGES,
  COMPLIANCE_POLICY_DOC,
  CLEAR_MAPPING_SIMILARITY,
  FLOW_DOWN_REVIEW_WORDING,
  MANDATORY_GAP_BLOCKER_WORKING_DAYS,
  MAX_OPPORTUNITIES_PER_SWEEP,
  MIN_MAPPING_SIMILARITY,
  PRE_SUBMISSION_STAGES,
  STATUS_SECTION_LIMIT,
  deriveOverallStatus,
  statusSeverity,
  worstStatus,
  type ComplianceOverallStatus,
} from './policy'

export const COMPLIANCE_AGENT_KEY = 'COMPLIANCE' as const
export const OPPORTUNITY_ENTITY_TYPE = 'Opportunity'

/** Observable stages, in the order a full run performs them. */
export const COMPLIANCE_PHASES = [
  'LOAD_CONTEXT',
  'CHECK_REGISTRATION',
  'CHECK_CERTIFICATIONS',
  'CHECK_INSURANCE',
  'CHECK_BONDING',
  'CHECK_DOCUMENT_EXPIRY',
  'PROCESS_SOLICITATIONS',
  'RUN_EXTRACTION',
  'CHECK_EXTRACTION_STATUS',
  'DERIVE_LM_COVERAGE',
  'CHECK_CLAUSE_OBLIGATIONS',
  'CHECK_AMENDMENT_IMPACTS',
  'RUN_PRE_SUBMISSION_CHECKS',
  'BUILD_COMPLIANCE_STATUS',
  'CREATE_NOTIFICATIONS',
  'CREATE_ESCALATIONS',
  'COMPLETE',
] as const

export type CompliancePhase = (typeof COMPLIANCE_PHASES)[number]

/** Firm-wide phases every run performs regardless of trigger. */
const FIRM_PHASES: CompliancePhase[] = [
  'LOAD_CONTEXT', 'CHECK_REGISTRATION', 'CHECK_CERTIFICATIONS',
  'CHECK_INSURANCE', 'CHECK_BONDING', 'CHECK_DOCUMENT_EXPIRY',
]
const CLOSING_PHASES: CompliancePhase[] = ['BUILD_COMPLIANCE_STATUS', 'CREATE_NOTIFICATIONS', 'CREATE_ESCALATIONS', 'COMPLETE']

/**
 * Which phases a run performs.
 *
 * The one rule that matters most: an EXTRACTION_COMPLETED run gets NO
 * RUN_EXTRACTION phase. That is what makes the extraction event loop
 * structurally impossible rather than merely unlikely.
 */
export function phasesForRun(triggerEntityType: string | null): CompliancePhase[] {
  switch (triggerEntityType) {
    case DOCUMENT_ENTITY_TYPE:
      // A new document is the ONLY trigger that may start an extraction.
      return order([
        ...FIRM_PHASES.slice(0, 1),
        'PROCESS_SOLICITATIONS', 'RUN_EXTRACTION', 'CHECK_EXTRACTION_STATUS',
        'DERIVE_LM_COVERAGE', 'CHECK_CLAUSE_OBLIGATIONS',
        ...CLOSING_PHASES,
      ])
    case EXTRACTION_JOB_ENTITY_TYPE:
      // Downstream of an extraction. Deliberately NO RUN_EXTRACTION.
      return order([
        'LOAD_CONTEXT', 'PROCESS_SOLICITATIONS', 'CHECK_EXTRACTION_STATUS',
        'DERIVE_LM_COVERAGE', 'CHECK_CLAUSE_OBLIGATIONS', 'RUN_PRE_SUBMISSION_CHECKS',
        ...CLOSING_PHASES,
      ])
    case AMENDMENT_ENTITY_TYPE:
      return order([
        'LOAD_CONTEXT', 'PROCESS_SOLICITATIONS', 'CHECK_AMENDMENT_IMPACTS',
        'DERIVE_LM_COVERAGE', 'CHECK_CLAUSE_OBLIGATIONS',
        ...CLOSING_PHASES,
      ])
    case PURSUIT_ENTITY_TYPE:
      return order([
        'LOAD_CONTEXT', 'PROCESS_SOLICITATIONS', 'CHECK_EXTRACTION_STATUS',
        'DERIVE_LM_COVERAGE', 'CHECK_CLAUSE_OBLIGATIONS', 'CHECK_AMENDMENT_IMPACTS',
        'RUN_PRE_SUBMISSION_CHECKS',
        ...CLOSING_PHASES,
      ])
    default:
      // Scheduled or manual tenant-wide sweep: everything except starting a new
      // extraction, which is document-driven rather than clock-driven.
      return order([...COMPLIANCE_PHASES].filter((p) => p !== 'RUN_EXTRACTION'))
  }
}

function order(phases: CompliancePhase[]): CompliancePhase[] {
  const seen = new Set(phases)
  return COMPLIANCE_PHASES.filter((p) => seen.has(p))
}

interface PhaseOutcome {
  phase: CompliancePhase
  ok: boolean
  detail: string
  error?: string
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
  clauses: {
    total: number
    reviewRequired: number
    verified: number
    unresolvedFlowDowns: number
  }
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
  amendment: AmendmentSummary | null
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

interface AmendmentSummary {
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
}

export interface ComplianceStatusArtifact {
  generatedAt: string
  runId: string
  scope: string
  phases: CompliancePhase[]
  registration: {
    samStatus: string
    samExpiry: string | null
    samDaysUntilExpiry: number | null
    samExpiryStatus: string
    samDataFreshness: string
    certifications: RegistrationWatchResult['certifications']
    insurance: RegistrationWatchResult['insurance']
    bondingCapacity: RegistrationWatchResult['bonding']
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
  llm: {
    aiExtractionAvailable: boolean
    budgetExhausted: boolean
    note: string
  }
  evidence: EvidenceRef[]
  warnings: string[]
  dataLimitations: string[]
  policy: typeof COMPLIANCE_POLICY_DOC
}

/**
 * The agent entry point.
 *
 * Every phase is isolated: one bad solicitation, a failed extraction, a
 * malformed amendment or an incomplete registration record degrades the run to
 * PARTIAL with an honest limitation rather than failing the tenant.
 */
export async function complianceAgentHandler(ctx: AgentExecutionContext): Promise<AgentHandlerResult> {
  const now = new Date()
  // OBSERVE may compute and persist artifacts but must not notify or start work
  // with side effects. PROPOSE and above may extract, notify and escalate.
  const mayAct = ctx.autonomyLevel !== 'OBSERVE'

  const phases = phasesForRun(ctx.triggerEntityType)
  const outcomes: PhaseOutcome[] = []
  const warnings: string[] = []
  const limitations: string[] = []
  const evidence: EvidenceRef[] = []
  const escalations: ProposedEscalation[] = []

  ctx.log('compliance scope resolved', { phases: phases.length, triggerEntityType: ctx.triggerEntityType, mayAct })

  let completed = 0
  const step = async <T>(phase: CompliancePhase, fn: () => Promise<T>, describe: (r: T) => string): Promise<T | null> => {
    if (!phases.includes(phase)) return null
    if (ctx.signal.aborted) {
      outcomes.push({ phase, ok: false, detail: 'cancelled before this phase ran' })
      return null
    }
    try {
      const result = await fn()
      outcomes.push({ phase, ok: true, detail: describe(result) })
      return result
    } catch (err) {
      const message = (err as Error).message
      outcomes.push({ phase, ok: false, detail: 'failed', error: message })
      warnings.push(`Phase ${phase} failed: ${message}`)
      limitations.push(`${phase} could not complete, so this status may be incomplete in that area.`)
      logger.error('Compliance agent phase failed (continuing)', { phase, runId: ctx.runId, error: message })
      return null
    } finally {
      completed++
      await ctx.heartbeat(Math.round((completed / phases.length) * 100), phase).catch(() => undefined)
    }
  }

  // --- LOAD_CONTEXT ------------------------------------------------
  const scope = await step(
    'LOAD_CONTEXT',
    async () => resolveScope(ctx, now),
    (r) => `${r.opportunities.length} opportunit(ies) in scope`,
  )

  // --- registration family (all deterministic) ----------------------
  const registration = await step(
    'CHECK_REGISTRATION',
    async () => assessRegistration(ctx.consultingFirmId, now),
    (r) => `SAM ${r.sam.expiryStatus}, ${r.certifications.length} certification(s), ${r.insurance.length} policy(ies)`,
  )
  if (registration) {
    if (phases.includes('CHECK_CERTIFICATIONS')) {
      outcomes.push({
        phase: 'CHECK_CERTIFICATIONS', ok: true,
        detail: `${registration.certifications.filter((c) => c.expiryStatus === 'EXPIRED').length} expired, ${registration.certifications.filter((c) => c.expiryStatus === 'EXPIRING_SOON').length} expiring`,
      })
    }
    if (phases.includes('CHECK_INSURANCE')) {
      outcomes.push({
        phase: 'CHECK_INSURANCE', ok: true,
        detail: `${registration.insurance.filter((p) => p.expiryStatus === 'EXPIRED').length} expired policy(ies)`,
      })
    }
    if (phases.includes('CHECK_BONDING')) {
      outcomes.push({ phase: 'CHECK_BONDING', ok: true, detail: `bonding ${registration.bonding.state}` })
    }
    warnings.push(...registration.warnings)
    limitations.push(...registration.insufficient)
    escalations.push(...registration.escalations)
    evidence.push({
      sourceType: 'RegistrationProfile',
      sourceId: ctx.consultingFirmId,
      retrievedAt: now.toISOString(),
      note: registration.sam.dataFreshness,
    })
  }

  // --- CHECK_DOCUMENT_EXPIRY ----------------------------------------
  const library = await step(
    'CHECK_DOCUMENT_EXPIRY',
    async () => getLibraryHealth(ctx.consultingFirmId, {}, now),
    (r) => `${r.length} standing document(s) assessed`,
  )

  // --- per-opportunity work ------------------------------------------
  const rows: OpportunityComplianceRow[] = []
  let extractionsStarted = 0
  let extractionsSkipped = 0

  if (scope) {
    for (const opportunity of scope.opportunities) {
      if (ctx.signal.aborted) {
        limitations.push('The run was cancelled before every opportunity was assessed.')
        break
      }
      try {
        const assessed = await assessOpportunity({
          ctx, opportunity, now, phases, mayAct, registration, escalations,
        })
        rows.push(assessed.row)
        extractionsStarted += assessed.extractionStarted ? 1 : 0
        extractionsSkipped += assessed.extractionSkipped ? 1 : 0
        warnings.push(...assessed.warnings)
        limitations.push(...assessed.limitations)
        evidence.push(...assessed.evidence)
      } catch (err) {
        const message = (err as Error).message
        warnings.push(`[${opportunity.title}] could not be assessed: ${message}`)
        limitations.push(`[${opportunity.title}] was skipped because its compliance data could not be read safely.`)
        logger.error('Compliance assessment failed for one opportunity (continuing)', {
          opportunityId: opportunity.id, runId: ctx.runId, error: message,
        })
      }
      await ctx.heartbeat(
        Math.min(99, Math.round((completed / phases.length) * 100)),
        `assessed ${rows.length}/${scope.opportunities.length}`,
      ).catch(() => undefined)
    }
  }

  for (const phase of ['PROCESS_SOLICITATIONS', 'RUN_EXTRACTION', 'CHECK_EXTRACTION_STATUS', 'DERIVE_LM_COVERAGE',
    'CHECK_CLAUSE_OBLIGATIONS', 'CHECK_AMENDMENT_IMPACTS', 'RUN_PRE_SUBMISSION_CHECKS'] as CompliancePhase[]) {
    if (!phases.includes(phase) || outcomes.some((o) => o.phase === phase)) continue
    outcomes.push({ phase, ok: true, detail: `${rows.length} opportunit(ies)` })
  }

  // --- BUILD_COMPLIANCE_STATUS --------------------------------------
  const artifacts: ProposedArtifact[] = []
  const artifact = await step(
    'BUILD_COMPLIANCE_STATUS',
    async () =>
      buildStatus({ ctx, now, phases, registration, library, rows, evidence, warnings, limitations, outcomes }),
    (r) => `overall ${r.overallStatus}`,
  )

  if (artifact) {
    artifacts.push({
      artifactType: 'COMPLIANCE_STATUS',
      title: `Compliance status — ${now.toISOString().slice(0, 10)}`,
      summary: buildSummaryLine(artifact),
      structuredData: artifact as unknown as Record<string, unknown>,
      evidence,
      sourceEntityType: ctx.triggerEntityType === OPPORTUNITY_ENTITY_TYPE && ctx.triggerEntityId
        ? OPPORTUNITY_ENTITY_TYPE
        : 'ConsultingFirm',
      sourceEntityId: ctx.triggerEntityType === OPPORTUNITY_ENTITY_TYPE && ctx.triggerEntityId
        ? ctx.triggerEntityId
        : ctx.consultingFirmId,
      confidenceState: artifact.overallStatus === 'INSUFFICIENT_DATA' ? 'LOW' : 'HIGH',
      // One current status per subject; earlier ones are superseded rather than
      // overwritten, so the six-hourly cadence keeps history without duplicating.
      supersedeKey: `compliance-status:${ctx.triggerEntityId ?? ctx.consultingFirmId}`,
    })

    if (artifact.overallStatus === 'BLOCKED' || artifact.overallStatus === 'HUMAN_REVIEW_REQUIRED') {
      escalations.push({
        severity: statusSeverity(artifact.overallStatus),
        title: `Compliance ${artifact.overallStatus.replace(/_/g, ' ').toLowerCase()}`,
        reason: artifact.statusReasons.slice(0, 6).join(' '),
        recommendedAction: 'Review the compliance status. The agent never verifies a requirement, approves a clause or acknowledges an amendment for you.',
        entityType: 'ConsultingFirm',
        entityId: ctx.consultingFirmId,
        // Keyed on the FIRM, not the trigger scope. This escalation is about the
        // firm's overall position, so a scheduled sweep, a document run and an
        // amendment run must all refresh ONE item rather than each opening
        // their own copy of the same finding.
        dedupeHint: `compliance-overall:${ctx.consultingFirmId}`,
      })
    }
  }

  if (phases.includes('CREATE_NOTIFICATIONS')) {
    outcomes.push({
      phase: 'CREATE_NOTIFICATIONS', ok: true,
      detail: mayAct ? 'owner notifications handled by the canonical reminder paths' : 'suppressed under OBSERVE autonomy',
    })
    if (!mayAct) limitations.push('Autonomy is OBSERVE, so no notification was sent and no extraction was started.')
  }
  if (phases.includes('CREATE_ESCALATIONS')) {
    outcomes.push({ phase: 'CREATE_ESCALATIONS', ok: true, detail: `${escalations.length} condition(s) raised` })
  }

  const failedPhases = outcomes.filter((o) => !o.ok)
  if (ctx.signal.aborted) limitations.push('The run was cancelled before every phase completed.')

  const producedResult = artifact !== null
  return {
    status: producedResult ? 'COMPLETED' : 'FAILED',
    summary: artifact
      ? buildSummaryLine(artifact) + (failedPhases.length ? ` ${failedPhases.length} phase(s) degraded.` : '')
      : 'The compliance status could not be produced. See warnings for the failing phase.',
    confidence: !producedResult ? 'LOW' : failedPhases.length > 0 ? 'MEDIUM' : 'HIGH',
    dataSufficiency: !producedResult
      ? 'INSUFFICIENT'
      : failedPhases.length > 0 || limitations.length > 0
        ? 'PARTIAL'
        : 'SUFFICIENT',
    evidence,
    artifacts,
    escalations,
    metrics: {
      phasesPlanned: phases.length,
      phasesSucceeded: outcomes.filter((o) => o.ok).length,
      phasesFailed: failedPhases.length,
      opportunitiesAssessed: rows.length,
      extractionsStarted,
      extractionsSkipped,
      blocked: rows.filter((r) => r.overallStatus === 'BLOCKED').length,
      humanReviewRequired: rows.filter((r) => r.overallStatus === 'HUMAN_REVIEW_REQUIRED').length,
      certificationsExpired: registration?.certifications.filter((c) => c.expiryStatus === 'EXPIRED').length ?? 0,
      insuranceExpired: registration?.insurance.filter((p) => p.expiryStatus === 'EXPIRED').length ?? 0,
      unresolvedFlowDowns: rows.reduce((s, r) => s + r.clauses.unresolvedFlowDowns, 0),
      unresolvedAmendmentImpacts: rows.reduce((s, r) => s + (r.amendment?.unresolvedImpacts ?? 0), 0),
      escalationsRaised: escalations.length,
    },
    warnings,
    limitations,
    inputSnapshot: {
      scope: ctx.triggerEntityId ?? 'TENANT',
      triggerEntityType: ctx.triggerEntityType,
      phases,
      autonomyLevel: ctx.autonomyLevel,
      opportunityIds: rows.map((r) => r.opportunityId),
    },
    inputHash: buildInputHash({
      consultingFirmId: ctx.consultingFirmId,
      scope: ctx.triggerEntityId ?? 'TENANT',
      opportunities: rows.map((r) => `${r.opportunityId}:${r.overallStatus}`),
      sam: registration?.sam.expiryStatus ?? 'unknown',
      bonding: registration?.bonding.state ?? 'unknown',
    }),
  }
}

// -------------------------------------------------------------
// Scope
// -------------------------------------------------------------

interface ScopeOpportunity {
  id: string
  title: string
  agency: string
  responseDeadline: Date | null
  pursuitId: string | null
  pipelineStage: string | null
  documentId: string | null
}

async function resolveScope(ctx: AgentExecutionContext, _now: Date): Promise<{ opportunities: ScopeOpportunity[] }> {
  const select = {
    id: true, title: true, agency: true, responseDeadline: true,
    bidPursuits: { select: { id: true, pipelineStage: true }, take: 1 },
  } as const

  // Every targeted lookup verifies BOTH the entity and its tenant, never an id
  // alone, so a cross-tenant event can never reach another firm's data.
  const targeted = await resolveTargetedOpportunityId(ctx)
  if (ctx.triggerEntityId && targeted === null) return { opportunities: [] }

  const where: Prisma.OpportunityWhereInput = targeted
    ? { id: targeted, consultingFirmId: ctx.consultingFirmId }
    : {
        consultingFirmId: ctx.consultingFirmId,
        isDemo: false,
        // A tenant-wide sweep covers opportunities the firm is actively working.
        bidPursuits: { some: { pipelineStage: { in: [...ACTIVE_PURSUIT_STAGES] as never[] } } },
      }

  const opportunities = await prisma.opportunity.findMany({
    where,
    select,
    orderBy: { responseDeadline: 'asc' },
    take: targeted ? 1 : MAX_OPPORTUNITIES_PER_SWEEP,
  })

  return {
    opportunities: opportunities.map((o) => ({
      id: o.id,
      title: o.title,
      agency: o.agency,
      responseDeadline: o.responseDeadline,
      pursuitId: o.bidPursuits[0]?.id ?? null,
      pipelineStage: o.bidPursuits[0]?.pipelineStage ?? null,
      documentId: null,
    })),
  }
}

/** Map a trigger entity onto the opportunity it concerns, tenant-verified. */
async function resolveTargetedOpportunityId(ctx: AgentExecutionContext): Promise<string | null> {
  if (!ctx.triggerEntityId) return null
  switch (ctx.triggerEntityType) {
    case OPPORTUNITY_ENTITY_TYPE: {
      const row = await prisma.opportunity.findFirst({
        where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
        select: { id: true },
      })
      return row?.id ?? null
    }
    case DOCUMENT_ENTITY_TYPE: {
      const row = await prisma.opportunityDocument.findFirst({
        where: { id: ctx.triggerEntityId, opportunity: { consultingFirmId: ctx.consultingFirmId } },
        select: { opportunityId: true },
      })
      return row?.opportunityId ?? null
    }
    case EXTRACTION_JOB_ENTITY_TYPE: {
      const row = await prisma.solicitationExtractionJob.findFirst({
        where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
        select: { opportunityId: true },
      })
      return row?.opportunityId ?? null
    }
    case AMENDMENT_ENTITY_TYPE: {
      const row = await prisma.amendmentRevision.findFirst({
        where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
        select: { opportunityId: true },
      })
      return row?.opportunityId ?? null
    }
    case PURSUIT_ENTITY_TYPE: {
      const row = await prisma.bidPursuit.findFirst({
        where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
        select: { opportunityId: true, pipelineStage: true },
      })
      return row?.opportunityId ?? null
    }
    default:
      return null
  }
}

// -------------------------------------------------------------
// Per-opportunity assessment
// -------------------------------------------------------------

async function assessOpportunity(args: {
  ctx: AgentExecutionContext
  opportunity: ScopeOpportunity
  now: Date
  phases: CompliancePhase[]
  mayAct: boolean
  registration: RegistrationWatchResult | null
  escalations: ProposedEscalation[]
}): Promise<{
  row: OpportunityComplianceRow
  extractionStarted: boolean
  extractionSkipped: boolean
  warnings: string[]
  limitations: string[]
  evidence: EvidenceRef[]
}> {
  const { ctx, opportunity, now, phases, mayAct, registration } = args
  const warnings: string[] = []
  const limitations: string[] = []
  const evidence: EvidenceRef[] = []

  const blockers: string[] = []
  const humanReviewReasons: string[] = []
  const attentionReasons: string[] = []
  const insufficientReasons: string[] = []

  // --- working days to deadline -------------------------------------
  let workingDaysToDeadline: number | null = null
  if (opportunity.responseDeadline && opportunity.responseDeadline.getTime() >= now.getTime()) {
    const calendar = await buildWorkingCalendar(ctx.consultingFirmId, now)
    workingDaysToDeadline = workingDaysBetween(now, opportunity.responseDeadline, calendar)
  }

  // --- optional automatic extraction --------------------------------
  let extractionStarted = false
  let extractionSkipped = false
  if (phases.includes('RUN_EXTRACTION') && mayAct) {
    const outcome = await maybeRunExtraction(ctx, opportunity, now)
    extractionStarted = outcome.started
    extractionSkipped = outcome.skipped
    warnings.push(...outcome.warnings)
    limitations.push(...outcome.limitations)
    if (outcome.escalation) args.escalations.push(outcome.escalation)
  }

  // --- matrix ---------------------------------------------------------
  const matrix = await prisma.complianceMatrix.findUnique({
    where: { opportunityId: opportunity.id },
    select: { id: true },
  })
  const requirements = matrix
    ? await prisma.matrixRequirement.findMany({
        where: { matrixId: matrix.id },
        select: { id: true, isMandatory: true, isManuallyVerified: true, status: true, reviewRequired: true },
        take: 1000,
      })
    : []

  const mandatory = requirements.filter((r) => r.isMandatory)
  const verified = requirements.filter((r) => r.isManuallyVerified)
  const incomplete = requirements.filter((r) => r.status !== 'COMPLETE')
  const coveragePercent = requirements.length === 0
    ? 0
    : Math.round(((requirements.length - incomplete.length) / requirements.length) * 100)

  if (requirements.length === 0) {
    insufficientReasons.push('No requirements have been extracted for this opportunity, so compliance coverage cannot be assessed.')
  }

  const incompleteMandatory = mandatory.filter((r) => r.status !== 'COMPLETE')
  if (incompleteMandatory.length > 0) {
    const nearDeadline = workingDaysToDeadline !== null && workingDaysToDeadline <= MANDATORY_GAP_BLOCKER_WORKING_DAYS
    if (nearDeadline) {
      blockers.push(
        `${incompleteMandatory.length} mandatory requirement(s) are incomplete with ${workingDaysToDeadline} working day(s) until the deadline.`,
      )
    } else {
      attentionReasons.push(`${incompleteMandatory.length} mandatory requirement(s) are incomplete.`)
    }
  }

  // --- extraction status ------------------------------------------------
  const latestJob = await prisma.solicitationExtractionJob.findFirst({
    where: { consultingFirmId: ctx.consultingFirmId, opportunityId: opportunity.id },
    orderBy: { createdAt: 'desc' },
  })
  const aiEnhanced = await hasAiExtractedRequirements(matrix?.id ?? null)
  if (latestJob) {
    evidence.push({
      sourceType: 'SolicitationExtractionJob',
      sourceId: latestJob.id,
      retrievedAt: now.toISOString(),
      note: `${latestJob.status} — ${latestJob.requirementsCreated} requirement(s), ${latestJob.mappingsCreated} mapping(s)`,
    })
    if (latestJob.status === ExtractionJobStatus.FAILED && latestJob.attempt >= latestJob.maxAttempts) {
      blockers.push(`Solicitation extraction failed after ${latestJob.attempt} attempt(s): ${latestJob.errorMessage ?? 'no error recorded'}.`)
      args.escalations.push({
        severity: 'HIGH',
        title: `Solicitation extraction failed after ${latestJob.attempt} attempt(s)`,
        reason: `Extraction for "${opportunity.title}" has failed ${latestJob.attempt} time(s), at or beyond its ${latestJob.maxAttempts}-attempt limit. Last error: ${latestJob.errorMessage ?? 'not recorded'}.`,
        recommendedAction: 'Check the uploaded document is readable, then re-run extraction from the opportunity.',
        entityType: EXTRACTION_JOB_ENTITY_TYPE,
        entityId: latestJob.id,
        dedupeHint: `compliance-extraction-failed:${latestJob.id}`,
      })
    }
    if (latestJob.parseWarnings.length > 0) warnings.push(...latestJob.parseWarnings.map((w) => `[${opportunity.title}] ${w}`))
  }
  if (!aiEnhanced) {
    limitations.push(
      `[${opportunity.title}] no AI-enhanced extraction is recorded; the compliance view is based on the deterministic parse only.`,
    )
  }

  // --- L/M coverage -----------------------------------------------------
  const coverage = phases.includes('DERIVE_LM_COVERAGE')
    ? await getLmCoverage(ctx.consultingFirmId, opportunity.id)
    : null
  const clearlyMapped = coverage?.mappings.filter((m) => m.confidence >= CLEAR_MAPPING_SIMILARITY && !m.reviewRequired).length ?? 0
  const mappingReviewRequired = coverage?.mappings.filter((m) => m.reviewRequired || m.verification === MappingVerification.UNVERIFIED).length ?? 0
  if (mappingReviewRequired > 0) {
    humanReviewReasons.push(
      `${mappingReviewRequired} Section L/M mapping(s) scored between ${MIN_MAPPING_SIMILARITY} and ${CLEAR_MAPPING_SIMILARITY} or are unconfirmed, so they need human review.`,
    )
  }

  // --- clause obligations ------------------------------------------------
  const clauses = phases.includes('CHECK_CLAUSE_OBLIGATIONS')
    ? await prisma.clauseObligation.findMany({
        where: { consultingFirmId: ctx.consultingFirmId, opportunityId: opportunity.id },
        select: { id: true, clauseNumber: true, legalReviewRequired: true, isManuallyVerified: true, flowDownStatus: true },
        take: 500,
      })
    : []
  const unresolvedFlowDowns = clauses.filter((c) => c.legalReviewRequired && !c.isManuallyVerified).length
  if (unresolvedFlowDowns > 0) {
    humanReviewReasons.push(`${unresolvedFlowDowns} clause(s) carry a possible subcontract flow-down. ${FLOW_DOWN_REVIEW_WORDING}`)
  }

  // --- amendment ---------------------------------------------------------
  let amendment: AmendmentRecheckResult | null = null
  if (phases.includes('CHECK_AMENDMENT_IMPACTS')) {
    amendment = await recheckAmendmentCompliance({ consultingFirmId: ctx.consultingFirmId, opportunityId: opportunity.id, now })
    args.escalations.push(...amendment.escalations)
    warnings.push(...amendment.warnings)
    limitations.push(...amendment.dataLimitations)
    if (amendment.conflicts.length > 0) {
      humanReviewReasons.push(
        `An amendment conflicts with ${amendment.conflicts.length} human-verified record(s). Every verified value was preserved unchanged.`,
      )
    }
    if (amendment.unresolvedImpacts > 0) {
      attentionReasons.push(`${amendment.unresolvedImpacts} amendment impact(s) are unacknowledged.`)
    }
  }

  // --- pre-submission ------------------------------------------------------
  const submission = phases.includes('RUN_PRE_SUBMISSION_CHECKS')
    ? await summariseSubmission(ctx.consultingFirmId, opportunity.id)
    : { submissionId: null, automatedPasses: 0, failures: 0, manualRequired: 0, unsupported: 0, blockers: [] as string[] }
  if (submission.blockers.length > 0) blockers.push(...submission.blockers)
  if (submission.manualRequired > 0) {
    attentionReasons.push(`${submission.manualRequired} submission check(s) require a human — they cannot be verified automatically.`)
  }

  // --- certification deadlines --------------------------------------------
  const certificationWarnings: string[] = []
  if (registration) {
    const expiring = certificationsExpiringBeforeDeadline(registration.certifications, opportunity.responseDeadline)
    for (const cert of expiring) {
      const message = `Certification "${cert.name}" expires on ${cert.expiryDate?.toISOString().slice(0, 10)}, before the response deadline.`
      certificationWarnings.push(message)
      blockers.push(message)
      args.escalations.push({
        severity: 'HIGH',
        title: `Certification expires before the deadline: ${cert.name}`,
        reason: `${message} An expired certification does not count towards set-aside eligibility for "${opportunity.title}".`,
        recommendedAction: 'Renew the certification before the response deadline, or reconsider the set-aside basis for this bid.',
        entityType: 'Certification',
        entityId: cert.id,
        assignedToUserId: cert.ownerUserId,
        dedupeHint: `compliance-cert-before-deadline:${cert.id}:${opportunity.id}`,
      })
    }
    // Firm-wide blockers apply to every opportunity in scope.
    blockers.push(...registration.blockers)
  }

  const { status, reasons } = deriveOverallStatus({ blockers, humanReviewReasons, attentionReasons, insufficientReasons })

  return {
    row: {
      opportunityId: opportunity.id,
      pursuitId: opportunity.pursuitId,
      title: opportunity.title,
      agency: opportunity.agency,
      responseDeadline: opportunity.responseDeadline?.toISOString() ?? null,
      workingDaysToDeadline,
      pipelineStage: opportunity.pipelineStage,
      matrix: {
        totalRequirements: requirements.length,
        mandatoryRequirements: mandatory.length,
        verifiedRequirements: verified.length,
        unverifiedRequirements: requirements.length - verified.length,
        incompleteRequirements: incomplete.length,
        coveragePercent,
      },
      lmCoverage: {
        instructions: coverage?.instructions.length ?? 0,
        evaluationCriteria: coverage?.evaluations.length ?? 0,
        clearlyMapped,
        reviewRequired: mappingReviewRequired,
        unmapped: (coverage?.unmappedInstructions.length ?? 0) + (coverage?.unmappedEvaluations.length ?? 0),
        gaps: coverage?.gaps ?? [],
      },
      clauses: {
        total: clauses.length,
        reviewRequired: clauses.filter((c) => c.legalReviewRequired).length,
        verified: clauses.filter((c) => c.isManuallyVerified).length,
        unresolvedFlowDowns,
      },
      extraction: {
        latestJobId: latestJob?.id ?? null,
        status: latestJob?.status ?? null,
        progressPercent: latestJob?.progressPercent ?? null,
        attempt: latestJob?.attempt ?? null,
        maxAttempts: latestJob?.maxAttempts ?? null,
        parseWarnings: latestJob?.parseWarnings ?? [],
        aiEnhanced,
        note: aiEnhanced
          ? 'Requirements include AI-extracted rows. None is human-verified until a person verifies it.'
          : 'Deterministic parse only. AI-enhanced extraction has not run for this opportunity.',
      },
      amendment: amendment
        ? {
            latestRevisionId: amendment.latestRevisionId,
            latestRevisionNo: amendment.latestRevisionNo,
            changedRequirements: amendment.changedRequirements,
            changedClauses: amendment.changedClauses,
            changedLmCriteria: amendment.changedLmCriteria,
            unresolvedImpacts: amendment.unresolvedImpacts,
            conflictsWithVerified: amendment.conflicts.length,
            workingDaysToDeadline: amendment.workingDaysToDeadline,
            humanReviewRequired: amendment.humanReviewRequired,
            analysisBasis: amendment.analysisBasis,
          }
        : null,
      submission,
      certificationWarnings,
      overallStatus: status,
      statusReasons: reasons,
    },
    extractionStarted,
    extractionSkipped,
    warnings,
    limitations,
    evidence,
  }
}

/**
 * Start the canonical §6.3A extraction when, and only when, it will not
 * duplicate work.
 *
 * THE DUPLICATE-EXTRACTION RULE (see the §7.3 report for the full audit):
 * the pre-existing `requirementExtractionWorker` already runs on every upload,
 * writing AI-extracted MatrixRequirement rows and FAR applicabilities. Section
 * 6's pipeline is a different, deterministic extractor that also writes
 * MatrixRequirement rows. Running both over one document would produce two sets
 * of requirements for the same text.
 *
 * So the agent defers: it starts a Section 6 extraction only when the legacy
 * path did not produce requirements for that document. In practice that covers
 * exactly the cases the legacy path cannot serve — no LLM provider configured,
 * or a legacy extraction that failed — which is where automatic extraction is
 * most valuable. Neither the upload route nor the legacy worker is modified.
 */
async function maybeRunExtraction(
  ctx: AgentExecutionContext,
  opportunity: ScopeOpportunity,
  now: Date,
): Promise<{ started: boolean; skipped: boolean; warnings: string[]; limitations: string[]; escalation?: ProposedEscalation }> {
  const warnings: string[] = []
  const limitations: string[] = []

  if (ctx.triggerEntityType !== DOCUMENT_ENTITY_TYPE || !ctx.triggerEntityId) {
    return { started: false, skipped: false, warnings, limitations }
  }

  const document = await prisma.opportunityDocument.findFirst({
    where: { id: ctx.triggerEntityId, opportunity: { consultingFirmId: ctx.consultingFirmId } },
    select: { id: true, fileName: true, rawAnalysis: true, extractionStatus: true, opportunityId: true },
  })
  if (!document) return { started: false, skipped: false, warnings, limitations }

  // Has the legacy path already produced requirements for THIS document?
  const legacyRequirements = await prisma.matrixRequirement.count({
    where: { sourceDocumentId: document.id, matrix: { opportunityId: document.opportunityId } },
  })
  if (legacyRequirements > 0) {
    limitations.push(
      `[${opportunity.title}] "${document.fileName}" already has ${legacyRequirements} extracted requirement(s) from the document extraction pipeline, so the agent did not run a second extraction over the same document.`,
    )
    return { started: false, skipped: true, warnings, limitations }
  }

  // Same text resolution the manual §6.3A route uses, so both agree.
  const raw = document.rawAnalysis as { text?: string; extractedText?: string } | null
  let text = raw?.text ?? raw?.extractedText ?? ''
  let documentName: string = document.fileName
  if (!text.trim()) {
    const opp = await prisma.opportunity.findFirst({
      where: { id: document.opportunityId, consultingFirmId: ctx.consultingFirmId },
      select: { description: true, descriptionHtml: true },
    })
    text = (opp?.descriptionHtml ?? opp?.description ?? '').replace(/<[^>]+>/g, ' ')
    documentName = 'Solicitation description'
  }
  if (!text.trim()) {
    limitations.push(
      `[${opportunity.title}] no readable text is available for "${document.fileName}" yet, so extraction was not started. It will be retried once document analysis has produced text.`,
    )
    return { started: false, skipped: true, warnings, limitations }
  }

  const outcome = await runExtraction({
    consultingFirmId: ctx.consultingFirmId,
    opportunityId: document.opportunityId,
    documentId: document.id,
    text,
    documentName,
    now,
  })

  if (outcome.alreadyProcessed) {
    limitations.push(`[${opportunity.title}] this document content was already extracted; the existing job was reused.`)
    return { started: false, skipped: true, warnings, limitations }
  }

  warnings.push(...outcome.warnings.map((w) => `[${opportunity.title}] ${w}`))

  // Announce completion so downstream compliance work runs. Emitted only for a
  // job that produced usable output — a FAILED job escalates instead.
  if (outcome.status === ExtractionJobStatus.SUCCEEDED || outcome.status === ExtractionJobStatus.PARTIAL) {
    await prisma.$transaction(async (tx) => {
      await emitExtractionCompleted(tx, {
        consultingFirmId: ctx.consultingFirmId,
        extractionJobId: outcome.jobId,
        opportunityId: document.opportunityId,
        documentId: document.id,
        status: outcome.status,
        requirementsCreated: outcome.requirementsCreated,
        clausesCreated: outcome.clausesCreated,
        mappingsCreated: outcome.mappingsCreated,
        unresolvedCount: outcome.unresolvedCount,
      })
    })
  }

  return { started: true, skipped: false, warnings, limitations }
}

async function hasAiExtractedRequirements(matrixId: string | null): Promise<boolean> {
  if (!matrixId) return false
  const count = await prisma.matrixRequirement.count({ where: { matrixId, extractionMethod: 'AI' } })
  return count > 0
}

/**
 * Summarise the latest pre-submission validation evidence.
 *
 * READ-ONLY. §6 owns `runSubmissionValidation`; re-running it here would create
 * a new evidence run on every sweep, so the agent reports the most recent one
 * and never manufactures a pass.
 */
async function summariseSubmission(consultingFirmId: string, opportunityId: string) {
  const submission = await prisma.proposalSubmission.findFirst({
    where: { consultingFirmId, opportunityId },
    select: { id: true, title: true },
  })
  if (!submission) {
    return { submissionId: null, automatedPasses: 0, failures: 0, manualRequired: 0, unsupported: 0, blockers: [] as string[] }
  }

  const checks = await prisma.submissionValidationCheck.findMany({
    where: { consultingFirmId, submissionId: submission.id },
    orderBy: { performedAt: 'desc' },
    take: 200,
  })
  // Only the most recent run is current; the ledger is append-only.
  const latestRunId = checks[0]?.runId ?? null
  const current = latestRunId ? checks.filter((c) => c.runId === latestRunId) : []

  const failures = current.filter((c) => c.outcome === 'FAILED')
  const blockers = failures
    .filter((c) => c.isBlocking)
    .map((c) => `Submission check "${c.checkLabel}" failed: ${c.message ?? c.actual ?? 'no detail recorded'}.`)

  return {
    submissionId: submission.id,
    automatedPasses: current.filter((c) => c.outcome === 'PASSED').length,
    failures: failures.length,
    manualRequired: current.filter((c) => c.outcome === 'MANUAL_REQUIRED').length,
    unsupported: current.filter((c) => c.outcome === 'UNSUPPORTED').length,
    blockers,
  }
}

// -------------------------------------------------------------
// Artifact
// -------------------------------------------------------------

async function buildStatus(args: {
  ctx: AgentExecutionContext
  now: Date
  phases: CompliancePhase[]
  registration: RegistrationWatchResult | null
  library: Awaited<ReturnType<typeof getLibraryHealth>> | null
  rows: OpportunityComplianceRow[]
  evidence: EvidenceRef[]
  warnings: string[]
  limitations: string[]
  outcomes: PhaseOutcome[]
}): Promise<ComplianceStatusArtifact> {
  const { ctx, now, registration, library, rows } = args

  const documents = library ?? []
  const expired = documents.filter((d) => d.expiryState === 'EXPIRED')
  const expiring = documents.filter((d) =>
    d.expiryState === 'EXPIRES_BEFORE_SUBMISSION' || d.expiryState === 'EXPIRES_BEFORE_AWARD' ||
    d.expiryState === 'EXPIRES_DURING_BASE_PERIOD' || d.expiryState === 'EXPIRES_DURING_OPTION_PERIOD')
  const missing = documents.filter((d) => d.expiryState === 'INSUFFICIENT_DATA')

  const totals = {
    opportunitiesAssessed: rows.length,
    blocked: rows.filter((r) => r.overallStatus === 'BLOCKED').length,
    humanReviewRequired: rows.filter((r) => r.overallStatus === 'HUMAN_REVIEW_REQUIRED').length,
    attentionRequired: rows.filter((r) => r.overallStatus === 'ATTENTION_REQUIRED').length,
    compliant: rows.filter((r) => r.overallStatus === 'COMPLIANT_CURRENT').length,
    insufficientData: rows.filter((r) => r.overallStatus === 'INSUFFICIENT_DATA').length,
  }

  // Firm-level conditions apply even when no opportunity is in scope.
  const firmStatus = deriveOverallStatus({
    blockers: registration?.blockers ?? [],
    humanReviewReasons: [],
    attentionReasons: registration?.attention ?? [],
    insufficientReasons: registration?.insufficient ?? [],
  })
  const overallStatus = worstStatus([firmStatus.status, ...rows.map((r) => r.overallStatus)])
  const statusReasons = [
    ...firmStatus.reasons,
    ...rows.filter((r) => r.overallStatus === overallStatus).flatMap((r) => r.statusReasons.map((x) => `[${r.title}] ${x}`)),
  ].slice(0, 20)

  const anyAiExtraction = rows.some((r) => r.extraction.aiEnhanced)

  return {
    generatedAt: now.toISOString(),
    runId: ctx.runId,
    scope: ctx.triggerEntityId ?? 'TENANT',
    phases: args.phases,
    registration: {
      samStatus: registration?.sam.status ?? 'UNKNOWN',
      samExpiry: registration?.sam.expiryDate?.toISOString() ?? null,
      samDaysUntilExpiry: registration?.sam.daysUntilExpiry ?? null,
      samExpiryStatus: registration?.sam.expiryStatus ?? 'MISSING',
      samDataFreshness: registration?.sam.dataFreshness ?? 'No registration data was read on this run.',
      certifications: registration?.certifications ?? [],
      insurance: registration?.insurance ?? [],
      bondingCapacity: registration?.bonding ?? {
        recordId: null, suretyName: null, singleProjectLimit: null, aggregateLimit: null,
        committedAmount: null, availableCapacity: null, effectiveDate: null, expiryDate: null,
        daysUntilExpiry: null, status: null, state: 'MISSING',
        reasons: ['Bonding was not assessed on this run.'],
      },
    },
    documents: {
      reusable: documents.filter((d) => d.approvedForReuse).length,
      expiring: expiring.length,
      expired: expired.length,
      missing: missing.length,
      items: documents.slice(0, STATUS_SECTION_LIMIT).map((d) => ({
        id: d.id, name: d.name, category: d.category,
        expiryState: d.expiryState, expiryMessage: d.expiryMessage, approvedForReuse: d.approvedForReuse,
      })),
    },
    opportunities: rows.slice(0, STATUS_SECTION_LIMIT),
    totals,
    overallStatus,
    statusReasons,
    llm: {
      aiExtractionAvailable: anyAiExtraction,
      budgetExhausted: false,
      note: anyAiExtraction
        ? 'Some requirements were produced by AI-assisted extraction. Every compliance check reported here is deterministic, and no AI output is treated as verified.'
        : 'No AI-assisted extraction contributed to this status. Every figure is derived deterministically from stored records; AI-enhanced extraction is optional and has not run.',
    },
    evidence: args.evidence.slice(0, 100),
    warnings: args.warnings,
    dataLimitations: args.limitations,
    policy: COMPLIANCE_POLICY_DOC,
  }
}

function buildSummaryLine(a: ComplianceStatusArtifact): string {
  const bits: string[] = [a.overallStatus.replace(/_/g, ' ')]
  if (a.totals.opportunitiesAssessed) bits.push(`${a.totals.opportunitiesAssessed} opportunit(ies) assessed`)
  if (a.totals.blocked) bits.push(`${a.totals.blocked} blocked`)
  if (a.totals.humanReviewRequired) bits.push(`${a.totals.humanReviewRequired} needing human review`)
  if (a.registration.samExpiryStatus !== 'ACTIVE') bits.push(`SAM ${a.registration.samExpiryStatus}`)
  if (a.documents.expired) bits.push(`${a.documents.expired} expired document(s)`)
  return bits.join(' · ')
}

function buildInputHash(parts: Record<string, unknown>): string {
  const raw = JSON.stringify(parts)
  let hash = 0
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0
  return `compliance:${parts.consultingFirmId}:${parts.scope}:${(hash >>> 0).toString(16)}`
}
