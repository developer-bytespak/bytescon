// =============================================================
// Keep the pipeline stage true to the work that has happened.
//
// Starting a proposal means the pursuit is in PROPOSAL; recording a submission
// means it is SUBMITTED. Without this the pipeline lagged behind the work and
// the "status and next step" guidance (services/opportunityJourney.ts) would
// report a stale stage. Only ever moves FORWARD along the active stages, one
// legal transition at a time, each recorded exactly like a manual move
// (PURSUIT_STAGE_CHANGED event in the same transaction, plus an audit row).
// Never touches a closed pursuit or one already at or past the target.
// =============================================================
import { PipelineStage } from '@prisma/client'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { logAudit } from './auditService'
import { isValidStageTransition } from './pipelineStages'
import { emitPursuitStageChanged } from './agents/opportunity/opportunityEvents'

const FORWARD: PipelineStage[] = ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL', 'SUBMITTED']

/**
 * Move the notice's pursuit forward to `target` if it is behind. Returns the
 * stage moved to, or null when nothing changed. Never throws: the action that
 * prompted it (creating a proposal, recording a submission) must not fail.
 */
export async function advancePursuit(
  consultingFirmId: string,
  opportunityId: string,
  target: 'PROPOSAL' | 'SUBMITTED',
  actor: { userId?: string | null; role?: string | null; why: string },
): Promise<PipelineStage | null> {
  try {
    const pursuit = await prisma.bidPursuit.upsert({
      where: { consultingFirmId_opportunityId: { consultingFirmId, opportunityId } },
      update: {},
      create: { consultingFirmId, opportunityId },
    })
    const from = FORWARD.indexOf(pursuit.pipelineStage)
    const to = FORWARD.indexOf(target)
    if (pursuit.closedAt || from < 0 || from >= to) return null

    const path = FORWARD.slice(from, to + 1)
    for (let i = 1; i < path.length; i++) {
      if (!isValidStageTransition(path[i - 1], path[i])) return null
    }
    const now = new Date()
    await prisma.$transaction(async (tx) => {
      let previousUpdatedAt = pursuit.updatedAt
      for (let i = 1; i < path.length; i++) {
        const row = await tx.bidPursuit.update({ where: { id: pursuit.id }, data: { pipelineStage: path[i], lastActivityAt: now } })
        await emitPursuitStageChanged(tx, {
          consultingFirmId, pursuitId: pursuit.id, opportunityId,
          fromStage: path[i - 1], toStage: path[i], previousUpdatedAt,
        })
        previousUpdatedAt = row.updatedAt
      }
    })
    await logAudit({
      consultingFirmId, actorUserId: actor.userId ?? undefined, actorRole: actor.role ?? undefined,
      action: 'UPDATE', entityType: 'BidPursuit', entityId: pursuit.id,
      rationale: `Stage ${pursuit.pipelineStage} → ${target}: ${actor.why}`,
      before: { pipelineStage: pursuit.pipelineStage }, after: { pipelineStage: target },
    })
    return target
  } catch (err) {
    logger.warn('Could not advance the pursuit stage', { consultingFirmId, opportunityId, target, error: (err as Error).message })
    return null
  }
}
