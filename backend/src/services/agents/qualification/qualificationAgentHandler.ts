// =============================================================
// §7.4 — Qualification Agent handler.
//
// A plain async function on the §7.0 AgentContext/AgentResult contract. It owns
// no queue, no worker, no scheduler and no reaper.
//
// FULLY DETERMINISTIC. It performs ZERO LLM calls: it never touches
// `ctx.budget.generate` or `generateWithRouter`, and the narrative is rendered
// by a pure template module. A regression test asserts the provider boundary is
// never reached.
//
// THE ABSOLUTE RULE
// This handler NEVER writes a BidDecision, a Scorecard decision, or a
// ScorecardDecision row. It cannot: the only way to record a decision is
// `recordQualificationDecision`, which requires a human actorUserId, and this
// module does not import it. The agent writes exactly one thing — a
// QualificationRecommendation, which is explicitly a RECOMMENDATION.
//
// It also never approves or rejects a GateReview. It may CREATE one so a human
// has somewhere to do the review; completing it is theirs.
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import type {
  AgentExecutionContext,
  AgentHandlerResult,
  EvidenceRef,
  ProposedArtifact,
  ProposedEscalation,
} from '../types'
import { computeScorecard } from '../../scorecardScoring'
import { resolveStoredProbability } from '../../winProbability'
import { computeConfidenceInterval, buildBins, INTERVAL_UNAVAILABLE_LABEL, type ConfidenceState } from '../../scoring/confidenceInterval'
import { SCORING_MODEL_VERSION } from '../../scoring/scoreExplanation'
import { notifyUser } from '../../notificationService'
import {
  BORDERLINE_POLICY_DOC,
  detectStageContradiction,
  evaluateBorderline,
  type BorderlineOutcome,
  type CapabilityGapSeverity,
  type CapacityState,
} from './borderlinePolicy'
import { renderRecommendationNarrative } from './recommendationNarrative'
import {
  loadCapabilityEvidence, loadCapacityEvidence, loadComplianceEvidence,
  loadCompetitorEvidence, loadIncumbentEvidence, loadPastPerformanceEvidence,
  loadPricingEvidence, toJson,
  type CapabilityEvidence, type CapacityEvidence, type ComplianceEvidence,
  type CompetitorEvidence, type IncumbentEvidence, type PastPerformanceEvidence,
  type PricingEvidence,
} from './qualificationEvidence'
import { OPPORTUNITY_ENTITY_TYPE } from './qualificationEvents'
import { PURSUIT_ENTITY_TYPE } from '../opportunity/opportunityEvents'
import { AMENDMENT_ENTITY_TYPE, EXTRACTION_JOB_ENTITY_TYPE } from '../compliance/complianceEvents'

export const QUALIFICATION_AGENT_KEY = 'QUALIFICATION' as const
export const ALGORITHM_VERSION = 'qualification-v1'

/** Pursuits worth qualifying. Terminal stages are deliberately excluded. */
export const QUALIFIABLE_STAGES = ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL'] as const
export const MAX_PURSUITS_PER_SWEEP = 25

/** Observable stages, in the order a full run performs them. */
export const QUALIFICATION_PHASES = [
  'LOAD_PURSUIT',
  'LOAD_OPPORTUNITY_MATCH',
  'LOAD_CAPABILITY',
  'LOAD_CAPACITY',
  'LOAD_PAST_PERFORMANCE',
  'LOAD_INCUMBENT_EVIDENCE',
  'LOAD_COMPETITOR_EVIDENCE',
  'LOAD_COMPLIANCE_CONTEXT',
  'COMPUTE_SCORECARD',
  'COMPUTE_WIN_PROBABILITY',
  'COMPUTE_CONFIDENCE',
  'COMPUTE_CAPABILITY_GAPS',
  'CHECK_PRICING_EVIDENCE',
  'EVALUATE_BORDERLINE_POLICY',
  'BUILD_RECOMMENDATION',
  'CREATE_ESCALATION',
  'BUILD_QUALIFICATION_BRIEF',
  'COMPLETE',
] as const

export type QualificationPhase = (typeof QUALIFICATION_PHASES)[number]

/**
 * Which phases a run performs.
 *
 * Every trigger needs the full evidence picture to produce a defensible
 * recommendation — a partial qualification would be worse than none. What the
 * trigger changes is SCOPE (which pursuits), not depth, so the phase list is
 * constant and `resolveScope` does the narrowing.
 */
export function phasesForRun(_triggerEntityType: string | null): QualificationPhase[] {
  return [...QUALIFICATION_PHASES]
}

interface PhaseOutcome {
  phase: QualificationPhase
  ok: boolean
  detail: string
}

export interface QualificationBrief {
  pursuitId: string
  opportunityId: string
  opportunityTitle: string
  generatedAt: string
  runId: string
  recommendation: {
    result: string
    strength: string
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
    calibrationSampleSufficiency: string
    dataSufficiency: string
    modelVersion: string
  }
  capability: {
    matchScore: number | null
    severity: string
    gaps: string[]
    criticalGaps: string[]
  }
  capacity: { state: string; conflicts: string[]; evidence: Record<string, unknown>; detail: string }
  pastPerformance: { relevantRecords: number; records: PastPerformanceEvidence['records']; limitations: string[] }
  incumbent: IncumbentEvidence
  competitors: CompetitorEvidence[]
  competitorLimitation: string | null
  pricing: PricingEvidence
  compliance: ComplianceEvidence
  stageContradiction: { contradicts: boolean; reason: string | null }
  proposedPriority: string | null
  narrative: string
  evidence: EvidenceRef[]
  warnings: string[]
  dataLimitations: string[]
  policy: typeof BORDERLINE_POLICY_DOC
}

/**
 * The agent entry point.
 *
 * Per-pursuit isolation: one malformed pursuit or one missing evidence source
 * degrades that pursuit's confidence and adds a limitation — it never fails the
 * tenant sweep.
 */
export async function qualificationAgentHandler(ctx: AgentExecutionContext): Promise<AgentHandlerResult> {
  const now = new Date()
  // OBSERVE may compute and persist the recommendation but must not notify or
  // open a gate review. PROPOSE and above may.
  const mayAct = ctx.autonomyLevel !== 'OBSERVE'

  const phases = phasesForRun(ctx.triggerEntityType)
  const warnings: string[] = []
  const limitations: string[] = []
  const evidence: EvidenceRef[] = []
  const escalations: ProposedEscalation[] = []
  const artifacts: ProposedArtifact[] = []
  const outcomes: PhaseOutcome[] = []

  const pursuits = await resolveScope(ctx)
  ctx.log('qualification scope resolved', { pursuits: pursuits.length, triggerEntityType: ctx.triggerEntityType, mayAct })

  if (pursuits.length === 0) {
    return {
      status: 'SKIPPED',
      summary: ctx.triggerEntityId
        ? 'The targeted pursuit is not in a qualifiable stage, or does not belong to this firm.'
        : 'No pursuit is in a qualifiable stage for this firm.',
      confidence: 'HIGH',
      dataSufficiency: 'SUFFICIENT',
      metrics: { pursuitsScanned: 0 },
      limitations: [`Only pursuits in stage ${QUALIFIABLE_STAGES.join(', ')} are qualified.`],
      inputSnapshot: { scope: ctx.triggerEntityId ?? 'TENANT', pursuitCount: 0 },
      inputHash: `qualification:${ctx.consultingFirmId}:none:${now.toISOString().slice(0, 10)}`,
    }
  }

  let assessed = 0
  let failed = 0
  let created = 0
  let unchanged = 0
  const resultTally: Record<string, number> = {}

  for (const pursuit of pursuits) {
    if (ctx.signal.aborted) {
      limitations.push('The run was cancelled before every pursuit was assessed.')
      break
    }
    try {
      const outcome = await qualifyPursuit({ ctx, pursuit, now, mayAct })
      assessed++
      created += outcome.createdNewVersion ? 1 : 0
      unchanged += outcome.createdNewVersion ? 0 : 1
      resultTally[outcome.brief.recommendation.result] = (resultTally[outcome.brief.recommendation.result] ?? 0) + 1

      warnings.push(...outcome.brief.warnings.map((w) => `[${pursuit.opportunityTitle}] ${w}`))
      limitations.push(...outcome.brief.dataLimitations.map((l) => `[${pursuit.opportunityTitle}] ${l}`))
      evidence.push(...outcome.brief.evidence)
      escalations.push(...outcome.escalations)
      artifacts.push(outcome.artifact)
    } catch (err) {
      failed++
      const message = (err as Error).message
      warnings.push(`[${pursuit.opportunityTitle}] could not be qualified: ${message}`)
      limitations.push(`[${pursuit.opportunityTitle}] was skipped because its evidence could not be read safely.`)
      logger.error('Qualification failed for one pursuit (continuing)', {
        pursuitId: pursuit.id, runId: ctx.runId, error: message,
      })
    }
    await ctx.heartbeat(Math.round((assessed / pursuits.length) * 100), `qualified ${assessed}/${pursuits.length}`).catch(() => undefined)
  }

  for (const phase of phases) outcomes.push({ phase, ok: true, detail: `${assessed} pursuit(s)` })

  const borderline = resultTally.BORDERLINE_REVIEW ?? 0
  const insufficient = resultTally.INSUFFICIENT_DATA ?? 0

  return {
    status: 'COMPLETED',
    summary:
      `Qualified ${assessed} pursuit(s): ${resultTally.RECOMMEND_BID ?? 0} bid, ${resultTally.RECOMMEND_NO_BID ?? 0} no-bid, ` +
      `${borderline} borderline, ${insufficient} with insufficient data.` +
      (failed ? ` ${failed} pursuit(s) could not be assessed.` : '') +
      ' Every result is a recommendation; no decision was recorded.',
    confidence: assessed === 0 ? 'LOW' : failed > 0 || insufficient === assessed ? 'MEDIUM' : 'HIGH',
    dataSufficiency:
      assessed === 0 ? 'INSUFFICIENT' : failed > 0 || limitations.length > 0 ? 'PARTIAL' : 'SUFFICIENT',
    evidence,
    artifacts,
    escalations,
    metrics: {
      pursuitsScanned: pursuits.length,
      pursuitsAssessed: assessed,
      pursuitsFailed: failed,
      recommendationsCreated: created,
      recommendationsUnchanged: unchanged,
      recommendBid: resultTally.RECOMMEND_BID ?? 0,
      recommendNoBid: resultTally.RECOMMEND_NO_BID ?? 0,
      borderline,
      insufficientData: insufficient,
      escalationsRaised: escalations.length,
      // Proven by test to stay zero, and asserted live.
      bidDecisionsWritten: 0,
    },
    warnings,
    limitations,
    inputSnapshot: {
      scope: ctx.triggerEntityId ?? 'TENANT',
      triggerEntityType: ctx.triggerEntityType,
      pursuitIds: pursuits.map((p) => p.id),
      autonomyLevel: ctx.autonomyLevel,
    },
    inputHash: `qualification:${ctx.consultingFirmId}:${ctx.triggerEntityId ?? 'TENANT'}:${pursuits.map((p) => p.id).sort().join(',').slice(0, 200)}`,
  }
}

// -------------------------------------------------------------
// Scope
// -------------------------------------------------------------

interface ScopePursuit {
  id: string
  opportunityId: string
  opportunityTitle: string
  agency: string
  naicsCode: string
  probabilityScore: number
  isScored: boolean
  pipelineStage: string
  priority: string
  ownerUserId: string | null
  responseDeadline: Date | null
}

async function resolveScope(ctx: AgentExecutionContext): Promise<ScopePursuit[]> {
  const select = {
    id: true, opportunityId: true, pipelineStage: true, priority: true, ownerUserId: true,
    opportunity: {
      select: { id: true, title: true, agency: true, naicsCode: true, probabilityScore: true, isScored: true, responseDeadline: true },
    },
  } as const

  const targetedPursuitId = await resolveTargetedPursuitId(ctx)
  // A targeted trigger that resolves to nothing means the entity is not this
  // firm's, or is not qualifiable. Never fall back to a tenant-wide sweep.
  if (ctx.triggerEntityId && targetedPursuitId === null) return []

  const rows = await prisma.bidPursuit.findMany({
    where: {
      consultingFirmId: ctx.consultingFirmId,
      pipelineStage: { in: [...QUALIFIABLE_STAGES] as never[] },
      ...(targetedPursuitId ? { id: targetedPursuitId } : {}),
    },
    select,
    orderBy: { lastActivityAt: 'desc' },
    take: targetedPursuitId ? 1 : MAX_PURSUITS_PER_SWEEP,
  })

  return rows.map((r) => ({
    id: r.id,
    opportunityId: r.opportunityId,
    opportunityTitle: r.opportunity.title,
    agency: r.opportunity.agency,
    naicsCode: r.opportunity.naicsCode,
    probabilityScore: r.opportunity.probabilityScore,
    isScored: r.opportunity.isScored,
    pipelineStage: r.pipelineStage,
    priority: r.priority,
    ownerUserId: r.ownerUserId,
    responseDeadline: r.opportunity.responseDeadline,
  }))
}

/** Map a trigger entity onto the pursuit it concerns, tenant-verified throughout. */
async function resolveTargetedPursuitId(ctx: AgentExecutionContext): Promise<string | null> {
  if (!ctx.triggerEntityId) return null

  const byOpportunity = async (opportunityId: string) => {
    const row = await prisma.bidPursuit.findFirst({
      where: { opportunityId, consultingFirmId: ctx.consultingFirmId },
      select: { id: true },
    })
    return row?.id ?? null
  }

  switch (ctx.triggerEntityType) {
    case PURSUIT_ENTITY_TYPE: {
      const row = await prisma.bidPursuit.findFirst({
        where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
        select: { id: true },
      })
      return row?.id ?? null
    }
    case OPPORTUNITY_ENTITY_TYPE: {
      const opp = await prisma.opportunity.findFirst({
        where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
        select: { id: true },
      })
      return opp ? byOpportunity(opp.id) : null
    }
    case EXTRACTION_JOB_ENTITY_TYPE: {
      const job = await prisma.solicitationExtractionJob.findFirst({
        where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
        select: { opportunityId: true },
      })
      return job ? byOpportunity(job.opportunityId) : null
    }
    case AMENDMENT_ENTITY_TYPE: {
      const rev = await prisma.amendmentRevision.findFirst({
        where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
        select: { opportunityId: true },
      })
      return rev ? byOpportunity(rev.opportunityId) : null
    }
    default:
      return null
  }
}

// -------------------------------------------------------------
// Per-pursuit qualification
// -------------------------------------------------------------

async function qualifyPursuit(args: {
  ctx: AgentExecutionContext
  pursuit: ScopePursuit
  now: Date
  mayAct: boolean
}): Promise<{
  brief: QualificationBrief
  artifact: ProposedArtifact
  escalations: ProposedEscalation[]
  createdNewVersion: boolean
}> {
  const { ctx, pursuit, now, mayAct } = args
  const warnings: string[] = []
  const dataLimitations: string[] = []
  const evidence: EvidenceRef[] = []
  const escalations: ProposedEscalation[] = []

  // --- evidence -------------------------------------------------------
  const [match, scorecard, compliance, incumbent, competitorResult, pastPerformance, pricing, capacity] =
    await Promise.all([
      prisma.opportunityMatch.findUnique({ where: { opportunityId: pursuit.opportunityId } }),
      prisma.scorecard.findFirst({
        where: { consultingFirmId: ctx.consultingFirmId, bidPursuitId: pursuit.id },
        include: { criteria: true },
      }),
      loadComplianceEvidence(ctx.consultingFirmId, pursuit.opportunityId),
      loadIncumbentEvidence(ctx.consultingFirmId, pursuit.opportunityId),
      loadCompetitorEvidence(ctx.consultingFirmId, { agency: pursuit.agency, naicsCode: pursuit.naicsCode }),
      loadPastPerformanceEvidence(ctx.consultingFirmId, { agency: pursuit.agency, naicsCode: pursuit.naicsCode }),
      loadPricingEvidence(ctx.consultingFirmId, pursuit.opportunityId),
      loadCapacityEvidence(ctx.consultingFirmId, pursuit.id),
    ])

  const capability: CapabilityEvidence = await loadCapabilityEvidence(
    ctx.consultingFirmId,
    pursuit.opportunityId,
    compliance.mandatoryRequirementGaps,
  )

  if (!match) dataLimitations.push('No capability match snapshot exists for this opportunity.')
  if (!compliance.available) dataLimitations.push(compliance.detail)
  if (competitorResult.limitation) dataLimitations.push(competitorResult.limitation)
  if (incumbent.limitation) dataLimitations.push(incumbent.limitation)
  dataLimitations.push(...pastPerformance.limitations, ...capability.limitations)
  if (pricing.availability !== 'AVAILABLE') dataLimitations.push(pricing.detail)

  evidence.push({
    sourceType: 'Opportunity',
    sourceId: pursuit.opportunityId,
    retrievedAt: now.toISOString(),
    note: `probabilityScore ${pursuit.probabilityScore}, isScored ${pursuit.isScored}`,
  })
  if (match) {
    evidence.push({
      sourceType: 'OpportunityMatch',
      sourceId: match.id,
      retrievedAt: now.toISOString(),
      note: `overall ${match.overallScore}, eligibility ${match.eligibility}`,
    })
  }

  // --- scorecard (canonical §5.2 engine) --------------------------------
  const scorecardResult = scorecard
    ? computeScorecard(scorecard.criteria.map((c) => ({ key: c.key, weight: c.weight, score: c.score, required: c.required })))
    : null
  if (!scorecard) {
    dataLimitations.push('No qualification scorecard has been started for this pursuit.')
  } else if (scorecardResult && !scorecardResult.complete) {
    dataLimitations.push(`The scorecard is incomplete: ${scorecardResult.missingRequiredKeys.join(', ')} not scored.`)
  }

  // --- probability (canonical stack, calibrated at exactly one layer) ----
  // `resolveStoredProbability` is documented as the SINGLE place calibration is
  // applied to a stored raw score, so calling it here cannot double-calibrate.
  const hasProbability = pursuit.isScored
  const probability = hasProbability ? resolveStoredProbability(pursuit.probabilityScore / 100, now) : null
  if (!hasProbability) {
    dataLimitations.push('This opportunity has not been scored, so no win probability is available.')
  }

  // --- confidence interval (canonical §6.2H engine) ----------------------
  const interval = await computeInterval(ctx.consultingFirmId, probability?.finalScore ?? null, capability, compliance)
  if (!interval.available) dataLimitations.push(interval.reason)

  // --- borderline policy --------------------------------------------------
  const capacityState = capacity.state as CapacityState
  const severity = capability.severity as CapabilityGapSeverity
  const outcome: BorderlineOutcome = evaluateBorderline({
    finalProbability: probability?.finalScore ?? null,
    intervalLower: interval.lower,
    intervalUpper: interval.upper,
    confidenceState: interval.confidence,
    dataSufficiency: policyDataSufficiency(probability),
    capabilityGapSeverity: severity,
    capacityState,
    complianceBlockers: compliance.blockers,
    complianceHumanReviewItems: compliance.humanReviewItems,
    scorecardScore: scorecardResult?.totalScore ?? null,
  })

  const contradiction = detectStageContradiction({
    pipelineStage: pursuit.pipelineStage,
    outcome,
    finalProbability: probability?.finalScore ?? null,
    capabilityGapSeverity: severity,
    complianceBlockers: compliance.blockers,
  })

  // --- narrative (deterministic; introduces no new number) ----------------
  const narrative = renderRecommendationNarrative({
    outcome,
    opportunityTitle: pursuit.opportunityTitle,
    finalProbability: probability?.finalScore ?? null,
    rawProbability: probability?.rawScore ?? null,
    probabilityMode: probability?.scoreType ?? null,
    probabilityReason: probability?.reason ?? null,
    intervalLower: interval.lower,
    intervalUpper: interval.upper,
    confidenceState: interval.confidence,
    scorecardScore: scorecardResult?.totalScore ?? null,
    matchScore: match?.overallScore ?? null,
    capabilityGapSeverity: severity,
    criticalGaps: capability.criticalGaps,
    capacityState,
    capacityDetail: capacity.detail,
    pastPerformanceCount: pastPerformance.relevantCount,
    incumbent: {
      name: incumbent.name,
      retentionNumerator: incumbent.retentionNumerator,
      retentionDenominator: incumbent.retentionDenominator,
      retentionRatePct: incumbent.retentionRatePct,
      available: incumbent.available,
      limitation: incumbent.limitation,
    },
    competitors: competitorResult.competitors.map((c) => ({
      name: c.name,
      awardsObserved: c.awardsObserved,
      totalObserved: c.totalObserved,
      observedAwardSharePct: c.observedAwardSharePct,
      isConfirmedWinRate: c.isConfirmedWinRate,
    })),
    pricing: { availability: pricing.availability, detail: pricing.detail },
    compliance: {
      blockers: compliance.blockers,
      humanReviewItems: compliance.humanReviewItems,
      available: compliance.available,
    },
    dataLimitations,
  })

  // --- persist the RECOMMENDATION (never a decision) ---------------------
  const inputHash = buildInputHash({
    pursuitId: pursuit.id,
    result: outcome.recommendation,
    reasonCodes: outcome.reasonCodes,
    finalProbability: probability?.finalScore ?? null,
    probabilityMode: probability?.scoreType ?? null,
    intervalLower: interval.lower,
    intervalUpper: interval.upper,
    severity,
    capacityState,
    complianceBlockers: compliance.blockers,
    complianceHumanReview: compliance.humanReviewItems,
    scorecardScore: scorecardResult?.totalScore ?? null,
    matchScore: match?.overallScore ?? null,
  })

  const proposedPriority = deriveProposedPriority(outcome, probability?.finalScore ?? null)

  const persisted = await persistRecommendation({
    ctx, pursuit, now, inputHash, outcome, narrative, proposedPriority,
    probability, interval, scorecardScore: scorecardResult?.totalScore ?? null,
    severity, capacityState, incumbent, competitors: competitorResult.competitors,
    pricing, compliance, dataLimitations,
  })

  // --- brief ---------------------------------------------------------------
  const brief: QualificationBrief = {
    pursuitId: pursuit.id,
    opportunityId: pursuit.opportunityId,
    opportunityTitle: pursuit.opportunityTitle,
    generatedAt: now.toISOString(),
    runId: ctx.runId,
    recommendation: {
      result: outcome.recommendation,
      strength: outcome.strength,
      borderline: outcome.isBorderline,
      reasonCodes: outcome.reasonCodes,
      reasons: outcome.reasons,
      version: persisted.version,
      recommendationId: persisted.id,
    },
    scorecard: {
      total: scorecardResult?.totalScore ?? null,
      complete: scorecardResult?.complete ?? false,
      recommendation: scorecardResult?.recommendation ?? null,
      criteria: (scorecard?.criteria ?? []).map((c) => ({
        key: c.key,
        weight: c.weight,
        score: c.score,
        // Contribution is null when the criterion is unscored — never zero,
        // which would read as "scored badly".
        contribution: c.score !== null ? Math.round((c.score * c.weight) / 100) : null,
        required: c.required,
        evidence: c.evidence,
      })),
      missingRequiredKeys: scorecardResult?.missingRequiredKeys ?? [],
      note: scorecard
        ? 'Scored by the canonical §5.2 scorecard engine against this firm\'s own criterion weights.'
        : 'No scorecard exists for this pursuit, so no scorecard evidence contributed.',
    },
    probability: {
      raw: probability?.rawScore ?? null,
      final: probability?.finalScore ?? null,
      mode: probability?.scoreType ?? null,
      calibrationStatus: probability?.method ?? null,
      calibrationReason: probability?.reason ?? null,
      sampleSize: probability?.sampleSize ?? null,
      intervalLower: interval.lower,
      intervalUpper: interval.upper,
      intervalAvailable: interval.available,
      intervalUnavailableLabel: interval.available ? null : INTERVAL_UNAVAILABLE_LABEL,
      confidenceState: interval.confidence,
      calibrationSampleSufficiency: probability?.dataSufficiency ?? 'NONE',
      dataSufficiency: policyDataSufficiency(probability),
      modelVersion: SCORING_MODEL_VERSION,
    },
    capability: {
      matchScore: match?.overallScore ?? null,
      severity,
      gaps: capability.allGaps,
      criticalGaps: capability.criticalGaps,
    },
    capacity: { state: capacity.state, conflicts: capacity.conflicts, evidence: capacity.evidence, detail: capacity.detail },
    pastPerformance: {
      relevantRecords: pastPerformance.relevantCount,
      records: pastPerformance.records,
      limitations: pastPerformance.limitations,
    },
    incumbent,
    competitors: competitorResult.competitors,
    competitorLimitation: competitorResult.limitation,
    pricing,
    compliance,
    stageContradiction: contradiction,
    proposedPriority,
    narrative,
    evidence,
    warnings,
    dataLimitations,
    policy: BORDERLINE_POLICY_DOC,
  }

  // --- gate review + escalations + notification --------------------------
  if (mayAct && outcome.isBorderline) {
    const gate = await ensureGateReview(ctx, pursuit, persisted.version)
    if (gate.created) {
      evidence.push({
        sourceType: 'GateReview',
        sourceId: gate.id,
        retrievedAt: now.toISOString(),
        note: 'Opened for human review of a borderline recommendation. The agent never completes it.',
      })
    }
  }

  escalations.push(...buildEscalations(pursuit, brief, contradiction))

  if (mayAct && persisted.createdNewVersion && pursuit.ownerUserId) {
    await notifyOwner(ctx, pursuit, brief, persisted.id).catch((err) => {
      warnings.push(`Owner notification failed: ${(err as Error).message}`)
    })
  }

  const artifact: ProposedArtifact = {
    artifactType: 'QUALIFICATION_BRIEF',
    title: `Qualification brief — ${pursuit.opportunityTitle}`,
    summary: `${outcome.recommendation}${outcome.strength !== 'NONE' ? ` (${outcome.strength})` : ''} · v${persisted.version}`,
    structuredData: brief as unknown as Record<string, unknown>,
    evidence,
    sourceEntityType: 'BidPursuit',
    sourceEntityId: pursuit.id,
    confidenceState: outcome.recommendation === 'INSUFFICIENT_DATA' ? 'LOW' : interval.confidence === 'HIGH' ? 'HIGH' : 'MEDIUM',
    // One current brief per pursuit; earlier ones are superseded, never
    // overwritten, so the decision trail stays intact.
    supersedeKey: `qualification-brief:${pursuit.id}`,
  }

  return { brief, artifact, escalations, createdNewVersion: persisted.createdNewVersion }
}

// -------------------------------------------------------------
// Confidence interval
// -------------------------------------------------------------

async function computeInterval(
  consultingFirmId: string,
  finalProbability: number | null,
  capability: CapabilityEvidence,
  compliance: ComplianceEvidence,
): Promise<{ lower: number | null; upper: number | null; available: boolean; confidence: ConfidenceState; reason: string }> {
  if (finalProbability === null) {
    return {
      lower: null, upper: null, available: false, confidence: 'INSUFFICIENT_DATA',
      reason: 'No probability was available, so no confidence interval could be produced.',
    }
  }

  // Verified outcomes are the only defensible basis for an interval. §6.2H's
  // engine decides whether there are enough; it is never overridden here.
  const outcomes = await prisma.submissionRecord.findMany({
    where: { consultingFirmId, outcome: { in: ['WON', 'LOST'] } },
    select: { outcome: true, opportunity: { select: { probabilityScore: true } } },
    take: 2000,
  })

  const samples = outcomes
    .filter((o) => o.opportunity)
    .map((o) => ({ predicted: (o.opportunity!.probabilityScore ?? 0) / 100, observed: o.outcome === 'WON' ? 1 : 0 }))

  const bins = buildBins(samples)
  // Data completeness is a real signal here: an assessment missing capability
  // or compliance evidence is genuinely less complete.
  const dataCompleteness =
    (capability.assessment ? 0.5 : 0) + (compliance.available ? 0.5 : 0)

  const result = computeConfidenceInterval({
    pointEstimate: finalProbability / 100,
    bins,
    tenantSampleSize: samples.length,
    modelVersion: SCORING_MODEL_VERSION,
    dataCompleteness,
    trainingSimilarity: samples.length > 0 ? 1 : 0,
  })

  return {
    lower: result.lower !== null ? Math.round(result.lower * 100) : null,
    upper: result.upper !== null ? Math.round(result.upper * 100) : null,
    available: result.available,
    confidence: result.confidence,
    reason: result.reason,
  }
}

// -------------------------------------------------------------
// Persistence — the ONLY thing this agent writes
// -------------------------------------------------------------

async function persistRecommendation(args: {
  ctx: AgentExecutionContext
  pursuit: ScopePursuit
  now: Date
  inputHash: string
  outcome: BorderlineOutcome
  narrative: string
  proposedPriority: string | null
  probability: ReturnType<typeof resolveStoredProbability> | null
  interval: { lower: number | null; upper: number | null; available: boolean; confidence: ConfidenceState; reason: string }
  scorecardScore: number | null
  severity: CapabilityGapSeverity
  capacityState: CapacityState
  incumbent: IncumbentEvidence
  competitors: CompetitorEvidence[]
  pricing: PricingEvidence
  compliance: ComplianceEvidence
  dataLimitations: string[]
}): Promise<{ id: string; version: number; createdNewVersion: boolean }> {
  const { ctx, pursuit, now, inputHash } = args

  // Unchanged normalised evidence produces no new version — a six-hourly sweep
  // over a static pursuit must not fill the history with identical rows.
  const existing = await prisma.qualificationRecommendation.findUnique({
    where: { pursuitId_inputHash: { pursuitId: pursuit.id, inputHash } },
    select: { id: true, version: true },
  })
  if (existing) return { ...existing, createdNewVersion: false }

  const previous = await prisma.qualificationRecommendation.findFirst({
    where: { consultingFirmId: ctx.consultingFirmId, pursuitId: pursuit.id },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, status: true },
  })

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.qualificationRecommendation.create({
      data: {
        consultingFirmId: ctx.consultingFirmId,
        pursuitId: pursuit.id,
        opportunityId: pursuit.opportunityId,
        agentRunId: ctx.runId,
        version: (previous?.version ?? 0) + 1,
        inputHash,
        algorithmVersion: ALGORITHM_VERSION,
        recommendation: args.outcome.recommendation,
        strength: args.outcome.strength,
        rawProbability: args.probability?.rawScore ?? null,
        finalProbability: args.probability?.finalScore ?? null,
        probabilityMode: args.probability?.scoreType ?? null,
        calibrationnote: args.probability?.reason ?? null,
        confidenceLower: args.interval.lower,
        confidenceUpper: args.interval.upper,
        confidenceState: mapConfidence(args.interval.confidence),
        dataSufficiency: mapSufficiency(policyDataSufficiency(args.probability), args.dataLimitations.length),
        scorecardScore: args.scorecardScore,
        isBorderline: args.outcome.isBorderline,
        borderlineReasons: args.outcome.reasonCodes,
        capabilityGapSeverity: args.severity,
        capacityState: args.capacityState,
        incumbentEvidence: toJson(args.incumbent),
        competitorEvidence: toJson(args.competitors),
        pricingEvidence: toJson(args.pricing),
        complianceEvidence: toJson(args.compliance),
        narrative: args.narrative,
        evidence: toJson({ policyVersion: args.outcome.policyVersion, reasons: args.outcome.reasons }),
        dataLimitations: args.dataLimitations,
        proposedPriority: args.proposedPriority,
        status: 'ACTIVE',
        supersedesId: previous?.id ?? null,
      },
      select: { id: true, version: true },
    })

    // The previous ACTIVE version becomes SUPERSEDED. A version a human already
    // accepted or rejected keeps that status — their action is the record.
    if (previous && previous.status === 'ACTIVE') {
      await tx.qualificationRecommendation.update({
        where: { id: previous.id },
        data: { status: 'SUPERSEDED', supersededAt: now },
      })
    }
    return row
  })

  return { ...created, createdNewVersion: true }
}

function mapConfidence(state: ConfidenceState): 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA' {
  return state
}

/**
 * Evidence sufficiency for the borderline policy.
 *
 * NOT the same thing as `WinProbabilityResult.dataSufficiency`, which reports
 * whether a CALIBRATION CURVE has enough fitted samples. A tenant with no curve
 * still has a perfectly usable raw probability; treating that as "no evidence"
 * would make the agent answer INSUFFICIENT_DATA forever on every pursuit.
 *
 *   no probability at all  → NONE          (nothing to decide on)
 *   uncalibrated (RAW/FALLBACK) → INSUFFICIENT  (decide, but err borderline)
 *   calibrated             → SUFFICIENT
 */
function policyDataSufficiency(
  probability: { finalScore: number; scoreType: string } | null,
): 'SUFFICIENT' | 'INSUFFICIENT' | 'NONE' {
  if (!probability) return 'NONE'
  return probability.scoreType === 'CALIBRATED' ? 'SUFFICIENT' : 'INSUFFICIENT'
}

function mapSufficiency(
  probabilitySufficiency: string,
  limitationCount: number,
): 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT' {
  if (probabilitySufficiency === 'NONE') return 'INSUFFICIENT'
  if (probabilitySufficiency === 'INSUFFICIENT' || limitationCount > 0) return 'PARTIAL'
  return 'SUFFICIENT'
}

/**
 * A priority the agent PROPOSES.
 *
 * `BidPursuit.priority` carries no human/derived distinction and no lock, so
 * §7.4 deliberately does NOT write it — an agent overwrite would silently
 * destroy a human's choice. The proposal is carried on the recommendation and
 * rendered in the UI for a person to apply.
 */
function deriveProposedPriority(outcome: BorderlineOutcome, finalProbability: number | null): string | null {
  if (outcome.recommendation === 'RECOMMEND_BID' && outcome.strength === 'STRONG') return 'HIGH'
  if (outcome.recommendation === 'RECOMMEND_NO_BID') return 'LOW'
  if (outcome.isBorderline) return 'MEDIUM'
  if (finalProbability === null) return null
  return 'MEDIUM'
}

// -------------------------------------------------------------
// Gate review — created for a human, never completed by the agent
// -------------------------------------------------------------

async function ensureGateReview(
  ctx: AgentExecutionContext,
  pursuit: ScopePursuit,
  version: number,
): Promise<{ id: string; created: boolean }> {
  const name = `Qualification review — borderline (v${version})`

  // One open review per (pursuit, condition). A NEW version after a material
  // requalification legitimately opens a new one; an unchanged re-run does not.
  const existing = await prisma.gateReview.findFirst({
    where: {
      consultingFirmId: ctx.consultingFirmId,
      bidPursuitId: pursuit.id,
      name,
      status: { in: ['NOT_STARTED', 'IN_PROGRESS', 'CHANGES_REQUIRED'] },
    },
    select: { id: true },
  })
  if (existing) return { id: existing.id, created: false }

  const scorecard = await prisma.scorecard.findFirst({
    where: { consultingFirmId: ctx.consultingFirmId, bidPursuitId: pursuit.id },
    select: { id: true, reviewerUserId: true },
  })
  const adminFallback = await prisma.user.findFirst({
    where: { consultingFirmId: ctx.consultingFirmId, role: 'ADMIN', isActive: true },
    select: { id: true },
  })

  const created = await prisma.gateReview.create({
    data: {
      consultingFirmId: ctx.consultingFirmId,
      bidPursuitId: pursuit.id,
      scorecardId: scorecard?.id ?? null,
      opportunityId: pursuit.opportunityId,
      name,
      stage: 'QUALIFICATION',
      // Existing reviewer first, then the pursuit owner, then an ADMIN.
      reviewerUserId: scorecard?.reviewerUserId ?? pursuit.ownerUserId ?? adminFallback?.id ?? null,
      dueDate: pursuit.responseDeadline,
      // NOT_STARTED — the agent opens it and stops. Completing it is human work.
      status: 'NOT_STARTED',
      comments: 'Opened by the Qualification Agent because the recommendation is borderline. The agent does not complete this review.',
    },
    select: { id: true },
  })
  return { id: created.id, created: true }
}

// -------------------------------------------------------------
// Escalations
// -------------------------------------------------------------

function buildEscalations(
  pursuit: ScopePursuit,
  brief: QualificationBrief,
  contradiction: { contradicts: boolean; reason: string | null },
): ProposedEscalation[] {
  const out: ProposedEscalation[] = []
  const rec = brief.recommendation

  if (rec.borderline) {
    out.push({
      severity: 'HIGH',
      title: `Borderline qualification: ${pursuit.opportunityTitle}`,
      reason: `${rec.reasons.join(' ')} The agent has not recorded any decision.`,
      recommendedAction: 'Review the qualification brief and record a bid/no-bid decision. Only a person can do that.',
      entityType: 'BidPursuit',
      entityId: pursuit.id,
      assignedToUserId: pursuit.ownerUserId,
      // Per (pursuit, version) so a material requalification raises a fresh
      // item while an unchanged re-run does not.
      dedupeHint: `qualification-borderline:${pursuit.id}:v${rec.version}`,
    })
  }

  if (brief.capacity.state === 'OVER_CAPACITY') {
    out.push({
      severity: 'MEDIUM',
      title: `Capacity conflict: ${pursuit.opportunityTitle}`,
      reason: brief.capacity.conflicts.join(' '),
      recommendedAction: 'Confirm the firm can deliver this pursuit alongside its current load.',
      entityType: 'BidPursuit',
      entityId: pursuit.id,
      dedupeHint: `qualification-capacity:${pursuit.id}`,
    })
  }

  if (brief.capability.severity === 'CRITICAL') {
    out.push({
      severity: 'HIGH',
      title: `Critical capability gap: ${pursuit.opportunityTitle}`,
      reason: `Critical gaps: ${brief.capability.criticalGaps.join('; ')}.`,
      recommendedAction: 'Close the gap, team for it, or reconsider the pursuit. The agent proposes no partner and creates no teaming arrangement.',
      entityType: 'BidPursuit',
      entityId: pursuit.id,
      dedupeHint: `qualification-capability:${pursuit.id}`,
    })
  }

  if (contradiction.contradicts && contradiction.reason) {
    out.push({
      severity: 'HIGH',
      title: `Qualification contradicts pursuit stage: ${pursuit.opportunityTitle}`,
      reason: contradiction.reason,
      recommendedAction: 'Confirm whether to continue. The agent has not moved the pursuit or changed any decision.',
      entityType: 'BidPursuit',
      entityId: pursuit.id,
      dedupeHint: `qualification-stage-contradiction:${pursuit.id}:v${rec.version}`,
    })
  }

  if (brief.compliance.available && brief.compliance.blockers > 0) {
    out.push({
      severity: 'HIGH',
      title: `Compliance blocker on a qualifying pursuit: ${pursuit.opportunityTitle}`,
      reason: `${brief.compliance.blockers} compliance blocker(s) affect this pursuit. ${brief.compliance.detail}`,
      recommendedAction: 'Resolve the compliance blocker before committing to this bid.',
      entityType: 'BidPursuit',
      entityId: pursuit.id,
      dedupeHint: `qualification-compliance:${pursuit.id}`,
    })
  }

  return out
}

async function notifyOwner(
  ctx: AgentExecutionContext,
  pursuit: ScopePursuit,
  brief: QualificationBrief,
  recommendationId: string,
): Promise<void> {
  if (!pursuit.ownerUserId) return
  await notifyUser({
    consultingFirmId: ctx.consultingFirmId,
    userId: pursuit.ownerUserId,
    type: 'QUALIFICATION_DECISION',
    title: `Qualification recommendation: ${brief.recommendation.result}`,
    body: `${pursuit.opportunityTitle} — ${brief.recommendation.reasons[0] ?? brief.narrative.split('\n')[1] ?? ''}`.slice(0, 400),
    linkPath: `/pipeline/${pursuit.id}`,
    entityType: 'QualificationRecommendation',
    entityId: recommendationId,
    // One notification per recommendation VERSION, so an unchanged six-hourly
    // re-run never notifies twice.
    dedupeKey: `qualification-recommendation:${recommendationId}`,
  })
}

function buildInputHash(parts: Record<string, unknown>): string {
  const raw = JSON.stringify(parts)
  let hash = 0
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0
  return `${ALGORITHM_VERSION}:${(hash >>> 0).toString(16)}`
}

export type { Prisma }
