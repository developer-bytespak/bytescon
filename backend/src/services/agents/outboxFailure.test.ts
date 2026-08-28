// =============================================================
// §7.0 — Outbox retry and dead-letter behaviour.
//
// Isolated in its own file because it mocks run creation to force the failure
// branch. Contriving a real database error would mean tampering with foreign
// keys, which is both fragile and a worse description of the behaviour under
// test: what matters is that a failing fan-out retries with backoff and
// eventually dead-letters rather than spinning forever.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const createRunMock = vi.fn()

vi.mock('./runService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runService')>()
  return { ...actual, createRun: (...args: unknown[]) => createRunMock(...args) }
})

// vi.mock is hoisted above these imports, so ./outbox receives the mocked
// createRun even though this reads like an ordinary import block.
import { prisma } from '../../config/database'
import { createTestFirm, cleanupFirm, disconnectDb } from '../../test-utils/testClient'
import { emitAgentEvent, processOutbox } from './outbox'

let firmId: string

beforeAll(async () => {
  const firm = await createTestFirm({ name: 'Outbox Failure Firm' })
  firmId = firm.id
})

afterAll(async () => {
  await cleanupFirm(firmId)
  await disconnectDb()
})

beforeEach(async () => {
  createRunMock.mockReset()
  await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmId } })
})

describe('outbox failure handling', () => {
  it('returns a failing event to PENDING with a backoff delay while attempts remain', async () => {
    createRunMock.mockRejectedValue(new Error('transient downstream failure'))
    await emitAgentEvent({ consultingFirmId: firmId, eventType: 'RUNTIME_DIAGNOSTIC_PING', entityId: 'retry-1' })

    const res = await processOutbox('worker-1', 20, new Date(), { consultingFirmId: firmId })
    expect(res.retried).toBe(1)
    expect(res.deadLettered).toBe(0)

    const ev = await prisma.agentEvent.findFirstOrThrow({ where: { consultingFirmId: firmId } })
    expect(ev.status).toBe('PENDING')
    expect(ev.attempt).toBe(1)
    expect(ev.lastError).toMatch(/transient downstream failure/)
    // Backed off rather than immediately re-claimable.
    expect(ev.availableAt.getTime()).toBeGreaterThan(Date.now())
    expect(ev.claimedBy).toBeNull()
  })

  it('dead-letters an event once its attempt budget is exhausted', async () => {
    createRunMock.mockRejectedValue(new Error('permanent failure'))
    const { eventId } = await emitAgentEvent({
      consultingFirmId: firmId,
      eventType: 'RUNTIME_DIAGNOSTIC_PING',
      entityId: 'dead-1',
    })
    // One attempt short of the ceiling; this pass consumes the last one.
    await prisma.agentEvent.update({ where: { id: eventId! }, data: { attempt: 2, maxAttempts: 3 } })

    const res = await processOutbox('worker-1', 20, new Date(), { consultingFirmId: firmId })
    expect(res.deadLettered).toBe(1)
    expect(res.retried).toBe(0)

    const ev = await prisma.agentEvent.findUniqueOrThrow({ where: { id: eventId! } })
    expect(ev.status).toBe('DEAD_LETTER')
    expect(ev.lastError).toMatch(/permanent failure/)
  })

  it('does not mark an event PROCESSED when fan-out failed', async () => {
    createRunMock.mockRejectedValue(new Error('nope'))
    await emitAgentEvent({ consultingFirmId: firmId, eventType: 'RUNTIME_DIAGNOSTIC_PING', entityId: 'not-processed' })

    await processOutbox('worker-1', 20, new Date(), { consultingFirmId: firmId })

    const ev = await prisma.agentEvent.findFirstOrThrow({ where: { consultingFirmId: firmId } })
    expect(ev.status).not.toBe('PROCESSED')
    expect(ev.processedAt).toBeNull()
  })

  it('recovers on a later pass once the downstream failure clears', async () => {
    createRunMock.mockRejectedValueOnce(new Error('flaky'))
    await emitAgentEvent({ consultingFirmId: firmId, eventType: 'RUNTIME_DIAGNOSTIC_PING', entityId: 'recover' })

    await processOutbox('worker-1', 20, new Date(), { consultingFirmId: firmId })
    let ev = await prisma.agentEvent.findFirstOrThrow({ where: { consultingFirmId: firmId } })
    expect(ev.status).toBe('PENDING')

    // Clear the backoff and let the next pass succeed.
    createRunMock.mockResolvedValue({ run: { id: 'run-x' }, created: true })
    await prisma.agentEvent.update({ where: { id: ev.id }, data: { availableAt: new Date(Date.now() - 1000) } })

    const res = await processOutbox('worker-1', 20, new Date(), { consultingFirmId: firmId })
    expect(res.processed).toBe(1)
    ev = await prisma.agentEvent.findFirstOrThrow({ where: { consultingFirmId: firmId } })
    expect(ev.status).toBe('PROCESSED')
    expect(ev.processedAt).not.toBeNull()
  })
})
