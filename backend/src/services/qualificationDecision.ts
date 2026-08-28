// =============================================================
// §7.4 — The canonical HUMAN qualification decision.
//
// Extracted VERBATIM from `POST /api/qualification/:pursuitId/decision` so that
// there is exactly ONE implementation of "a person recorded a bid/no-bid
// decision". The original route now calls this function, and the §7.4
// accept/reject endpoints call the same function.
//
// Behaviour is unchanged: the same stage guard, the same required-criteria
// check, the same override-reason rule, the same Scorecard update,
// ScorecardDecision history row, pipeline transition, owner notification and
// audit action.
//
// WHY THIS MATTERS FOR §7.4
// The Qualification Agent must never record a decision. Because the only way to
// record one is this function, and this function REQUIRES an `actorUserId` that
// is a real person, an agent code path cannot reach a decision even by mistake.
// The agent never imports this module.
// =============================================================
import { Prisma, QualificationStatus, ScorecardRecommendation } from '@prisma/client'
import { prisma } from '../config/database'
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors'
import { computeScorecard } from './scorecardScoring'
import { isValidStageTransition } from './pipelineStages'
import { notifyUser } from './notificationService'
import { emitBidDecisionRecorded } from './agents/teaming/teamingEvents'

/** Decisions that close or advance a pursuit. */
export const FINAL_DECISIONS = ['BID', 'NO_BID', 'CONDITIONAL', 'DEFERRED'] as const
export type FinalDecision = (typeof FINAL_DECISIONS)[number]

/**
 * A pursuit already past qualification must not be silently dragged back into
 * it.
 */
export const NON_QUALIFIABLE_STAGES = ['SUBMITTED', 'AWARDED', 'LOST', 'ARCHIVED']

/**
 * Map a system recommendation to the decision it endorses. DEFERRED is never a
 * system recommendation, so choosing it is always an override.
 */
export function isOverrideDecision(
  recommendation: ScorecardRecommendation | null,
  decision: FinalDecision,
): boolean {
  if (!recommendation || recommendation === 'REVIEW_REQUIRED') return true
  return (recommendation as string) !== (decision as string)
}

export interface RecordDecisionArgs {
  consultingFirmId: string
  pursuitId: string
  decision: FinalDecision
  /**
   * The PERSON recording the decision. Required — there is deliberately no way
   * to record a decision without a human actor.
   */
  actorUserId: string
  overrideReason?: string | null
  reviewerComments?: string | null
}

export interface RecordDecisionResult {
  scorecardId: string
  decision: FinalDecision
  isOverride: boolean
  totalScore: number
  recommendation: ScorecardRecommendation | null
  stageChangedTo: string | null
  decidedAt: Date
}

/**
 * Record a human qualification decision.
 *
 * Throws rather than coercing: an undecidable scorecard, a pursuit past
 * qualification, or a missing override reason are all refusals, exactly as the
 * original route behaved.
 */
export async function recordQualificationDecision(args: RecordDecisionArgs): Promise<RecordDecisionResult> {
  if (!args.actorUserId) {
    throw new ValidationError('A qualification decision must be recorded by a person.')
  }

  const pursuit = await prisma.bidPursuit.findFirst({
    where: { id: args.pursuitId, consultingFirmId: args.consultingFirmId },
    include: { opportunity: { select: { id: true, title: true } } },
  })
  if (!pursuit) throw new NotFoundError('Pursuit not found')

  if (NON_QUALIFIABLE_STAGES.includes(pursuit.pipelineStage)) {
    throw new ConflictError(`Cannot record a qualification decision for a pursuit in stage ${pursuit.pipelineStage}`)
  }

  const sc = await prisma.scorecard.findFirst({
    where: { consultingFirmId: args.consultingFirmId, bidPursuitId: pursuit.id },
    include: { criteria: true },
  })
  if (!sc) throw new NotFoundError('Scorecard not started')
  if (sc.status !== 'NOT_REVIEWED' && sc.status !== 'IN_REVIEW') {
    throw new ConflictError('This scorecard has already been decided — reassess it to change the decision')
  }

  const result = computeScorecard(
    sc.criteria.map((c) => ({ key: c.key, weight: c.weight, score: c.score, required: c.required })),
  )
  if (!result.complete) {
    throw new ValidationError(`Cannot decide — required criteria not scored: ${result.missingRequiredKeys.join(', ')}`)
  }

  const override = isOverrideDecision(result.recommendation, args.decision)
  const reason = (args.overrideReason ?? '').trim()
  if (override && reason.length === 0) {
    throw new ValidationError('An override reason is required when the decision differs from the system recommendation')
  }

  // Compute the pipeline target for this decision (only applied if legal).
  let stageTarget: string | null = null
  if (args.decision === 'BID') stageTarget = 'CAPTURE'
  else if (args.decision === 'NO_BID') stageTarget = 'NO_BID'
  // CONDITIONAL / DEFERRED keep the pursuit in its current (QUALIFICATION) stage.

  const now = new Date()
  let stageChangedTo: string | null = null

  await prisma.$transaction(async (tx) => {
    await tx.scorecard.update({
      where: { id: sc.id },
      data: {
        status: args.decision as QualificationStatus,
        finalDecision: args.decision as QualificationStatus,
        totalScore: result.totalScore,
        recommendation: result.recommendation,
        isOverride: override,
        overrideReason: override ? reason : null,
        overriddenByUserId: override ? args.actorUserId : null,
        decidedByUserId: args.actorUserId,
        decidedAt: now,
        reviewerComments: args.reviewerComments ?? sc.reviewerComments,
      },
    })
    await tx.scorecardDecision.create({
      data: {
        consultingFirmId: args.consultingFirmId,
        scorecardId: sc.id,
        bidPursuitId: pursuit.id,
        opportunityId: pursuit.opportunityId,
        status: args.decision as QualificationStatus,
        recommendation: result.recommendation,
        totalScore: result.totalScore,
        isOverride: override,
        overrideReason: override ? reason : null,
        reviewerComments: args.reviewerComments ?? null,
        changedByUserId: args.actorUserId,
        changeReason: override ? `Override → ${args.decision}` : `Decision → ${args.decision}`,
        snapshotJson: {
          criteria: sc.criteria.map((c) => ({ key: c.key, score: c.score, weight: c.weight })),
          recommendation: result.recommendation,
          totalScore: result.totalScore,
        },
      },
    })
    // §7.5 — the decision event shares this transaction, so a rolled-back
    // decision emits nothing. The payload carries ids and status only.
    await emitBidDecisionRecorded(
      {
        consultingFirmId: args.consultingFirmId,
        pursuitId: pursuit.id,
        opportunityId: pursuit.opportunityId,
        decision: args.decision,
        isOverride: override,
        decidedByUserId: args.actorUserId,
      },
      tx,
    )

    const pursuitData: Prisma.BidPursuitUpdateInput = { lastActivityAt: now }
    if (stageTarget && isValidStageTransition(pursuit.pipelineStage, stageTarget as never)) {
      pursuitData.pipelineStage = stageTarget as never
      stageChangedTo = stageTarget
    }
    await tx.bidPursuit.update({ where: { id: pursuit.id }, data: pursuitData })

    // Notify the pursuit owner (if any, and not the actor).
    if (pursuit.ownerUserId && pursuit.ownerUserId !== args.actorUserId) {
      await notifyUser(
        {
          consultingFirmId: args.consultingFirmId,
          userId: pursuit.ownerUserId,
          type: 'QUALIFICATION_DECISION',
          title: `Qualification decision: ${args.decision}`,
          body: pursuit.opportunity.title,
          linkPath: `/pipeline/${pursuit.id}`,
          entityType: 'Scorecard',
          entityId: sc.id,
          dedupeKey: `qual-decided:${sc.id}:${now.getTime()}`,
        },
        tx,
      )
    }
  })

  return {
    scorecardId: sc.id,
    decision: args.decision,
    isOverride: override,
    totalScore: result.totalScore,
    recommendation: result.recommendation,
    stageChangedTo,
    decidedAt: now,
  }
}
