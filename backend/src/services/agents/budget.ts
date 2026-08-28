// =============================================================
// §7.0 — Background token/cost budget guard.
//
// The planning report identified uncontrolled background LLM spend as a genuine
// missing control: nine agents x N tenants x a frequent cadence is a different
// cost profile from a human pressing a button. `tierGate` already enforces
// limits on the REQUEST path; nothing enforced them for background work.
//
// This guard sits in front of the existing llmRouter. It does not duplicate
// provider routing, key resolution, caching or fallback — it only decides
// whether the call is allowed to happen at all, and it decides BEFORE the
// provider is reached. That ordering is the entire control and is covered by a
// dedicated test that asserts the provider function was never invoked.
// =============================================================
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { checkAiCallLimit } from '../../middleware/tierGate'
import { generateWithRouter, type LLMTask } from '../llm/llmRouter'
import type { LLMRequest, LLMResponse } from '../llm/provider.interface'
import { AgentBudgetExhaustedError, type AgentBudgetGuard, type BudgetDecision } from './types'

/** Used when neither the schedule nor the agent definition sets a budget. */
export const DEFAULT_RUN_TOKEN_BUDGET = 200_000

export interface BudgetGuardOptions {
  consultingFirmId: string
  runId: string
  scheduleId: string | null
  /** Ceiling for this single run. */
  runTokenBudget: number
  /** Remaining budget on the tenant's schedule row, null when unlimited. */
  scheduleTokenBudget: number | null
  scheduleTokensUsed: number
  /** Injection seam so tests can prove the provider is never reached. */
  generate?: typeof generateWithRouter
  /** Injection seam for the tenant-plan check. */
  checkPlanLimit?: typeof checkAiCallLimit
}

/**
 * Creates the per-run guard handed to a handler as `ctx.budget`.
 *
 * Three ceilings are checked, cheapest first: the run's own budget, the
 * tenant's per-agent schedule budget, then the tenant's plan AI-call limit.
 */
export function createBudgetGuard(opts: BudgetGuardOptions): AgentBudgetGuard {
  const generate = opts.generate ?? generateWithRouter
  const checkPlan = opts.checkPlanLimit ?? checkAiCallLimit

  let tokenInput = 0
  let tokenOutput = 0
  let estimatedCostUsd = 0

  const used = () => tokenInput + tokenOutput

  async function decide(estimatedTokens: number): Promise<BudgetDecision> {
    const projected = used() + Math.max(0, estimatedTokens)

    if (projected > opts.runTokenBudget) {
      return {
        allowed: false,
        scope: 'RUN',
        reason:
          `This run's token budget (${opts.runTokenBudget}) would be exceeded: ` +
          `${used()} already used, ${estimatedTokens} more requested.`,
      }
    }

    if (opts.scheduleTokenBudget !== null) {
      const scheduleProjected = opts.scheduleTokensUsed + projected
      if (scheduleProjected > opts.scheduleTokenBudget) {
        return {
          allowed: false,
          scope: 'SCHEDULE',
          reason:
            `The agent's budget for this tenant (${opts.scheduleTokenBudget} tokens this period) ` +
            `would be exceeded: ${opts.scheduleTokensUsed} already used this period.`,
        }
      }
    }

    // Reuses the existing plan enforcement rather than inventing a second one.
    try {
      const plan = await checkPlan(opts.consultingFirmId)
      if (!plan.allowed) {
        return {
          allowed: false,
          scope: 'TENANT_PLAN',
          reason: `Tenant plan AI-call limit reached (${plan.current}/${plan.max}).`,
        }
      }
    } catch (err) {
      // A limit-check outage must not silently unlock unlimited spend, but it
      // also must not hard-fail a deterministic-capable agent. Log and allow the
      // two hard token ceilings above to remain the binding control.
      logger.warn('Agent budget: plan limit check failed, falling back to token ceilings', {
        runId: opts.runId,
        error: (err as Error).message,
      })
    }

    return {
      allowed: true,
      remainingTokens: opts.runTokenBudget - used(),
      remainingCostUsd: null,
    }
  }

  return {
    check: decide,

    async generate(req: LLMRequest, callOpts): Promise<LLMResponse> {
      const estimated = callOpts.estimatedTokens ?? estimateTokens(req)
      const decision = await decide(estimated)

      if (!decision.allowed) {
        // Deliberately BEFORE any provider call.
        logger.warn('Agent LLM call blocked by budget guard', {
          runId: opts.runId,
          scope: decision.scope,
        })
        throw new AgentBudgetExhaustedError(decision.reason, decision.scope)
      }

      const res = await generate(req, opts.consultingFirmId, {
        task: callOpts.task,
        useCache: callOpts.useCache,
      })

      tokenInput += res.inputTokens ?? 0
      tokenOutput += res.outputTokens ?? 0
      estimatedCostUsd += res.estimatedCostUsd ?? 0
      return res
    },

    consumed: () => ({ tokenInput, tokenOutput, estimatedCostUsd }),
  }
}

/**
 * Cheap pre-call size estimate (~4 chars/token) plus the requested completion
 * ceiling. Only used to decide whether to attempt the call; real usage is taken
 * from the provider response and from ApiUsageLog, which llmRouter already writes.
 */
export function estimateTokens(req: LLMRequest): number {
  const chars = (req.systemPrompt?.length ?? 0) + (req.userPrompt?.length ?? 0)
  return Math.ceil(chars / 4) + (req.maxTokens ?? 1024)
}

/**
 * Rolls the tenant's per-agent budget window monthly and returns the tokens
 * already consumed in the current period.
 */
export async function resolveSchedulePeriodUsage(
  scheduleId: string | null,
  now: Date = new Date(),
): Promise<{ tokensUsed: number; budget: number | null }> {
  if (!scheduleId) return { tokensUsed: 0, budget: null }

  const schedule = await prisma.agentSchedule.findUnique({
    where: { id: scheduleId },
    select: { tokenBudget: true, tokensUsedThisPeriod: true, budgetPeriodStartedAt: true },
  })
  if (!schedule) return { tokensUsed: 0, budget: null }

  const periodAgeDays = (now.getTime() - schedule.budgetPeriodStartedAt.getTime()) / 86_400_000
  if (periodAgeDays >= 30) {
    await prisma.agentSchedule.update({
      where: { id: scheduleId },
      data: { tokensUsedThisPeriod: 0, costUsedThisPeriodUsd: 0, budgetPeriodStartedAt: now },
    })
    return { tokensUsed: 0, budget: schedule.tokenBudget }
  }

  return { tokensUsed: schedule.tokensUsedThisPeriod, budget: schedule.tokenBudget }
}

/** Accrues a completed run's usage onto its tenant schedule. */
export async function recordScheduleUsage(
  scheduleId: string | null,
  tokens: number,
  costUsd: number,
): Promise<void> {
  if (!scheduleId || (tokens <= 0 && costUsd <= 0)) return
  await prisma.agentSchedule
    .update({
      where: { id: scheduleId },
      data: {
        tokensUsedThisPeriod: { increment: tokens },
        costUsedThisPeriodUsd: { increment: costUsd },
      },
    })
    .catch((err) => logger.warn('Failed to accrue agent schedule usage', { scheduleId, error: (err as Error).message }))
}
