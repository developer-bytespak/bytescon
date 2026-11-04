// =============================================================
// A schedule records how its runs ended.
//
// "Last successful run" and the failure count come from here. Ten final failures
// in a row pause the schedule until a person saves its settings, so a broken
// agent stops retrying forever.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '../../config/database'
import { createTestFirm, createTestUser, cleanupFirm, disconnectDb, type TestFirm } from '../../test-utils/testClient'
import { enableAgentForFirm } from '../../test-utils/factories'
import { AgentRetryableError, dispatchAgentRun } from './dispatch'
import { createRun } from './runService'
import { reapStaleAgentRuns } from './reaper'
import { upsertSchedule } from './scheduler'
import { agentQueue, enqueueAgentRun } from '../../workers/agentWorker'

const DIAG = 'INTERNAL_DIAGNOSTIC' as const
let firm: TestFirm
let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  firm = await createTestFirm({ name: 'Schedule Outcome Firm' })
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await agentQueue.close()
  await disconnectDb()
})

beforeEach(async () => {
  await prisma.agentRun.deleteMany({ where: { consultingFirmId: firm.id } })
  await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: firm.id } })
})

async function scheduledRun(mode: string, overrides: Record<string, unknown> = {}) {
  const schedule = await prisma.agentSchedule.findUniqueOrThrow({
    where: { consultingFirmId_agentKey: { consultingFirmId: firm.id, agentKey: DIAG } },
  })
  const { run } = await createRun({
    consultingFirmId: firm.id, agentKey: DIAG, triggerType: 'SCHEDULE', scheduleId: schedule.id,
    idempotencyKey: uniq('run'), triggerEntityType: 'DIAGNOSTIC_MODE', triggerEntityId: mode, ...overrides,
  })
  return run
}

const readSchedule = () =>
  prisma.agentSchedule.findUniqueOrThrow({ where: { consultingFirmId_agentKey: { consultingFirmId: firm.id, agentKey: DIAG } } })

describe('recording run outcomes', () => {
  beforeEach(async () => {
    await enableAgentForFirm(firm.id, DIAG)
  })

  it('sets the last successful run and clears the failure count', async () => {
    await prisma.agentSchedule.updateMany({ where: { consultingFirmId: firm.id }, data: { consecutiveFailures: 4 } })
    const run = await scheduledRun('succeed')
    expect((await dispatchAgentRun(run.id)).status).toBe('COMPLETED')

    const s = await readSchedule()
    expect(s.lastSuccessfulRunAt).toBeInstanceOf(Date)
    expect(s.consecutiveFailures).toBe(0)
  })

  it('counts a failed run once, at its final failure rather than each retry', async () => {
    const run = await scheduledRun('fail', { maxAttempts: 2 })

    await expect(dispatchAgentRun(run.id)).rejects.toBeInstanceOf(AgentRetryableError)
    expect((await readSchedule()).consecutiveFailures).toBe(0)

    expect((await dispatchAgentRun(run.id)).status).toBe('FAILED')
    const s = await readSchedule()
    expect(s.consecutiveFailures).toBe(1)
    expect(s.lastFailureAt).toBeInstanceOf(Date)
    expect(s.lastFailureMessage).toMatch(/intentional handler failure/)
  })

  it('counts a run that went silent and was ended by the stale-run check', async () => {
    const run = await scheduledRun('succeed')
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', startedAt: new Date(0), heartbeatAt: new Date(0), timeoutMs: 1000 },
    })
    await reapStaleAgentRuns()
    expect((await readSchedule()).consecutiveFailures).toBe(1)
  })

  it('gives a backed-off agent a fresh start when a person saves its settings', async () => {
    await prisma.agentSchedule.updateMany({ where: { consultingFirmId: firm.id }, data: { consecutiveFailures: 10 } })
    const admin = await createTestUser(firm.id)
    await upsertSchedule({ consultingFirmId: firm.id, agentKey: DIAG, actorUserId: admin.id, patch: { isEnabled: true } })
    expect((await readSchedule()).consecutiveFailures).toBe(0)
  })
})

describe('queueing a run', () => {
  it('gives the queue as many attempts as the run is allowed', async () => {
    const { run } = await createRun({
      consultingFirmId: firm.id, agentKey: DIAG, triggerType: 'MANUAL', idempotencyKey: uniq('run'), maxAttempts: 7,
    })
    await enqueueAgentRun(run.id, 60_000)
    const job = await agentQueue.getJob(`run:${run.id}`)
    expect(job?.opts.attempts).toBe(7)
    await job?.remove()
  })
})
