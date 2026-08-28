// =============================================================
// §7.5 — Teaming Agent handler.
//
// A plain async handler on the shared §7.0 runtime. It creates no queue, no
// worker, no scheduler and no reaper.
//
// WHAT IT MAY DO
//   propose partners with per-dimension evidence · propose a workshare, always
//   labelled PROPOSED · prepare agreement/NDA and outreach DRAFTS · compute
//   objective partner performance · compute subcontracting-goal attainment ·
//   notify internal users · raise escalations
//
// WHAT IT MAY NEVER DO — at PROPOSE *or* ACT_WITH_GUARDRAILS
//   execute a teaming arrangement · mark an agreement SIGNED or EXECUTED ·
//   create a signature or acceptance · clear a legal-review requirement ·
//   send outreach through any channel · contact a partner · record a
//   subjective partner judgement · alter a BidDecision · change a verified
//   subcontracting target
//
// It imports no mail transport and no messaging client. There is no code path
// from this file to an outbound send.
// =============================================================
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import { notifyUser } from '../../notificationService'
import { assessCapabilityGaps, type GapAssessment } from '../../scoring/capabilityGap'
import { matchPartnerToOpportunity, type MatchPartner, type PartnerMatchResult } from '../../partnerMatch'
import { workingDaysBetween } from '../../milestones/workingDays'
import { buildWorkingCalendar } from '../workingCalendar'
import { isLlmProviderConfigured } from '../../llm/llmRouter'
import type {
  AgentExecutionContext,
  AgentHandlerResult,
  EvidenceRef,
  ProposedArtifact,
  ProposedEscalation,
} from '../types'
import {
  computePartnerPerformance,
  assessPerformanceDecline,
  persistPartnerPerformance,
  findPriorPeriod,
  summarisePerformance,
  MINIMUM_SAMPLE_SIZE,
} from './partnerPerformance'
import {
  loadActionableGoals,
  loadGoalSpendEvidence,
  computeGoalAttainment,
  persistGoalProgress,
  AT_RISK_WORKING_DAYS,
} from './subcontractGoals'
import { emitSubcontractMilestoneDue } from './teamingEvents'
import { draftAgreement, draftOutreach, type AgreementDraft, type OutreachDraft, type WorkshareProposal } from './teamingDrafts'

export const TEAMING_AGENT_KEY = 'TEAMING' as const
export const TEAMING_METHOD_VERSION = 'teaming-v1'

const DAY_MS = 86_400_000

/** Stages where teaming support is still actionable. */
export const TEAMABLE_STAGES = ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL'] as const

/** A tenant sweep is bounded so one firm cannot monopolise the shared worker. */
export const MAX_PURSUITS_PER_SWEEP = 25

/** Partners considered per pursuit, ranked deterministically before the cut. */
export const MAX_PARTNER_CANDIDATES = 10

/** Inside this many working days, an unresolved critical gap escalates. */
export const CRITICAL_GAP_WORKING_DAYS = 15

/** Trailing window the performance refresh measures. */
export const PERFORMANCE_WINDOW_DAYS = 90

/**
 * The wording used when the tenant's own network yields nothing.
 *
 * It says the NETWORK holds no suitable partner. It never claims no such
 * company exists in the market — the platform has not looked at the market.
 */
export const NO_SUITABLE_PARTNER_MESSAGE = 'No suitable partner was found in the current partner network.'

export const TEAMING_PHASES = [
  'LOAD_PURSUIT',
  'LOAD_CAPABILITY_GAPS',
  'LOAD_PARTNER_NETWORK',
  'FILTER_ELIGIBLE_PARTNERS',
  'RANK_PARTNERS',
  'CHECK_PARTNER_PERFORMANCE',
  'CHECK_SUBCONTRACT_GOALS',
  'CHECK_OBLIGATION_DEADLINES',
  'PREPARE_DRAFT_OPTIONS',
  'BUILD_TEAMING_PLAN',
  'CREATE_NOTIFICATIONS',
  'CREATE_ESCALATIONS',
  'COMPLETE',
] as const

export type TeamingPhase = (typeof TEAMING_PHASES)[number]

/**
 * Only the phases a given trigger actually needs.
 *
 * A PARTNER_ADDED run re-evaluates gaps against the enlarged network but has no
 * reason to recompute quarterly performance; a SUBCONTRACT_MILESTONE_DUE run
 * touches goals and deadlines only.
 */
export function phasesForRun(triggerEntityType: string | null): TeamingPhase[] {
  if (triggerEntityType === 'SubcontractingGoal') {
    return ['CHECK_SUBCONTRACT_GOALS', 'CHECK_OBLIGATION_DEADLINES', 'CREATE_NOTIFICATIONS', 'CREATE_ESCALATIONS', 'COMPLETE']
  }
  if (triggerEntityType === 'Partner') {
    return [
      'LOAD_PURSUIT', 'LOAD_CAPABILITY_GAPS', 'LOAD_PARTNER_NETWORK', 'FILTER_ELIGIBLE_PARTNERS',
      'RANK_PARTNERS', 'PREPARE_DRAFT_OPTIONS', 'BUILD_TEAMING_PLAN', 'CREATE_NOTIFICATIONS',
      'CREATE_ESCALATIONS', 'COMPLETE',
    ]
  }
  return [...TEAMING_PHASES]
}

// -------------------------------------------------------------
// Plan shape
// -------------------------------------------------------------

export interface TeamingPlanGap {
  gapId: string
  requirement: string
  gapClass: 'CAPABILITY' | 'CERTIFICATION' | 'ELIGIBILITY' | 'GEOGRAPHY' | 'VEHICLE' | 'CAPACITY'
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR'
  evidence: string
  dataSufficiency: string
  /** A matched partner is PROPOSED mitigation. It never closes the gap. */
  mitigationStatus: 'UNRESOLVED' | 'PROPOSED_MITIGATION' | 'HUMAN_APPROVED_ARRANGEMENT'
}

export interface TeamingPlanCandidate {
  partnerId: string
  name: string
  overallFit: number
  dimensions: Array<{ dimension: string; points: number; detail: string }>
  matchingCapabilities: string[]
  missingRequirements: string[]
  certifications: { claimed: string[]; requiredForSetAside: string | null; met: boolean; detail: string; verificationState: string }
  geography: { level: string; detail: string }
  relevantExperience: { priorTeamedBids: number; priorWins: number; detail: string }
  performanceSummary: ReturnType<typeof summarisePerformance>
  evidence: string
  limitations: string[]
  eligibilityState: 'POSSIBLY_ELIGIBLE' | 'INSUFFICIENT_DATA' | 'NOT_ESTABLISHED'
}

export interface TeamingPlan {
  pursuitId: string
  opportunityId: string
  opportunityTitle: string
  generatedAt: string
  methodVersion: string
  capabilityGaps: TeamingPlanGap[]
  partnerCandidates: TeamingPlanCandidate[]
  noSuitablePartner: boolean
  noSuitablePartnerMessage: string | null
  proposedWorkshare: WorkshareProposal
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
    riskState: string
    dataSufficiency: string
    dueDate: string | null
    workingDaysRemaining: number | null
    isHumanVerified: boolean
    source: string
    limitations: string[]
  }>
  obligationDeadlines: Array<{ goalId: string; dueDate: string; workingDaysRemaining: number | null; riskState: string }>
  partnerPerformance: Array<{
    partnerId: string
    partnerName: string
    sampleSize: number
    dataSufficiency: string
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

// -------------------------------------------------------------
// Handler
// -------------------------------------------------------------

export async function teamingAgentHandler(ctx: AgentExecutionContext): Promise<AgentHandlerResult> {
  const now = new Date()
  // OBSERVE computes and persists evidence but neither notifies nor escalates.
  const mayAct = ctx.autonomyLevel !== 'OBSERVE'
  const phases = phasesForRun(ctx.triggerEntityType)

  const warnings: string[] = []
  const limitations: string[] = []
  const evidence: EvidenceRef[] = []
  const escalations: ProposedEscalation[] = []
  const artifacts: ProposedArtifact[] = []

  const firm = await prisma.consultingFirm.findUnique({
    where: { id: ctx.consultingFirmId },
    select: { name: true },
  })

  // The LLM is strictly optional, and BOTH conditions must hold: a provider is
  // actually configured, and the run has budget. A firm with no key never
  // reaches the router at all, so NO_LLM_KEY cannot arise.
  const providerConfigured = await isLlmProviderConfigured(ctx.consultingFirmId)
  const useLlm = providerConfigured && (await ctx.budget.check(1)).allowed
  if (!providerConfigured) {
    limitations.push('No LLM provider is configured, so every draft was produced from the deterministic template. The template carries the same legal-review and human-send guarantees.')
  }

  const goalPhaseOnly = ctx.triggerEntityType === 'SubcontractingGoal'
  const pursuits = goalPhaseOnly ? [] : await resolveScope(ctx)
  ctx.log('teaming scope resolved', {
    pursuits: pursuits.length,
    triggerEntityType: ctx.triggerEntityType,
    mayAct,
    useLlm,
  })

  // ---- goal + performance work is tenant-level, not per-pursuit ----------
  const goalOutcome = phases.includes('CHECK_SUBCONTRACT_GOALS')
    ? await refreshSubcontractingGoals(ctx, now, mayAct)
    : { goals: [], deadlines: [], escalations: [], limitations: [], notified: 0 }

  const performanceOutcome = phases.includes('CHECK_PARTNER_PERFORMANCE')
    ? await refreshPartnerPerformance(ctx, now, mayAct)
    : { records: [], escalations: [], limitations: [], notified: 0 }

  escalations.push(...goalOutcome.escalations, ...performanceOutcome.escalations)
  limitations.push(...goalOutcome.limitations, ...performanceOutcome.limitations)

  if (pursuits.length === 0 && goalOutcome.goals.length === 0 && performanceOutcome.records.length === 0) {
    return {
      status: 'SKIPPED',
      summary: ctx.triggerEntityId
        ? 'The targeted record is not in scope for teaming support, or does not belong to this firm.'
        : 'No pursuit has an open capability gap, and no verified subcontracting goal or attributed partner work exists for this firm.',
      confidence: 'HIGH',
      dataSufficiency: 'SUFFICIENT',
      metrics: { pursuitsScanned: 0, goalsTracked: 0, partnersMeasured: 0 },
      limitations: [
        `Only pursuits in stage ${TEAMABLE_STAGES.join(', ')} receive teaming support.`,
        ...limitations,
      ],
      inputSnapshot: { scope: ctx.triggerEntityId ?? 'TENANT', pursuitCount: 0 },
      inputHash: `teaming:${ctx.consultingFirmId}:none:${now.toISOString().slice(0, 10)}`,
    }
  }

  let planned = 0
  let failed = 0
  let changed = 0
  let candidatesTotal = 0
  let gapsTotal = 0
  let draftsTotal = 0
  let outreachTotal = 0
  let noPartnerCount = 0
  let notified = goalOutcome.notified + performanceOutcome.notified

  for (const pursuit of pursuits) {
    if (ctx.signal.aborted) {
      limitations.push('The run was cancelled before every pursuit was planned.')
      break
    }
    try {
      const outcome = await planPursuit({
        ctx,
        pursuit,
        now,
        mayAct,
        useLlm,
        firmName: firm?.name ?? 'This firm',
        goals: goalOutcome.goals.filter((g) => g.pursuitId === pursuit.id || g.pursuitId === null),
        deadlines: goalOutcome.deadlines,
        performance: performanceOutcome.records,
      })
      planned += 1
      changed += outcome.changed ? 1 : 0
      candidatesTotal += outcome.plan.partnerCandidates.length
      gapsTotal += outcome.plan.capabilityGaps.length
      draftsTotal += outcome.plan.drafts.length
      outreachTotal += outcome.plan.outreachDrafts.length
      noPartnerCount += outcome.plan.noSuitablePartner ? 1 : 0
      notified += outcome.notified

      warnings.push(...outcome.plan.warnings.map((w) => `[${pursuit.opportunityTitle}] ${w}`))
      limitations.push(...outcome.plan.dataLimitations.map((l) => `[${pursuit.opportunityTitle}] ${l}`))
      evidence.push(...outcome.evidence)
      escalations.push(...outcome.escalations)
      artifacts.push(outcome.artifact)
    } catch (err) {
      // One malformed partner row, or one unreadable pursuit, must not take the
      // whole tenant run down.
      failed += 1
      const message = (err as Error).message
      warnings.push(`[${pursuit.opportunityTitle}] could not be planned: ${message}`)
      limitations.push(`[${pursuit.opportunityTitle}] was skipped because its teaming evidence could not be read safely.`)
      logger.error('Teaming planning failed for one pursuit (continuing)', {
        pursuitId: pursuit.id, runId: ctx.runId, error: message,
      })
    }
    const denominator = Math.max(1, pursuits.length)
    await ctx
      .heartbeat(Math.round((planned / denominator) * 100), `planned ${planned}/${pursuits.length}`)
      .catch(() => undefined)
  }

  const summaryParts = [
    `Planned teaming for ${planned} pursuit(s) across ${gapsTotal} open capability gap(s), proposing ${candidatesTotal} partner candidate(s).`,
  ]
  if (noPartnerCount > 0) summaryParts.push(`${noPartnerCount} gap set had no suitable partner in the current network.`)
  if (draftsTotal > 0 || outreachTotal > 0) {
    summaryParts.push(`${draftsTotal} agreement/NDA draft(s) and ${outreachTotal} outreach draft(s) were prepared for human review.`)
  }
  if (goalOutcome.goals.length > 0) summaryParts.push(`${goalOutcome.goals.length} subcontracting goal(s) measured.`)
  if (performanceOutcome.records.length > 0) summaryParts.push(`${performanceOutcome.records.length} partner performance record(s) refreshed.`)
  if (failed > 0) summaryParts.push(`${failed} pursuit(s) could not be planned.`)
  summaryParts.push('Nothing was executed, signed or sent.')

  return {
    status: 'COMPLETED',
    summary: summaryParts.join(' '),
    confidence: planned === 0 && goalOutcome.goals.length === 0 ? 'LOW' : failed > 0 ? 'MEDIUM' : 'HIGH',
    dataSufficiency: failed > 0 || limitations.length > 0 ? 'PARTIAL' : 'SUFFICIENT',
    evidence,
    artifacts,
    escalations,
    metrics: {
      pursuitsScanned: pursuits.length,
      pursuitsPlanned: planned,
      pursuitsFailed: failed,
      plansChanged: changed,
      capabilityGaps: gapsTotal,
      partnerCandidates: candidatesTotal,
      agreementDrafts: draftsTotal,
      outreachDrafts: outreachTotal,
      noSuitablePartner: noPartnerCount,
      goalsTracked: goalOutcome.goals.length,
      partnersMeasured: performanceOutcome.records.length,
      escalationsRaised: escalations.length,
      notificationsSent: notified,
      // All four are proven zero by test at both autonomy levels, and live.
      arrangementsExecuted: 0,
      agreementsSigned: 0,
      outreachMessagesSent: 0,
      bidDecisionsAltered: 0,
    },
    warnings,
    limitations,
    inputSnapshot: {
      scope: ctx.triggerEntityId ?? 'TENANT',
      triggerEntityType: ctx.triggerEntityType,
      pursuitIds: pursuits.map((p) => p.id),
      goalIds: goalOutcome.goals.map((g) => g.goalId),
      autonomyLevel: ctx.autonomyLevel,
      llmUsed: useLlm,
    },
    inputHash: `teaming:${ctx.consultingFirmId}:${ctx.triggerEntityId ?? 'TENANT'}:${pursuits.map((p) => p.id).sort().join(',').slice(0, 200)}`,
  }
}

// -------------------------------------------------------------
// Scope — always tenant-filtered
// -------------------------------------------------------------

interface ScopePursuit {
  id: string
  opportunityId: string
  opportunityTitle: string
  agency: string
  naicsCode: string
  setAsideType: string
  description: string | null
  placeOfPerformance: string | null
  solicitationNumber: string | null
  responseDeadline: Date | null
  pipelineStage: string
  ownerUserId: string | null
}

/**
 * Resolve what this run covers.
 *
 * Every branch filters on `consultingFirmId`. A targeted id belonging to
 * another firm resolves to nothing rather than to that firm's record.
 */
async function resolveScope(ctx: AgentExecutionContext): Promise<ScopePursuit[]> {
  const select = {
    id: true,
    opportunityId: true,
    pipelineStage: true,
    ownerUserId: true,
    opportunity: {
      select: {
        title: true, agency: true, naicsCode: true, setAsideType: true,
        description: true, placeOfPerformance: true, samNoticeId: true, responseDeadline: true,
      },
    },
  } satisfies Prisma.BidPursuitSelect

  const shape = (rows: Array<{
    id: string; opportunityId: string; pipelineStage: string; ownerUserId: string | null
    opportunity: {
      title: string; agency: string; naicsCode: string; setAsideType: string
      description: string | null; placeOfPerformance: string | null
      samNoticeId: string | null; responseDeadline: Date | null
    }
  }>): ScopePursuit[] =>
    rows.map((r) => ({
      id: r.id,
      opportunityId: r.opportunityId,
      opportunityTitle: r.opportunity.title,
      agency: r.opportunity.agency,
      naicsCode: r.opportunity.naicsCode,
      setAsideType: r.opportunity.setAsideType,
      description: r.opportunity.description,
      placeOfPerformance: r.opportunity.placeOfPerformance,
      solicitationNumber: r.opportunity.samNoticeId,
      responseDeadline: r.opportunity.responseDeadline,
      pipelineStage: r.pipelineStage,
      ownerUserId: r.ownerUserId,
    }))

  const stageFilter = { pipelineStage: { in: [...TEAMABLE_STAGES] as never } }

  if (ctx.triggerEntityType === 'BidPursuit' && ctx.triggerEntityId) {
    const rows = await prisma.bidPursuit.findMany({
      where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId, ...stageFilter },
      select,
    })
    return shape(rows)
  }

  if (ctx.triggerEntityType === 'Opportunity' && ctx.triggerEntityId) {
    const rows = await prisma.bidPursuit.findMany({
      where: { opportunityId: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId, ...stageFilter },
      select,
    })
    return shape(rows)
  }

  // PARTNER_ADDED re-evaluates every open pursuit against the enlarged network.
  const rows = await prisma.bidPursuit.findMany({
    where: { consultingFirmId: ctx.consultingFirmId, ...stageFilter },
    select,
    orderBy: [{ lastActivityAt: 'desc' }, { id: 'asc' }],
    take: MAX_PURSUITS_PER_SWEEP,
  })
  return shape(rows)
}

// -------------------------------------------------------------
// Per-pursuit planning
// -------------------------------------------------------------

interface PlanOutcome {
  plan: TeamingPlan
  artifact: ProposedArtifact
  escalations: ProposedEscalation[]
  evidence: EvidenceRef[]
  changed: boolean
  notified: number
}

async function planPursuit(args: {
  ctx: AgentExecutionContext
  pursuit: ScopePursuit
  now: Date
  mayAct: boolean
  useLlm: boolean
  firmName: string
  goals: GoalRow[]
  deadlines: Array<{ goalId: string; dueDate: string; workingDaysRemaining: number | null; riskState: string }>
  performance: PerformanceRow[]
}): Promise<PlanOutcome> {
  const { ctx, pursuit, now, mayAct, useLlm, firmName } = args
  const warnings: string[] = []
  const dataLimitations: string[] = []
  const evidence: EvidenceRef[] = []
  const escalations: ProposedEscalation[] = []

  // ---- LOAD_CAPABILITY_GAPS — the canonical §6 engine, never a second one --
  let assessment: GapAssessment | null = null
  try {
    assessment = await assessCapabilityGaps(ctx.consultingFirmId, pursuit.opportunityId)
  } catch (err) {
    dataLimitations.push(`The capability gap assessment could not run: ${(err as Error).message}`)
  }

  const gaps = assessment ? buildGaps(assessment) : []
  dataLimitations.push(...(assessment?.limitations ?? []))
  if (assessment) {
    evidence.push({
      sourceType: 'CapabilityGapAssessment',
      sourceId: pursuit.opportunityId,
      retrievedAt: now.toISOString(),
      note: `${gaps.length} open gap(s); ${gaps.filter((g) => g.severity === 'CRITICAL').length} critical`,
    })
  }

  // ---- LOAD_PARTNER_NETWORK — tenant-private, always ----------------------
  const partners = await prisma.partner.findMany({
    where: { consultingFirmId: ctx.consultingFirmId, isActive: true },
    select: {
      id: true, name: true, uei: true, cmmcLevel: true, primaryNaicsCodes: true,
      primarySetAsides: true, capabilities: true, certifications: true, geography: true,
      contactName: true, contactEmail: true,
    },
    orderBy: { id: 'asc' },
    take: 200,
  })

  if (partners.length === 0) {
    dataLimitations.push('This firm has no active partner records, so no candidate could be considered.')
  }

  // Prior teaming context, also tenant-scoped.
  const priorArrangements = await prisma.teamingArrangement.findMany({
    where: { consultingFirmId: ctx.consultingFirmId },
    select: { partnerId: true, opportunityId: true, teamingStatus: true, opportunity: { select: { status: true } } },
  })
  const priorByPartner = new Map<string, { oppIds: Set<string>; wonIds: Set<string> }>()
  for (const a of priorArrangements) {
    const entry = priorByPartner.get(a.partnerId) ?? { oppIds: new Set<string>(), wonIds: new Set<string>() }
    entry.oppIds.add(a.opportunityId)
    if (a.opportunity?.status === 'AWARDED') entry.wonIds.add(a.opportunityId)
    priorByPartner.set(a.partnerId, entry)
  }

  // ---- FILTER_ELIGIBLE_PARTNERS + RANK_PARTNERS ---------------------------
  const matchOpportunity = {
    naicsCode: pursuit.naicsCode,
    setAsideType: pursuit.setAsideType,
    title: pursuit.opportunityTitle,
    description: pursuit.description,
    placeOfPerformance: pursuit.placeOfPerformance,
  }

  const ranked: Array<{ partner: (typeof partners)[number]; match: PartnerMatchResult }> = []
  for (const p of partners) {
    try {
      const prior = priorByPartner.get(p.id) ?? { oppIds: new Set<string>(), wonIds: new Set<string>() }
      const match = matchPartnerToOpportunity(
        {
          id: p.id, name: p.name, uei: p.uei, cmmcLevel: p.cmmcLevel,
          primaryNaicsCodes: p.primaryNaicsCodes, primarySetAsides: p.primarySetAsides,
          capabilities: p.capabilities, certifications: p.certifications, geography: p.geography,
        } satisfies MatchPartner,
        matchOpportunity,
        { priorOppIds: prior.oppIds, wonOppIds: prior.wonIds },
      )
      ranked.push({ partner: p, match })
    } catch (err) {
      // One malformed partner row is skipped, named, and does not stop the rest.
      warnings.push(`Partner ${p.name} could not be scored and was skipped: ${(err as Error).message}`)
    }
  }

  // Deterministic ordering: score desc, then id asc so ties never shuffle.
  ranked.sort((a, b) => (b.match.score - a.match.score) || a.partner.id.localeCompare(b.partner.id))
  const shortlist = ranked.slice(0, MAX_PARTNER_CANDIDATES)

  const candidates: TeamingPlanCandidate[] = shortlist.map(({ partner, match }) => {
    const prior = priorByPartner.get(partner.id) ?? { oppIds: new Set<string>(), wonIds: new Set<string>() }
    const perf = args.performance.find((r) => r.partnerId === partner.id)
    return {
      partnerId: partner.id,
      name: partner.name,
      overallFit: match.score,
      dimensions: match.factors.map((f) => ({ dimension: f.factor, points: f.points, detail: f.detail })),
      matchingCapabilities: match.matchingCapabilities,
      missingRequirements: match.missingRequirements,
      certifications: {
        claimed: partner.certifications,
        requiredForSetAside: match.certificationFit.required,
        met: match.certificationFit.met,
        detail: match.certificationFit.detail,
        // Partner certifications are self-declared records in this build. They
        // are never presented as verified.
        verificationState: partner.certifications.length > 0 ? 'UNVERIFIED_SELF_DECLARED' : 'NONE_RECORDED',
      },
      geography: { level: match.geographyFit.level, detail: match.geographyFit.detail },
      relevantExperience: {
        priorTeamedBids: prior.oppIds.size,
        priorWins: prior.wonIds.size,
        detail:
          prior.oppIds.size === 0
            ? 'No prior teaming record with this firm.'
            : `${prior.wonIds.size} win(s) across ${prior.oppIds.size} prior teamed bid(s) with this firm.`,
      },
      performanceSummary: summarisePerformance(perf?.record ?? null),
      evidence: match.whyRecommended,
      limitations: match.dataLimitations,
      eligibilityState: eligibilityStateFor(match),
    }
  })

  const criticalGaps = gaps.filter((g) => g.severity === 'CRITICAL')
  // A candidate is suitable only if it actually addresses something.
  const suitable = candidates.filter((c) => c.matchingCapabilities.length > 0 || c.certifications.met)
  const noSuitablePartner = criticalGaps.length > 0 && suitable.length === 0

  if (noSuitablePartner) {
    dataLimitations.push(
      `${NO_SUITABLE_PARTNER_MESSAGE} ${partners.length} active partner record(s) were evaluated. This is a statement about this firm's own network, not about the market.`,
    )
  }

  // A proposed mitigation NEVER downgrades a critical gap.
  for (const gap of gaps) {
    if (suitable.some((c) => c.matchingCapabilities.some((cap) => gap.requirement.toLowerCase().includes(cap.toLowerCase())))) {
      gap.mitigationStatus = 'PROPOSED_MITIGATION'
    }
  }
  // Only a person moves an arrangement to COMMITTED or signs the agreement.
  // Until then, a matched partner is a proposal and nothing more.
  const approved = await prisma.teamingArrangement.findFirst({
    where: {
      consultingFirmId: ctx.consultingFirmId,
      opportunityId: pursuit.opportunityId,
      OR: [{ teamingStatus: 'COMMITTED' }, { agreementStatus: 'SIGNED' }],
    },
    select: { id: true },
  })
  if (approved) {
    for (const gap of gaps) {
      if (gap.mitigationStatus === 'PROPOSED_MITIGATION') gap.mitigationStatus = 'HUMAN_APPROVED_ARRANGEMENT'
    }
  }

  // ---- proposed workshare -------------------------------------------------
  const workshare = proposeWorkshare(gaps, suitable)

  // ---- PREPARE_DRAFT_OPTIONS ---------------------------------------------
  const drafts: TeamingPlan['drafts'] = []
  const outreachDrafts: TeamingPlan['outreachDrafts'] = []
  const topCandidate = suitable[0]

  if (topCandidate && criticalGaps.length > 0) {
    const partnerRow = partners.find((p) => p.id === topCandidate.partnerId)!
    const agreement = await draftAgreement(
      ctx,
      {
        documentType: 'TEAMING_AGREEMENT',
        firmName,
        partnerId: topCandidate.partnerId,
        partnerName: topCandidate.name,
        partnerRole: 'SUB',
        arrangementType: 'TEAMING_AGREEMENT',
        opportunityId: pursuit.opportunityId,
        opportunityTitle: pursuit.opportunityTitle,
        agency: pursuit.agency,
        solicitationNumber: pursuit.solicitationNumber,
        capabilityGapsAddressed: criticalGaps.map((g) => g.requirement),
        partnerContribution: topCandidate.matchingCapabilities,
        workshare,
        certificationEvidence: topCandidate.certifications.claimed,
      },
      { useLlm },
    )
    dataLimitations.push(...agreement.limitations)
    warnings.push(...agreement.warnings)
    drafts.push(describeDraft(agreement.draft, topCandidate.partnerId))

    const outreach = await draftOutreach(
      ctx,
      {
        partnerId: topCandidate.partnerId,
        partnerName: topCandidate.name,
        contactName: partnerRow.contactName,
        contactAddress: partnerRow.contactEmail,
        opportunityId: pursuit.opportunityId,
        opportunityTitle: pursuit.opportunityTitle,
        solicitationNumber: pursuit.solicitationNumber,
        agency: pursuit.agency,
        capabilityGaps: criticalGaps.map((g) => g.requirement),
        matchEvidence: topCandidate.dimensions
          .filter((d) => d.points > 0)
          .map((d) => ({ reason: d.dimension, evidence: d.detail })),
        hasAgreementDraft: true,
      },
      { useLlm },
    )
    dataLimitations.push(...outreach.limitations)
    warnings.push(...outreach.warnings)
    outreachDrafts.push({
      draftId: `${pursuit.id}:${topCandidate.partnerId}:OUTREACH`,
      partnerId: topCandidate.partnerId,
      status: outreach.draft.status,
      source: outreach.draft.source,
      sendAllowed: outreach.draft.sendAllowed,
      humanSendRequired: outreach.draft.humanSendRequired,
      subject: outreach.draft.subject,
    })
  }

  // ---- BUILD_TEAMING_PLAN -------------------------------------------------
  const relevantGoals = args.goals.filter((g) => g.pursuitId === pursuit.id)
  const notificationLog: string[] = []
  const escalationLog: string[] = []

  const plan: TeamingPlan = {
    pursuitId: pursuit.id,
    opportunityId: pursuit.opportunityId,
    opportunityTitle: pursuit.opportunityTitle,
    generatedAt: now.toISOString(),
    methodVersion: TEAMING_METHOD_VERSION,
    capabilityGaps: gaps,
    partnerCandidates: candidates,
    noSuitablePartner,
    noSuitablePartnerMessage: noSuitablePartner ? NO_SUITABLE_PARTNER_MESSAGE : null,
    proposedWorkshare: workshare,
    drafts,
    outreachDrafts,
    subcontractingGoals: relevantGoals.map((g) => g.summary),
    obligationDeadlines: args.deadlines.filter((d) => relevantGoals.some((g) => g.goalId === d.goalId)),
    partnerPerformance: args.performance
      .filter((r) => candidates.some((c) => c.partnerId === r.partnerId))
      .map((r) => r.summary),
    notifications: notificationLog,
    escalations: escalationLog,
    warnings,
    dataLimitations,
  }

  // ---- CREATE_ESCALATIONS -------------------------------------------------
  const calendar = await buildWorkingCalendar(ctx.consultingFirmId, now)
  const unresolvedCritical = gaps.filter(
    (g) => g.severity === 'CRITICAL' && g.mitigationStatus !== 'HUMAN_APPROVED_ARRANGEMENT',
  )

  if (unresolvedCritical.length > 0 && pursuit.responseDeadline) {
    const workingDays = workingDaysBetween(now, pursuit.responseDeadline, calendar)
    if (workingDays >= 0 && workingDays <= CRITICAL_GAP_WORKING_DAYS) {
      const title = `Critical capability gap near submission — ${pursuit.opportunityTitle}`
      escalations.push({
        severity: workingDays <= 5 ? 'CRITICAL' : 'HIGH',
        title,
        reason:
          `${unresolvedCritical.length} critical capability gap(s) remain unresolved with ${workingDays} working day(s) until the response deadline: ` +
          `${unresolvedCritical.map((g) => g.requirement).join('; ')}. ` +
          `${suitable.length} candidate partner(s) were proposed. A proposed partner does not close the gap — only a teaming arrangement a person approves does.`,
        recommendedAction: 'Review the teaming plan, approve or reject the proposed partner, and record the arrangement.',
        entityType: 'BidPursuit',
        entityId: pursuit.id,
        assignedToUserId: pursuit.ownerUserId,
        dedupeHint: `teaming-critical-gap:${pursuit.id}`,
      })
      escalationLog.push(title)
    }
  }

  if (noSuitablePartner) {
    const title = `No suitable partner in network — ${pursuit.opportunityTitle}`
    escalations.push({
      severity: 'HIGH',
      title,
      reason:
        `${NO_SUITABLE_PARTNER_MESSAGE} ${criticalGaps.length} critical gap(s) remain and ${partners.length} active partner record(s) were evaluated against them. ` +
        'This describes this firm\'s own partner network only; the platform has not searched the market.',
      recommendedAction: 'Add partner records that cover the missing capability, or reconsider the pursuit.',
      entityType: 'BidPursuit',
      entityId: pursuit.id,
      assignedToUserId: pursuit.ownerUserId,
      dedupeHint: `teaming-no-partner:${pursuit.id}`,
    })
    escalationLog.push(title)
  }

  // ---- artifact + supersession -------------------------------------------
  const inputHash = buildPlanHash(plan)
  const supersedeKey = `teaming-plan:${pursuit.id}`
  const previous = await prisma.agentArtifact.findFirst({
    where: {
      consultingFirmId: ctx.consultingFirmId,
      agentKey: TEAMING_AGENT_KEY,
      artifactType: 'TEAMING_PLAN',
      sourceEntityType: 'BidPursuit',
      sourceEntityId: pursuit.id,
      supersededByArtifactId: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, structuredData: true },
  })
  const previousHash = (previous?.structuredData as { inputHash?: string } | null)?.inputHash ?? null
  const changed = previousHash !== inputHash

  const artifact: ProposedArtifact = {
    artifactType: 'TEAMING_PLAN',
    title: `Teaming plan — ${pursuit.opportunityTitle}`,
    summary:
      `${gaps.length} gap(s), ${candidates.length} candidate(s)` +
      (noSuitablePartner ? ' — no suitable partner in network' : '') +
      (drafts.length > 0 ? ` · ${drafts.length} draft(s) awaiting legal review` : ''),
    structuredData: { ...plan, inputHash } as unknown as Record<string, unknown>,
    evidence,
    sourceEntityType: 'BidPursuit',
    sourceEntityId: pursuit.id,
    confidenceState: gaps.length === 0 ? 'HIGH' : candidates.length > 0 ? 'MEDIUM' : 'LOW',
    supersedeKey,
  }

  // ---- CREATE_NOTIFICATIONS ----------------------------------------------
  let notified = 0
  if (mayAct && changed && pursuit.ownerUserId) {
    if (unresolvedCritical.length > 0) {
      await notifyUser({
        consultingFirmId: ctx.consultingFirmId,
        userId: pursuit.ownerUserId,
        type: 'TEAMING_REMINDER',
        title: `Teaming plan updated — ${unresolvedCritical.length} critical gap(s)`,
        body: `${pursuit.opportunityTitle}: ${suitable.length} candidate partner(s) proposed. Nothing has been agreed or sent.`.slice(0, 400),
        linkPath: `/teaming?pursuit=${pursuit.id}`,
        entityType: 'BidPursuit',
        entityId: pursuit.id,
        dedupeKey: `teaming-plan:${pursuit.id}:${inputHash}`,
      }).catch((err) => warnings.push(`Owner notification failed: ${(err as Error).message}`))
      notificationLog.push('Pursuit owner notified of the updated teaming plan.')
      notified += 1
    }
    if (drafts.length > 0) {
      await notifyUser({
        consultingFirmId: ctx.consultingFirmId,
        userId: pursuit.ownerUserId,
        type: 'TEAMING_REMINDER',
        title: 'Teaming draft ready for review',
        body: `A draft teaming document for ${pursuit.opportunityTitle} is ready. It requires legal review and is not executable.`.slice(0, 400),
        linkPath: `/teaming?pursuit=${pursuit.id}`,
        entityType: 'BidPursuit',
        entityId: pursuit.id,
        dedupeKey: `teaming-draft:${pursuit.id}:${inputHash}`,
      }).catch((err) => warnings.push(`Draft notification failed: ${(err as Error).message}`))
      notificationLog.push('Pursuit owner notified that a draft is ready for review.')
      notified += 1
    }
  }

  return { plan, artifact, escalations, evidence, changed, notified }
}

// -------------------------------------------------------------
// Gaps
// -------------------------------------------------------------

/**
 * Turn the canonical assessment into plan gaps.
 *
 * Certification and eligibility gaps are CRITICAL because they bear on whether
 * the firm may bid at all. Nothing here downgrades a gap.
 */
function buildGaps(a: GapAssessment): TeamingPlanGap[] {
  const gaps: TeamingPlanGap[] = []
  const push = (
    requirement: string,
    gapClass: TeamingPlanGap['gapClass'],
    severity: TeamingPlanGap['severity'],
    evidence: string,
  ) => {
    gaps.push({
      gapId: `${gapClass}:${requirement}`,
      requirement,
      gapClass,
      severity,
      evidence,
      dataSufficiency: a.limitations.length > 0 ? 'PARTIAL' : 'SUFFICIENT',
      mitigationStatus: 'UNRESOLVED',
    })
  }

  for (const g of a.missingEligibility) push(g, 'ELIGIBILITY', 'CRITICAL', 'Set-aside eligibility assessment')
  for (const g of a.missingCertifications) push(g, 'CERTIFICATION', 'CRITICAL', 'Certification requirement assessment')
  for (const g of a.missingCapabilities) push(g, 'CAPABILITY', 'MAJOR', 'Capability match assessment')
  for (const g of a.capacityGaps) push(g, 'CAPACITY', 'MAJOR', 'Declared capacity assessment')
  for (const g of a.geographyGaps) push(g, 'GEOGRAPHY', 'MINOR', 'Place-of-performance assessment')
  for (const g of a.vehicleGaps) push(g, 'VEHICLE', 'MINOR', 'Contract vehicle assessment')
  return gaps
}

/**
 * Eligibility is never asserted from absence of evidence.
 *
 * The strongest thing this build can honestly say about a partner is
 * POSSIBLY_ELIGIBLE, because partner certifications are self-declared records
 * and are not verified against an authoritative source.
 */
function eligibilityStateFor(match: PartnerMatchResult): TeamingPlanCandidate['eligibilityState'] {
  if (match.insufficientData) return 'INSUFFICIENT_DATA'
  if (match.certificationFit.required === null) return 'POSSIBLY_ELIGIBLE'
  return match.certificationFit.met ? 'POSSIBLY_ELIGIBLE' : 'NOT_ESTABLISHED'
}

/**
 * A workshare the platform PROPOSES. It is never agreed, never binding, never
 * written onto an arrangement, and never used to change pricing.
 */
function proposeWorkshare(gaps: TeamingPlanGap[], suitable: TeamingPlanCandidate[]): WorkshareProposal {
  if (suitable.length === 0 || gaps.length === 0) {
    return {
      status: 'NOT_AVAILABLE',
      primePercent: null,
      partnerPercent: null,
      description: null,
      rationale: null,
      limitations: ['No workshare is proposed: there is no candidate partner addressing a recorded gap.'],
    }
  }

  const total = gaps.length
  const covered = gaps.filter((g) => g.mitigationStatus !== 'UNRESOLVED').length
  const raw = total > 0 ? Math.round((covered / total) * 100) : 0
  // Bounded to a defensible band; the platform is proposing a starting point
  // for a human negotiation, not calculating an entitlement.
  const partnerPercent = Math.min(49, Math.max(10, raw))

  return {
    status: 'PROPOSED',
    primePercent: 100 - partnerPercent,
    partnerPercent,
    description: `Starting point for discussion, derived from ${covered} of ${total} recorded gap(s) a candidate partner appears to address.`,
    rationale: 'Derived from recorded capability gaps and matched partner capabilities only.',
    limitations: [
      'PROPOSED only. This is not agreed, is not binding, and has not changed any arrangement, pricing or subcontracting goal.',
      'It does not account for labour mix, level of effort, or contract value, none of which are recorded here.',
    ],
  }
}

function describeDraft(draft: AgreementDraft, partnerId: string): TeamingPlan['drafts'][number] {
  return {
    draftId: `${partnerId}:${draft.documentType}`,
    documentType: draft.documentType,
    status: draft.status,
    source: draft.source,
    legalReviewRequired: draft.legalReviewRequired,
    executionAllowed: draft.executionAllowed,
    banner: draft.banner,
    partnerId,
  }
}

/**
 * Hash of everything that makes a plan materially different.
 *
 * Excludes `generatedAt`, so an unchanged re-run supersedes nothing and the
 * artifact history stays meaningful.
 */
function buildPlanHash(plan: TeamingPlan): string {
  const material = {
    gaps: plan.capabilityGaps.map((g) => `${g.gapId}:${g.severity}:${g.mitigationStatus}`).sort(),
    candidates: plan.partnerCandidates.map((c) => `${c.partnerId}:${c.overallFit}:${c.certifications.met}:${c.performanceSummary.sampleSize}`).sort(),
    noSuitablePartner: plan.noSuitablePartner,
    workshare: `${plan.proposedWorkshare.status}:${plan.proposedWorkshare.partnerPercent}`,
    drafts: plan.drafts.map((d) => `${d.draftId}:${d.status}`).sort(),
    goals: plan.subcontractingGoals.map((g) => `${g.goalId}:${g.riskState}:${g.achieved}`).sort(),
    deadlines: plan.obligationDeadlines.map((d) => `${d.goalId}:${d.riskState}`).sort(),
  }
  // A real digest. A truncated encoding of the JSON prefix would make any
  // change past the first field invisible.
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

// -------------------------------------------------------------
// Subcontracting goals
// -------------------------------------------------------------

interface GoalRow {
  goalId: string
  pursuitId: string | null
  summary: TeamingPlan['subcontractingGoals'][number]
}

async function refreshSubcontractingGoals(
  ctx: AgentExecutionContext,
  now: Date,
  mayAct: boolean,
): Promise<{
  goals: GoalRow[]
  deadlines: Array<{ goalId: string; dueDate: string; workingDaysRemaining: number | null; riskState: string }>
  escalations: ProposedEscalation[]
  limitations: string[]
  notified: number
}> {
  const scope = ctx.triggerEntityType === 'SubcontractingGoal' && ctx.triggerEntityId
    ? { goalId: ctx.triggerEntityId }
    : {}

  const allGoals = await loadActionableGoals(ctx.consultingFirmId)
  const goals = scope.goalId ? allGoals.filter((g) => g.id === scope.goalId) : allGoals

  const calendar = await buildWorkingCalendar(ctx.consultingFirmId, now)
  const rows: GoalRow[] = []
  const deadlines: Array<{ goalId: string; dueDate: string; workingDaysRemaining: number | null; riskState: string }> = []
  const escalations: ProposedEscalation[] = []
  const limitations: string[] = []
  let notified = 0

  for (const goal of goals) {
    const workingDaysRemaining = goal.dueDate ? workingDaysBetween(now, goal.dueDate, calendar) : null
    const evidence = await loadGoalSpendEvidence(ctx.consultingFirmId, goal)
    const attainment = computeGoalAttainment(goal, evidence, workingDaysRemaining, now)

    const periodStart = goal.measurementStartDate ?? new Date(now.getTime() - 365 * DAY_MS)
    const periodEnd = goal.measurementEndDate ?? goal.dueDate ?? now
    await persistGoalProgress({
      consultingFirmId: ctx.consultingFirmId,
      attainment,
      periodStart,
      periodEnd,
    })

    const fmt = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(2))
    rows.push({
      goalId: goal.id,
      pursuitId: goal.pursuitId,
      summary: {
        goalId: goal.id,
        goalType: goal.goalType,
        targetType: goal.targetType,
        target: goal.targetType === 'PERCENT' ? fmt(goal.targetPercent) : fmt(goal.targetAmount),
        achieved: goal.targetType === 'PERCENT' ? fmt(attainment.achievedPercent) : fmt(attainment.achievedAmount),
        remaining: goal.targetType === 'PERCENT' ? fmt(attainment.remainingPercent) : fmt(attainment.remainingAmount),
        riskState: attainment.riskState,
        dataSufficiency: attainment.dataSufficiency,
        dueDate: goal.dueDate?.toISOString() ?? null,
        workingDaysRemaining,
        isHumanVerified: goal.isHumanVerified,
        source: goal.source,
        limitations: attainment.limitations,
      },
    })
    limitations.push(...attainment.limitations.map((l) => `[goal ${goal.goalType}] ${l}`))

    if (goal.dueDate) {
      deadlines.push({
        goalId: goal.id,
        dueDate: goal.dueDate.toISOString(),
        workingDaysRemaining,
        riskState: attainment.riskState,
      })
    }

    // SUBCONTRACT_MILESTONE_DUE — the obligation entered its risk window.
    const inRiskWindow =
      attainment.riskState === 'AT_RISK' ||
      attainment.riskState === 'MISSED' ||
      (workingDaysRemaining !== null && workingDaysRemaining >= 0 && workingDaysRemaining <= AT_RISK_WORKING_DAYS)

    if (mayAct && inRiskWindow) {
      await prisma
        .$transaction(async (tx) =>
          emitSubcontractMilestoneDue(
            {
              consultingFirmId: ctx.consultingFirmId,
              goalId: goal.id,
              riskState: attainment.riskState,
              workingDaysRemaining,
              dueDateIso: goal.dueDate?.toISOString() ?? null,
            },
            tx,
          ),
        )
        .catch((err) => logger.warn('Subcontract milestone event not emitted', { goalId: goal.id, error: (err as Error).message }))
    }

    if (attainment.riskState === 'AT_RISK' || attainment.riskState === 'MISSED') {
      escalations.push({
        severity: attainment.riskState === 'MISSED' ? 'CRITICAL' : 'HIGH',
        title: `Subcontracting goal ${attainment.riskState} — ${goal.goalType}`,
        reason:
          `The ${goal.goalType} goal is ${attainment.riskState}. ` +
          `Target ${goal.targetType === 'PERCENT' ? `${fmt(goal.targetPercent)}%` : fmt(goal.targetAmount)}; ` +
          `achieved ${goal.targetType === 'PERCENT' ? `${fmt(attainment.achievedPercent) ?? 'unknown'}%` : fmt(attainment.achievedAmount) ?? 'unknown'}` +
          `${workingDaysRemaining !== null ? ` with ${workingDaysRemaining} working day(s) remaining` : ''}. ` +
          `Source: ${goal.source}${goal.sourceReference ? ` (${goal.sourceReference})` : ''}.`,
        recommendedAction: 'Review the subcontracting plan and the recorded partner commitments.',
        entityType: 'SubcontractingGoal',
        entityId: goal.id,
        dedupeHint: `teaming-goal-risk:${goal.id}:${attainment.riskState}`,
      })

      if (mayAct && goal.createdByUserId) {
        await notifyUser({
          consultingFirmId: ctx.consultingFirmId,
          userId: goal.createdByUserId,
          type: 'TEAMING_REMINDER',
          title: `Subcontracting goal ${attainment.riskState}`,
          body: `The ${goal.goalType} goal is ${attainment.riskState}.`.slice(0, 400),
          linkPath: '/teaming',
          entityType: 'SubcontractingGoal',
          entityId: goal.id,
          dedupeKey: `teaming-goal-risk:${goal.id}:${attainment.riskState}`,
        }).catch(() => undefined)
        notified += 1
      }
    }
  }

  return { goals: rows, deadlines, escalations, limitations, notified }
}

// -------------------------------------------------------------
// Partner performance
// -------------------------------------------------------------

interface PerformanceRow {
  partnerId: string
  record: Awaited<ReturnType<typeof persistPartnerPerformance>>['record']
  summary: TeamingPlan['partnerPerformance'][number]
}

/**
 * The weekly refresh.
 *
 * The measured window ends at the start of the current ISO week, so every run
 * inside one week recomputes the SAME period and upserts idempotently. A daily
 * schedule therefore produces one meaningful performance record per week.
 */
async function refreshPartnerPerformance(
  ctx: AgentExecutionContext,
  now: Date,
  mayAct: boolean,
): Promise<{ records: PerformanceRow[]; escalations: ProposedEscalation[]; limitations: string[]; notified: number }> {
  const periodEnd = startOfIsoWeek(now)
  const periodStart = new Date(periodEnd.getTime() - PERFORMANCE_WINDOW_DAYS * DAY_MS)

  // Only partners with work explicitly attributed to them are measurable.
  const attributed = await prisma.contractDeliverable.findMany({
    where: {
      consultingFirmId: ctx.consultingFirmId,
      partnerId: { not: null },
      isArchived: false,
      OR: [
        { dueDate: { gte: periodStart, lte: periodEnd } },
        { submissionDate: { gte: periodStart, lte: periodEnd } },
      ],
    },
    select: { partnerId: true },
    distinct: ['partnerId'],
    take: 200,
  })

  const records: PerformanceRow[] = []
  const escalations: ProposedEscalation[] = []
  const limitations: string[] = []
  let notified = 0

  for (const row of attributed) {
    if (!row.partnerId) continue
    const computation = await computePartnerPerformance({
      consultingFirmId: ctx.consultingFirmId,
      partnerId: row.partnerId,
      periodStart,
      periodEnd,
    })
    if (!computation) continue

    const prior = await findPriorPeriod(ctx.consultingFirmId, row.partnerId, periodStart)
    const decline = assessPerformanceDecline(computation, prior)
    const { record } = await persistPartnerPerformance({
      consultingFirmId: ctx.consultingFirmId,
      computation,
      decline,
    })

    const summary = summarisePerformance(record)
    records.push({
      partnerId: row.partnerId,
      record,
      summary: {
        partnerId: row.partnerId,
        partnerName: computation.partnerName,
        sampleSize: record.sampleSize,
        dataSufficiency: record.dataSufficiency,
        onTime: summary.onTime,
        acceptance: summary.acceptance,
        declineDetected: decline.declined,
        detail: summary.detail,
      },
    })
    limitations.push(...computation.limitations.map((l) => `[partner ${computation.partnerName}] ${l}`))

    if (decline.declined) {
      escalations.push({
        severity: 'MEDIUM',
        title: `Partner performance decline — ${computation.partnerName}`,
        reason: `${decline.reason} This is an objective measurement across ${MINIMUM_SAMPLE_SIZE}+ attributed deliverables, not a judgement of the partner.`,
        recommendedAction: 'Review the attributed deliverables before drawing any conclusion.',
        entityType: 'Partner',
        entityId: row.partnerId,
        dedupeHint: `teaming-performance-decline:${row.partnerId}:${periodEnd.toISOString().slice(0, 10)}`,
      })

      if (mayAct) {
        const admins = await prisma.user.findMany({
          where: { consultingFirmId: ctx.consultingFirmId, role: 'ADMIN', isActive: true },
          select: { id: true },
          take: 5,
        })
        for (const admin of admins) {
          await notifyUser({
            consultingFirmId: ctx.consultingFirmId,
            userId: admin.id,
            type: 'TEAMING_REMINDER',
            title: `Partner performance decline — ${computation.partnerName}`,
            body: (decline.reason ?? '').slice(0, 400),
            linkPath: '/teaming',
            entityType: 'Partner',
            entityId: row.partnerId,
            dedupeKey: `teaming-performance-decline:${row.partnerId}:${periodEnd.toISOString().slice(0, 10)}:${admin.id}`,
          }).catch(() => undefined)
          notified += 1
        }
      }
    }
  }

  return { records, escalations, limitations, notified }
}

/** UTC start of the ISO week containing `d`. Stable within a week. */
export function startOfIsoWeek(d: Date): Date {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay()
  utc.setUTCDate(utc.getUTCDate() - (day - 1))
  return utc
}
