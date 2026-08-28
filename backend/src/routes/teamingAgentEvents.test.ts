// =============================================================
// §7.5 — Teaming Agent events and HTTP surface.
//
// The four triggers are proven through their REAL write paths: a committed
// write emits exactly one event, a rolled-back write emits none, a benign
// duplicate never rolls the business write back, and no event crosses a tenant
// boundary.
//
// The HTTP surface is proven to contain no send endpoint and no execute
// endpoint at all.
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
import { processOutbox, claimEvents } from '../services/agents/outbox'
import { assessCapabilityGaps } from '../services/scoring/capabilityGap'
import { recordQualificationDecision } from '../services/qualificationDecision'
import {
  BID_DECISION_RECORDED,
  CAPABILITY_GAP_DETECTED,
  PARTNER_ADDED,
  SUBCONTRACT_MILESTONE_DUE,
  emitPartnerAdded,
  emitSubcontractMilestoneDue,
  gapSnapshotWorsened,
} from '../services/agents/teaming/teamingEvents'

const BASE = '/api/agents/teaming'
const DAY = 86_400_000

let app: Express
let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let consultantA: TestUser
let adminB: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'Teaming Event Firm A' })
  firmB = await createTestFirm({ name: 'Teaming Event Firm B' })
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
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
    await prisma.auditEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.subcontractingGoalProgress.deleteMany({ where: { consultingFirmId: id } })
    await prisma.subcontractingGoal.deleteMany({ where: { consultingFirmId: id } })
    await prisma.partnerPerformanceRecord.deleteMany({ where: { consultingFirmId: id } })
    await prisma.scorecardDecision.deleteMany({ where: { consultingFirmId: id } })
    await prisma.scorecard.deleteMany({ where: { consultingFirmId: id } })
    await prisma.teamingArrangement.deleteMany({ where: { consultingFirmId: id } })
    await prisma.partner.deleteMany({ where: { consultingFirmId: id } })
    await prisma.capabilityGapAssessment.deleteMany({ where: { consultingFirmId: id } })
    await prisma.bidPursuit.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
  }
})

async function makeOpportunity(firmId: string, over: Record<string, unknown> = {}) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId: firmId, samNoticeId: uniq('S7-TEAM-QA-EV'),
      title: 'S7-TEAM-QA event opportunity', agency: 'Department of Defense',
      naicsCode: '541512', setAsideType: 'SDVOSB',
      responseDeadline: new Date(Date.now() + 45 * DAY),
      status: 'ACTIVE', isDemo: false, ...over,
    },
  })
}

async function makePursuit(firmId: string, opportunityId: string, over: Record<string, unknown> = {}) {
  return prisma.bidPursuit.create({
    data: {
      consultingFirmId: firmId, opportunityId, pipelineStage: 'QUALIFICATION',
      status: 'REVIEWING', priority: 'MEDIUM', ...over,
    },
  })
}

const eventsFor = (firmId: string) =>
  prisma.agentEvent.findMany({ where: { consultingFirmId: firmId }, orderBy: { createdAt: 'asc' } })

// -------------------------------------------------------------
// BID_DECISION_RECORDED
// -------------------------------------------------------------

describe('BID_DECISION_RECORDED', () => {
  async function decidablePursuit() {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await prisma.scorecard.create({
      data: {
        consultingFirmId: firmA.id, bidPursuitId: pursuit.id, opportunityId: opp.id, status: 'IN_REVIEW',
        criteria: {
          create: [
            { key: 'capability', name: 'Capability', weight: 50, score: 80, required: true, displayOrder: 0 },
            { key: 'competition', name: 'Competition', weight: 50, score: 70, required: true, displayOrder: 1 },
          ],
        },
      },
    })
    return { opp, pursuit }
  }

  it('emits exactly one event when a human records a BID', async () => {
    const { pursuit } = await decidablePursuit()
    await recordQualificationDecision({
      consultingFirmId: firmA.id, pursuitId: pursuit.id, decision: 'BID',
      actorUserId: adminA.id, overrideReason: null, reviewerComments: null,
    })

    const events = (await eventsFor(firmA.id)).filter((e) => e.eventType === BID_DECISION_RECORDED)
    expect(events).toHaveLength(1)
    expect(events[0].entityType).toBe('BidPursuit')
    expect(events[0].entityId).toBe(pursuit.id)
  })

  it('carries ids and status only — never a recommendation payload', async () => {
    const { pursuit, opp } = await decidablePursuit()
    await recordQualificationDecision({
      consultingFirmId: firmA.id, pursuitId: pursuit.id, decision: 'BID',
      actorUserId: adminA.id, overrideReason: null, reviewerComments: null,
    })

    const event = (await eventsFor(firmA.id)).find((e) => e.eventType === BID_DECISION_RECORDED)!
    expect(Object.keys(event.payload as object).sort()).toEqual([
      'decidedByUserId', 'decision', 'isOverride', 'opportunityId', 'pursuitId',
    ])
    expect((event.payload as { opportunityId: string }).opportunityId).toBe(opp.id)
  })

  it('names the person who decided, never a system actor', async () => {
    const { pursuit } = await decidablePursuit()
    await recordQualificationDecision({
      consultingFirmId: firmA.id, pursuitId: pursuit.id, decision: 'BID',
      actorUserId: adminA.id, overrideReason: null, reviewerComments: null,
    })
    const event = (await eventsFor(firmA.id)).find((e) => e.eventType === BID_DECISION_RECORDED)!
    expect((event.payload as { decidedByUserId: string }).decidedByUserId).toBe(adminA.id)
  })

  it('emits nothing when the decision is refused', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    // No scorecard exists, so the canonical path refuses.
    await expect(
      recordQualificationDecision({
        consultingFirmId: firmA.id, pursuitId: pursuit.id, decision: 'BID',
        actorUserId: adminA.id, overrideReason: null, reviewerComments: null,
      }),
    ).rejects.toThrow()

    expect((await eventsFor(firmA.id)).filter((e) => e.eventType === BID_DECISION_RECORDED)).toHaveLength(0)
  })

  it('records a NO_BID as the fact it is, for the handler to ignore', async () => {
    const { pursuit } = await decidablePursuit()
    await recordQualificationDecision({
      consultingFirmId: firmA.id, pursuitId: pursuit.id, decision: 'NO_BID',
      actorUserId: adminA.id, overrideReason: 'Capacity is committed elsewhere.', reviewerComments: null,
    })
    const event = (await eventsFor(firmA.id)).find((e) => e.eventType === BID_DECISION_RECORDED)!
    expect((event.payload as { decision: string }).decision).toBe('NO_BID')
  })

  it('never emits into another firm', async () => {
    const { pursuit } = await decidablePursuit()
    await recordQualificationDecision({
      consultingFirmId: firmA.id, pursuitId: pursuit.id, decision: 'BID',
      actorUserId: adminA.id, overrideReason: null, reviewerComments: null,
    })
    expect(await eventsFor(firmB.id)).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// CAPABILITY_GAP_DETECTED
// -------------------------------------------------------------

describe('the gap-worsened rule', () => {
  const snap = (caps: string[] = [], certs: string[] = [], elig: string[] = []) => ({
    missingCapabilities: caps, missingCertifications: certs, missingEligibility: elig,
  })

  it('fires for a first gap', () => {
    expect(gapSnapshotWorsened(null, snap(['cyber'])).worsened).toBe(true)
  })

  it('does not fire when nothing is missing', () => {
    expect(gapSnapshotWorsened(null, snap()).worsened).toBe(false)
  })

  it('does not fire for an unchanged gap set', () => {
    expect(gapSnapshotWorsened(snap(['cyber']), snap(['cyber'])).worsened).toBe(false)
  })

  it('does not fire when a gap is resolved', () => {
    expect(gapSnapshotWorsened(snap(['cyber', 'cloud']), snap(['cyber'])).worsened).toBe(false)
  })

  it('fires for a genuinely new gap alongside an old one', () => {
    const r = gapSnapshotWorsened(snap(['cyber']), snap(['cyber', 'cloud']))
    expect(r.worsened).toBe(true)
    expect(r.newGaps).toEqual(['capability:cloud'])
  })

  it('distinguishes a certification gap from a capability gap of the same name', () => {
    const r = gapSnapshotWorsened(snap(['SDVOSB']), snap(['SDVOSB'], ['SDVOSB']))
    expect(r.newGaps).toEqual(['certification:SDVOSB'])
  })

  it('is stable in ordering, so the dedupe key is stable', () => {
    const a = gapSnapshotWorsened(null, snap(['b', 'a'])).newGaps
    const b = gapSnapshotWorsened(null, snap(['a', 'b'])).newGaps
    expect(a).toEqual(b)
  })
})

describe('CAPABILITY_GAP_DETECTED through the canonical assessment', () => {
  it('emits once when a material gap first appears', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    await assessCapabilityGaps(firmA.id, opp.id)

    const events = (await eventsFor(firmA.id)).filter((e) => e.eventType === CAPABILITY_GAP_DETECTED)
    expect(events).toHaveLength(1)
    expect(events[0].entityType).toBe('Opportunity')
    expect(events[0].entityId).toBe(opp.id)
  })

  it('does not emit again for an unchanged gap set', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    await assessCapabilityGaps(firmA.id, opp.id)
    await assessCapabilityGaps(firmA.id, opp.id)
    await assessCapabilityGaps(firmA.id, opp.id)

    expect((await eventsFor(firmA.id)).filter((e) => e.eventType === CAPABILITY_GAP_DETECTED)).toHaveLength(1)
  })

  it('carries the gap keys and a critical count, not the evidence behind them', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    await assessCapabilityGaps(firmA.id, opp.id)

    const event = (await eventsFor(firmA.id)).find((e) => e.eventType === CAPABILITY_GAP_DETECTED)!
    expect(Object.keys(event.payload as object).sort()).toEqual(['criticalGapCount', 'newGaps', 'opportunityId'])
  })

  it('still writes the assessment even when nothing is emitted', async () => {
    const opp = await makeOpportunity(firmA.id, { setAsideType: 'NONE' })
    await makePursuit(firmA.id, opp.id)
    await assessCapabilityGaps(firmA.id, opp.id)
    expect(await prisma.capabilityGapAssessment.count({ where: { opportunityId: opp.id } })).toBe(1)
  })

  it('never emits into another firm', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    await assessCapabilityGaps(firmA.id, opp.id)
    expect(await eventsFor(firmB.id)).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// PARTNER_ADDED
// -------------------------------------------------------------

describe('PARTNER_ADDED through the real create route', () => {
  const body = () => ({ name: uniq('S7-TEAM-QA Partner'), uei: uniq('UEI'), capabilities: ['cyber'] })

  it('emits exactly one event when a partner is created', async () => {
    const res = await request(app).post('/api/teaming/partners').set(H(adminA.token)).send(body())
    expect(res.status).toBe(201)

    const events = (await eventsFor(firmA.id)).filter((e) => e.eventType === PARTNER_ADDED)
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe(res.body.data.partner.id)
  })

  it('states that being added establishes nothing', async () => {
    await request(app).post('/api/teaming/partners').set(H(adminA.token)).send(body())
    const event = (await eventsFor(firmA.id)).find((e) => e.eventType === PARTNER_ADDED)!
    expect(event.payload).toMatchObject({ verified: false, eligible: false, recommended: false })
  })

  it('emits nothing when the create is rejected as a duplicate', async () => {
    const shared = body()
    await request(app).post('/api/teaming/partners').set(H(adminA.token)).send(shared)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    const second = await request(app).post('/api/teaming/partners').set(H(adminA.token)).send(shared)
    expect(second.status).toBe(409)
    expect((await eventsFor(firmA.id)).filter((e) => e.eventType === PARTNER_ADDED)).toHaveLength(0)
  })

  it('still creates the partner when the same event is emitted twice', async () => {
    const partner = await prisma.partner.create({
      data: { consultingFirmId: firmA.id, name: uniq('S7-TEAM-QA Dup'), uei: uniq('UEI') },
    })
    // A benign duplicate must not roll the business write back.
    await prisma.$transaction(async (tx) => {
      await emitPartnerAdded({ consultingFirmId: firmA.id, partnerId: partner.id }, tx)
      await emitPartnerAdded({ consultingFirmId: firmA.id, partnerId: partner.id }, tx)
    })
    expect(await prisma.partner.findUnique({ where: { id: partner.id } })).not.toBeNull()
    expect((await eventsFor(firmA.id)).filter((e) => e.eventType === PARTNER_ADDED)).toHaveLength(1)
  })

  it('emits nothing when the surrounding transaction rolls back', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const created = await tx.partner.create({
          data: { consultingFirmId: firmA.id, name: uniq('S7-TEAM-QA Rollback'), uei: uniq('UEI') },
        })
        await emitPartnerAdded({ consultingFirmId: firmA.id, partnerId: created.id }, tx)
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')

    expect((await eventsFor(firmA.id)).filter((e) => e.eventType === PARTNER_ADDED)).toHaveLength(0)
    expect(await prisma.partner.count({ where: { consultingFirmId: firmA.id, name: { contains: 'Rollback' } } })).toBe(0)
  })

  it('never emits into another firm', async () => {
    await request(app).post('/api/teaming/partners').set(H(adminA.token)).send(body())
    expect(await eventsFor(firmB.id)).toHaveLength(0)
  })

  it('creates exactly one run when the event is processed', async () => {
    await prisma.agentSchedule.create({
      data: { consultingFirmId: firmA.id, agentKey: 'TEAMING', isEnabled: true, scheduleType: 'CRON', cronExpression: '0 3 * * *' },
    })
    await request(app).post('/api/teaming/partners').set(H(adminA.token)).send(body())
    await processOutbox('worker-1', 20, new Date(), { consultingFirmId: firmA.id })

    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmA.id, agentKey: 'TEAMING' } })).toBe(1)
  })
})

// -------------------------------------------------------------
// SUBCONTRACT_MILESTONE_DUE
// -------------------------------------------------------------

describe('SUBCONTRACT_MILESTONE_DUE', () => {
  async function makeGoal(firmId: string) {
    return prisma.subcontractingGoal.create({
      data: {
        consultingFirmId: firmId, goalType: 'SDVOSB', targetType: 'PERCENT',
        targetPercent: new Prisma.Decimal('20.00'), source: 'SUBCONTRACTING_PLAN',
        isHumanVerified: true, status: 'ACTIVE', dueDate: new Date(Date.now() + 5 * DAY),
      },
    })
  }

  it('emits one event for a goal entering its risk window', async () => {
    const goal = await makeGoal(firmA.id)
    await prisma.$transaction(async (tx) =>
      emitSubcontractMilestoneDue(
        { consultingFirmId: firmA.id, goalId: goal.id, riskState: 'AT_RISK', workingDaysRemaining: 3, dueDateIso: goal.dueDate!.toISOString() },
        tx,
      ),
    )
    const events = (await eventsFor(firmA.id)).filter((e) => e.eventType === SUBCONTRACT_MILESTONE_DUE)
    expect(events).toHaveLength(1)
    expect(events[0].entityType).toBe('SubcontractingGoal')
    expect(events[0].entityId).toBe(goal.id)
  })

  it('does not re-emit while the risk state is unchanged', async () => {
    const goal = await makeGoal(firmA.id)
    for (let i = 0; i < 3; i += 1) {
      await prisma.$transaction(async (tx) =>
        emitSubcontractMilestoneDue(
          { consultingFirmId: firmA.id, goalId: goal.id, riskState: 'AT_RISK', workingDaysRemaining: 3 - i, dueDateIso: null },
          tx,
        ),
      )
    }
    expect((await eventsFor(firmA.id)).filter((e) => e.eventType === SUBCONTRACT_MILESTONE_DUE)).toHaveLength(1)
  })

  it('emits again when the risk state changes', async () => {
    const goal = await makeGoal(firmA.id)
    for (const riskState of ['AT_RISK', 'MISSED']) {
      await prisma.$transaction(async (tx) =>
        emitSubcontractMilestoneDue({ consultingFirmId: firmA.id, goalId: goal.id, riskState, workingDaysRemaining: 0, dueDateIso: null }, tx),
      )
    }
    expect((await eventsFor(firmA.id)).filter((e) => e.eventType === SUBCONTRACT_MILESTONE_DUE)).toHaveLength(2)
  })

  it('emits nothing when the surrounding transaction rolls back', async () => {
    const goal = await makeGoal(firmA.id)
    await expect(
      prisma.$transaction(async (tx) => {
        await emitSubcontractMilestoneDue({ consultingFirmId: firmA.id, goalId: goal.id, riskState: 'AT_RISK', workingDaysRemaining: 1, dueDateIso: null }, tx)
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect((await eventsFor(firmA.id)).filter((e) => e.eventType === SUBCONTRACT_MILESTONE_DUE)).toHaveLength(0)
  })

  it('never crosses a tenant boundary when claimed', async () => {
    const goal = await makeGoal(firmA.id)
    await prisma.$transaction(async (tx) =>
      emitSubcontractMilestoneDue({ consultingFirmId: firmA.id, goalId: goal.id, riskState: 'AT_RISK', workingDaysRemaining: 1, dueDateIso: null }, tx),
    )
    expect(await claimEvents('t', 10, new Date(), { consultingFirmId: firmB.id })).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// HTTP surface
// -------------------------------------------------------------

describe(`GET ${BASE}/plan/:pursuitId`, () => {
  it('requires authentication', async () => {
    expect((await request(app).get(`${BASE}/plan/x`)).status).toBe(401)
  })

  it('404s across firms', async () => {
    const opp = await makeOpportunity(firmB.id)
    const pursuit = await makePursuit(firmB.id, opp.id)
    expect((await request(app).get(`${BASE}/plan/${pursuit.id}`).set(H(adminA.token))).status).toBe(404)
  })

  it('returns a null plan before the agent has run', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    const res = await request(app).get(`${BASE}/plan/${pursuit.id}`).set(H(adminA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.plan).toBeNull()
  })

  it('publishes the policy the UI displays', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    const res = await request(app).get(`${BASE}/plan/${pursuit.id}`).set(H(adminA.token))
    expect(res.body.data.policy.legalReviewBanner).toBe('REQUIRES LEGAL REVIEW — NOT EXECUTABLE')
    expect(res.body.data.policy.noSuitablePartnerMessage).toContain('in the current partner network')
    expect(res.body.data.policy.notes.join(' ')).toContain('never signs, executes, or clears legal review')
  })

  it('is readable by a consultant', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    expect((await request(app).get(`${BASE}/plan/${pursuit.id}`).set(H(consultantA.token))).status).toBe(200)
  })
})

describe(`${BASE}/goals`, () => {
  const goalBody = (over: Record<string, unknown> = {}) => ({
    goalType: 'SDVOSB', targetType: 'PERCENT', targetPercent: 20,
    source: 'SUBCONTRACTING_PLAN', sourceReference: 'Plan §3.2', ...over,
  })

  it('rejects a non-admin', async () => {
    expect((await request(app).post(`${BASE}/goals`).set(H(consultantA.token)).send(goalBody())).status).toBe(403)
  })

  it('records an obligation with the person who entered it', async () => {
    const res = await request(app).post(`${BASE}/goals`).set(H(adminA.token)).send(goalBody())
    expect(res.status).toBe(201)
    expect(res.body.data.goal.createdByUserId).toBe(adminA.id)
    // Not verified merely because it was entered.
    expect(res.body.data.goal.isHumanVerified).toBe(false)
  })

  it('refuses a percentage goal with no positive target', async () => {
    const res = await request(app).post(`${BASE}/goals`).set(H(adminA.token)).send(goalBody({ targetPercent: 0 }))
    expect(res.status).toBe(422)
    expect(res.body.error).toContain('greater than zero')
  })

  it('refuses an amount goal with no positive target', async () => {
    const res = await request(app).post(`${BASE}/goals`).set(H(adminA.token))
      .send(goalBody({ targetType: 'AMOUNT', targetPercent: undefined }))
    expect(res.status).toBe(422)
  })

  it('404s when the pursuit belongs to another firm', async () => {
    const opp = await makeOpportunity(firmB.id)
    const pursuit = await makePursuit(firmB.id, opp.id)
    const res = await request(app).post(`${BASE}/goals`).set(H(adminA.token)).send(goalBody({ pursuitId: pursuit.id }))
    expect(res.status).toBe(404)
  })

  it('stores a Decimal target exactly', async () => {
    const res = await request(app).post(`${BASE}/goals`).set(H(adminA.token)).send(goalBody({ targetPercent: 23.45 }))
    const goal = await prisma.subcontractingGoal.findUniqueOrThrow({ where: { id: res.body.data.goal.id } })
    expect(goal.targetPercent?.toFixed(2)).toBe('23.45')
  })

  it('audits the obligation', async () => {
    await request(app).post(`${BASE}/goals`).set(H(adminA.token)).send(goalBody())
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { consultingFirmId: firmA.id, entityType: 'SubcontractingGoal' },
    })
    expect(audit.actorUserId).toBe(adminA.id)
    expect(audit.rationale).toContain('SUBCONTRACTING_PLAN')
  })

  it('lists only this firm\'s goals', async () => {
    await request(app).post(`${BASE}/goals`).set(H(adminA.token)).send(goalBody())
    await request(app).post(`${BASE}/goals`).set(H(adminB.token)).send(goalBody())

    const res = await request(app).get(`${BASE}/goals`).set(H(adminA.token))
    expect(res.body.data.goals).toHaveLength(1)
  })

  it('lets an admin verify an obligation', async () => {
    const created = await request(app).post(`${BASE}/goals`).set(H(adminA.token)).send(goalBody())
    const res = await request(app).patch(`${BASE}/goals/${created.body.data.goal.id}`)
      .set(H(adminA.token)).send({ isHumanVerified: true })
    expect(res.status).toBe(200)
    expect(res.body.data.goal.isHumanVerified).toBe(true)
  })

  it('404s when patching another firm\'s goal', async () => {
    const created = await request(app).post(`${BASE}/goals`).set(H(adminB.token)).send(goalBody())
    const res = await request(app).patch(`${BASE}/goals/${created.body.data.goal.id}`)
      .set(H(adminA.token)).send({ isHumanVerified: true })
    expect(res.status).toBe(404)
  })
})

describe(`GET ${BASE}/performance`, () => {
  it('returns only this firm\'s records', async () => {
    const partnerB = await prisma.partner.create({
      data: { consultingFirmId: firmB.id, name: uniq('B'), uei: uniq('UEI') },
    })
    await prisma.partnerPerformanceRecord.create({
      data: {
        consultingFirmId: firmB.id, partnerId: partnerB.id,
        periodStart: new Date(Date.now() - 90 * DAY), periodEnd: new Date(), sampleSize: 12,
      },
    })
    const res = await request(app).get(`${BASE}/performance`).set(H(adminA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.records).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// There is no send route and no execute route
// -------------------------------------------------------------

describe('the API offers no way to execute or send', () => {
  it('declares no send, sign, execute or e-signature endpoint', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(join(__dirname, 'teamingAgent.ts'), 'utf8')
    const routes = [...src.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`)
    expect(routes.length).toBeGreaterThan(0)
    for (const route of routes) {
      expect(route.toLowerCase(), route).not.toMatch(/send|sign|execute|approve|transmit/)
    }
  })

  it('imports no mail transport', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(join(__dirname, 'teamingAgent.ts'), 'utf8').toLowerCase()
    for (const forbidden of ['nodemailer', 'emailservice', 'sendmail', 'twilio', 'sendgrid']) {
      expect(src, forbidden).not.toContain(forbidden)
    }
  })

  it('404s an invented send route rather than silently accepting it', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    const res = await request(app).post(`${BASE}/plan/${pursuit.id}/send`).set(H(adminA.token)).send({})
    expect(res.status).toBe(404)
  })
})
