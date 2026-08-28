// =============================================================
// §7.2 — Opportunity domain events through the real HTTP write paths, plus the
// Opportunity Agent API.
//
// The properties that matter for a transactional outbox, re-proved for the four
// new events because §7.1 found a real bug here: a successful business write
// emits exactly one event, a rolled-back write emits none, a benign duplicate
// never rolls the business write back, a retried request never duplicates, and
// an event can never cross a tenant boundary.
//
// Also covers the apply/revert authorization and tenant isolation.
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
import {
  FIRM_CAPABILITY_CHANGED,
  MONITORING_PROFILE_SAVED,
  PURSUIT_STAGE_CHANGED,
  SOURCE_SYNC_COMPLETED,
  emitFirmCapabilityChanged,
  emitMonitoringProfileSaved,
  emitPursuitStageChanged,
  emitSourceSyncCompleted,
} from '../services/agents/opportunity/opportunityEvents'
import { analysePursuitFeedback, applyPursuitFeedback } from '../services/agents/opportunity/pursuitFeedback'

let app: Express
let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let consultantA: TestUser
let adminB: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const DISCOVERY = '/api/discovery'
const PROFILES = '/api/monitoring-profiles'
const PURSUITS = '/api/pursuits'
const OA = '/api/agents/opportunity'

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'Opportunity Event Firm A' })
  firmB = await createTestFirm({ name: 'Opportunity Event Firm B' })
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
    await prisma.pursuitFeedbackSignal.deleteMany({ where: { consultingFirmId: id } })
    await prisma.bidPursuit.deleteMany({ where: { consultingFirmId: id } })
    await prisma.savedMonitoringProfile.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
    await prisma.firmCapability.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunitySourceConfig.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------

const eventsOf = (firmId: string, type: string) =>
  prisma.agentEvent.findMany({ where: { consultingFirmId: firmId, eventType: type } })

async function makeOpportunity(firmId: string, over: Partial<Prisma.OpportunityUncheckedCreateInput> = {}) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId: firmId,
      samNoticeId: uniq('S7-OA-QA'),
      title: 'Opportunity event fixture',
      agency: 'GSA',
      naicsCode: '541512',
      setAsideType: 'NONE',
      responseDeadline: new Date(Date.now() + 30 * 86_400_000),
      status: 'ACTIVE',
      isDemo: false,
      ...over,
    },
  })
}

const CAPABILITY_BODY = {
  name: 'Cloud migration',
  category: 'TECHNICAL',
  keywords: ['cloud', 'migration'],
  naicsCodes: ['541512'],
  pscCodes: ['D302'],
  geographies: ['Nationwide'],
  contractVehicles: [],
}

// -------------------------------------------------------------
// FIRM_CAPABILITY_CHANGED
// -------------------------------------------------------------

describe('FIRM_CAPABILITY_CHANGED', () => {
  it('emits exactly one event when a capability is created', async () => {
    const res = await request(app).post(`${DISCOVERY}/capabilities`).set(H(adminA.token)).send(CAPABILITY_BODY)
    expect(res.status).toBe(201)

    const events = await eventsOf(firmA.id, FIRM_CAPABILITY_CHANGED)
    expect(events).toHaveLength(1)
    expect(events[0].entityType).toBe('FirmCapability')
    expect(events[0].entityId).toBe(res.body.data.id)
    expect((events[0].payload as { changeType: string }).changeType).toBe('CREATED')
  })

  it('emits a fresh event when the matching-relevant fields materially change', async () => {
    const created = await request(app).post(`${DISCOVERY}/capabilities`).set(H(adminA.token)).send(CAPABILITY_BODY)
    await request(app).put(`${DISCOVERY}/capabilities/${created.body.data.id}`).set(H(adminA.token))
      .send({ naicsCodes: ['541511', '541512'] })

    expect(await eventsOf(firmA.id, FIRM_CAPABILITY_CHANGED)).toHaveLength(2)
  })

  it('collapses a no-op save onto the existing event', async () => {
    const created = await request(app).post(`${DISCOVERY}/capabilities`).set(H(adminA.token)).send(CAPABILITY_BODY)
    // Same material content as the create — nothing matching cares about changed.
    await request(app).put(`${DISCOVERY}/capabilities/${created.body.data.id}`).set(H(adminA.token))
      .send({ name: CAPABILITY_BODY.name })

    expect(await eventsOf(firmA.id, FIRM_CAPABILITY_CHANGED)).toHaveLength(1)
  })

  it('survives a benign duplicate without rolling back the business write', async () => {
    const created = await request(app).post(`${DISCOVERY}/capabilities`).set(H(adminA.token)).send(CAPABILITY_BODY)
    const id = created.body.data.id

    // Change, then change back: the second update reproduces the original
    // fingerprint, so the outbox insert is a duplicate. The §7.1 bug was that
    // this aborted the transaction and lost the business write.
    await request(app).put(`${DISCOVERY}/capabilities/${id}`).set(H(adminA.token)).send({ name: 'Renamed' })
    const back = await request(app).put(`${DISCOVERY}/capabilities/${id}`).set(H(adminA.token))
      .send({ name: CAPABILITY_BODY.name })

    expect(back.status).toBe(200)
    const row = await prisma.firmCapability.findUnique({ where: { id } })
    expect(row?.name).toBe(CAPABILITY_BODY.name)
  })

  it('emits on verification change but never marks the capability verified itself', async () => {
    const created = await request(app).post(`${DISCOVERY}/capabilities`).set(H(adminA.token)).send(CAPABILITY_BODY)
    const before = await prisma.firmCapability.findUnique({ where: { id: created.body.data.id } })
    expect(before?.verification).toBe('UNVERIFIED')

    await request(app).post(`${DISCOVERY}/capabilities/${created.body.data.id}/verify`).set(H(adminA.token))
      .send({ verification: 'VERIFIED' })

    const events = await eventsOf(firmA.id, FIRM_CAPABILITY_CHANGED)
    expect(events.length).toBeGreaterThanOrEqual(2)
    const after = await prisma.firmCapability.findUnique({ where: { id: created.body.data.id } })
    expect(after?.verifiedByUserId).toBe(adminA.id)
  })

  it('emits zero events when the business write is rolled back', async () => {
    await prisma.$transaction(async (tx) => {
      const row = await tx.firmCapability.create({
        data: { consultingFirmId: firmA.id, ...CAPABILITY_BODY, category: 'TECHNICAL' },
      })
      await emitFirmCapabilityChanged(tx, {
        consultingFirmId: firmA.id,
        capabilityId: row.id,
        changeType: 'CREATED',
        material: { ...CAPABILITY_BODY, verification: 'UNVERIFIED', isArchived: false },
      })
      throw new Error('rollback')
    }).catch(() => undefined)

    expect(await eventsOf(firmA.id, FIRM_CAPABILITY_CHANGED)).toHaveLength(0)
    expect(await prisma.firmCapability.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('rejects a capability write from a CONSULTANT', async () => {
    const res = await request(app).post(`${DISCOVERY}/capabilities`).set(H(consultantA.token)).send(CAPABILITY_BODY)
    expect(res.status).toBe(403)
    expect(await eventsOf(firmA.id, FIRM_CAPABILITY_CHANGED)).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// MONITORING_PROFILE_SAVED
// -------------------------------------------------------------

describe('MONITORING_PROFILE_SAVED', () => {
  const profileBody = () => ({ name: uniq('S7-OA-QA profile'), filters: { agency: 'GSA' }, alertFrequency: 'DAILY' })

  it('emits exactly one event when a profile is created', async () => {
    const res = await request(app).post(PROFILES).set(H(adminA.token)).send(profileBody())
    expect(res.status).toBe(201)

    const events = await eventsOf(firmA.id, MONITORING_PROFILE_SAVED)
    expect(events).toHaveLength(1)
    expect(events[0].entityType).toBe('SavedMonitoringProfile')
    expect(events[0].entityId).toBe(res.body.data.id)
  })

  it('emits a fresh event when the filters materially change', async () => {
    const created = await request(app).post(PROFILES).set(H(adminA.token)).send(profileBody())
    await request(app).put(`${PROFILES}/${created.body.data.id}`).set(H(adminA.token))
      .send({ filters: { agency: 'DoD' } })

    expect(await eventsOf(firmA.id, MONITORING_PROFILE_SAVED)).toHaveLength(2)
  })

  it('collapses a rename-only save onto the existing event', async () => {
    const created = await request(app).post(PROFILES).set(H(adminA.token)).send(profileBody())
    const res = await request(app).put(`${PROFILES}/${created.body.data.id}`).set(H(adminA.token))
      .send({ name: uniq('S7-OA-QA renamed') })

    expect(res.status).toBe(200)
    expect(await eventsOf(firmA.id, MONITORING_PROFILE_SAVED)).toHaveLength(1)
  })

  it('emits when a profile is reactivated', async () => {
    const created = await request(app).post(PROFILES).set(H(adminA.token)).send(profileBody())
    await request(app).patch(`${PROFILES}/${created.body.data.id}/active`).set(H(adminA.token)).send({ isActive: false })
    expect(await eventsOf(firmA.id, MONITORING_PROFILE_SAVED)).toHaveLength(2)
  })

  it('emits zero events when the business write is rolled back', async () => {
    await prisma.$transaction(async (tx) => {
      const row = await tx.savedMonitoringProfile.create({
        data: { consultingFirmId: firmA.id, name: uniq('rollback'), filters: {}, alertFrequency: 'DISABLED' },
      })
      await emitMonitoringProfileSaved(tx, {
        consultingFirmId: firmA.id,
        profileId: row.id,
        changeType: 'CREATED',
        material: { filters: {}, alertFrequency: 'DISABLED', priority: 'MEDIUM', isActive: true, isArchived: false, visibility: 'FIRM' },
      })
      throw new Error('rollback')
    }).catch(() => undefined)

    expect(await eventsOf(firmA.id, MONITORING_PROFILE_SAVED)).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// PURSUIT_STAGE_CHANGED
// -------------------------------------------------------------

describe('PURSUIT_STAGE_CHANGED', () => {
  async function makePursuit(firmId: string) {
    const opp = await makeOpportunity(firmId)
    return prisma.bidPursuit.create({
      data: { consultingFirmId: firmId, opportunityId: opp.id, pipelineStage: 'IDENTIFIED', status: 'REVIEWING' },
    })
  }

  it('emits exactly one event on a valid stage transition', async () => {
    const pursuit = await makePursuit(firmA.id)
    const res = await request(app).patch(`${PURSUITS}/${pursuit.id}/stage`).set(H(adminA.token))
      .send({ stage: 'QUALIFICATION' })
    expect(res.status).toBe(200)

    const events = await eventsOf(firmA.id, PURSUIT_STAGE_CHANGED)
    expect(events).toHaveLength(1)
    const payload = events[0].payload as { pursuitId: string; opportunityId: string; fromStage: string; toStage: string }
    expect(payload.pursuitId).toBe(pursuit.id)
    expect(payload.opportunityId).toBe(pursuit.opportunityId)
    expect(payload.fromStage).toBe('IDENTIFIED')
    expect(payload.toStage).toBe('QUALIFICATION')
  })

  it('emits zero events when the transition is rejected by the state machine', async () => {
    const pursuit = await makePursuit(firmA.id)
    const res = await request(app).patch(`${PURSUITS}/${pursuit.id}/stage`).set(H(adminA.token))
      .send({ stage: 'AWARDED' })
    expect(res.status).toBe(422)
    expect(await eventsOf(firmA.id, PURSUIT_STAGE_CHANGED)).toHaveLength(0)
  })

  it('emits on a user-declared pass, the negative preference signal', async () => {
    const pursuit = await makePursuit(firmA.id)
    const res = await request(app).patch(`${PURSUITS}/${pursuit.id}`).set(H(adminA.token)).send({ action: 'passed' })
    expect(res.status).toBe(200)

    const events = await eventsOf(firmA.id, PURSUIT_STAGE_CHANGED)
    expect(events).toHaveLength(1)
    const payload = events[0].payload as { toStage: string; declaredStatus: string }
    expect(payload.toStage).toBe('NO_BID')
    expect(payload.declaredStatus).toBe('PASSED')
  })

  it('absorbs a duplicate emission without rolling back the business write', async () => {
    // This is the §7.1 regression in its purest form: emitting the same event
    // twice inside one transaction must be a no-op, not a 25P02 abort that
    // discards the caller's write.
    const pursuit = await makePursuit(firmA.id)

    await prisma.$transaction(async (tx) => {
      await tx.bidPursuit.update({ where: { id: pursuit.id }, data: { pipelineStage: 'QUALIFICATION' } })
      const first = await emitPursuitStageChanged(tx, {
        consultingFirmId: firmA.id, pursuitId: pursuit.id, opportunityId: pursuit.opportunityId,
        fromStage: 'IDENTIFIED', toStage: 'QUALIFICATION',
      })
      const second = await emitPursuitStageChanged(tx, {
        consultingFirmId: firmA.id, pursuitId: pursuit.id, opportunityId: pursuit.opportunityId,
        fromStage: 'IDENTIFIED', toStage: 'QUALIFICATION',
      })
      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.eventId).toBe(first.eventId)
    })

    expect(await eventsOf(firmA.id, PURSUIT_STAGE_CHANGED)).toHaveLength(1)
    const row = await prisma.bidPursuit.findUnique({ where: { id: pursuit.id } })
    expect(row?.pipelineStage).toBe('QUALIFICATION')
  })

  it('emits zero events when the business write is rolled back', async () => {
    const pursuit = await makePursuit(firmA.id)
    await prisma.$transaction(async (tx) => {
      await tx.bidPursuit.update({ where: { id: pursuit.id }, data: { pipelineStage: 'CAPTURE' } })
      await emitPursuitStageChanged(tx, {
        consultingFirmId: firmA.id,
        pursuitId: pursuit.id,
        opportunityId: pursuit.opportunityId,
        fromStage: 'IDENTIFIED',
        toStage: 'CAPTURE',
      })
      throw new Error('rollback')
    }).catch(() => undefined)

    expect(await eventsOf(firmA.id, PURSUIT_STAGE_CHANGED)).toHaveLength(0)
    const row = await prisma.bidPursuit.findUnique({ where: { id: pursuit.id } })
    expect(row?.pipelineStage).toBe('IDENTIFIED')
  })

  it('cannot transition another firm\'s pursuit', async () => {
    const pursuit = await makePursuit(firmB.id)
    const res = await request(app).patch(`${PURSUITS}/${pursuit.id}/stage`).set(H(adminA.token))
      .send({ stage: 'QUALIFICATION' })
    expect(res.status).toBe(404)
    expect(await eventsOf(firmA.id, PURSUIT_STAGE_CHANGED)).toHaveLength(0)
    expect(await eventsOf(firmB.id, PURSUIT_STAGE_CHANGED)).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// SOURCE_SYNC_COMPLETED
// -------------------------------------------------------------

describe('SOURCE_SYNC_COMPLETED', () => {
  it('emits exactly one event per completed sync run', async () => {
    const config = await prisma.opportunitySourceConfig.create({
      data: {
        consultingFirmId: firmA.id, displayName: uniq('S7-OA-QA src'),
        adapterKey: uniq('adapter'), category: 'SAM_GOV', isEnabled: true,
      },
    })

    await prisma.$transaction(async (tx) => {
      await emitSourceSyncCompleted(tx, {
        consultingFirmId: firmA.id, sourceConfigId: config.id, adapterKey: 'sam_gov', category: 'SAM_GOV',
        syncRunId: 'run-1', status: 'SUCCEEDED', recordsCreated: 3, recordsUpdated: 2, recordsSkipped: 0,
        errorCount: 0, cursorAfter: 'cursor-1',
      })
    })

    const events = await eventsOf(firmA.id, SOURCE_SYNC_COMPLETED)
    expect(events).toHaveLength(1)
    const payload = events[0].payload as { changedRecordCount: number; cursorAfter: string }
    expect(payload.changedRecordCount).toBe(5)
    expect(payload.cursorAfter).toBe('cursor-1')
  })

  it('carries identifiers and counters, never the source records themselves', async () => {
    await prisma.$transaction(async (tx) => {
      await emitSourceSyncCompleted(tx, {
        consultingFirmId: firmA.id, sourceConfigId: 'cfg-1', adapterKey: 'sam_gov', category: 'SAM_GOV',
        syncRunId: 'run-2', status: 'PARTIAL', recordsCreated: 1, recordsUpdated: 1, recordsSkipped: 1,
        errorCount: 1, cursorAfter: null,
      })
    })
    const [event] = await eventsOf(firmA.id, SOURCE_SYNC_COMPLETED)
    expect(JSON.stringify(event.payload).length).toBeLessThan(500)
  })

  it('does not emit a duplicate for the same sync run', async () => {
    for (let i = 0; i < 2; i++) {
      await prisma.$transaction(async (tx) => {
        await emitSourceSyncCompleted(tx, {
          consultingFirmId: firmA.id, sourceConfigId: 'cfg-1', adapterKey: 'sam_gov', category: 'SAM_GOV',
          syncRunId: 'run-3', status: 'SUCCEEDED', recordsCreated: 1, recordsUpdated: 0, recordsSkipped: 0,
          errorCount: 0, cursorAfter: null,
        })
      })
    }
    expect(await eventsOf(firmA.id, SOURCE_SYNC_COMPLETED)).toHaveLength(1)
  })
})

// -------------------------------------------------------------
// Outbox fan-out
// -------------------------------------------------------------

describe('outbox fan-out', () => {
  /**
   * `processOutbox` deliberately drains EVERY tenant, so a concurrently running
   * suite may claim this firm's event and complete the fan-out a moment later.
   * Polling for the run makes the assertion deterministic without weakening it:
   * the property under test is still "exactly one run per event, ever".
   *
   * Deliberately does NOT call releaseStuckEvents — that is global, and forcing
   * it here would yank events another suite is legitimately mid-way through.
   */
  async function drainForEntity(entityId: string, attempts = 8) {
    for (let i = 0; i < attempts; i++) {
      await processOutbox(`test-worker-${i}`, 20, new Date(), { consultingFirmId: firmA.id })
      const run = await prisma.agentRun.findFirst({
        where: { consultingFirmId: firmA.id, agentKey: 'OPPORTUNITY', triggerType: 'EVENT', triggerEntityId: entityId },
      })
      if (run) return run
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }

  it('creates one Opportunity Agent run per event, and only one on replay', async () => {
    const created = await request(app).post(`${DISCOVERY}/capabilities`).set(H(adminA.token)).send(CAPABILITY_BODY)
    expect(created.status).toBe(201)

    const run = await drainForEntity(created.body.data.id)
    expect(run).not.toBeNull()
    expect(run!.triggerEntityType).toBe('FirmCapability')

    // Replay: a processed event must never produce a second run.
    await processOutbox('test-worker-replay', 20, new Date(), { consultingFirmId: firmA.id })
    await processOutbox('test-worker-replay-2', 20, new Date(), { consultingFirmId: firmA.id })

    const runs = await prisma.agentRun.findMany({
      where: { consultingFirmId: firmA.id, agentKey: 'OPPORTUNITY', triggerType: 'EVENT', triggerEntityId: created.body.data.id },
    })
    expect(runs).toHaveLength(1)
  })

  it('never creates a run for another tenant from an event', async () => {
    const created = await request(app).post(`${DISCOVERY}/capabilities`).set(H(adminA.token)).send(CAPABILITY_BODY)
    await drainForEntity(created.body.data.id)

    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })
})

// -------------------------------------------------------------
// API
// -------------------------------------------------------------

describe('GET /latest', () => {
  it('reports honest empty state before the agent has ever run', async () => {
    const res = await request(app).get(`${OA}/latest`).set(H(adminA.token))
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.brief).toBeNull()
    expect(res.body.data.lastRun).toBeNull()
    expect(res.body.data.learning.effectiveWeightProfile).toBe('BASE')
  })

  it('surfaces the documented policy so the UI never hard-codes a threshold', async () => {
    const res = await request(app).get(`${OA}/latest`).set(H(adminA.token))
    expect(res.body.data.policy.minimumSampleSize).toBe(20)
    expect(res.body.data.policy.learnableDimensions).toHaveLength(8)
  })

  it('is readable by a CONSULTANT', async () => {
    const res = await request(app).get(`${OA}/latest`).set(H(consultantA.token))
    expect(res.status).toBe(200)
  })

  it('rejects an unauthenticated request', async () => {
    expect((await request(app).get(`${OA}/latest`)).status).toBe(401)
  })
})

describe('feedback API', () => {
  async function seedProposal(firmId: string) {
    for (let i = 0; i < 24; i++) {
      const pursued = i < 12
      const opp = await makeOpportunity(firmId)
      await prisma.opportunityMatch.create({
        data: {
          opportunityId: opp.id, consultingFirmId: firmId,
          overallScore: pursued ? 80 : 20,
          capabilityScore: pursued ? 90 : 20, naicsScore: pursued ? 90 : 20,
          pscScore: 50, certificationScore: 50, pastPerformanceScore: 50,
          geographyScore: 50, vehicleScore: 50, keywordScore: 50,
          evidence: {}, eligibility: 'ELIGIBLE', eligibilityReason: 'test', eligibilityEvidence: {},
        },
      })
      await prisma.bidPursuit.create({
        data: {
          consultingFirmId: firmId, opportunityId: opp.id,
          pipelineStage: pursued ? 'PROPOSAL' : 'NO_BID', status: 'REVIEWING', source: 'USER',
        },
      })
    }
    const result = await analysePursuitFeedback({ consultingFirmId: firmId })
    return result.signalId!
  }

  it('lists only this firm\'s signals', async () => {
    await seedProposal(firmA.id)
    await seedProposal(firmB.id)

    const res = await request(app).get(`${OA}/feedback`).set(H(adminA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.signals).toHaveLength(1)
  })

  it('does not disclose another firm\'s signal by id', async () => {
    const signalB = await seedProposal(firmB.id)
    const res = await request(app).get(`${OA}/feedback/${signalB}`).set(H(adminA.token))
    expect(res.status).toBe(404)
  })

  it('lets an ADMIN apply a proposal and audits the human action', async () => {
    const id = await seedProposal(firmA.id)
    const res = await request(app).post(`${OA}/feedback/${id}/apply`).set(H(adminA.token))

    expect(res.status).toBe(200)
    expect(res.body.data.signal.status).toBe('APPLIED')
    expect(res.body.data.signal.appliedByUserId).toBe(adminA.id)

    const audit = await prisma.auditEvent.findFirst({
      where: { consultingFirmId: firmA.id, entityType: 'PursuitFeedbackSignal', entityId: id },
    })
    expect(audit).not.toBeNull()
    expect(audit?.actorUserId).toBe(adminA.id)
  })

  it('refuses to let a CONSULTANT apply a weighting', async () => {
    const id = await seedProposal(firmA.id)
    const res = await request(app).post(`${OA}/feedback/${id}/apply`).set(H(consultantA.token))
    expect(res.status).toBe(403)

    const row = await prisma.pursuitFeedbackSignal.findUnique({ where: { id } })
    expect(row?.status).toBe('PROPOSED')
  })

  it('rejects a duplicate apply', async () => {
    const id = await seedProposal(firmA.id)
    await request(app).post(`${OA}/feedback/${id}/apply`).set(H(adminA.token))
    const second = await request(app).post(`${OA}/feedback/${id}/apply`).set(H(adminA.token))
    expect(second.status).toBe(422)
  })

  it('refuses to apply another firm\'s signal', async () => {
    const signalB = await seedProposal(firmB.id)
    const res = await request(app).post(`${OA}/feedback/${signalB}/apply`).set(H(adminA.token))
    expect(res.status).toBe(422)

    const row = await prisma.pursuitFeedbackSignal.findUnique({ where: { id: signalB } })
    expect(row?.status).toBe('PROPOSED')
  })

  it('reverts and reports the exact restored baseline', async () => {
    const id = await seedProposal(firmA.id)
    await request(app).post(`${OA}/feedback/${id}/apply`).set(H(adminA.token))

    const before = await prisma.pursuitFeedbackSignal.findUnique({ where: { id } })
    const res = await request(app).post(`${OA}/feedback/${id}/revert`).set(H(adminA.token))

    expect(res.status).toBe(200)
    expect(res.body.data.signal.status).toBe('REVERTED')
    expect(res.body.data.restoredWeights).toEqual(before?.baselineWeights)
  })

  it('refuses to let a CONSULTANT revert a weighting', async () => {
    const id = await seedProposal(firmA.id)
    await request(app).post(`${OA}/feedback/${id}/apply`).set(H(adminA.token))
    const res = await request(app).post(`${OA}/feedback/${id}/revert`).set(H(consultantA.token))
    expect(res.status).toBe(403)

    const row = await prisma.pursuitFeedbackSignal.findUnique({ where: { id } })
    expect(row?.status).toBe('APPLIED')
  })

  it('refuses to revert another firm\'s applied signal', async () => {
    const signalB = await seedProposal(firmB.id)
    await applyPursuitFeedback({ consultingFirmId: firmB.id, signalId: signalB, userId: adminB.id })
    const res = await request(app).post(`${OA}/feedback/${signalB}/revert`).set(H(adminA.token))
    expect(res.status).toBe(422)

    const row = await prisma.pursuitFeedbackSignal.findUnique({ where: { id: signalB } })
    expect(row?.status).toBe('APPLIED')
  })

  it('surfaces the applied signal on /latest with the adjusted profile', async () => {
    const id = await seedProposal(firmA.id)
    await request(app).post(`${OA}/feedback/${id}/apply`).set(H(adminA.token))

    const res = await request(app).get(`${OA}/latest`).set(H(adminA.token))
    expect(res.body.data.learning.effectiveWeightProfile).toBe('PURSUIT_ADJUSTED')
    expect(res.body.data.learning.appliedSignal.id).toBe(id)
  })
})
