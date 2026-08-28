// =============================================================
// §7.0 — Shared agent runtime: pure-logic units.
//
// No database. Covers the registry contract, the run state machine, the
// autonomy/safe-action policy, cron computation and the budget guard's
// ordering guarantee (refuse BEFORE the provider is reached).
// =============================================================
import { describe, it, expect, vi } from 'vitest'
import {
  AGENT_REGISTRY, getAgentDefinition, isKnownAgentKey, publicAgentDefinitions,
  agentsSubscribedTo, requireAgentDefinition,
} from './registry'
import { DOMAIN_AGENT_KEYS } from './types'
import { assertRunTransition, canTransitionRun, isTerminalRunStatus, TERMINAL_RUN_STATUSES } from './runStateMachine'
import { canApplyAction, partitionAppliedActions, isReadOnlyAutonomy, SAFE_ACTION_REGISTRY } from './safeActions'
import { computeNextRunAt, isValidCronExpression } from './scheduler'
import { createBudgetGuard, estimateTokens } from './budget'
import { buildRunIdempotencyKey, scheduleDiscriminator } from './runService'
import { buildEventDedupeKey } from './outbox'
import { shouldNotify, DEFAULT_AGENT_NOTIFICATION_PREFERENCE } from './notifications'
import { buildEscalationDedupeKey } from './escalations'
import type { AgentRunStatus } from '@prisma/client'

// -------------------------------------------------------------
// Registry
// -------------------------------------------------------------

describe('AGENT_REGISTRY — the nine agents are declared honestly', () => {
  it('registers all nine domain agent keys', () => {
    for (const key of DOMAIN_AGENT_KEYS) {
      expect(getAgentDefinition(key), key).toBeDefined()
    }
    expect(publicAgentDefinitions()).toHaveLength(9)
  })

  it('marks exactly the delivered agents as implemented and the rest honestly not', () => {
    // §7.1 CONTRACT_ADMINISTRATION · §7.2 OPPORTUNITY · §7.3 COMPLIANCE ·
    // §7.4 QUALIFICATION · §7.5 TEAMING · §7.6 PRICING. Every other domain
    // agent must still declare itself unimplemented with no handler wired.
    // §7.9 completed Section 7: every domain agent is delivered.
    const DELIVERED = new Set(['CONTRACT_ADMINISTRATION', 'OPPORTUNITY', 'COMPLIANCE', 'QUALIFICATION', 'TEAMING', 'PRICING', 'PROPOSAL', 'FINANCE', 'INTELLIGENCE'])
    for (const def of publicAgentDefinitions()) {
      if (DELIVERED.has(def.key)) {
        expect(def.implemented, `${def.key} is delivered and must say so`).toBe(true)
        expect(def.handler, `${def.key} must have a real handler`).toBeTypeOf('function')
      } else {
        expect(def.implemented, `${def.key} must not claim to be implemented`).toBe(false)
        expect(def.handler, `${def.key} must have no handler`).toBeNull()
      }
    }
  })

  it('defaults every agent to PROPOSE autonomy', () => {
    for (const def of AGENT_REGISTRY) {
      expect(def.defaultAutonomyLevel, def.key).toBe('PROPOSE')
    }
  })

  it('ships every domain agent disabled by default', () => {
    for (const def of publicAgentDefinitions()) {
      expect(def.defaultEnabled, def.key).toBe(false)
    }
  })

  it('hides the internal diagnostic agent from the product surface', () => {
    expect(AGENT_REGISTRY.some((d) => d.key === 'INTERNAL_DIAGNOSTIC')).toBe(true)
    expect(publicAgentDefinitions().some((d) => d.key === 'INTERNAL_DIAGNOSTIC')).toBe(false)
  })

  it('keeps the internal diagnostic agent executable so the runtime can be proven', () => {
    const diag = requireAgentDefinition('INTERNAL_DIAGNOSTIC')
    expect(diag.implemented).toBe(true)
    expect(diag.handler).toBeTypeOf('function')
  })

  it('declares a no-LLM behaviour for every agent', () => {
    for (const def of AGENT_REGISTRY) {
      expect(def.noLlmBehaviour.length, def.key).toBeGreaterThan(0)
    }
  })

  it('gives every agent a planned slice and a positive runtime budget', () => {
    for (const def of AGENT_REGISTRY) {
      expect(def.plannedSlice, def.key).toMatch(/^7\.\d$/)
      expect(def.maxRuntimeMs, def.key).toBeGreaterThan(0)
      expect(def.defaultMaxAttempts, def.key).toBeGreaterThanOrEqual(1)
    }
  })

  it('rejects an unknown agent key', () => {
    expect(isKnownAgentKey('NOT_AN_AGENT')).toBe(false)
    expect(isKnownAgentKey('OPPORTUNITY')).toBe(true)
    expect(() => requireAgentDefinition('NOPE' as never)).toThrow(/Unknown agent key/)
  })

  it('never resolves an unimplemented agent as an event subscriber', () => {
    // §7.4 — QUALIFICATION now has a handler, so it resolves for its trigger.
    expect(agentsSubscribedTo('OPPORTUNITY_MATCH_HIGH').map((d) => d.key)).toEqual(['QUALIFICATION'])
    // The diagnostic agent is implemented, so it does resolve.
    expect(agentsSubscribedTo('RUNTIME_DIAGNOSTIC_PING').map((d) => d.key)).toEqual(['INTERNAL_DIAGNOSTIC'])
    // §7.1 — the delivered contract agent resolves for its own events.
    // §7.9 — Intelligence subscribes to the SAME §7.1 emitter rather than
    // duplicating it, so an award fans out to both agents.
    expect(agentsSubscribedTo('CONTRACT_AWARDED').map((d) => d.key).sort()).toEqual(['CONTRACT_ADMINISTRATION', 'INTELLIGENCE'])
    // §7.2 — the delivered opportunity agent resolves for its own events.
    expect(agentsSubscribedTo('SOURCE_SYNC_COMPLETED').map((d) => d.key)).toEqual(['OPPORTUNITY'])
  })
})

// -------------------------------------------------------------
// Run state machine
// -------------------------------------------------------------

describe('run state machine', () => {
  it.each([
    ['QUEUED', 'RUNNING'],
    ['QUEUED', 'CANCELLED'],
    // Pre-execution validation may refuse a run outright.
    ['QUEUED', 'FAILED'],
    ['RUNNING', 'COMPLETED'],
    ['RUNNING', 'FAILED'],
    ['RUNNING', 'TIMED_OUT'],
    ['RUNNING', 'CANCELLED'],
    ['RUNNING', 'WAITING_FOR_REVIEW'],
    ['WAITING_FOR_REVIEW', 'COMPLETED'],
    ['WAITING_FOR_REVIEW', 'CANCELLED'],
  ] as Array<[AgentRunStatus, AgentRunStatus]>)('allows %s -> %s', (from, to) => {
    expect(canTransitionRun(from, to)).toBe(true)
    expect(() => assertRunTransition(from, to)).not.toThrow()
  })

  it.each([
    ['COMPLETED', 'RUNNING'],
    ['FAILED', 'COMPLETED'],
    ['CANCELLED', 'COMPLETED'],
    ['TIMED_OUT', 'COMPLETED'],
    ['SKIPPED', 'RUNNING'],
    ['QUEUED', 'COMPLETED'],
    ['WAITING_FOR_REVIEW', 'RUNNING'],
  ] as Array<[AgentRunStatus, AgentRunStatus]>)('rejects %s -> %s', (from, to) => {
    expect(canTransitionRun(from, to)).toBe(false)
    expect(() => assertRunTransition(from, to)).toThrow()
  })

  it('treats every terminal status as immutable', () => {
    for (const s of TERMINAL_RUN_STATUSES) {
      expect(isTerminalRunStatus(s)).toBe(true)
      expect(() => assertRunTransition(s, 'RUNNING')).toThrow(/already in terminal state/)
    }
  })

  it('is a no-op when the status is unchanged', () => {
    expect(() => assertRunTransition('COMPLETED', 'COMPLETED')).not.toThrow()
  })
})

// -------------------------------------------------------------
// Autonomy / safe actions
// -------------------------------------------------------------

describe('autonomy policy', () => {
  it('never permits an action below ACT_WITH_GUARDRAILS', () => {
    expect(canApplyAction('INTERNAL_DIAGNOSTIC', 'OBSERVE', 'diagnostic.noop')).toBe(false)
    expect(canApplyAction('INTERNAL_DIAGNOSTIC', 'PROPOSE', 'diagnostic.noop')).toBe(false)
  })

  it('permits an allowlisted action at ACT_WITH_GUARDRAILS', () => {
    expect(canApplyAction('INTERNAL_DIAGNOSTIC', 'ACT_WITH_GUARDRAILS', 'diagnostic.noop')).toBe(true)
  })

  it('refuses an action that is not allowlisted even at the highest autonomy', () => {
    expect(canApplyAction('INTERNAL_DIAGNOSTIC', 'ACT_WITH_GUARDRAILS', 'diagnostic.delete-everything')).toBe(false)
  })

  it('registers no domain actions in the foundation slice, so ACT permits nothing for the nine', () => {
    for (const key of DOMAIN_AGENT_KEYS) {
      expect(requireAgentDefinition(key).allowlistedActionKeys, key).toEqual([])
      expect(canApplyAction(key, 'ACT_WITH_GUARDRAILS', 'anything'), key).toBe(false)
    }
    expect(SAFE_ACTION_REGISTRY.every((a) => a.agentKey === 'INTERNAL_DIAGNOSTIC')).toBe(true)
  })

  it('classifies OBSERVE and PROPOSE as read-only', () => {
    expect(isReadOnlyAutonomy('OBSERVE')).toBe(true)
    expect(isReadOnlyAutonomy('PROPOSE')).toBe(true)
    expect(isReadOnlyAutonomy('ACT_WITH_GUARDRAILS')).toBe(false)
  })

  it('downgrades an action the handler claimed but was not allowed to apply', () => {
    const { permitted, rejected } = partitionAppliedActions('INTERNAL_DIAGNOSTIC', 'PROPOSE', [
      { actionKey: 'diagnostic.noop' },
    ])
    expect(permitted).toHaveLength(0)
    expect(rejected).toHaveLength(1)
  })
})

// -------------------------------------------------------------
// Scheduling maths
// -------------------------------------------------------------

describe('schedule computation', () => {
  const from = new Date('2026-03-01T10:00:00.000Z')

  it('computes the next cron occurrence', () => {
    const next = computeNextRunAt(
      { scheduleType: 'CRON', cronExpression: '0 */2 * * *', intervalMinutes: null, timezone: 'UTC' },
      from,
    )
    expect(next?.toISOString()).toBe('2026-03-01T12:00:00.000Z')
  })

  it('computes an interval schedule', () => {
    const next = computeNextRunAt(
      { scheduleType: 'INTERVAL', cronExpression: null, intervalMinutes: 90, timezone: 'UTC' },
      from,
    )
    expect(next?.toISOString()).toBe('2026-03-01T11:30:00.000Z')
  })

  it('returns null for MANUAL_ONLY so the due query never picks it up', () => {
    expect(computeNextRunAt({ scheduleType: 'MANUAL_ONLY', cronExpression: '* * * * *', intervalMinutes: null, timezone: 'UTC' }, from)).toBeNull()
  })

  it('returns null rather than "run constantly" for an invalid cron', () => {
    expect(computeNextRunAt({ scheduleType: 'CRON', cronExpression: 'not-a-cron', intervalMinutes: null, timezone: 'UTC' }, from)).toBeNull()
    expect(isValidCronExpression('not-a-cron')).toBe(false)
    expect(isValidCronExpression('0 */2 * * *')).toBe(true)
  })

  it('respects the timezone', () => {
    const utc = computeNextRunAt({ scheduleType: 'CRON', cronExpression: '0 9 * * *', intervalMinutes: null, timezone: 'UTC' }, from)
    const ny = computeNextRunAt({ scheduleType: 'CRON', cronExpression: '0 9 * * *', intervalMinutes: null, timezone: 'America/New_York' }, from)
    expect(utc?.toISOString()).not.toBe(ny?.toISOString())
  })
})

// -------------------------------------------------------------
// Idempotency keys
// -------------------------------------------------------------

describe('idempotency keys', () => {
  const base = { agentKey: 'OPPORTUNITY', consultingFirmId: 'firm-1', trigger: 'SCHEDULE' } as const

  it('is stable for the same inputs', () => {
    expect(buildRunIdempotencyKey({ ...base, discriminator: 'x' }))
      .toBe(buildRunIdempotencyKey({ ...base, discriminator: 'x' }))
  })

  it('differs across tenants, agents, triggers and discriminators', () => {
    const k = buildRunIdempotencyKey({ ...base, discriminator: 'x' })
    expect(buildRunIdempotencyKey({ ...base, consultingFirmId: 'firm-2', discriminator: 'x' })).not.toBe(k)
    expect(buildRunIdempotencyKey({ ...base, agentKey: 'FINANCE', discriminator: 'x' })).not.toBe(k)
    expect(buildRunIdempotencyKey({ ...base, trigger: 'MANUAL', discriminator: 'x' })).not.toBe(k)
    expect(buildRunIdempotencyKey({ ...base, discriminator: 'y' })).not.toBe(k)
  })

  it('buckets schedule discriminators to the minute so a double pass collapses', () => {
    expect(scheduleDiscriminator(new Date('2026-03-01T10:00:10Z')))
      .toBe(scheduleDiscriminator(new Date('2026-03-01T10:00:59Z')))
    expect(scheduleDiscriminator(new Date('2026-03-01T10:00:00Z')))
      .not.toBe(scheduleDiscriminator(new Date('2026-03-01T10:01:00Z')))
  })

  it('derives stable event and escalation dedupe keys', () => {
    const args = { consultingFirmId: 'f', eventType: 'X', entityType: 'T', entityId: '1' }
    expect(buildEventDedupeKey(args)).toBe(buildEventDedupeKey(args))
    expect(buildEventDedupeKey({ ...args, entityId: '2' })).not.toBe(buildEventDedupeKey(args))
    expect(buildEscalationDedupeKey('f', 'FINANCE', 'hint')).toBe('f:FINANCE:hint')
  })
})

// -------------------------------------------------------------
// Budget guard — the ordering guarantee
// -------------------------------------------------------------

describe('budget guard', () => {
  const req = { systemPrompt: 'sys', userPrompt: 'user', maxTokens: 100 }
  const okResponse = {
    text: 'ok', inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001, provider: 'test', model: 'test',
  }

  function guard(overrides: Partial<Parameters<typeof createBudgetGuard>[0]> = {}) {
    const generate = vi.fn().mockResolvedValue(okResponse)
    const g = createBudgetGuard({
      consultingFirmId: 'firm-1',
      runId: 'run-1',
      scheduleId: null,
      runTokenBudget: 10_000,
      scheduleTokenBudget: null,
      scheduleTokensUsed: 0,
      generate: generate as never,
      checkPlanLimit: (async () => ({ allowed: true, current: 0, max: 100 })) as never,
      ...overrides,
    })
    return { g, generate }
  }

  it('allows a call that fits the budget and records usage', async () => {
    const { g, generate } = guard()
    const res = await g.generate(req, { task: 'AI_ASSISTANT', estimatedTokens: 100 })
    expect(res.text).toBe('ok')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(g.consumed()).toEqual({ tokenInput: 10, tokenOutput: 5, estimatedCostUsd: 0.001 })
  })

  it('BLOCKS an over-budget call BEFORE the provider is invoked', async () => {
    const { g, generate } = guard({ runTokenBudget: 50 })
    await expect(g.generate(req, { task: 'AI_ASSISTANT', estimatedTokens: 5_000 })).rejects.toThrow(/token budget/i)
    // The whole point of the control: the provider was never reached.
    expect(generate).not.toHaveBeenCalled()
  })

  it('allows a call exactly at the boundary and refuses one token past it', async () => {
    const { g: atBoundary, generate: g1 } = guard({ runTokenBudget: 100 })
    await expect(atBoundary.check(100)).resolves.toMatchObject({ allowed: true })
    await atBoundary.generate(req, { task: 'AI_ASSISTANT', estimatedTokens: 100 })
    expect(g1).toHaveBeenCalledTimes(1)

    const { g: overBy1, generate: g2 } = guard({ runTokenBudget: 100 })
    await expect(overBy1.check(101)).resolves.toMatchObject({ allowed: false, scope: 'RUN' })
    await expect(overBy1.generate(req, { task: 'AI_ASSISTANT', estimatedTokens: 101 })).rejects.toThrow()
    expect(g2).not.toHaveBeenCalled()
  })

  it('enforces the tenant schedule budget separately from the run budget', async () => {
    const { g, generate } = guard({
      runTokenBudget: 1_000_000,
      scheduleTokenBudget: 500,
      scheduleTokensUsed: 450,
    })
    const decision = await g.check(100)
    expect(decision).toMatchObject({ allowed: false, scope: 'SCHEDULE' })
    await expect(g.generate(req, { task: 'AI_ASSISTANT', estimatedTokens: 100 })).rejects.toThrow()
    expect(generate).not.toHaveBeenCalled()
  })

  it('blocks when the tenant plan AI limit is reached', async () => {
    const { g, generate } = guard({
      checkPlanLimit: (async () => ({ allowed: false, current: 100, max: 100 })) as never,
    })
    await expect(g.check(10)).resolves.toMatchObject({ allowed: false, scope: 'TENANT_PLAN' })
    await expect(g.generate(req, { task: 'AI_ASSISTANT', estimatedTokens: 10 })).rejects.toThrow()
    expect(generate).not.toHaveBeenCalled()
  })

  it('accumulates usage so a second call can exhaust the budget', async () => {
    const big = { ...okResponse, inputTokens: 400, outputTokens: 400 }
    const generate = vi.fn().mockResolvedValue(big)
    const g = createBudgetGuard({
      consultingFirmId: 'f', runId: 'r', scheduleId: null,
      runTokenBudget: 1_000, scheduleTokenBudget: null, scheduleTokensUsed: 0,
      generate: generate as never,
      checkPlanLimit: (async () => ({ allowed: true, current: 0, max: 100 })) as never,
    })
    await g.generate(req, { task: 'AI_ASSISTANT', estimatedTokens: 100 })
    expect(g.consumed().tokenInput + g.consumed().tokenOutput).toBe(800)
    await expect(g.generate(req, { task: 'AI_ASSISTANT', estimatedTokens: 300 })).rejects.toThrow()
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('estimates tokens from prompt size plus the completion ceiling', () => {
    expect(estimateTokens({ systemPrompt: 'a'.repeat(400), userPrompt: '', maxTokens: 100 })).toBe(200)
  })
})

// -------------------------------------------------------------
// Notification preference logic
// -------------------------------------------------------------

describe('notification preference gating', () => {
  const pref = DEFAULT_AGENT_NOTIFICATION_PREFERENCE

  it('does not notify routine successes by default (nine agents would be unusable)', () => {
    expect(shouldNotify(pref, 'SUCCESS')).toBe(false)
  })

  it('notifies failures and escalations by default', () => {
    expect(shouldNotify(pref, 'FAILURE')).toBe(true)
    expect(shouldNotify(pref, 'ESCALATION', 'HIGH')).toBe(true)
  })

  it('suppresses an escalation below the minimum severity', () => {
    expect(shouldNotify({ ...pref, minimumSeverity: 'HIGH' }, 'ESCALATION', 'LOW')).toBe(false)
    expect(shouldNotify({ ...pref, minimumSeverity: 'HIGH' }, 'ESCALATION', 'CRITICAL')).toBe(true)
  })

  it('suppresses everything when in-app notifications are off', () => {
    const off = { ...pref, inAppEnabled: false }
    expect(shouldNotify(off, 'FAILURE')).toBe(false)
    expect(shouldNotify(off, 'ESCALATION', 'CRITICAL')).toBe(false)
  })

  it('honours an explicit opt-out of escalation notifications', () => {
    expect(shouldNotify({ ...pref, notifyOnEscalation: false }, 'ESCALATION', 'CRITICAL')).toBe(false)
  })
})
