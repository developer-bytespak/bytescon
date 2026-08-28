// =============================================================
// §7.0 — Agent dispatch.
//
// The single execution path for every agent. It owns validation, claiming,
// timeout, cancellation, persistence, audit, notification and final status, so
// a handler is free to be nothing more than an async function that returns a
// result object.
//
// Ordering matters and is deliberate:
//   validate -> claim (compare-and-set) -> execute under timeout ->
//   persist artifacts -> persist escalations -> record usage -> audit ->
//   notify -> finalize
//
// Artifacts and escalations are persisted BEFORE the final status write so a
// crash between them leaves the run visibly RUNNING for the reaper rather than
// COMPLETED-with-missing-output.
// =============================================================
import { Prisma } from '@prisma/client'
import type { AgentRun } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { logAudit } from '../auditService'
import { requireAgentDefinition } from './registry'
import { claimRunForExecution, finalizeRun, heartbeatRun, requeueForRetry } from './runService'
import { persistArtifacts } from './artifacts'
import { persistEscalations } from './escalations'
import { notifyAgentOutcome } from './notifications'
import { canApplyAction, partitionAppliedActions } from './safeActions'
import { createBudgetGuard, DEFAULT_RUN_TOKEN_BUDGET, recordScheduleUsage, resolveSchedulePeriodUsage } from './budget'
import { AgentBudgetExhaustedError, type AgentExecutionContext, type AgentHandlerResult } from './types'
import {
  agentBudgetBlocks,
  agentEscalationsCreated,
  agentEstimatedCost,
  agentRunDuration,
  agentRunsActive,
  agentRunsFinished,
  agentRunsStarted,
  agentTokensConsumed,
} from './metrics'

export interface DispatchOutcome {
  runId: string
  status: string
  skippedReason?: string
  artifactsCreated?: number
  escalationsCreated?: number
  retryScheduled?: boolean
}

/** Raised when a run should be retried by BullMQ rather than finalised. */
export class AgentRetryableError extends Error {
  constructor(message: string, readonly runId: string) {
    super(message)
    this.name = 'AgentRetryableError'
  }
}

/**
 * Executes one AgentRun to a terminal status.
 *
 * Returns rather than throws for expected outcomes (unimplemented agent,
 * disabled schedule, already-claimed run). Throws AgentRetryableError only when
 * BullMQ should retry.
 */
export async function dispatchAgentRun(runId: string): Promise<DispatchOutcome> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId } })
  if (!run) {
    logger.warn('Agent dispatch: run not found', { runId })
    return { runId, status: 'MISSING' }
  }

  // ---- validate registry entry -----------------------------------------
  const def = requireAgentDefinition(run.agentKey)

  if (!def.implemented || !def.handler) {
    // Honest refusal. The agent's own slice has not landed.
    await finalizeRun({
      runId,
      status: 'SKIPPED',
      outputSummary: `${def.name} is not implemented yet (planned in slice ${def.plannedSlice}).`,
      confidenceState: 'INSUFFICIENT_DATA',
      dataSufficiency: 'INSUFFICIENT',
      errorCode: 'NOT_IMPLEMENTED',
      errorMessage: `No handler is registered for ${run.agentKey}.`,
      limitations: [`${def.name} has no handler in this build.`],
    })
    return { runId, status: 'SKIPPED', skippedReason: 'NOT_IMPLEMENTED' }
  }

  // ---- validate tenant + enabled state ---------------------------------
  const schedule = run.scheduleId
    ? await prisma.agentSchedule.findUnique({ where: { id: run.scheduleId } })
    : null

  if (schedule && schedule.consultingFirmId !== run.consultingFirmId) {
    // Defensive: a run must never execute against another tenant's schedule.
    await finalizeRun({
      runId,
      status: 'FAILED',
      outputSummary: 'Tenant mismatch between run and schedule.',
      errorCode: 'TENANT_MISMATCH',
      errorMessage: 'Refusing to execute: schedule belongs to a different firm.',
    })
    return { runId, status: 'FAILED', skippedReason: 'TENANT_MISMATCH' }
  }

  if (run.triggerType === 'SCHEDULE' && schedule && !schedule.isEnabled) {
    await finalizeRun({
      runId,
      status: 'SKIPPED',
      outputSummary: 'Agent is disabled for this firm.',
      errorCode: 'DISABLED',
    })
    return { runId, status: 'SKIPPED', skippedReason: 'DISABLED' }
  }

  // ---- claim (compare-and-set; loses safely to a concurrent worker) -----
  const claimed = await claimRunForExecution(runId);
  if (!claimed) {
    const fresh = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true } })
    logger.info('Agent dispatch: run was not claimable', { runId, status: fresh?.status })
    return { runId, status: fresh?.status ?? 'UNKNOWN', skippedReason: 'NOT_CLAIMABLE' }
  }

  agentRunsStarted.inc({ agent: run.agentKey, trigger: run.triggerType })
  agentRunsActive.inc({ agent: run.agentKey })

  void logAudit({
    consultingFirmId: run.consultingFirmId,
    actorUserId: run.initiatedByUserId,
    action: 'AGENT_RUN_STARTED',
    entityType: 'AgentRun',
    entityId: runId,
    rationale: `${run.agentKey} attempt ${claimed.attempt}/${claimed.maxAttempts}`,
  })

  const startedAt = Date.now()
  const controller = new AbortController()
  const timeoutMs = claimed.timeoutMs || def.maxRuntimeMs

  // Watchdog: fires the abort signal so a cooperative handler stops promptly.
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Cancellation poller: a user cancelling mid-flight aborts the handler.
  const cancelPoll = setInterval(() => {
    void prisma.agentRun
      .findUnique({ where: { id: runId }, select: { status: true } })
      .then((r) => {
        if (r && (r.status === 'CANCELLED' || r.status === 'TIMED_OUT')) controller.abort()
      })
      .catch(() => undefined)
  }, 1000)

  const scheduleUsage = await resolveSchedulePeriodUsage(run.scheduleId)
  const budget = createBudgetGuard({
    consultingFirmId: run.consultingFirmId,
    runId,
    scheduleId: run.scheduleId,
    runTokenBudget: def.defaultTokenBudget ?? DEFAULT_RUN_TOKEN_BUDGET,
    scheduleTokenBudget: scheduleUsage.budget,
    scheduleTokensUsed: scheduleUsage.tokensUsed,
  })

  const ctx: AgentExecutionContext = {
    agentKey: run.agentKey,
    consultingFirmId: run.consultingFirmId,
    runId,
    trigger: run.triggerType,
    triggerEntityType: run.triggerEntityType,
    triggerEntityId: run.triggerEntityId,
    idempotencyKey: run.idempotencyKey,
    autonomyLevel: claimed.autonomyLevel,
    initiatedByUserId: run.initiatedByUserId,
    scheduleId: run.scheduleId,
    eventId: run.eventId,
    attempt: claimed.attempt,
    deadlineAt: new Date(startedAt + timeoutMs),
    signal: controller.signal,
    log: (message, meta) =>
      logger.info(message, { ...meta, runId, agentKey: run.agentKey, consultingFirmId: run.consultingFirmId }),
    heartbeat: (pct, stage) => heartbeatRun(runId, pct, stage),
    budget,
    audit: async (action, entityType, entityId, rationale) => {
      await logAudit({
        consultingFirmId: run.consultingFirmId,
        actorUserId: run.initiatedByUserId,
        action: action as Parameters<typeof logAudit>[0]['action'],
        entityType,
        entityId,
        rationale,
      })
    },
    canApply: (actionKey) => canApplyAction(run.agentKey, claimed.autonomyLevel, actionKey),
  }

  let outcome: DispatchOutcome = { runId, status: 'FAILED' }

  try {
    const result = await runWithTimeout(def.handler(ctx), timeoutMs, controller)
    outcome = await finishSuccessfully(claimed, result, budget, def.name)
  } catch (err) {
    outcome = await finishWithError(claimed, err, budget)
  } finally {
    clearTimeout(timer)
    clearInterval(cancelPoll)
    agentRunsActive.dec({ agent: run.agentKey })

    const usage = budget.consumed()
    if (usage.tokenInput || usage.tokenOutput) {
      agentTokensConsumed.inc({ agent: run.agentKey, direction: 'input' }, usage.tokenInput)
      agentTokensConsumed.inc({ agent: run.agentKey, direction: 'output' }, usage.tokenOutput)
    }
    if (usage.estimatedCostUsd) agentEstimatedCost.inc({ agent: run.agentKey }, usage.estimatedCostUsd)
    await recordScheduleUsage(run.scheduleId, usage.tokenInput + usage.tokenOutput, usage.estimatedCostUsd)

    agentRunDuration.observe({ agent: run.agentKey, status: outcome.status }, (Date.now() - startedAt) / 1000)
    agentRunsFinished.inc({ agent: run.agentKey, status: outcome.status })
  }

  return outcome
}

/**
 * Races the handler against its runtime budget. A handler that ignores the
 * abort signal still loses the race, so a runaway can never hold the worker.
 */
async function runWithTimeout(
  work: Promise<AgentHandlerResult>,
  timeoutMs: number,
  controller: AbortController,
): Promise<AgentHandlerResult> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          const e = new Error(`Agent handler exceeded its ${timeoutMs}ms budget`)
          e.name = 'AgentTimeoutError'
          reject(e)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function finishSuccessfully(
  run: AgentRun,
  result: AgentHandlerResult,
  budget: ReturnType<typeof createBudgetGuard>,
  agentName: string,
): Promise<DispatchOutcome> {
  const warnings = [...(result.warnings ?? [])]

  // Trust nothing: an applied action is only honoured when the autonomy policy
  // would genuinely have permitted it.
  const applied = partitionAppliedActions(run.agentKey, run.autonomyLevel, result.appliedActions ?? [])
  for (const rejected of applied.rejected) {
    warnings.push(
      `Action "${rejected.actionKey}" was reported as applied but is not permitted at autonomy level ${run.autonomyLevel}; recorded as a proposal instead.`,
    )
    logger.warn('Agent reported an action it was not permitted to apply', {
      runId: run.id,
      agentKey: run.agentKey,
      actionKey: rejected.actionKey,
    })
  }

  const artifactResult = await persistArtifacts({
    consultingFirmId: run.consultingFirmId,
    runId: run.id,
    agentKey: run.agentKey,
    artifacts: result.artifacts ?? [],
  })
  if (artifactResult.skippedVerified > 0) {
    warnings.push(
      `${artifactResult.skippedVerified} human-verified artifact(s) were left untouched rather than superseded.`,
    )
  }
  if (artifactResult.created > 0) {
    void logAudit({
      consultingFirmId: run.consultingFirmId,
      actorUserId: run.initiatedByUserId,
      action: 'AGENT_ARTIFACT_CREATED',
      entityType: 'AgentRun',
      entityId: run.id,
      rationale: `${artifactResult.created} artifact(s) created by ${run.agentKey}`,
    })
  }

  const escalationResult = await persistEscalations({
    consultingFirmId: run.consultingFirmId,
    runId: run.id,
    agentKey: run.agentKey,
    escalations: result.escalations ?? [],
  })
  for (const rec of escalationResult.records.filter((r) => r.wasCreated)) {
    agentEscalationsCreated.inc({ agent: run.agentKey, severity: rec.severity })
    void logAudit({
      consultingFirmId: run.consultingFirmId,
      actorUserId: null,
      action: 'AGENT_ESCALATED',
      entityType: 'AgentEscalation',
      entityId: rec.id,
      rationale: rec.title,
    })
  }
  if (escalationResult.suppressedResolved > 0) {
    warnings.push(
      `${escalationResult.suppressedResolved} escalation(s) matched an item a human already resolved and were not reopened.`,
    )
  }

  for (const proposal of result.proposedActions ?? []) {
    void logAudit({
      consultingFirmId: run.consultingFirmId,
      actorUserId: null,
      action: 'AGENT_ACTION_PROPOSED',
      entityType: proposal.entityType ?? 'AgentRun',
      entityId: proposal.entityId ?? run.id,
      rationale: `${proposal.actionKey}: ${proposal.description}`,
    })
  }
  for (const act of applied.permitted) {
    void logAudit({
      consultingFirmId: run.consultingFirmId,
      actorUserId: null,
      action: 'AGENT_ACTION_APPLIED',
      entityType: act.entityType ?? 'AgentRun',
      entityId: act.entityId ?? run.id,
      rationale: `${act.actionKey}: ${act.description}`,
    })
  }

  const usage = budget.consumed()
  const finalized = await finalizeRun({
    runId: run.id,
    status: result.status,
    outputSummary: result.summary,
    confidenceState: result.confidence,
    dataSufficiency: result.dataSufficiency,
    warnings,
    limitations: result.limitations ?? [],
    inputSnapshot: (result.inputSnapshot ?? undefined) as Prisma.InputJsonValue | undefined,
    inputHash: result.inputHash ?? null,
    tokenInput: usage.tokenInput,
    tokenOutput: usage.tokenOutput,
    estimatedCostUsd: usage.estimatedCostUsd,
  })

  const finalStatus = finalized?.status ?? 'CANCELLED'

  void logAudit({
    consultingFirmId: run.consultingFirmId,
    actorUserId: run.initiatedByUserId,
    action: finalStatus === 'COMPLETED' ? 'AGENT_RUN_COMPLETED' : 'AGENT_RUN_FAILED',
    entityType: 'AgentRun',
    entityId: run.id,
    rationale: result.summary,
  })

  // Notify only for a genuinely finished run — a cancelled one says nothing.
  if (finalized) {
    if (escalationResult.records.some((r) => r.wasCreated)) {
      const top = escalationResult.records.filter((r) => r.wasCreated)[0]
      await notifyAgentOutcome({
        consultingFirmId: run.consultingFirmId,
        agentKey: run.agentKey,
        runId: run.id,
        kind: 'ESCALATION',
        severity: top.severity,
        escalationId: top.id,
        title: `${agentName}: ${top.title}`,
        body: result.summary,
      })
    } else if (finalStatus === 'COMPLETED') {
      await notifyAgentOutcome({
        consultingFirmId: run.consultingFirmId,
        agentKey: run.agentKey,
        runId: run.id,
        kind: 'SUCCESS',
        title: `${agentName} completed`,
        body: result.summary,
      })
    }
  }

  return {
    runId: run.id,
    status: finalStatus,
    artifactsCreated: artifactResult.created,
    escalationsCreated: escalationResult.created,
  }
}

async function finishWithError(
  run: AgentRun,
  err: unknown,
  budget: ReturnType<typeof createBudgetGuard>,
): Promise<DispatchOutcome> {
  const error = err as Error
  const usage = budget.consumed()

  // --- budget exhaustion is a structured outcome, not a crash ------------
  if (error instanceof AgentBudgetExhaustedError) {
    agentBudgetBlocks.inc({ agent: run.agentKey, scope: error.scope })
    await persistEscalations({
      consultingFirmId: run.consultingFirmId,
      runId: run.id,
      agentKey: run.agentKey,
      escalations: [
        {
          severity: 'HIGH',
          title: 'Agent AI budget exhausted',
          reason: error.message,
          recommendedAction: 'Raise the budget for this agent, or leave it to run deterministically.',
          dedupeHint: `budget-exhausted:${error.scope}`,
        },
      ],
    })
    await finalizeRun({
      runId: run.id,
      status: 'FAILED',
      outputSummary: 'Stopped before calling an AI provider: the configured background budget was exhausted.',
      confidenceState: 'INSUFFICIENT_DATA',
      dataSufficiency: 'INSUFFICIENT',
      errorCode: error.code,
      errorMessage: error.message,
      limitations: ['Monthly AI budget exhausted — no provider call was made.'],
      tokenInput: usage.tokenInput,
      tokenOutput: usage.tokenOutput,
      estimatedCostUsd: usage.estimatedCostUsd,
    })
    await notifyAgentOutcome({
      consultingFirmId: run.consultingFirmId,
      agentKey: run.agentKey,
      runId: run.id,
      kind: 'FAILURE',
      title: 'Agent stopped: AI budget exhausted',
      body: error.message,
    })
    return { runId: run.id, status: 'FAILED', skippedReason: 'BUDGET_EXHAUSTED' }
  }

  // --- timeout ----------------------------------------------------------
  const isTimeout = error.name === 'AgentTimeoutError'
  if (isTimeout) {
    await finalizeRun({
      runId: run.id,
      status: 'TIMED_OUT',
      outputSummary: 'The agent exceeded its maximum runtime and was stopped.',
      errorCode: 'TIMEOUT',
      errorMessage: error.message,
      tokenInput: usage.tokenInput,
      tokenOutput: usage.tokenOutput,
      estimatedCostUsd: usage.estimatedCostUsd,
    })
    void logAudit({
      consultingFirmId: run.consultingFirmId,
      actorUserId: null,
      action: 'AGENT_RUN_TIMED_OUT',
      entityType: 'AgentRun',
      entityId: run.id,
      rationale: error.message,
    })
    await persistEscalations({
      consultingFirmId: run.consultingFirmId,
      runId: run.id,
      agentKey: run.agentKey,
      escalations: [
        {
          severity: 'MEDIUM',
          title: 'Agent run timed out',
          reason: error.message,
          recommendedAction: 'Review the agent configuration or raise its maximum runtime.',
          dedupeHint: `timeout:${run.agentKey}`,
        },
      ],
    })
    await notifyAgentOutcome({
      consultingFirmId: run.consultingFirmId,
      agentKey: run.agentKey,
      runId: run.id,
      kind: 'FAILURE',
      title: 'Agent run timed out',
      body: error.message,
    })
    return { runId: run.id, status: 'TIMED_OUT' }
  }

  // --- ordinary failure: retry while budget remains ----------------------
  logger.error('Agent handler failed', {
    runId: run.id,
    agentKey: run.agentKey,
    attempt: run.attempt,
    error: error.message,
  })

  const canRetry = await requeueForRetry(run.id)
  if (canRetry) {
    // Left QUEUED for BullMQ's backoff to pick up again.
    throw new AgentRetryableError(error.message, run.id)
  }

  await finalizeRun({
    runId: run.id,
    status: 'FAILED',
    outputSummary: 'The agent failed and its retry budget is exhausted.',
    errorCode: 'HANDLER_ERROR',
    errorMessage: error.message,
    tokenInput: usage.tokenInput,
    tokenOutput: usage.tokenOutput,
    estimatedCostUsd: usage.estimatedCostUsd,
  })
  void logAudit({
    consultingFirmId: run.consultingFirmId,
    actorUserId: null,
    action: 'AGENT_RUN_FAILED',
    entityType: 'AgentRun',
    entityId: run.id,
    rationale: error.message,
  })
  await notifyAgentOutcome({
    consultingFirmId: run.consultingFirmId,
    agentKey: run.agentKey,
    runId: run.id,
    kind: 'FAILURE',
    title: 'Agent run failed',
    body: error.message,
  })
  return { runId: run.id, status: 'FAILED' }
}
