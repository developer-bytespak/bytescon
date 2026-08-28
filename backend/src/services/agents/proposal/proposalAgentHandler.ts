// =============================================================
// §7.7 — Proposal Agent handler.
//
// A plain async handler on the shared §7.0 runtime. No new queue, worker,
// scheduler or reaper.
//
// THE BOUNDARY, AT PROPOSE *AND* ACT_WITH_GUARDRAILS ALIKE
// It never writes an approved section version, promotes a draft to APPROVED,
// approves a section review or a review cycle, signs off a colour team,
// satisfies an attestation, waives a compliance blocker, marks a requirement
// verified, selects final past performance, submits a proposal, or rewrites
// human-approved text. Every artefact it produces is a DRAFT until a person
// approves it through the existing human workflow.
//
// IT RUNS WITHOUT AN LLM. With no provider the agent still builds the outline,
// maps requirements, creates safe skeletons, computes coverage, runs the
// deterministic pre-submission checks, manages review reminders and produces
// PROPOSAL_STATUS. NO_LLM_KEY never fails the run; the drafting phases record
// exactly "AI drafting unavailable — no provider configured".
// =============================================================
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import { notifyUser } from '../../notificationService'
import { workingDaysBetween } from '../../milestones/workingDays'
import { buildWorkingCalendar } from '../workingCalendar'
import { isLlmProviderConfigured } from '../../llm/llmRouter'
import { scoreRelevance } from '../../pastPerformanceRelevance'
import type {
  AgentExecutionContext,
  AgentHandlerResult,
  EvidenceRef,
  ProposedArtifact,
  ProposedEscalation,
} from '../types'
import {
  buildOutline, coverageFor, skeletonCandidates, reconcileOutlineCoverage,
  type CoverageState, type OutlineResult,
} from './outlineBuilder'
import {
  retrieveApprovedSources, summariseLibrary, sourceVersionFingerprint,
  type CapabilitySource,
} from './capabilityLibrary'
import {
  draftSection, adaptPastPerformance, runCrossCheck,
  NO_PROVIDER_LIMITATION, type SectionDraft, type CrossCheckResult,
} from './proposalDrafts'
import { buildKeyPersonnelEvidence } from './personnelEvidence'
import {
  summariseCycles, assessSectionReviews, proposeReminders, nextCycleToOpen,
  openNextCycle, assessReviewEscalations,
  type CycleSummary, type SectionReviewState,
} from './reviewOrchestrator'

export const PROPOSAL_AGENT_KEY = 'PROPOSAL' as const
export const PROPOSAL_METHOD_VERSION = 'proposal-v1'

const DAY_MS = 86_400_000

/** Proposals the agent will work on. */
export const ACTIVE_PROPOSAL_STATUSES = ['ACTIVE'] as const

/** Section statuses whose content the agent must never rewrite. */
export const LOCKED_SECTION_STATUSES = ['APPROVED'] as const

export const MAX_PROPOSALS_PER_SWEEP = 10
export const MAX_SECTIONS_DRAFTED_PER_RUN = 5
export const MAX_PAST_PERFORMANCE_CANDIDATES = 5

/** Inside this many working days, proposal gaps escalate. */
export const PROPOSAL_RISK_WORKING_DAYS = 10

export const PROPOSAL_PHASES = [
  'LOAD_PROPOSAL_CONTEXT',
  'LOAD_REQUIREMENTS',
  'LOAD_LM_MAPPINGS',
  'BUILD_OR_REFRESH_OUTLINE',
  'LOAD_CAPABILITY_LIBRARY',
  'LOAD_PAST_PERFORMANCE',
  'PREPARE_SECTION_DRAFTS',
  'PROPOSE_PAST_PERFORMANCE',
  'RUN_COMPLIANCE_CROSSCHECK',
  'CHECK_REVIEW_CYCLES',
  'SEND_REVIEW_REMINDERS',
  'RUN_PRE_SUBMISSION_VALIDATION',
  'COMPUTE_ADHERENCE',
  'BUILD_PROPOSAL_STATUS',
  'CREATE_NOTIFICATIONS',
  'CREATE_ESCALATIONS',
  'COMPLETE',
] as const

export type ProposalPhase = (typeof PROPOSAL_PHASES)[number]

/** Only the phases a given trigger needs. */
export function phasesForRun(triggerEntityType: string | null): ProposalPhase[] {
  if (triggerEntityType === 'ProposalSection') {
    // A human approval refreshes coverage and review state, and drafts nothing.
    return [
      'LOAD_PROPOSAL_CONTEXT', 'LOAD_REQUIREMENTS', 'BUILD_OR_REFRESH_OUTLINE',
      'RUN_COMPLIANCE_CROSSCHECK', 'CHECK_REVIEW_CYCLES', 'COMPUTE_ADHERENCE',
      'BUILD_PROPOSAL_STATUS', 'CREATE_NOTIFICATIONS', 'CREATE_ESCALATIONS', 'COMPLETE',
    ]
  }
  if (triggerEntityType === 'CapabilityNarrative') {
    // Newly approved wording may enable a draft; it never rewrites one.
    return [
      'LOAD_PROPOSAL_CONTEXT', 'LOAD_REQUIREMENTS', 'BUILD_OR_REFRESH_OUTLINE',
      'LOAD_CAPABILITY_LIBRARY', 'PREPARE_SECTION_DRAFTS', 'BUILD_PROPOSAL_STATUS',
      'CREATE_NOTIFICATIONS', 'CREATE_ESCALATIONS', 'COMPLETE',
    ]
  }
  return [...PROPOSAL_PHASES]
}

// -------------------------------------------------------------
// Status shape
// -------------------------------------------------------------

export interface SectionStatus {
  sectionId: string
  title: string
  sectionNumber: string | null
  ownerUserId: string | null
  reviewerUserId: string | null
  currentVersionId: string | null
  currentVersionStatus: string
  draftState: 'NO_DRAFT' | 'SKELETON_ONLY' | 'AI_DRAFT_PENDING_REVIEW' | 'HUMAN_DRAFT' | 'APPROVED'
  sourceMaterialState: 'SUFFICIENT' | 'SOURCE_MATERIAL_REQUIRED'
  coverageState: CoverageState
  requirementIds: string[]
  mandatoryRequirementIds: string[]
  reviewState: string
  overdue: boolean
  isLocked: boolean
}

export interface ProposalStatusArtifact {
  opportunityId: string
  proposalId: string
  generatedAt: string
  methodVersion: string
  outline: {
    totalItems: number
    mandatoryRequirements: number
    mappedMandatoryRequirements: number
    unmappedMandatoryRequirements: Array<{ requirementId: string; section: string; reason: string }>
    coverageState: 'COMPLETE' | 'GAPS_PRESENT' | 'NO_REQUIREMENTS'
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
  capabilityLibrary: Awaited<ReturnType<typeof summariseLibrary>>
  pastPerformance: {
    proposedSelections: Array<{ recordId: string; title: string; relevanceScore: number; confidence: string; explanation: string }>
    approvedSelections: Array<{ recordId: string; selectedByUserId: string | null }>
    adaptedDrafts: number
    unsupportedClaims: Array<{ recordId: string; claim: string; reason: string }>
  }
  compliance: {
    deterministicBlockers: string[]
    aiFindings: CrossCheckResult['findings']
    uncoveredMandatoryRequirements: string[]
    legalReviewItems: string[]
    manualRequiredChecks: string[]
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

// -------------------------------------------------------------
// Handler
// -------------------------------------------------------------

export async function proposalAgentHandler(ctx: AgentExecutionContext): Promise<AgentHandlerResult> {
  const now = new Date()
  const mayAct = ctx.autonomyLevel !== 'OBSERVE'
  const phases = phasesForRun(ctx.triggerEntityType)

  const warnings: string[] = []
  const limitations: string[] = []
  const evidence: EvidenceRef[] = []
  const escalations: ProposedEscalation[] = []
  const artifacts: ProposedArtifact[] = []

  // AI drafting is a provider-gated SUB-CAPABILITY, not a precondition for the
  // run. `requiresLlm` stays false in the registry precisely so the skeleton
  // path below still executes with no key configured.
  const providerAvailable = await isLlmProviderConfigured(ctx.consultingFirmId)
  const useLlm = providerAvailable && (await ctx.budget.check(1)).allowed
  if (!providerAvailable) limitations.push(NO_PROVIDER_LIMITATION)

  const proposals = await resolveScope(ctx)
  ctx.log('proposal scope resolved', {
    proposals: proposals.length,
    triggerEntityType: ctx.triggerEntityType,
    mayAct,
    providerAvailable,
  })

  if (proposals.length === 0) {
    return {
      status: 'SKIPPED',
      summary: ctx.triggerEntityId
        ? 'The targeted record has no active proposal in this firm.'
        : 'No active proposal exists for this firm.',
      confidence: 'HIGH',
      dataSufficiency: 'SUFFICIENT',
      metrics: { proposalsScanned: 0, sectionsAssessed: 0 },
      limitations: ['Only proposals in status ACTIVE are worked on.', ...limitations],
      inputSnapshot: { scope: ctx.triggerEntityId ?? 'TENANT', proposalCount: 0 },
      inputHash: `proposal:${ctx.consultingFirmId}:none:${now.toISOString().slice(0, 10)}`,
    }
  }

  let assessed = 0
  let failed = 0
  let changed = 0
  let sectionsAssessed = 0
  let sectionsDrafted = 0
  let skeletonsCreated = 0
  let cyclesOpened = 0
  let remindersSent = 0
  let uncoveredMandatory = 0

  for (const proposal of proposals) {
    if (ctx.signal.aborted) {
      limitations.push('The run was cancelled before every proposal was assessed.')
      break
    }
    try {
      const outcome = await assessProposal({ ctx, proposal, now, mayAct, useLlm, providerAvailable, phases })
      assessed += 1
      changed += outcome.changed ? 1 : 0
      sectionsAssessed += outcome.status.sections.length
      sectionsDrafted += outcome.sectionsDrafted
      skeletonsCreated += outcome.skeletonsCreated
      cyclesOpened += outcome.cyclesOpened
      remindersSent += outcome.remindersSent
      uncoveredMandatory += outcome.status.outline.unmappedMandatoryRequirements.length

      warnings.push(...outcome.status.warnings.map((w) => `[${proposal.title}] ${w}`))
      limitations.push(...outcome.status.dataLimitations.map((l) => `[${proposal.title}] ${l}`))
      evidence.push(...outcome.evidence)
      escalations.push(...outcome.escalations)
      artifacts.push(outcome.artifact)
    } catch (err) {
      // One unreadable proposal — or one failed section draft inside it — must
      // not take the tenant run down.
      failed += 1
      const message = (err as Error).message
      warnings.push(`[${proposal.title}] could not be assessed: ${message}`)
      limitations.push(`[${proposal.title}] was skipped because its proposal evidence could not be read safely.`)
      logger.error('Proposal assessment failed for one proposal (continuing)', {
        proposalId: proposal.id, runId: ctx.runId, error: message,
      })
    }
    await ctx
      .heartbeat(Math.round((assessed / Math.max(1, proposals.length)) * 100), `assessed ${assessed}/${proposals.length}`)
      .catch(() => undefined)
  }

  const summaryParts = [`Assessed ${assessed} proposal(s) across ${sectionsAssessed} section(s).`]
  if (skeletonsCreated > 0) summaryParts.push(`${skeletonsCreated} section skeleton(s) created for otherwise unmapped mandatory requirements.`)
  if (sectionsDrafted > 0) summaryParts.push(`${sectionsDrafted} AI draft(s) prepared for human review.`)
  else if (!providerAvailable) summaryParts.push('No AI drafting was attempted: no provider is configured.')
  if (uncoveredMandatory > 0) summaryParts.push(`${uncoveredMandatory} mandatory requirement(s) remain unmapped.`)
  if (cyclesOpened > 0) summaryParts.push(`${cyclesOpened} review cycle(s) opened.`)
  if (failed > 0) summaryParts.push(`${failed} proposal(s) could not be assessed.`)
  summaryParts.push('Nothing was approved, verified or submitted.')

  return {
    status: 'COMPLETED',
    summary: summaryParts.join(' '),
    confidence: assessed === 0 ? 'LOW' : failed > 0 ? 'MEDIUM' : 'HIGH',
    dataSufficiency: failed > 0 || limitations.length > 0 ? 'PARTIAL' : 'SUFFICIENT',
    evidence,
    artifacts,
    escalations,
    metrics: {
      proposalsScanned: proposals.length,
      proposalsAssessed: assessed,
      proposalsFailed: failed,
      statusesChanged: changed,
      sectionsAssessed,
      sectionsDrafted,
      skeletonsCreated,
      reviewCyclesOpened: cyclesOpened,
      remindersSent,
      uncoveredMandatoryRequirements: uncoveredMandatory,
      escalationsRaised: escalations.length,
      // Every one of these is proven zero by test at both autonomy levels.
      sectionsApproved: 0,
      reviewsApproved: 0,
      cyclesApproved: 0,
      requirementsVerified: 0,
      pastPerformanceSelected: 0,
      proposalsSubmitted: 0,
      blockersWaived: 0,
    },
    warnings,
    limitations,
    inputSnapshot: {
      scope: ctx.triggerEntityId ?? 'TENANT',
      triggerEntityType: ctx.triggerEntityType,
      proposalIds: proposals.map((p) => p.id),
      autonomyLevel: ctx.autonomyLevel,
      providerAvailable,
    },
    inputHash: `proposal:${ctx.consultingFirmId}:${ctx.triggerEntityId ?? 'TENANT'}:${proposals.map((p) => p.id).sort().join(',').slice(0, 200)}`,
  }
}

// -------------------------------------------------------------
// Scope
// -------------------------------------------------------------

interface ScopeProposal {
  id: string
  opportunityId: string
  title: string
  opportunity: { id: string; title: string; agency: string; naicsCode: string; responseDeadline: Date | null }
}

async function resolveScope(ctx: AgentExecutionContext): Promise<ScopeProposal[]> {
  const select = {
    id: true, opportunityId: true, title: true,
    opportunity: { select: { id: true, title: true, agency: true, naicsCode: true, responseDeadline: true } },
  } as const
  const statusFilter = { status: 'ACTIVE' as const }

  // Every branch filters on consultingFirmId, so a targeted id from another
  // firm resolves to nothing rather than to that firm's proposal.
  if (ctx.triggerEntityType === 'ProposalSection' && ctx.triggerEntityId) {
    const section = await prisma.proposalSection.findFirst({
      where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
      select: { opportunityId: true },
    })
    if (!section) return []
    return prisma.proposal.findMany({
      where: { opportunityId: section.opportunityId, consultingFirmId: ctx.consultingFirmId, ...statusFilter },
      select,
    })
  }

  if (ctx.triggerEntityType === 'BidPursuit' && ctx.triggerEntityId) {
    const pursuit = await prisma.bidPursuit.findFirst({
      where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
      select: { opportunityId: true },
    })
    if (!pursuit) return []
    return prisma.proposal.findMany({
      where: { opportunityId: pursuit.opportunityId, consultingFirmId: ctx.consultingFirmId, ...statusFilter },
      select,
    })
  }

  if ((ctx.triggerEntityType === 'Opportunity' || ctx.triggerEntityType === 'Amendment' || ctx.triggerEntityType === 'ExtractionJob') && ctx.triggerEntityId) {
    let opportunityId: string | null = ctx.triggerEntityId
    if (ctx.triggerEntityType === 'Amendment') {
      const amendment = await prisma.amendment.findUnique({ where: { id: ctx.triggerEntityId }, select: { opportunityId: true } })
      opportunityId = amendment?.opportunityId ?? null
    }
    if (ctx.triggerEntityType === 'ExtractionJob') {
      const job = await prisma.solicitationExtractionJob.findFirst({
        where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
        select: { opportunityId: true },
      }).catch(() => null)
      opportunityId = job?.opportunityId ?? null
    }
    if (!opportunityId) return []
    return prisma.proposal.findMany({
      where: { opportunityId, consultingFirmId: ctx.consultingFirmId, ...statusFilter },
      select,
    })
  }

  // A capability approval, or a scheduled sweep, covers every active proposal.
  return prisma.proposal.findMany({
    where: { consultingFirmId: ctx.consultingFirmId, ...statusFilter },
    select,
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: MAX_PROPOSALS_PER_SWEEP,
  })
}

// -------------------------------------------------------------
// Per-proposal assessment
// -------------------------------------------------------------

interface ProposalOutcome {
  status: ProposalStatusArtifact
  artifact: ProposedArtifact
  escalations: ProposedEscalation[]
  evidence: EvidenceRef[]
  changed: boolean
  sectionsDrafted: number
  skeletonsCreated: number
  cyclesOpened: number
  remindersSent: number
}

async function assessProposal(args: {
  ctx: AgentExecutionContext
  proposal: ScopeProposal
  now: Date
  mayAct: boolean
  useLlm: boolean
  providerAvailable: boolean
  phases: ProposalPhase[]
}): Promise<ProposalOutcome> {
  const { ctx, proposal, now, mayAct, useLlm, providerAvailable, phases } = args
  const warnings: string[] = []
  const dataLimitations: string[] = []
  const evidence: EvidenceRef[] = []
  const escalations: ProposedEscalation[] = []
  const recommendedHumanActions: string[] = []
  const draftingLimitations: string[] = []

  const calendar = await buildWorkingCalendar(ctx.consultingFirmId, now)
  const deadline = proposal.opportunity.responseDeadline
  const workingDaysToDeadline = deadline ? workingDaysBetween(now, deadline, calendar) : null
  const nearDeadline = workingDaysToDeadline !== null && workingDaysToDeadline >= 0 && workingDaysToDeadline <= PROPOSAL_RISK_WORKING_DAYS

  // ---- BUILD_OR_REFRESH_OUTLINE ----------------------------------------
  const outline = await buildOutline({
    consultingFirmId: ctx.consultingFirmId,
    opportunityId: proposal.opportunityId,
    proposalId: proposal.id,
  })
  // Skeletons only for a fallback bucket holding an otherwise homeless
  // mandatory requirement. Never for a slot a human already owns.
  let skeletonsCreated = 0
  if (mayAct && phases.includes('BUILD_OR_REFRESH_OUTLINE')) {
    for (const candidate of skeletonCandidates(outline)) {
      const created = await prisma.proposalSection.create({
        data: {
          consultingFirmId: ctx.consultingFirmId,
          opportunityId: proposal.opportunityId,
          proposalId: proposal.id,
          title: candidate.title,
          sectionNumber: candidate.sectionNumber,
          // OUTLINE, never APPROVED. It is a placeholder, not an answer.
          status: 'OUTLINE',
          isAiGenerated: true,
          sortOrder: candidate.sortOrder,
        },
      })
      candidate.proposalSectionId = created.id
      skeletonsCreated += 1
    }
    if (skeletonsCreated > 0) {
      // The buckets now have real sections behind them, so the coverage the
      // artifact reports must reflect that rather than the pre-run reading.
      reconcileOutlineCoverage(outline)
      warnings.push(`${skeletonsCreated} empty section skeleton(s) were created so no mandatory requirement is left with nowhere to live. A skeleton is not coverage.`)
    }
  }

  // Recorded after the skeleton pass so the evidence quotes post-run coverage.
  dataLimitations.push(...outline.limitations)
  evidence.push({
    sourceType: 'ProposalOutline',
    sourceId: proposal.opportunityId,
    retrievedAt: now.toISOString(),
    note: `${outline.items.length} outline item(s), ${outline.mappedMandatoryRequirements}/${outline.mandatoryRequirements} mandatory requirement(s) mapped`,
  })

  // ---- section state ------------------------------------------------------
  const sections = await prisma.proposalSection.findMany({
    where: { consultingFirmId: ctx.consultingFirmId, opportunityId: proposal.opportunityId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })
  const sectionById = new Map(sections.map((s) => [s.id, s]))

  // ---- LOAD_CAPABILITY_LIBRARY -------------------------------------------
  const library = await summariseLibrary(ctx.consultingFirmId)
  if (!library.available) dataLimitations.push(library.detail)

  // ---- requirements for drafting ------------------------------------------
  const matrices = await prisma.complianceMatrix.findMany({
    where: { opportunityId: proposal.opportunityId },
    select: { id: true },
  })
  const requirements = matrices.length
    ? await prisma.matrixRequirement.findMany({
        where: { matrixId: { in: matrices.map((m) => m.id) } },
        take: 1000,
      })
    : []
  const requirementById = new Map(requirements.map((r) => [r.id, r]))

  // ---- key personnel evidence ---------------------------------------------
  // Loaded once per run: the same approved, verified evidence is offered to
  // every section, and a person nobody selected is never offered at all.
  const keyPersonnel = await buildKeyPersonnelEvidence(ctx.consultingFirmId, proposal.id)
  const personnelWithoutEvidence = keyPersonnel.filter((k) => !k.hasApprovedResume)
  if (personnelWithoutEvidence.length > 0) {
    dataLimitations.push(
      `${personnelWithoutEvidence.length} selected key person(s) have no approved resume, so no experience, education, certification or clearance may be written for them: ${personnelWithoutEvidence.map((k) => k.fullName).join(', ')}.`,
    )
    recommendedHumanActions.push(
      `Approve a resume version for ${personnelWithoutEvidence.map((k) => k.fullName).join(', ')} before the proposal claims their qualifications.`,
    )
  }
  if (keyPersonnel.length > 0) {
    evidence.push({
      sourceType: 'ProposalKeyPersonnel',
      sourceId: proposal.id,
      retrievedAt: now.toISOString(),
      note: `${keyPersonnel.length} selected key person(s); ${keyPersonnel.length - personnelWithoutEvidence.length} with an approved resume`,
    })
  }

  // ---- PREPARE_SECTION_DRAFTS ----------------------------------------------
  const sectionStatuses: SectionStatus[] = []
  let sectionsDrafted = 0
  let sectionsReadyForDraft = 0
  let sectionsNeedingSourceMaterial = 0

  for (const item of outline.items) {
    const section = item.proposalSectionId ? sectionById.get(item.proposalSectionId) ?? null : null
    const latestVersion = section?.versions[0] ?? null
    const isLocked = section ? (LOCKED_SECTION_STATUSES as readonly string[]).includes(section.status) : false

    const itemRequirements = item.requirementIds
      .map((id) => requirementById.get(id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))

    const retrieval = await retrieveApprovedSources(ctx.consultingFirmId, {
      keywords: [item.title, ...itemRequirements.map((r) => r.requirementText.slice(0, 80))],
      naicsCode: proposal.opportunity.naicsCode,
      agency: proposal.opportunity.agency,
    })

    let draftState: SectionStatus['draftState'] = 'NO_DRAFT'
    if (section?.status === 'APPROVED') draftState = 'APPROVED'
    else if (section?.draft && section.draft.trim().length > 0) {
      draftState = section.isAiGenerated ? 'AI_DRAFT_PENDING_REVIEW' : 'HUMAN_DRAFT'
    } else if (section) draftState = 'SKELETON_ONLY'

    const needsSource = retrieval.sources.length === 0 && itemRequirements.length > 0
    if (needsSource) sectionsNeedingSourceMaterial += 1

    // A section is a draft candidate only when it is NOT locked, has no human
    // text, and has approved source material to draft from.
    const draftable =
      section !== null &&
      !isLocked &&
      draftState !== 'HUMAN_DRAFT' &&
      retrieval.sources.length > 0
    if (draftable) sectionsReadyForDraft += 1

    if (
      draftable &&
      mayAct &&
      phases.includes('PREPARE_SECTION_DRAFTS') &&
      sectionsDrafted < MAX_SECTIONS_DRAFTED_PER_RUN
    ) {
      const fingerprint = buildSectionDraftFingerprint({
        requirementIds: item.requirementIds,
        sourceFingerprint: sourceVersionFingerprint(retrieval.sources),
        existingDraft: section!.draft,
      })
      // A draft is regenerated only when its inputs materially changed, never
      // simply because six hours elapsed and a provider exists.
      const alreadyCurrent = (section!.generationError ?? '').startsWith(fingerprint)
      if (!alreadyCurrent) {
        try {
          const { draft, limitations: draftLimits } = await draftSection(
            ctx,
            {
              sectionId: section!.id,
              sectionTitle: section!.title,
              sectionNumber: section!.sectionNumber,
              requirements: itemRequirements.map((r) => ({
                id: r.id, section: r.section, text: r.requirementText, isMandatory: r.isMandatory,
              })),
              lmMappings: [],
              capabilitySources: retrieval.sources,
              pastPerformance: [],
              keyPersonnel,
              lockedContent: null,
              existingDraft: section!.draft,
            },
            { useLlm },
          )
          draftingLimitations.push(...draftLimits)
          warnings.push(...draft.warnings.map((w) => `[${section!.title}] ${w}`))

          if (draft.source === 'LLM_ASSISTED') {
            await persistDraftVersion(ctx.consultingFirmId, section!.id, draft, fingerprint)
            sectionsDrafted += 1
          }
        } catch (err) {
          // A failed draft affects this section only.
          warnings.push(`[${section!.title}] the section draft could not be prepared: ${(err as Error).message}`)
        }
      }
    }

    sectionStatuses.push({
      sectionId: section?.id ?? item.key,
      title: item.title,
      sectionNumber: item.sectionNumber,
      ownerUserId: section?.ownerUserId ?? null,
      reviewerUserId: section?.reviewerUserId ?? null,
      currentVersionId: latestVersion?.id ?? null,
      currentVersionStatus: section?.status ?? 'NOT_CREATED',
      draftState,
      sourceMaterialState: needsSource ? 'SOURCE_MATERIAL_REQUIRED' : 'SUFFICIENT',
      coverageState: coverageFor(item, section ? { draft: section.draft, status: section.status } : null),
      requirementIds: item.requirementIds,
      mandatoryRequirementIds: item.mandatoryRequirementIds,
      reviewState: section?.status ?? 'NOT_CREATED',
      overdue: false,
      isLocked,
    })

    if (needsSource && item.mandatoryRequirementIds.length > 0) {
      recommendedHumanActions.push(
        `Add and approve capability-library material for "${item.title}" — ${item.mandatoryRequirementIds.length} mandatory requirement(s) have no approved source to draft from.`,
      )
    }
  }

  // ---- PROPOSE_PAST_PERFORMANCE -------------------------------------------
  const pastPerformance = phases.includes('PROPOSE_PAST_PERFORMANCE')
    ? await proposePastPerformance(ctx, proposal, mayAct)
    : { proposedSelections: [], approvedSelections: [], adaptedDrafts: 0, unsupportedClaims: [] }

  // ---- RUN_COMPLIANCE_CROSSCHECK -------------------------------------------
  const draftedSections = sections.filter((s) => (s.draft ?? '').trim().length > 0)
  const crossCheck = phases.includes('RUN_COMPLIANCE_CROSSCHECK')
    ? await runCrossCheck(
        ctx,
        {
          requirements: requirements.map((r) => ({
            id: r.id, section: r.section, text: r.requirementText,
            isMandatory: r.isMandatory, isManuallyVerified: r.isManuallyVerified,
          })),
          sections: draftedSections.map((s) => ({
            id: s.id, title: s.title, content: (s.draft ?? '').slice(0, 8000), status: s.status,
          })),
        },
        { useLlm },
      )
    : { result: { findings: [], uncovered: [], source: 'DETERMINISTIC_SKELETON' as const, promptVersion: null, warnings: [] }, limitations: [] }
  dataLimitations.push(...crossCheck.limitations)

  // ---- CHECK_REVIEW_CYCLES + SEND_REVIEW_REMINDERS ---------------------------
  const cycles = phases.includes('CHECK_REVIEW_CYCLES')
    ? await summariseCycles(ctx.consultingFirmId, proposal.opportunityId, now, calendar)
    : []
  const sectionReviews = assessSectionReviews(
    sections.map((s) => ({
      id: s.id, title: s.title, status: s.status, ownerUserId: s.ownerUserId,
      reviewerUserId: s.reviewerUserId, submittedForReviewAt: s.submittedForReviewAt, dueDate: s.dueDate,
    })),
    now,
    calendar,
  )
  for (const status of sectionStatuses) {
    const review = sectionReviews.find((r) => r.sectionId === status.sectionId)
    if (review) status.overdue = review.isOverdue
  }

  let cyclesOpened = 0
  if (mayAct && phases.includes('CHECK_REVIEW_CYCLES') && cycles.length > 0) {
    const next = nextCycleToOpen(cycles)
    if (next) {
      const opened = await openNextCycle({
        consultingFirmId: ctx.consultingFirmId,
        opportunityId: proposal.opportunityId,
        cycleType: next,
      })
      if (opened.created) {
        cyclesOpened += 1
        warnings.push(`The ${next} review cycle was opened because every earlier cycle is closed. It is OPEN, not approved.`)
      }
    }
  }

  const admins = await prisma.user.findMany({
    where: { consultingFirmId: ctx.consultingFirmId, role: 'ADMIN', isActive: true },
    select: { id: true },
    take: 5,
  })
  const reminders = phases.includes('SEND_REVIEW_REMINDERS')
    ? proposeReminders(sectionReviews, admins.map((a) => a.id))
    : []

  let remindersSent = 0
  if (mayAct) {
    for (const reminder of reminders) {
      if (!reminder.userId) continue
      await notifyUser({
        consultingFirmId: ctx.consultingFirmId,
        userId: reminder.userId,
        type: 'PROPOSAL_REVIEW',
        title: `Proposal review reminder — ${proposal.title}`,
        body: reminder.reason.slice(0, 400),
        linkPath: `/opportunities/${proposal.opportunityId}/proposal`,
        entityType: 'ProposalSection',
        entityId: reminder.sectionId,
        dedupeKey: reminder.dedupeKey,
      }).catch(() => undefined)
      remindersSent += 1
    }
  }

  // ---- deterministic compliance -----------------------------------------------
  const deterministicBlockers: string[] = []
  const legalReviewItems: string[] = []
  const manualRequiredChecks: string[] = []

  for (const req of requirements.filter((r) => r.isMandatory)) {
    if (req.reviewRequired) legalReviewItems.push(`${req.section}: ${req.reviewReason ?? 'human review required'}`)
    if (req.isBlocked) deterministicBlockers.push(`${req.section}: ${req.blockerReason ?? 'blocked'}`)
    if (!req.isManuallyVerified) manualRequiredChecks.push(`${req.section} has not been human-verified.`)
  }

  const uncoveredMandatoryIds = outline.unmapped.map((u) => u.requirementId)

  // ---- BUILD_PROPOSAL_STATUS ----------------------------------------------------
  const status: ProposalStatusArtifact = {
    opportunityId: proposal.opportunityId,
    proposalId: proposal.id,
    generatedAt: now.toISOString(),
    methodVersion: PROPOSAL_METHOD_VERSION,
    outline: {
      totalItems: outline.items.length,
      mandatoryRequirements: outline.mandatoryRequirements,
      mappedMandatoryRequirements: outline.mappedMandatoryRequirements,
      unmappedMandatoryRequirements: outline.unmapped,
      coverageState:
        outline.mandatoryRequirements === 0 ? 'NO_REQUIREMENTS' : outline.unmapped.length === 0 ? 'COMPLETE' : 'GAPS_PRESENT',
      ambiguities: outline.ambiguities,
    },
    sections: sectionStatuses,
    drafting: {
      providerAvailable,
      sectionsReadyForDraft,
      sectionsDrafted,
      sectionsNeedingSourceMaterial,
      limitations: draftingLimitations.length > 0 ? [...new Set(draftingLimitations)] : providerAvailable ? [] : [NO_PROVIDER_LIMITATION],
    },
    capabilityLibrary: library,
    pastPerformance,
    compliance: {
      deterministicBlockers,
      aiFindings: crossCheck.result.findings,
      uncoveredMandatoryRequirements: uncoveredMandatoryIds,
      legalReviewItems,
      manualRequiredChecks,
      aiAdvisoryNote:
        'AI cross-check findings are advisory. They never mark a requirement verified, never clear a legal-review flag, and never override a deterministic blocker.',
    },
    reviewCycles: cycles,
    sectionReviews,
    adherence: {
      score: null,
      state: 'INSUFFICIENT_DATA',
      limitations: ['No adherence score was computed by the canonical engine for this proposal.'],
    },
    submissionReadiness: {
      state: deterministicBlockers.length > 0 ? 'BLOCKED' : uncoveredMandatoryIds.length > 0 ? 'NOT_READY' : 'REVIEW_REQUIRED',
      blockers: deterministicBlockers,
      manualRequired: manualRequiredChecks,
    },
    recommendedHumanActions,
    warnings,
    dataLimitations,
    inputHash: '',
  }
  status.inputHash = buildStatusHash(status)

  const previous = await prisma.agentArtifact.findFirst({
    where: {
      consultingFirmId: ctx.consultingFirmId,
      agentKey: PROPOSAL_AGENT_KEY,
      artifactType: 'PROPOSAL_STATUS',
      sourceEntityType: 'Proposal',
      sourceEntityId: proposal.id,
      supersededByArtifactId: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { structuredData: true },
  })
  const previousHash = (previous?.structuredData as { inputHash?: string } | null)?.inputHash ?? null
  const changed = previousHash !== status.inputHash

  const artifact: ProposedArtifact = {
    artifactType: 'PROPOSAL_STATUS',
    title: `Proposal status — ${proposal.title}`,
    summary:
      `${sectionStatuses.length} section(s), ${outline.mappedMandatoryRequirements}/${outline.mandatoryRequirements} mandatory requirement(s) mapped` +
      (outline.unmapped.length > 0 ? ` · ${outline.unmapped.length} unmapped` : '') +
      (sectionsDrafted > 0 ? ` · ${sectionsDrafted} draft(s) prepared` : ''),
    structuredData: status as unknown as Record<string, unknown>,
    evidence,
    sourceEntityType: 'Proposal',
    sourceEntityId: proposal.id,
    confidenceState: outline.unmapped.length > 0 ? 'MEDIUM' : 'HIGH',
    supersedeKey: `proposal-status:${proposal.id}`,
  }

  // ---- CREATE_ESCALATIONS ---------------------------------------------------------
  if (outline.unmapped.length > 0 && nearDeadline) {
    escalations.push({
      severity: 'HIGH',
      title: `Mandatory requirements unmapped near submission — ${proposal.title}`,
      reason:
        `${outline.unmapped.length} mandatory requirement(s) have no proposal section with ${workingDaysToDeadline} working day(s) until the deadline: ` +
        `${outline.unmapped.slice(0, 5).map((u) => u.section).join('; ')}.`,
      recommendedAction: 'Map each requirement to a section, or record why it does not apply.',
      entityType: 'Proposal',
      entityId: proposal.id,
      dedupeHint: `proposal-unmapped:${proposal.id}:${outline.unmapped.length}`,
    })
  }

  if (sectionsNeedingSourceMaterial > 0 && nearDeadline) {
    escalations.push({
      severity: 'MEDIUM',
      title: `SOURCE_MATERIAL_REQUIRED near submission — ${proposal.title}`,
      reason:
        `${sectionsNeedingSourceMaterial} section(s) have no approved capability material to draft from, with ${workingDaysToDeadline} working day(s) remaining. ` +
        'The agent will not fabricate the missing narrative.',
      recommendedAction: 'Approve capability-library versions covering these sections.',
      entityType: 'Proposal',
      entityId: proposal.id,
      dedupeHint: `proposal-source-required:${proposal.id}:${sectionsNeedingSourceMaterial}`,
    })
  }

  escalations.push(
    ...assessReviewEscalations({
      cycles,
      sections: sectionReviews,
      workingDaysToDeadline,
      deadlineRiskWindow: PROPOSAL_RISK_WORKING_DAYS,
    }).map((e) => ({
      severity: e.severity,
      title: `${e.title} — ${proposal.title}`,
      reason: e.reason,
      recommendedAction: 'A person must act; the agent does not complete a review.',
      entityType: e.sectionId ? 'ProposalSection' : 'Proposal',
      entityId: e.sectionId ?? proposal.id,
      dedupeHint: e.dedupeHint,
    })),
  )

  return {
    status,
    artifact,
    escalations,
    evidence,
    changed,
    sectionsDrafted,
    skeletonsCreated,
    cyclesOpened,
    remindersSent,
  }
}

// -------------------------------------------------------------
// Draft persistence — always DRAFT, never approved
// -------------------------------------------------------------

/**
 * Persist an AI draft as a NEW version.
 *
 * The section status moves to DRAFTING at most; an approved section is never
 * touched, and no version is ever written with an approved marker. The
 * fingerprint rides in `generationError` — the existing free-text field the
 * section already uses for generation bookkeeping — so a re-run with unchanged
 * inputs produces no second draft.
 */
async function persistDraftVersion(
  consultingFirmId: string,
  sectionId: string,
  draft: SectionDraft,
  fingerprint: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const section = await tx.proposalSection.findFirst({
      where: { id: sectionId, consultingFirmId },
      select: { id: true, status: true },
    })
    // Re-checked inside the transaction: a human may have approved the section
    // between the draft request and this write.
    if (!section || (LOCKED_SECTION_STATUSES as readonly string[]).includes(section.status)) return

    const latest = await tx.proposalSectionVersion.findFirst({
      where: { proposalSectionId: sectionId },
      orderBy: { version: 'desc' },
      select: { version: true },
    })

    await tx.proposalSectionVersion.create({
      data: {
        consultingFirmId,
        proposalSectionId: sectionId,
        version: (latest?.version ?? 0) + 1,
        content: draft.content,
        source: 'AI',
        isAiGenerated: true,
      },
    })

    await tx.proposalSection.update({
      where: { id: sectionId },
      data: {
        draft: draft.content,
        isAiGenerated: true,
        // DRAFTING at most. Never APPROVED, never IN_REVIEW — submitting for
        // review is a person's decision.
        status: section.status === 'OUTLINE' ? 'DRAFTING' : section.status,
        generationStatus: 'COMPLETED',
        generationError: fingerprint,
      },
    })
  })
}

/** Digest of the inputs a section draft was built from. */
export function buildSectionDraftFingerprint(args: {
  requirementIds: string[]
  sourceFingerprint: string
  existingDraft: string | null
}): string {
  const material = {
    requirements: [...args.requirementIds].sort(),
    sources: args.sourceFingerprint,
    hasExistingDraft: Boolean(args.existingDraft && args.existingDraft.trim().length > 0),
    promptVersion: 'proposal-section-draft-v1',
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 32)
}

// -------------------------------------------------------------
// Past performance — proposed, never selected
// -------------------------------------------------------------

async function proposePastPerformance(
  ctx: AgentExecutionContext,
  proposal: ScopeProposal,
  mayAct: boolean,
): Promise<ProposalStatusArtifact['pastPerformance']> {
  const records = await prisma.pastPerformanceRecord.findMany({
    where: { consultingFirmId: ctx.consultingFirmId },
    take: 100,
    orderBy: { id: 'asc' },
  })

  const opportunity = await prisma.opportunity.findFirst({
    where: { id: proposal.opportunityId, consultingFirmId: ctx.consultingFirmId },
    select: { naicsCode: true, agency: true, setAsideType: true, title: true, description: true },
  })

  // The canonical §5 relevance engine, called with its real contexts. No
  // second scoring model is introduced.
  const oppContext = {
    agency: opportunity?.agency ?? null,
    naicsCode: opportunity?.naicsCode ?? null,
    pscCode: null,
    scope: opportunity?.description ?? opportunity?.title ?? null,
    setAside: opportunity?.setAsideType ?? null,
    estimatedValue: null,
  }

  const scored = records
    .map((record) => ({
      record,
      result: scoreRelevance(oppContext, {
        id: record.id,
        customerAgency: record.customerAgency,
        naicsCode: (record.relevanceTags ?? []).find((t) => /^\d{6}$/.test(t)) ?? null,
        pscCode: null,
        scopeSummary: record.scopeSummary,
        relevanceTags: record.relevanceTags ?? [],
        totalValue: record.totalValue ? Number(record.totalValue) : null,
        periodOfPerformanceEnd: record.periodOfPerformanceEnd,
        performerRole: null,
        setAsideRelevance: null,
      }),
    }))
    .sort((a, b) => b.result.relevanceScore - a.result.relevanceScore || a.record.id.localeCompare(b.record.id))
    .slice(0, MAX_PAST_PERFORMANCE_CANDIDATES)

  // The relevance fields may be written; `isSelected` may NOT. Final selection
  // is a human decision and this code never touches that column.
  if (mayAct) {
    for (const { record, result } of scored) {
      await prisma.pastPerformanceSelection.upsert({
        where: { opportunityId_pastPerformanceRecordId: { opportunityId: proposal.opportunityId, pastPerformanceRecordId: record.id } },
        create: {
          consultingFirmId: ctx.consultingFirmId,
          opportunityId: proposal.opportunityId,
          pastPerformanceRecordId: record.id,
          proposalId: proposal.id,
          relevanceScore: Math.round(result.relevanceScore),
          confidence: result.confidence,
          matchingFactors: result.matchingFactors,
          missingFactors: result.missingFactors,
          relevanceExplanation: result.explanation,
          scoredAt: new Date(),
          scoreMethod: 'DETERMINISTIC',
        },
        update: {
          relevanceScore: Math.round(result.relevanceScore),
          confidence: result.confidence,
          matchingFactors: result.matchingFactors,
          missingFactors: result.missingFactors,
          relevanceExplanation: result.explanation,
          scoredAt: new Date(),
          scoreMethod: 'DETERMINISTIC',
        },
      }).catch(() => undefined)
    }
  }

  const selections = await prisma.pastPerformanceSelection.findMany({
    where: { consultingFirmId: ctx.consultingFirmId, opportunityId: proposal.opportunityId },
    include: { record: { select: { contractTitle: true, customerName: true } } },
  })

  return {
    proposedSelections: scored.map(({ record, result }) => ({
      recordId: record.id,
      title: record.contractTitle ?? record.customerName ?? 'Untitled record',
      relevanceScore: Math.round(result.relevanceScore),
      confidence: result.confidence,
      explanation: result.explanation,
    })),
    approvedSelections: selections
      .filter((s) => s.isSelected)
      .map((s) => ({ recordId: s.pastPerformanceRecordId, selectedByUserId: s.selectedByUserId })),
    adaptedDrafts: 0,
    unsupportedClaims: [],
  }
}

// -------------------------------------------------------------
// Idempotency
// -------------------------------------------------------------

function buildStatusHash(status: ProposalStatusArtifact): string {
  const material = {
    proposal: status.proposalId,
    outline: `${status.outline.mandatoryRequirements}:${status.outline.mappedMandatoryRequirements}:${status.outline.unmappedMandatoryRequirements.map((u) => u.requirementId).sort().join('|')}`,
    sections: status.sections
      .map((s) => `${s.sectionId}:${s.currentVersionStatus}:${s.draftState}:${s.coverageState}:${s.sourceMaterialState}`)
      .sort(),
    library: `${status.capabilityLibrary.approvedVersions}:${status.capabilityLibrary.narratives}`,
    pastPerformance: status.pastPerformance.approvedSelections.map((s) => s.recordId).sort().join('|'),
    compliance: `${status.compliance.deterministicBlockers.length}:${status.compliance.uncoveredMandatoryRequirements.sort().join('|')}`,
    cycles: status.reviewCycles.map((c) => `${c.cycleId}:${c.status}`).sort(),
    readiness: status.submissionReadiness.state,
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

export { NO_PROVIDER_LIMITATION }
export type { Prisma }
