// =============================================================
// Agents are opt-in per firm (B6).
//
// An event (an upload, a rejected deliverable, an award) must only wake an
// agent the firm has switched on, and the run must follow that firm's chosen
// autonomy level and AI token budget. Switching an agent off must also stop
// runs that were already queued. A person pressing "Run now" is an explicit
// choice and is not gated.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const generateWithRouterSpy = vi.fn()
vi.mock('../llm/llmRouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm/llmRouter')>()
  return { ...actual, generateWithRouter: (...a: unknown[]) => generateWithRouterSpy(...a) }
})

import * as registry from './registry'
import { prisma } from '../../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, type TestFirm } from '../../test-utils/testClient'
import { enableAgentForFirm } from '../../test-utils/factories'
import { emitAgentEvent, processOutbox } from './outbox'
import { dispatchAgentRun } from './dispatch'
import { buildRunIdempotencyKey, createRun } from './runService'
import type { AgentExecutionContext } from './types'

const DIAG = 'INTERNAL_DIAGNOSTIC' as const
const EVENT = 'RUNTIME_DIAGNOSTIC_PING'

let firmA: TestFirm
let firmB: TestFirm
let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Agent Opt-in Firm A' })
  firmB = await createTestFirm({ name: 'Agent Opt-in Firm B' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  generateWithRouterSpy.mockReset()
  vi.restoreAllMocks()
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentArtifact.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
    await prisma.userNotification.deleteMany({ where: { consultingFirmId: id } })
  }
})

async function emitAndDrain(firmId: string, entityId = uniq('e')) {
  await emitAgentEvent({ consultingFirmId: firmId, eventType: EVENT, entityType: 'Test', entityId })
  return processOutbox(uniq('worker'), 20, new Date(), { consultingFirmId: firmId })
}

const eventRuns = (firmId: string) =>
  prisma.agentRun.findMany({ where: { consultingFirmId: firmId, agentKey: DIAG, triggerType: 'EVENT' } })

/** Replaces the diagnostic handler so a test can see the context it ran with. */
function captureHandler(body: (ctx: AgentExecutionContext) => Promise<void> = async () => undefined) {
  const real = registry.requireAgentDefinition(DIAG)
  const seen: AgentExecutionContext[] = []
  vi.spyOn(registry, 'requireAgentDefinition').mockImplementation((key) =>
    key === DIAG
      ? {
          ...real,
          handler: async (ctx) => {
            seen.push(ctx)
            await body(ctx)
            return { status: 'COMPLETED', summary: 'captured', confidence: 'HIGH', dataSufficiency: 'SUFFICIENT' }
          },
        }
      : registry.AGENT_REGISTRY.find((d) => d.key === key)!,
  )
  return seen
}

describe('event runs need the firm to switch the agent on', () => {
  it('creates no run for a firm that never switched the agent on', async () => {
    const res = await emitAndDrain(firmA.id)
    expect(res.notEnabledSkipped).toBe(1)
    expect(await eventRuns(firmA.id)).toHaveLength(0)
    // The event is still completed, not left to retry forever.
    const ev = await prisma.agentEvent.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(ev.status).toBe('PROCESSED')
  })

  it('creates no run when the firm switched the agent off', async () => {
    await enableAgentForFirm(firmA.id, DIAG, { isEnabled: false })
    await emitAndDrain(firmA.id)
    expect(await eventRuns(firmA.id)).toHaveLength(0)
  })

  it('creates no run when the agent is set to manual-only', async () => {
    await enableAgentForFirm(firmA.id, DIAG, { scheduleType: 'MANUAL_ONLY' })
    await emitAndDrain(firmA.id)
    expect(await eventRuns(firmA.id)).toHaveLength(0)
  })

  it('wakes the agent only for the firm that opted in', async () => {
    await enableAgentForFirm(firmA.id, DIAG)
    await emitAndDrain(firmA.id)
    await emitAndDrain(firmB.id)
    expect(await eventRuns(firmA.id)).toHaveLength(1)
    expect(await eventRuns(firmB.id)).toHaveLength(0)
  })
})

describe("event runs follow the firm's settings", () => {
  it("uses the firm's autonomy level, retries and timeout, and links its schedule", async () => {
    const [schedule] = await enableAgentForFirm(firmA.id, DIAG, { autonomyLevel: 'OBSERVE' })
    await prisma.agentSchedule.update({ where: { id: schedule.id }, data: { maxAttempts: 1, timeoutMs: 5_000 } })

    await emitAndDrain(firmA.id)
    const [run] = await eventRuns(firmA.id)
    expect(run.scheduleId).toBe(schedule.id)
    expect(run.autonomyLevel).toBe('OBSERVE')
    expect(run.maxAttempts).toBe(1)
    expect(run.timeoutMs).toBe(5_000)

    const seen = captureHandler()
    await dispatchAgentRun(run.id)
    expect(seen[0].autonomyLevel).toBe('OBSERVE')
  })

  it("stops before calling the AI provider once the firm's agent budget is used up", async () => {
    const [schedule] = await enableAgentForFirm(firmA.id, DIAG, { tokenBudget: 1_000 })
    await prisma.agentSchedule.update({ where: { id: schedule.id }, data: { tokensUsedThisPeriod: 900 } })

    await emitAndDrain(firmA.id)
    const [run] = await eventRuns(firmA.id)

    captureHandler(async (ctx) => {
      await ctx.budget.generate(
        { systemPrompt: 'opt-in test', userPrompt: 'opt-in test', maxTokens: 16 },
        { task: 'AI_ASSISTANT', estimatedTokens: 500 },
      )
    })
    const outcome = await dispatchAgentRun(run.id)

    expect(outcome.skippedReason).toBe('BUDGET_EXHAUSTED')
    expect(generateWithRouterSpy).not.toHaveBeenCalled()
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.errorMessage).toMatch(/budget for this tenant/)
  })

  it("adds an event run's AI usage to the firm's agent budget", async () => {
    const [schedule] = await enableAgentForFirm(firmA.id, DIAG, { tokenBudget: 10_000 })
    generateWithRouterSpy.mockResolvedValue({ content: 'ok', inputTokens: 120, outputTokens: 30, estimatedCostUsd: 0.01 })

    await emitAndDrain(firmA.id)
    const [run] = await eventRuns(firmA.id)
    captureHandler(async (ctx) => {
      await ctx.budget.generate(
        { systemPrompt: 'opt-in test', userPrompt: 'opt-in test', maxTokens: 16 },
        { task: 'AI_ASSISTANT', estimatedTokens: 200 },
      )
    })
    await dispatchAgentRun(run.id)

    expect(generateWithRouterSpy).toHaveBeenCalledTimes(1)
    const after = await prisma.agentSchedule.findUniqueOrThrow({ where: { id: schedule.id } })
    expect(after.tokensUsedThisPeriod).toBe(150)
  })
})

describe('switching an agent off stops queued runs', () => {
  it('skips a queued event run when the firm switches the agent off before it starts', async () => {
    const [schedule] = await enableAgentForFirm(firmA.id, DIAG)
    await emitAndDrain(firmA.id)
    const [run] = await eventRuns(firmA.id)

    await prisma.agentSchedule.update({ where: { id: schedule.id }, data: { isEnabled: false } })
    const seen = captureHandler()
    const outcome = await dispatchAgentRun(run.id)

    expect(outcome).toMatchObject({ status: 'SKIPPED', skippedReason: 'DISABLED' })
    expect(seen).toHaveLength(0)
  })

  it('skips an event run queued before opt-in was enforced (no schedule link)', async () => {
    const { run } = await createRun({
      consultingFirmId: firmA.id,
      agentKey: DIAG,
      triggerType: 'EVENT',
      idempotencyKey: buildRunIdempotencyKey({ agentKey: DIAG, consultingFirmId: firmA.id, trigger: 'EVENT', discriminator: uniq('legacy') }),
    })
    const seen = captureHandler()
    const outcome = await dispatchAgentRun(run.id)
    expect(outcome.skippedReason).toBe('DISABLED')
    expect(seen).toHaveLength(0)
  })

  it('still runs a manual "Run now" for an agent the firm has not switched on', async () => {
    const { run } = await createRun({
      consultingFirmId: firmA.id,
      agentKey: DIAG,
      triggerType: 'MANUAL',
      idempotencyKey: buildRunIdempotencyKey({ agentKey: DIAG, consultingFirmId: firmA.id, trigger: 'MANUAL', discriminator: uniq('manual') }),
    })
    const seen = captureHandler()
    const outcome = await dispatchAgentRun(run.id)
    expect(outcome.status).toBe('COMPLETED')
    expect(seen).toHaveLength(1)
  })
})
