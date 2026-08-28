// =============================================================
// §7.0 — Stale-run reaper.
//
// Same job as backtestReaper and ingestReaper: nothing may sit RUNNING forever.
// A worker that is SIGKILLed mid-run leaves a row nobody will ever finish, and
// without this the agent overview would show a permanently "in progress" agent.
//
// The tolerance is derived from the run's OWN timeout budget rather than a
// global constant, so a legitimately long agent is not reaped early. A run whose
// heartbeat is fresh is always left alone, and a run that reached a terminal
// status while the reaper was deciding is never touched (the status guard in the
// UPDATE makes that race safe).
// =============================================================
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { logAudit } from '../auditService'
import { sendOpsAlert } from '../alertService'
import { persistEscalations } from './escalations'
import { agentStaleRunsReaped } from './metrics'

/** Grace beyond a run's own timeout before it is considered abandoned. */
export const HEARTBEAT_GRACE_MULTIPLIER = 2

export interface ReaperResult {
  scanned: number
  reaped: number
  leftAlone: number
  reapedRunIds: string[]
}

/**
 * Terminates runs whose heartbeat has gone silent for longer than
 * `HEARTBEAT_GRACE_MULTIPLIER x timeoutMs`.
 */
export async function reapStaleAgentRuns(now: Date = new Date(), batchSize = 100): Promise<ReaperResult> {
  const result: ReaperResult = { scanned: 0, reaped: 0, leftAlone: 0, reapedRunIds: [] }

  const running = await prisma.agentRun.findMany({
    where: { status: 'RUNNING' },
    select: {
      id: true,
      consultingFirmId: true,
      agentKey: true,
      timeoutMs: true,
      heartbeatAt: true,
      startedAt: true,
      createdAt: true,
    },
    take: batchSize,
  })

  result.scanned = running.length

  for (const run of running) {
    const reference = run.heartbeatAt ?? run.startedAt ?? run.createdAt
    const silentMs = now.getTime() - reference.getTime()
    const toleranceMs = Math.max(run.timeoutMs, 1000) * HEARTBEAT_GRACE_MULTIPLIER

    if (silentMs <= toleranceMs) {
      result.leftAlone++
      continue
    }

    // Status guard: a run that completed since the SELECT is not touched.
    const updated = await prisma.agentRun.updateMany({
      where: { id: run.id, status: 'RUNNING' },
      data: {
        status: 'TIMED_OUT',
        finishedAt: now,
        errorCode: 'STALE_NO_HEARTBEAT',
        errorMessage: `No heartbeat for ${Math.round(silentMs / 1000)}s (tolerance ${Math.round(toleranceMs / 1000)}s). The worker likely restarted mid-run.`,
        outputSummary: 'Terminated by the stale-run reaper.',
      },
    })

    if (updated.count === 0) {
      result.leftAlone++
      continue
    }

    result.reaped++
    result.reapedRunIds.push(run.id)
    agentStaleRunsReaped.inc({ agent: run.agentKey })

    void logAudit({
      consultingFirmId: run.consultingFirmId,
      actorUserId: null,
      action: 'AGENT_RUN_TIMED_OUT',
      entityType: 'AgentRun',
      entityId: run.id,
      rationale: `Reaped after ${Math.round(silentMs / 1000)}s without a heartbeat`,
    })

    // Deduped per agent so a systemic problem raises one item, not hundreds.
    await persistEscalations({
      consultingFirmId: run.consultingFirmId,
      runId: run.id,
      agentKey: run.agentKey,
      escalations: [
        {
          severity: 'HIGH',
          title: 'Agent run abandoned',
          reason: `A ${run.agentKey} run stopped reporting progress and was terminated by the reaper.`,
          recommendedAction: 'Check worker health and backend logs around this run.',
          entityType: 'AgentRun',
          entityId: run.id,
          dedupeHint: `stale-run:${run.agentKey}`,
        },
      ],
    })
  }

  if (result.reaped > 0) {
    logger.warn('Agent reaper terminated stale runs', { reaped: result.reaped, runIds: result.reapedRunIds })
    // Throttled per key by alertService, so a flapping worker pages once.
    void sendOpsAlert({
      key: 'agent-stale-runs',
      severity: 'warning',
      title: `Agent runtime: ${result.reaped} stale run(s) terminated`,
      detail: `Run ids: ${result.reapedRunIds.slice(0, 10).join(', ')}`,
    })
  }

  return result
}
