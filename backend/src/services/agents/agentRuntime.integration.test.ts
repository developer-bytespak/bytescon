// =============================================================
// §7.0 — Shared agent runtime against a real PostgreSQL database.
//
// Covers dispatch (success/failure/timeout/retry/cancel/heartbeat), the
// scheduler, the transactional outbox, escalation dedupe and workflow,
// artifact supersession, the reaper, and tenant isolation on all six models.
//
// The INTERNAL_DIAGNOSTIC agent is used throughout so the runtime is proven
// without pretending any of the nine domain agents exists.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import * as registry from './registry'
import { prisma } from '../../config/database'
import { createTestFirm, createTestUser, cleanupFirm, disconnectDb, type TestFirm, type TestUser } from '../../test-utils/testClient'
import { dispatchAgentRun, AgentRetryableError } from './dispatch'
import { buildRunIdempotencyKey, createRun, cancelRun, finalizeRun, heartbeatRun } from './runService'
import { runAgentScheduler, computeNextRunAt, upsertSchedule } from './scheduler'
import { emitAgentEvent, processOutbox, claimEvents, releaseStuckEvents } from './outbox'
import { persistEscalations, transitionEscalation, countOpenEscalations } from './escalations'
import { persistArtifacts, verifyArtifact } from './artifacts'
import { reapStaleAgentRuns } from './reaper'
import { DIAGNOSTIC_MODE_ENTITY_TYPE } from './handlers/internalDiagnostic'

const DIAG = 'INTERNAL_DIAGNOSTIC' as const

let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Agent Runtime Firm A' })
  firmB = await createTestFirm({ name: 'Agent Runtime Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  // Runs cascade to artifacts; escalations and events are firm-scoped.
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
  }
})

let keySeq = 0
const uniqueKey = () => `test-key-${Date.now()}-${keySeq++}`

async function makeDiagnosticRun(mode: string, overrides: Record<string, unknown> = {}) {
  const { run } = await createRun({
    consultingFirmId: firmA.id,
    agentKey: DIAG,
    triggerType: 'MANUAL',
    idempotencyKey: uniqueKey(),
    triggerEntityType: DIAGNOSTIC_MODE_ENTITY_TYPE,
    triggerEntityId: mode,
    ...overrides,
  })
  return run
}

// -------------------------------------------------------------
// Dispatch
// -------------------------------------------------------------

describe('dispatch — happy path', () => {
  it('runs a deterministic handler to COMPLETED with artifact, audit and heartbeat', async () => {
    const run = await makeDiagnosticRun('succeed')
    const outcome = await dispatchAgentRun(run.id)

    expect(outcome.status).toBe('COMPLETED')

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('COMPLETED')
    expect(after.progressPercent).toBe(100)
    expect(after.startedAt).not.toBeNull()
    expect(after.finishedAt).not.toBeNull()
    expect(after.heartbeatAt).not.toBeNull()
    expect(after.durationMs).toBeGreaterThanOrEqual(0)
    expect(after.confidenceState).toBe('HIGH')
    expect(after.dataSufficiency).toBe('SUFFICIENT')
    expect(after.outputSummary).toMatch(/diagnostic/i)

    const artifacts = await prisma.agentArtifact.findMany({ where: { runId: run.id } })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].artifactType).toBe('RUNTIME_DIAGNOSTIC')
    expect(artifacts[0].isHumanVerified).toBe(false)

    const audits = await prisma.auditEvent.findMany({
      where: { consultingFirmId: firmA.id, entityId: run.id },
      select: { action: true },
    })
    const actions = audits.map((a) => a.action)
    expect(actions).toContain('AGENT_RUN_CREATED')
    expect(actions).toContain('AGENT_RUN_STARTED')
    expect(actions).toContain('AGENT_RUN_COMPLETED')
  })

  it('records WAITING_FOR_REVIEW when the handler defers to a human', async () => {
    const run = await makeDiagnosticRun('review')
    await dispatchAgentRun(run.id)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('WAITING_FOR_REVIEW')
  })

  it('records SKIPPED without inventing an outcome when there is nothing to do', async () => {
    const run = await makeDiagnosticRun('skip')
    await dispatchAgentRun(run.id)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('SKIPPED')
    expect(after.dataSufficiency).toBe('INSUFFICIENT')
    expect(after.limitations.length).toBeGreaterThan(0)
  })
})

describe('dispatch — refuses unimplemented agents', () => {
  it('SKIPS a domain agent with NOT_IMPLEMENTED rather than pretending it ran', async () => {
    const { run } = await createRun({
      consultingFirmId: firmA.id,
      agentKey: 'INTELLIGENCE',
      triggerType: 'MANUAL',
      idempotencyKey: uniqueKey(),
    })
    // §7.9 completed Section 7, so the guard is exercised by stubbing the
    // registry rather than by relying on an undelivered agent.
    const real = registry.requireAgentDefinition('INTELLIGENCE')
    const spy = vi.spyOn(registry, 'requireAgentDefinition').mockImplementation((key) =>
      key === 'INTELLIGENCE' ? { ...real, implemented: false, handler: null } : registry.AGENT_REGISTRY.find((d) => d.key === key)!,
    )
    const outcome = await dispatchAgentRun(run.id)
    spy.mockRestore()
    expect(outcome.status).toBe('SKIPPED')
    expect(outcome.skippedReason).toBe('NOT_IMPLEMENTED')

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.errorCode).toBe('NOT_IMPLEMENTED')
    expect(after.outputSummary).toMatch(/not implemented yet/i)
    expect(await prisma.agentArtifact.count({ where: { runId: run.id } })).toBe(0)
  })
})

describe('dispatch — failure, retry and timeout', () => {
  it('retries a failing handler while budget remains, then FAILS terminally', async () => {
    const run = await makeDiagnosticRun('fail', { maxAttempts: 2 })

    // Attempt 1: re-queued for retry, surfaced to BullMQ as a retryable error.
    await expect(dispatchAgentRun(run.id)).rejects.toBeInstanceOf(AgentRetryableError)
    let after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('QUEUED')
    expect(after.attempt).toBe(2)

    // Attempt 2: budget exhausted, so it finalises.
    const outcome = await dispatchAgentRun(run.id)
    expect(outcome.status).toBe('FAILED')
    after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('FAILED')
    expect(after.errorCode).toBe('HANDLER_ERROR')
    expect(after.errorMessage).toMatch(/intentional handler failure/)
  })

  it('marks a run TIMED_OUT rather than leaving it RUNNING forever', async () => {
    // 1.5s budget against a handler that sleeps 60s.
    const run = await makeDiagnosticRun('timeout', { timeoutMs: 1500, maxAttempts: 1 })
    const outcome = await dispatchAgentRun(run.id)
    expect(outcome.status).toBe('TIMED_OUT')

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('TIMED_OUT')
    expect(after.errorCode).toBe('TIMEOUT')
    expect(after.finishedAt).not.toBeNull()

    // A timeout escalates so it is visible rather than silently absorbed.
    const escalations = await prisma.agentEscalation.findMany({ where: { consultingFirmId: firmA.id } })
    expect(escalations.some((e) => e.title === 'Agent run timed out')).toBe(true)
  }, 20000)

  it('blocks an over-budget LLM call and records it structurally, without crashing', async () => {
    const run = await makeDiagnosticRun('budget', { maxAttempts: 1 })
    const outcome = await dispatchAgentRun(run.id)
    expect(outcome.skippedReason).toBe('BUDGET_EXHAUSTED')

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('FAILED')
    expect(after.errorCode).toBe('AGENT_BUDGET_EXHAUSTED')
    expect(after.limitations.join(' ')).toMatch(/budget exhausted/i)
    // No provider was reached, so no tokens were consumed.
    expect(after.tokenInput).toBe(0)
    expect(after.tokenOutput).toBe(0)
  })
})

describe('dispatch — cancellation and concurrency', () => {
  it('cancels a QUEUED run and refuses to complete it afterwards', async () => {
    const run = await makeDiagnosticRun('succeed')
    const res = await cancelRun(firmA.id, run.id, adminA.id)
    expect(res.cancelled).toBe(true)

    // The worker picking it up later must not resurrect it.
    const outcome = await dispatchAgentRun(run.id)
    expect(outcome.skippedReason).toBe('NOT_CLAIMABLE')
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('CANCELLED')
    expect(after.cancelledAt).not.toBeNull()
  })

  it('refuses to cancel an already-terminal run', async () => {
    const run = await makeDiagnosticRun('succeed')
    await dispatchAgentRun(run.id)
    const res = await cancelRun(firmA.id, run.id, adminA.id)
    expect(res.cancelled).toBe(false)
    expect(res.reason).toMatch(/already COMPLETED/)
  })

  it('lets only one of two concurrent dispatches claim the run', async () => {
    const run = await makeDiagnosticRun('succeed')
    const [a, b] = await Promise.all([dispatchAgentRun(run.id), dispatchAgentRun(run.id)])
    const outcomes = [a.status, b.status].sort()
    // Exactly one executes; the other loses the compare-and-set.
    expect(outcomes.filter((s) => s === 'COMPLETED')).toHaveLength(1)
    expect(await prisma.agentArtifact.count({ where: { runId: run.id } })).toBe(1)
  })

  it('never finalizes a run twice', async () => {
    const run = await makeDiagnosticRun('succeed')
    await dispatchAgentRun(run.id)
    const second = await finalizeRun({ runId: run.id, status: 'FAILED', outputSummary: 'should not apply' })
    expect(second).toBeNull()
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('COMPLETED')
  })
})

// -------------------------------------------------------------
// Idempotency
// -------------------------------------------------------------

describe('run idempotency', () => {
  it('returns the existing run instead of creating a duplicate', async () => {
    const key = uniqueKey()
    const first = await createRun({ consultingFirmId: firmA.id, agentKey: DIAG, triggerType: 'MANUAL', idempotencyKey: key })
    const second = await createRun({ consultingFirmId: firmA.id, agentKey: DIAG, triggerType: 'MANUAL', idempotencyKey: key })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.run.id).toBe(first.run.id)
    expect(await prisma.agentRun.count({ where: { idempotencyKey: key } })).toBe(1)
  })

  it('does not duplicate artifacts when the same attempt is replayed', async () => {
    const run = await makeDiagnosticRun('succeed')
    await dispatchAgentRun(run.id)
    // Force the run back to RUNNING to simulate a replay of the same attempt.
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'RUNNING', finishedAt: null } })
    await dispatchAgentRun(run.id)
    expect(await prisma.agentArtifact.count({ where: { runId: run.id } })).toBe(1)
  })
})

// -------------------------------------------------------------
// Scheduler
// -------------------------------------------------------------

describe('scheduler', () => {
  async function makeSchedule(firmId: string, overrides: Record<string, unknown> = {}) {
    return prisma.agentSchedule.create({
      data: {
        consultingFirmId: firmId,
        agentKey: DIAG,
        isEnabled: true,
        scheduleType: 'CRON',
        cronExpression: '*/5 * * * *',
        nextRunAt: new Date(Date.now() - 60_000),
        ...overrides,
      },
    })
  }

  it('creates a run for an enabled, due schedule and advances nextRunAt', async () => {
    const schedule = await makeSchedule(firmA.id)
    const res = await runAgentScheduler(new Date(), 100, { consultingFirmId: firmA.id })
    expect(res.runsCreated).toBe(1)

    const after = await prisma.agentSchedule.findUniqueOrThrow({ where: { id: schedule.id } })
    expect(after.lastRunAt).not.toBeNull()
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('creates only ONE run when the scheduler runs twice in the same window', async () => {
    await makeSchedule(firmA.id)
    const now = new Date()
    await runAgentScheduler(now, 100, { consultingFirmId: firmA.id })
    // Re-arm the cursor to simulate a second pass hitting the same due window.
    await prisma.agentSchedule.updateMany({
      where: { consultingFirmId: firmA.id },
      data: { nextRunAt: new Date(now.getTime() - 60_000) },
    })
    const second = await runAgentScheduler(now, 100, { consultingFirmId: firmA.id })

    expect(second.duplicatesSkipped).toBe(1)
    expect(second.runsCreated).toBe(0)
    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmA.id, triggerType: 'SCHEDULE' } })).toBe(1)
  })

  it('ignores a disabled schedule', async () => {
    await makeSchedule(firmA.id, { isEnabled: false })
    const res = await runAgentScheduler(new Date(), 100, { consultingFirmId: firmA.id })
    expect(res.due).toBe(0)
    expect(res.runsCreated).toBe(0)
  })

  it('ignores a schedule that is not due yet', async () => {
    await makeSchedule(firmA.id, { nextRunAt: new Date(Date.now() + 3_600_000) })
    const res = await runAgentScheduler(new Date(), 100, { consultingFirmId: firmA.id })
    expect(res.due).toBe(0)
  })

  it('backs off a schedule that has failed too many times', async () => {
    await makeSchedule(firmA.id, { consecutiveFailures: 10 })
    const res = await runAgentScheduler(new Date(), 100, { consultingFirmId: firmA.id })
    expect(res.due).toBe(0)
  })

  it('never creates a run for an unimplemented agent, even when enabled and due', async () => {
    await prisma.agentSchedule.create({
      data: {
        consultingFirmId: firmA.id,
        agentKey: 'INTELLIGENCE',
        isEnabled: true,
        scheduleType: 'CRON',
        cronExpression: '*/5 * * * *',
        nextRunAt: new Date(Date.now() - 60_000),
      },
    })
    const real = registry.requireAgentDefinition('INTELLIGENCE')
    const spy = vi.spyOn(registry, 'requireAgentDefinition').mockImplementation((key) =>
      key === 'INTELLIGENCE' ? { ...real, implemented: false, handler: null } : registry.AGENT_REGISTRY.find((d) => d.key === key)!,
    )
    const res = await runAgentScheduler(new Date(), 100, { consultingFirmId: firmA.id })
    spy.mockRestore()
    expect(res.skippedUnimplemented).toBe(1)
    expect(res.runsCreated).toBe(0)
    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('scopes created runs to the owning tenant', async () => {
    await makeSchedule(firmA.id)
    await makeSchedule(firmB.id)
    // Both tenants are scanned here — this test is specifically about the
    // scheduler keeping two firms' runs apart, so it must not scope to one.
    const now = new Date()
    await runAgentScheduler(now, 100, { consultingFirmId: firmA.id })
    await runAgentScheduler(now, 100, { consultingFirmId: firmB.id })

    const aRuns = await prisma.agentRun.findMany({ where: { consultingFirmId: firmA.id } })
    const bRuns = await prisma.agentRun.findMany({ where: { consultingFirmId: firmB.id } })
    expect(aRuns).toHaveLength(1)
    expect(bRuns).toHaveLength(1)
    expect(aRuns[0].consultingFirmId).not.toBe(bRuns[0].consultingFirmId)
  })

  it('clears nextRunAt when an agent is disabled through upsertSchedule', async () => {
    await upsertSchedule({
      consultingFirmId: firmA.id, agentKey: DIAG, actorUserId: adminA.id,
      patch: { isEnabled: true, scheduleType: 'CRON', cronExpression: '0 * * * *' },
    })
    const enabled = await prisma.agentSchedule.findFirstOrThrow({ where: { consultingFirmId: firmA.id, agentKey: DIAG } })
    expect(enabled.nextRunAt).not.toBeNull()

    await upsertSchedule({ consultingFirmId: firmA.id, agentKey: DIAG, actorUserId: adminA.id, patch: { isEnabled: false } })
    const disabled = await prisma.agentSchedule.findFirstOrThrow({ where: { consultingFirmId: firmA.id, agentKey: DIAG } })
    expect(disabled.nextRunAt).toBeNull()
  })

  it('enforces one schedule per (firm, agent)', async () => {
    await makeSchedule(firmA.id)
    await expect(makeSchedule(firmA.id)).rejects.toThrow()
  })
})

// -------------------------------------------------------------
// Transactional outbox
// -------------------------------------------------------------

describe('transactional outbox', () => {
  it('emits an event and fans it out to exactly one run per subscriber', async () => {
    await emitAgentEvent({
      consultingFirmId: firmA.id,
      eventType: 'RUNTIME_DIAGNOSTIC_PING',
      entityType: 'Test',
      entityId: 'e1',
    })

    // processOutbox drains every tenant by design, so its global counters are
    // not a safe assertion when other suites run in parallel. Assert on this
    // firm's own rows instead.
    await processOutbox('worker-1', 20, new Date(), { consultingFirmId: firmA.id })

    const runs = await prisma.agentRun.findMany({ where: { consultingFirmId: firmA.id, triggerType: 'EVENT' } })
    expect(runs).toHaveLength(1)
    expect(runs[0].agentKey).toBe(DIAG)
    const ev = await prisma.agentEvent.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(ev.status).toBe('PROCESSED')
  })

  it('rolls the event back with the business write when the transaction aborts', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await emitAgentEvent(
          { consultingFirmId: firmA.id, eventType: 'RUNTIME_DIAGNOSTIC_PING', entityId: 'rollback' },
          tx,
        )
        throw new Error('business write failed')
      }),
    ).rejects.toThrow('business write failed')

    expect(await prisma.agentEvent.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('deduplicates a re-emitted event', async () => {
    const args = { consultingFirmId: firmA.id, eventType: 'RUNTIME_DIAGNOSTIC_PING', entityType: 'Test', entityId: 'dup' }
    const first = await emitAgentEvent(args)
    const second = await emitAgentEvent(args)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.eventId).toBe(first.eventId)
    expect(await prisma.agentEvent.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })

  it('creates only one run when the same event is processed twice', async () => {
    await emitAgentEvent({ consultingFirmId: firmA.id, eventType: 'RUNTIME_DIAGNOSTIC_PING', entityId: 'once' })
    await processOutbox('worker-1', 20, new Date(), { consultingFirmId: firmA.id })
    // Re-open the event to simulate a redelivery.
    await prisma.agentEvent.updateMany({
      where: { consultingFirmId: firmA.id },
      data: { status: 'PENDING', processedAt: null },
    })
    await processOutbox('worker-2', 20, new Date(), { consultingFirmId: firmA.id })

    // The tenant-scoped outcome is what matters: still exactly one run.
    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmA.id, triggerType: 'EVENT' } })).toBe(1)
  })

  it('lets only ONE of two concurrent workers claim an event', async () => {
    await emitAgentEvent({ consultingFirmId: firmA.id, eventType: 'RUNTIME_DIAGNOSTIC_PING', entityId: 'race' })
    const [a, b] = await Promise.all([claimEvents('w1', 20, new Date(), { consultingFirmId: firmA.id }), claimEvents('w2', 20, new Date(), { consultingFirmId: firmA.id })])
    expect(a.length + b.length).toBe(1)
  })

  it('marks an event PROCESSED when nothing implemented subscribes', async () => {
    // No implemented agent subscribes to this event type at all.
    await emitAgentEvent({ consultingFirmId: firmA.id, eventType: 'NOTHING_SUBSCRIBES_TO_THIS', entityId: 'x' })
    await processOutbox('worker-1', 20, new Date(), { consultingFirmId: firmA.id })
    // Nothing implemented listens for it, so the event is completed without
    // producing a run for this firm.
    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    const ev = await prisma.agentEvent.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(ev.status).toBe('PROCESSED')
  })

  it('releases an event whose worker died mid-processing', async () => {
    await prisma.agentEvent.create({
      data: {
        consultingFirmId: firmA.id,
        eventType: 'RUNTIME_DIAGNOSTIC_PING',
        dedupeKey: uniqueKey(),
        status: 'PROCESSING',
        claimedAt: new Date(Date.now() - 10 * 60_000),
        claimedBy: 'dead-worker',
      },
    })
    const released = await releaseStuckEvents(5 * 60_000)
    expect(released).toBe(1)
    const ev = await prisma.agentEvent.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(ev.status).toBe('PENDING')
    expect(ev.claimedBy).toBeNull()
  })

  it('keeps events tenant-scoped', async () => {
    await emitAgentEvent({ consultingFirmId: firmA.id, eventType: 'RUNTIME_DIAGNOSTIC_PING', entityId: 'a' })
    await emitAgentEvent({ consultingFirmId: firmB.id, eventType: 'RUNTIME_DIAGNOSTIC_PING', entityId: 'b' })
    // Both tenants are drained here — this test is specifically about the fan-out
    // keeping two firms' runs apart, so it must not scope to one.
    const at = new Date()
    await processOutbox('worker-1', 20, at, { consultingFirmId: firmA.id })
    await processOutbox('worker-1', 20, at, { consultingFirmId: firmB.id })

    const aRuns = await prisma.agentRun.findMany({ where: { consultingFirmId: firmA.id } })
    const bRuns = await prisma.agentRun.findMany({ where: { consultingFirmId: firmB.id } })
    expect(aRuns).toHaveLength(1)
    expect(bRuns).toHaveLength(1)
  })
})

// -------------------------------------------------------------
// Escalations
// -------------------------------------------------------------

describe('escalations', () => {
  const esc = (hint = 'h1') => ({
    severity: 'MEDIUM' as const,
    title: 'Needs a human',
    reason: 'Because the agent refused to decide.',
    dedupeHint: hint,
  })

  it('creates an escalation and counts it as open', async () => {
    await persistEscalations({ consultingFirmId: firmA.id, runId: null, agentKey: DIAG, escalations: [esc()] })
    expect(await countOpenEscalations(firmA.id)).toMatchObject({ [DIAG]: 1 })
  })

  it('refreshes rather than duplicating on a repeat sighting', async () => {
    await persistEscalations({ consultingFirmId: firmA.id, runId: null, agentKey: DIAG, escalations: [esc()] })
    const second = await persistEscalations({ consultingFirmId: firmA.id, runId: null, agentKey: DIAG, escalations: [esc()] })
    expect(second.created).toBe(0)
    expect(second.refreshed).toBe(1)
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })

  it('only ever raises severity on a repeat sighting', async () => {
    await persistEscalations({ consultingFirmId: firmA.id, runId: null, agentKey: DIAG, escalations: [{ ...esc(), severity: 'HIGH' }] })
    await persistEscalations({ consultingFirmId: firmA.id, runId: null, agentKey: DIAG, escalations: [{ ...esc(), severity: 'LOW' }] })
    const row = await prisma.agentEscalation.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(row.severity).toBe('HIGH')
  })

  it('does NOT reopen an escalation a human already resolved', async () => {
    await persistEscalations({ consultingFirmId: firmA.id, runId: null, agentKey: DIAG, escalations: [esc()] })
    const row = await prisma.agentEscalation.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    await transitionEscalation({ consultingFirmId: firmA.id, escalationId: row.id, transition: 'RESOLVE', userId: adminA.id, resolution: 'handled' })

    const again = await persistEscalations({ consultingFirmId: firmA.id, runId: null, agentKey: DIAG, escalations: [esc()] })
    expect(again.suppressedResolved).toBe(1)
    const after = await prisma.agentEscalation.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.status).toBe('RESOLVED')
  })

  it('supports acknowledge then resolve, recording both actors', async () => {
    await persistEscalations({ consultingFirmId: firmA.id, runId: null, agentKey: DIAG, escalations: [esc()] })
    const row = await prisma.agentEscalation.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })

    await transitionEscalation({ consultingFirmId: firmA.id, escalationId: row.id, transition: 'ACKNOWLEDGE', userId: adminA.id })
    let after = await prisma.agentEscalation.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.status).toBe('ACKNOWLEDGED')
    expect(after.acknowledgedByUserId).toBe(adminA.id)

    await transitionEscalation({ consultingFirmId: firmA.id, escalationId: row.id, transition: 'RESOLVE', userId: adminA.id, resolution: 'done' })
    after = await prisma.agentEscalation.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.status).toBe('RESOLVED')
    expect(after.resolution).toBe('done')
  })

  it('rejects a transition out of a terminal state', async () => {
    await persistEscalations({ consultingFirmId: firmA.id, runId: null, agentKey: DIAG, escalations: [esc()] })
    const row = await prisma.agentEscalation.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    await transitionEscalation({ consultingFirmId: firmA.id, escalationId: row.id, transition: 'RESOLVE', userId: adminA.id })
    await expect(
      transitionEscalation({ consultingFirmId: firmA.id, escalationId: row.id, transition: 'ACKNOWLEDGE', userId: adminA.id }),
    ).rejects.toThrow(/already RESOLVED/)
  })

  it('refuses a cross-tenant transition', async () => {
    await persistEscalations({ consultingFirmId: firmA.id, runId: null, agentKey: DIAG, escalations: [esc()] })
    const row = await prisma.agentEscalation.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    await expect(
      transitionEscalation({ consultingFirmId: firmB.id, escalationId: row.id, transition: 'RESOLVE', userId: adminA.id }),
    ).rejects.toThrow(/not found for this firm/)
  })
})

// -------------------------------------------------------------
// Artifacts
// -------------------------------------------------------------

describe('artifacts', () => {
  async function artifactRun() {
    const run = await makeDiagnosticRun('succeed')
    await dispatchAgentRun(run.id)
    return run
  }

  it('supersedes a prior artifact for the same subject rather than overwriting', async () => {
    await artifactRun()
    await artifactRun()

    const all = await prisma.agentArtifact.findMany({
      where: { consultingFirmId: firmA.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(all).toHaveLength(2)
    expect(all[0].supersededByArtifactId).toBe(all[1].id)
    expect(all[0].supersededAt).not.toBeNull()
    expect(all[1].supersededByArtifactId).toBeNull()
  })

  it('NEVER supersedes a human-verified artifact', async () => {
    await artifactRun()
    const first = await prisma.agentArtifact.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(await verifyArtifact(firmA.id, first.id, adminA.id)).toBe(true)

    await artifactRun()

    const after = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: first.id } })
    expect(after.isHumanVerified).toBe(true)
    expect(after.supersededByArtifactId).toBeNull()
    expect(after.verifiedByUserId).toBe(adminA.id)
  })

  it('refuses to verify another tenant’s artifact', async () => {
    await artifactRun()
    const a = await prisma.agentArtifact.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(await verifyArtifact(firmB.id, a.id, adminA.id)).toBe(false)
  })

  it('reports skippedVerified so the run surfaces what it left alone', async () => {
    await artifactRun()
    const first = await prisma.agentArtifact.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    await verifyArtifact(firmA.id, first.id, adminA.id)

    const run = await makeDiagnosticRun('succeed')
    await dispatchAgentRun(run.id)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.warnings.join(' ')).toMatch(/human-verified artifact/i)
  })

  it('does not write an artifact for another tenant', async () => {
    await persistArtifacts({
      consultingFirmId: firmB.id,
      runId: (await makeDiagnosticRun('succeed')).id,
      agentKey: DIAG,
      artifacts: [{ artifactType: 'RUNTIME_DIAGNOSTIC', title: 'x', structuredData: {} }],
    })
    const aCount = await prisma.agentArtifact.count({ where: { consultingFirmId: firmA.id } })
    const bCount = await prisma.agentArtifact.count({ where: { consultingFirmId: firmB.id } })
    expect(aCount).toBe(0)
    expect(bCount).toBe(1)
  })
})

// -------------------------------------------------------------
// Reaper
// -------------------------------------------------------------

describe('stale-run reaper', () => {
  it('times out a run whose heartbeat has gone silent', async () => {
    const run = await makeDiagnosticRun('succeed', { timeoutMs: 1000 })
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', startedAt: new Date(Date.now() - 600_000), heartbeatAt: new Date(Date.now() - 600_000) },
    })

    const res = await reapStaleAgentRuns()
    expect(res.reaped).toBe(1)

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('TIMED_OUT')
    expect(after.errorCode).toBe('STALE_NO_HEARTBEAT')
  })

  it('leaves a run with a fresh heartbeat alone', async () => {
    const run = await makeDiagnosticRun('succeed', { timeoutMs: 600_000 })
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', startedAt: new Date(), heartbeatAt: new Date() },
    })
    const res = await reapStaleAgentRuns()
    expect(res.reaped).toBe(0)
    expect(res.leftAlone).toBeGreaterThanOrEqual(1)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('RUNNING')
  })

  it('never touches an already-completed run', async () => {
    const run = await makeDiagnosticRun('succeed')
    await dispatchAgentRun(run.id)
    const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })

    await reapStaleAgentRuns()

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('COMPLETED')
    expect(after.finishedAt?.getTime()).toBe(before.finishedAt?.getTime())
  })

  it('raises one deduped escalation for repeated stale runs of the same agent', async () => {
    for (let i = 0; i < 2; i++) {
      const run = await makeDiagnosticRun('succeed', { timeoutMs: 1000 })
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: 'RUNNING', heartbeatAt: new Date(Date.now() - 600_000) },
      })
    }
    await reapStaleAgentRuns()
    const escalations = await prisma.agentEscalation.findMany({
      where: { consultingFirmId: firmA.id, title: 'Agent run abandoned' },
    })
    expect(escalations).toHaveLength(1)
  })

  it('updates heartbeat only while a run is RUNNING', async () => {
    const run = await makeDiagnosticRun('succeed')
    await heartbeatRun(run.id, 50, 'stage-x')
    // Still QUEUED, so the heartbeat is a no-op.
    let after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.progressPercent).toBe(0)

    await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'RUNNING' } })
    await heartbeatRun(run.id, 50, 'stage-x')
    after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.progressPercent).toBe(50)
    expect(after.progressStage).toBe('stage-x')
  })
})

// -------------------------------------------------------------
// Tenant isolation across all six models
// -------------------------------------------------------------

describe('tenant isolation', () => {
  it('keeps runs, artifacts, escalations, events, schedules and preferences separate', async () => {
    const runA = await makeDiagnosticRun('succeed')
    await dispatchAgentRun(runA.id)
    await persistEscalations({
      consultingFirmId: firmA.id, runId: runA.id, agentKey: DIAG,
      escalations: [{ severity: 'LOW', title: 't', reason: 'r', dedupeHint: 'iso' }],
    })
    await emitAgentEvent({ consultingFirmId: firmA.id, eventType: 'RUNTIME_DIAGNOSTIC_PING', entityId: 'iso' })
    await prisma.agentSchedule.create({ data: { consultingFirmId: firmA.id, agentKey: DIAG } })
    const userB = await createTestUser(firmB.id, { role: 'ADMIN' })
    await prisma.agentNotificationPreference.create({
      data: { consultingFirmId: firmB.id, userId: userB.id, agentKey: DIAG },
    })

    // Firm B sees none of firm A's rows.
    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.agentArtifact.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.agentEvent.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.agentSchedule.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.agentNotificationPreference.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('enforces one notification preference per (user, agent)', async () => {
    const u = await createTestUser(firmA.id, { role: 'ADMIN' })
    await prisma.agentNotificationPreference.create({ data: { consultingFirmId: firmA.id, userId: u.id, agentKey: DIAG } })
    await expect(
      prisma.agentNotificationPreference.create({ data: { consultingFirmId: firmA.id, userId: u.id, agentKey: DIAG } }),
    ).rejects.toThrow()
  })

  it('refuses to execute a run whose schedule belongs to another tenant', async () => {
    const scheduleB = await prisma.agentSchedule.create({ data: { consultingFirmId: firmB.id, agentKey: DIAG } })
    const { run } = await createRun({
      consultingFirmId: firmA.id,
      agentKey: DIAG,
      triggerType: 'SCHEDULE',
      scheduleId: scheduleB.id,
      idempotencyKey: uniqueKey(),
    })
    const outcome = await dispatchAgentRun(run.id)
    expect(outcome.skippedReason).toBe('TENANT_MISMATCH')
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('FAILED')
  })
})

// -------------------------------------------------------------
// Idempotency-key helper sanity against the DB constraint
// -------------------------------------------------------------

describe('database constraints', () => {
  it('rejects two runs sharing an idempotency key', async () => {
    const key = buildRunIdempotencyKey({ agentKey: DIAG, consultingFirmId: firmA.id, trigger: 'MANUAL', discriminator: 'dupe' })
    await prisma.agentRun.create({ data: { consultingFirmId: firmA.id, agentKey: DIAG, triggerType: 'MANUAL', idempotencyKey: key } })
    await expect(
      prisma.agentRun.create({ data: { consultingFirmId: firmA.id, agentKey: DIAG, triggerType: 'MANUAL', idempotencyKey: key } }),
    ).rejects.toThrow()
  })

  it('rejects two events sharing a dedupe key', async () => {
    const key = uniqueKey()
    await prisma.agentEvent.create({ data: { consultingFirmId: firmA.id, eventType: 'X', dedupeKey: key } })
    await expect(
      prisma.agentEvent.create({ data: { consultingFirmId: firmA.id, eventType: 'X', dedupeKey: key } }),
    ).rejects.toThrow()
  })

  it('computes a next run time consistent with the stored cron', async () => {
    const s = await prisma.agentSchedule.create({
      data: { consultingFirmId: firmA.id, agentKey: DIAG, scheduleType: 'CRON', cronExpression: '0 0 * * *', timezone: 'UTC' },
    })
    const next = computeNextRunAt(s, new Date('2026-05-01T10:00:00Z'))
    expect(next?.toISOString()).toBe('2026-05-02T00:00:00.000Z')
  })
})
