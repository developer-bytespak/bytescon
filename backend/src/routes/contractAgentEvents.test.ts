// =============================================================
// §7.1 — Contract domain events through the real HTTP write paths.
//
// The properties that matter for a transactional outbox: a successful business
// write emits exactly one event, a rolled-back write emits none, a retried
// request never duplicates, and an event can never cross a tenant boundary.
//
// Also covers the contract-health read API and its authorization.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb,
  type TestFirm, type TestUser,
} from '../test-utils/testClient'
import { processOutbox } from '../services/agents/outbox'
import { emitContractAwarded } from '../services/agents/contract/contractEvents'

let app: Express
let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let consultantA: TestUser
let adminB: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const CM = '/api/contract-management'
const CF = '/api/contract-finance'
const CH = '/api/contract-health'

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'Contract Event Firm A' })
  firmB = await createTestFirm({ name: 'Contract Event Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  consultantA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contract.deleteMany({ where: { consultingFirmId: id } })
  }
})

async function makeContract(token: string, over: Record<string, unknown> = {}) {
  const res = await request(app).post(`${CM}/`).set(H(token)).send({
    contractNumber: uniq('S7-CA'),
    title: 'Event fixture',
    status: 'DRAFT',
    ...over,
  }).expect(201)
  return res.body.data
}

const eventsOf = (firmId: string, type: string) =>
  prisma.agentEvent.findMany({ where: { consultingFirmId: firmId, eventType: type } })

// -------------------------------------------------------------
// CONTRACT_AWARDED
// -------------------------------------------------------------

describe('CONTRACT_AWARDED', () => {
  it('emits nothing for a DRAFT contract', async () => {
    await makeContract(adminA.token, { status: 'DRAFT' })
    expect(await eventsOf(firmA.id, 'CONTRACT_AWARDED')).toHaveLength(0)
  })

  it('emits exactly one event when a contract is created ACTIVE', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    const events = await eventsOf(firmA.id, 'CONTRACT_AWARDED')
    expect(events).toHaveLength(1)
    expect(events[0].entityType).toBe('Contract')
    expect(events[0].entityId).toBe(c.id)
  })

  it('emits on the DRAFT → ACTIVE transition, and only once', async () => {
    const c = await makeContract(adminA.token, { status: 'DRAFT' })
    await request(app).put(`${CM}/${c.id}`).set(H(adminA.token)).send({ status: 'ACTIVE' }).expect(200)
    expect(await eventsOf(firmA.id, 'CONTRACT_AWARDED')).toHaveLength(1)

    // Re-saving ACTIVE, or cycling away and back, must not re-fire.
    await request(app).put(`${CM}/${c.id}`).set(H(adminA.token)).send({ status: 'ACTIVE' }).expect(200)
    await request(app).put(`${CM}/${c.id}`).set(H(adminA.token)).send({ status: 'ON_HOLD' }).expect(200)
    await request(app).put(`${CM}/${c.id}`).set(H(adminA.token)).send({ status: 'ACTIVE' }).expect(200)
    expect(await eventsOf(firmA.id, 'CONTRACT_AWARDED')).toHaveLength(1)
  })

  it('emits ZERO events when the surrounding transaction rolls back', async () => {
    const c = await makeContract(adminA.token, { status: 'DRAFT' })
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.contract.update({ where: { id: c.id }, data: { status: 'ACTIVE' } })
        await emitContractAwarded(tx, { consultingFirmId: firmA.id, contractId: c.id, contractNumber: c.contractNumber })
        throw new Error('business write failed')
      }),
    ).rejects.toThrow('business write failed')

    expect(await eventsOf(firmA.id, 'CONTRACT_AWARDED')).toHaveLength(0)
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.status).toBe('DRAFT')
  })
})

// -------------------------------------------------------------
// CONTRACT_MODIFICATION_ADDED
// -------------------------------------------------------------

describe('CONTRACT_MODIFICATION_ADDED', () => {
  it('emits one event when a modification is recorded', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    await request(app).post(`${CM}/${c.id}/modifications`).set(H(adminA.token))
      .send({ modNumber: 'P00001', fundingChange: 1000 }).expect(201)

    const events = await eventsOf(firmA.id, 'CONTRACT_MODIFICATION_ADDED')
    expect(events).toHaveLength(1)
    expect((events[0].payload as Record<string, unknown>).stage).toBe('CREATED')
  })

  it('does not duplicate when the same modNumber is submitted twice', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    await request(app).post(`${CM}/${c.id}/modifications`).set(H(adminA.token)).send({ modNumber: 'P00001' }).expect(201)
    // Duplicate modNumber is rejected by the existing business rule.
    await request(app).post(`${CM}/${c.id}/modifications`).set(H(adminA.token)).send({ modNumber: 'P00001' }).expect(409)
    expect(await eventsOf(firmA.id, 'CONTRACT_MODIFICATION_ADDED')).toHaveLength(1)
  })

  it('emits a second, distinct event when the modification is applied', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE', fundedValue: 1000 })
    const mod = await request(app).post(`${CM}/${c.id}/modifications`).set(H(adminA.token))
      .send({ modNumber: 'P00002', fundingChange: 500 }).expect(201)

    await request(app).post(`${CM}/modifications/${mod.body.data.id}/apply`).set(H(adminA.token)).expect(200)

    const events = await eventsOf(firmA.id, 'CONTRACT_MODIFICATION_ADDED')
    expect(events).toHaveLength(2)
    expect(events.map((e) => (e.payload as Record<string, unknown>).stage).sort()).toEqual(['APPLIED', 'CREATED'])
  })

  it('emits no APPLIED event when the apply is rejected as a double-apply', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE', fundedValue: 1000 })
    const mod = await request(app).post(`${CM}/${c.id}/modifications`).set(H(adminA.token))
      .send({ modNumber: 'P00003', fundingChange: 500 }).expect(201)
    await request(app).post(`${CM}/modifications/${mod.body.data.id}/apply`).set(H(adminA.token)).expect(200)
    await request(app).post(`${CM}/modifications/${mod.body.data.id}/apply`).set(H(adminA.token)).expect(409)

    const applied = (await eventsOf(firmA.id, 'CONTRACT_MODIFICATION_ADDED'))
      .filter((e) => (e.payload as Record<string, unknown>).stage === 'APPLIED')
    expect(applied).toHaveLength(1)
  })
})

// -------------------------------------------------------------
// DELIVERABLE_STATUS_CHANGED
// -------------------------------------------------------------

describe('DELIVERABLE_STATUS_CHANGED', () => {
  async function makeDeliverable(contractId: string) {
    const res = await request(app).post(`${CM}/${contractId}/deliverables`).set(H(adminA.token))
      .send({ name: 'Report', dueDate: new Date(Date.now() + 86400000).toISOString() }).expect(201)
    return res.body.data
  }

  it('emits one event per genuine transition, carrying the contract as the entity', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    const d = await makeDeliverable(c.id)

    await request(app).post(`${CM}/deliverables/${d.id}/transition`).set(H(adminA.token))
      .send({ status: 'IN_PROGRESS' }).expect(200)

    const events = await eventsOf(firmA.id, 'DELIVERABLE_STATUS_CHANGED')
    expect(events).toHaveLength(1)
    // Targeted at the contract so the run does not rescan the tenant.
    expect(events[0].entityType).toBe('Contract')
    expect(events[0].entityId).toBe(c.id)
    expect((events[0].payload as Record<string, unknown>).deliverableId).toBe(d.id)
  })

  it('does not duplicate when the same transition is replayed', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    const d = await makeDeliverable(c.id)
    await request(app).post(`${CM}/deliverables/${d.id}/transition`).set(H(adminA.token)).send({ status: 'IN_PROGRESS' }).expect(200)
    // Same target status again — an idempotent no-op in the §5 state machine.
    await request(app).post(`${CM}/deliverables/${d.id}/transition`).set(H(adminA.token)).send({ status: 'IN_PROGRESS' }).expect(200)
    expect(await eventsOf(firmA.id, 'DELIVERABLE_STATUS_CHANGED')).toHaveLength(1)
  })

  it('emits from submit and accept, which are the authoritative paths', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    const d = await makeDeliverable(c.id)
    await request(app).post(`${CM}/deliverables/${d.id}/submit`).set(H(adminA.token)).send({}).expect(200)
    await request(app).post(`${CM}/deliverables/${d.id}/accept`).set(H(adminA.token)).send({}).expect(200)

    const stages = (await eventsOf(firmA.id, 'DELIVERABLE_STATUS_CHANGED'))
      .map((e) => (e.payload as Record<string, string>).toStatus).sort()
    expect(stages).toEqual(['ACCEPTED', 'SUBMITTED'])
  })

  it('emits nothing when the transition is rejected as invalid', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    const d = await makeDeliverable(c.id)
    await request(app).post(`${CM}/deliverables/${d.id}/accept`).set(H(adminA.token)).send({}).expect(409)
    expect(await eventsOf(firmA.id, 'DELIVERABLE_STATUS_CHANGED')).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// FUNDING_TRANSACTION_ADDED
// -------------------------------------------------------------

describe('FUNDING_TRANSACTION_ADDED', () => {
  it('emits one event per ledger write', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    await request(app).post(`${CF}/${c.id}/funding`).set(H(adminA.token))
      .send({ type: 'INITIAL_OBLIGATION', amount: 150000 }).expect(201)

    const events = await eventsOf(firmA.id, 'FUNDING_TRANSACTION_ADDED')
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe(c.id)
  })

  it('emits nothing when the ledger write is rejected for duplicate modification funding', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    const mod = await request(app).post(`${CM}/${c.id}/modifications`).set(H(adminA.token))
      .send({ modNumber: 'P00010' }).expect(201)

    await request(app).post(`${CF}/${c.id}/funding`).set(H(adminA.token))
      .send({ type: 'INCREMENTAL_FUNDING', amount: 1000, modificationId: mod.body.data.id }).expect(201)
    await request(app).post(`${CF}/${c.id}/funding`).set(H(adminA.token))
      .send({ type: 'INCREMENTAL_FUNDING', amount: 1000, modificationId: mod.body.data.id }).expect(409)

    // The rejected second write rolled back, so only one event exists.
    expect(await eventsOf(firmA.id, 'FUNDING_TRANSACTION_ADDED')).toHaveLength(1)
  })
})

// -------------------------------------------------------------
// Event → run, and tenant isolation of the whole chain
// -------------------------------------------------------------

describe('event fan-out to the agent', () => {
  it('creates exactly one targeted run per event', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    await processOutbox('test-worker', 20, new Date(), { consultingFirmId: firmA.id })

    const runs = await prisma.agentRun.findMany({
      where: { consultingFirmId: firmA.id, agentKey: 'CONTRACT_ADMINISTRATION' },
    })
    expect(runs).toHaveLength(1)
    expect(runs[0].triggerType).toBe('EVENT')
    expect(runs[0].triggerEntityId).toBe(c.id)
  })

  it('does not create a second run when the same event is reprocessed', async () => {
    await makeContract(adminA.token, { status: 'ACTIVE' })
    await processOutbox('test-worker', 20, new Date(), { consultingFirmId: firmA.id })
    await prisma.agentEvent.updateMany({ where: { consultingFirmId: firmA.id }, data: { status: 'PENDING', processedAt: null } })
    await processOutbox('test-worker-2', 20, new Date(), { consultingFirmId: firmA.id })

    // Two subscribers (§7.1 Contract Administration and §7.9 Intelligence), so
    // one event legitimately produces two runs. What must NOT happen is a
    // third appearing when the same event is processed again.
    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmA.id } })).toBe(2)
  })

  it('keeps one firm’s events entirely out of another firm’s runs', async () => {
    await makeContract(adminA.token, { status: 'ACTIVE' })
    await makeContract(adminB.token, { status: 'ACTIVE' })
    // Both tenants are drained here — this test is specifically about one firm's
    // events staying out of another firm's runs, so it must not scope to one.
    const at = new Date()
    await processOutbox('test-worker', 20, at, { consultingFirmId: firmA.id })
    await processOutbox('test-worker', 20, at, { consultingFirmId: firmB.id })

    const aRuns = await prisma.agentRun.findMany({ where: { consultingFirmId: firmA.id } })
    const bRuns = await prisma.agentRun.findMany({ where: { consultingFirmId: firmB.id } })
    expect(aRuns).toHaveLength(2)
    expect(bRuns).toHaveLength(2)
    expect(aRuns[0].triggerEntityId).not.toBe(bRuns[0].triggerEntityId)
  })
})

// -------------------------------------------------------------
// Contract health API
// -------------------------------------------------------------

describe('contract health API', () => {
  it('returns an honest portfolio before the agent has ever run', async () => {
    await makeContract(adminA.token, { status: 'ACTIVE' })
    const res = await request(app).get(`${CH}/portfolio`).set(H(adminA.token)).expect(200)

    expect(res.body.data.totals.monitoredContracts).toBe(1)
    expect(res.body.data.totals.assessedContracts).toBe(0)
    expect(res.body.data.contracts[0].health).toBeNull()
    expect(res.body.data.lastRun).toBeNull()
    // Thresholds are published so the UI never hard-codes them.
    expect(res.body.data.policy.fundingWarningPct).toBe(0.9)
  })

  it('returns an honest null health for an unassessed contract', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    const res = await request(app).get(`${CH}/${c.id}`).set(H(adminA.token)).expect(200)
    expect(res.body.data.health).toBeNull()
    expect(res.body.data.contract.id).toBe(c.id)
  })

  it('404s a cross-tenant contract health request', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    await request(app).get(`${CH}/${c.id}`).set(H(adminB.token)).expect(404)
  })

  it('never leaks another firm’s contracts into the portfolio', async () => {
    await makeContract(adminA.token, { status: 'ACTIVE' })
    const res = await request(app).get(`${CH}/portfolio`).set(H(adminB.token)).expect(200)
    expect(res.body.data.totals.monitoredContracts).toBe(0)
    expect(res.body.data.contracts).toHaveLength(0)
  })

  it('is readable by a CONSULTANT', async () => {
    await makeContract(adminA.token, { status: 'ACTIVE' })
    await request(app).get(`${CH}/portfolio`).set(H(consultantA.token)).expect(200)
  })

  it('rejects an unauthenticated caller', async () => {
    await request(app).get(`${CH}/portfolio`).expect(401)
  })
})

// -------------------------------------------------------------
// Agent registry surface
// -------------------------------------------------------------

describe('agent registry after §7.1', () => {
  it('reports every domain agent as implemented after §7.9', async () => {
    const res = await request(app).get('/api/agents/definitions').set(H(adminA.token)).expect(200)
    const byKey = Object.fromEntries(res.body.data.map((d: { key: string; implemented: boolean }) => [d.key, d.implemented]))

    expect(byKey.CONTRACT_ADMINISTRATION).toBe(true)
    // §7.2 delivered OPPORTUNITY, so it is no longer in the undelivered set.
    expect(byKey.OPPORTUNITY).toBe(true)
    // §7.3 delivered COMPLIANCE, so it is no longer in the undelivered set.
    expect(byKey.COMPLIANCE).toBe(true)
    // §7.4 delivered QUALIFICATION, so it is no longer in the undelivered set.
    expect(byKey.QUALIFICATION).toBe(true)
    // §7.5 delivered TEAMING, so it is no longer in the undelivered set.
    expect(byKey.TEAMING).toBe(true)
    // §7.6 delivered PRICING, so it is no longer in the undelivered set.
    expect(byKey.PRICING).toBe(true)
    expect(byKey.PROPOSAL).toBe(true)
    expect(byKey.FINANCE).toBe(true)
    // §7.9 completed Section 7 — every domain agent is now implemented.
    expect(byKey.INTELLIGENCE).toBe(true)
  })

  it('allows enabling a schedule for it now that a handler exists', async () => {
    const res = await request(app).put('/api/agents/schedules/CONTRACT_ADMINISTRATION').set(H(adminA.token))
      .send({ isEnabled: true, scheduleType: 'CRON', cronExpression: '0 7 * * *' }).expect(200)
    expect(res.body.data.isEnabled).toBe(true)
    expect(res.body.data.nextRunAt).not.toBeNull()
    expect(res.body.data.autonomyLevel).toBe('PROPOSE')
  })

  it('now enables Intelligence, because it has a real handler', async () => {
    // The refusal path itself is covered in routes/agents.test.ts, which stubs
    // the registry so the guard is tested without needing an undelivered agent.
    await request(app).put('/api/agents/schedules/INTELLIGENCE').set(H(adminA.token)).send({ isEnabled: true }).expect(200)
  })

  it('accepts a contract-targeted manual run through the generic runtime API', async () => {
    const c = await makeContract(adminA.token, { status: 'ACTIVE' })
    const res = await request(app).post('/api/agents/runs').set(H(adminA.token)).send({
      agentKey: 'CONTRACT_ADMINISTRATION',
      idempotencyToken: uniq('manual'),
      triggerEntityType: 'Contract',
      triggerEntityId: c.id,
    }).expect(201)
    expect(res.body.data.run.triggerEntityId).toBe(c.id)
  })

  it('blocks a CONSULTANT from triggering it', async () => {
    await request(app).post('/api/agents/runs').set(H(consultantA.token))
      .send({ agentKey: 'CONTRACT_ADMINISTRATION' }).expect(403)
  })
})
