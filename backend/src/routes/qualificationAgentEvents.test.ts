// =============================================================
// §7.4 — Qualification Agent HTTP surface and event wiring.
//
// Two things are proven here:
//   1. OPPORTUNITY_MATCH_HIGH is emitted on the CROSSING only, inside the same
//      transaction as the match write, so a rolled-back match emits nothing.
//   2. Accepting or rejecting a recommendation records the decision through the
//      one canonical human path, always with a real person as the actor.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb,
  type TestFirm, type TestUser,
} from '../test-utils/testClient'
import { persistMatch, type MatchComputation } from '../services/discovery/matchRefresh'
import { claimEvents } from '../services/agents/outbox'
import { dispatchAgentRun } from '../services/agents/dispatch'
import { createRun } from '../services/agents/runService'

const BASE = '/api/agents/qualification'
const DAY = 86_400_000

let app: Express
let firm: TestFirm
let admin: TestUser
let consultant: TestUser
let otherFirm: TestFirm
let otherAdmin: TestUser
let clientCompanyId: string

const H = (t: string) => ({ Authorization: `Bearer ${t}` })

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Qualification Agent Routes Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  otherFirm = await createTestFirm({ name: 'Qualification Agent Routes Other' })
  otherAdmin = await createTestUser(otherFirm.id, { role: 'ADMIN' })
  const client = await prisma.clientCompany.create({
    data: { consultingFirmId: firm.id, name: 'S7-QUAL-QA Client' },
  })
  clientCompanyId = client.id
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await cleanupFirm(otherFirm.id)
  await disconnectDb()
})

beforeEach(async () => {
  for (const id of [firm.id, otherFirm.id]) {
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.auditEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.qualificationRecommendation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.scorecardDecision.deleteMany({ where: { consultingFirmId: id } })
    await prisma.scorecard.deleteMany({ where: { consultingFirmId: id } })
    await prisma.gateReview.deleteMany({ where: { consultingFirmId: id } })
    await prisma.bidPursuit.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunityMatch.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
    await prisma.firmCapability.deleteMany({ where: { consultingFirmId: id } })
    await prisma.registrationProfile.deleteMany({ where: { consultingFirmId: id } })
  }
})

async function makeOpportunity(firmId: string, over: Record<string, unknown> = {}) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId: firmId, samNoticeId: uniq('S7-QUAL-QA-RT'),
      title: 'S7-QUAL-QA route solicitation', agency: 'Department of Defense',
      naicsCode: '541512', setAsideType: 'NONE',
      responseDeadline: new Date(Date.now() + 45 * DAY),
      status: 'ACTIVE', isDemo: false, probabilityScore: 90, isScored: true,
      ...over,
    },
  })
}

async function makePursuit(firmId: string, opportunityId: string, over: Record<string, unknown> = {}) {
  return prisma.bidPursuit.create({
    data: {
      consultingFirmId: firmId, opportunityId,
      pipelineStage: 'QUALIFICATION', status: 'REVIEWING', priority: 'MEDIUM',
      ...over,
    },
  })
}

/**
 * Enough real evidence for a NON-borderline call: verified outcomes for the
 * §6.2H interval engine, declared capacity, and a capability to assess against.
 * Without these a fresh tenant is legitimately borderline on everything.
 */
async function seedDecisiveEvidence(firmId: string) {
  await prisma.registrationProfile.create({
    data: {
      consultingFirmId: firmId, samStatus: 'ACTIVE',
      samExpiryDate: new Date(Date.now() + 400 * DAY), naicsCodes: ['541512'],
    },
  })
  await prisma.firmCapability.create({
    data: {
      consultingFirmId: firmId, name: 'S7-QUAL-QA cyber capability', category: 'TECHNICAL',
      naicsCodes: ['541512'], concurrentCapacity: 50, verification: 'VERIFIED',
    },
  })
  for (let i = 0; i < 24; i += 1) {
    const won = i % 4 !== 0
    const opp = await prisma.opportunity.create({
      data: {
        consultingFirmId: firmId, samNoticeId: uniq('S7-QUAL-QA-HIST'),
        title: `S7-QUAL-QA historical ${i}`, agency: 'Department of Defense',
        naicsCode: '541512', setAsideType: 'NONE',
        responseDeadline: new Date(Date.now() - (60 + i) * DAY),
        status: 'ARCHIVED', isDemo: false, probabilityScore: 92, isScored: true,
      },
    })
    await prisma.submissionRecord.create({
      data: {
        consultingFirmId: firmId, clientCompanyId, opportunityId: opp.id,
        submittedAt: new Date(Date.now() - (55 + i) * DAY),
        wasOnTime: true, status: 'APPROVED', outcome: won ? 'WON' : 'LOST',
      },
    })
  }
}

/**
 * A scorecard a HUMAN started and scored. The canonical decision path refuses to
 * record a decision without one, which is exactly the behaviour §7.4 relies on.
 */
async function startScorecard(firmId: string, pursuitId: string, opportunityId: string) {
  return prisma.scorecard.create({
    data: {
      consultingFirmId: firmId, bidPursuitId: pursuitId, opportunityId, status: 'IN_REVIEW',
      criteria: {
        create: [
          { key: 'capability', name: 'Capability', weight: 50, score: 80, required: true, displayOrder: 0 },
          { key: 'competition', name: 'Competition', weight: 50, score: 70, required: true, displayOrder: 1 },
        ],
      },
    },
  })
}

async function qualify(firmId: string) {
  const { run } = await createRun({
    consultingFirmId: firmId, agentKey: 'QUALIFICATION', triggerType: 'MANUAL',
    idempotencyKey: uniq('qual-route-run'),
  })
  await dispatchAgentRun(run.id)
  return run.id
}

const currentRecommendation = (firmId: string) =>
  prisma.qualificationRecommendation.findFirstOrThrow({
    where: { consultingFirmId: firmId, status: 'ACTIVE' }, orderBy: { version: 'desc' },
  })

// -------------------------------------------------------------
// OPPORTUNITY_MATCH_HIGH
// -------------------------------------------------------------

describe('OPPORTUNITY_MATCH_HIGH emission', () => {
  /** A minimal but real MatchComputation — persistMatch owns its own transaction. */
  const computation = (overallScore: number): MatchComputation => ({
    match: {
      overallScore,
      baseOverallScore: overallScore,
      weightProfile: 'BASE',
      appliedSignalId: null,
      dimensions: [
        { key: 'capability', label: 'Capability', weight: 1, score: overallScore, evidence: 'test', dataAvailable: true },
      ],
      matchedCapabilityIds: [],
      missingCapabilities: [],
      capacityWarning: null,
      dataLimitations: [],
      hasSufficientData: true,
      matchMethod: 'DETERMINISTIC',
      methodVersion: 'test-v1',
    } as unknown as MatchComputation['match'],
    eligibility: {
      state: 'ELIGIBLE',
      reason: 'test',
      evidence: [],
      requiredCertKeys: [],
      partnerCoverage: [],
      disclaimer: null,
      expiringCertificationIds: [],
    } as unknown as MatchComputation['eligibility'],
  })

  const persist = (opportunityId: string, score: number) =>
    persistMatch(firm.id, opportunityId, computation(score), new Date())

  it('emits when a match first crosses the high threshold', async () => {
    const opp = await makeOpportunity(firm.id)
    await persist(opp.id, 85)

    const events = await claimEvents('qual-test', 10, new Date(), { consultingFirmId: firm.id })
    expect(events.map((e) => e.eventType)).toContain('OPPORTUNITY_MATCH_HIGH')
  })

  it('does not emit for a low match', async () => {
    const opp = await makeOpportunity(firm.id)
    await persist(opp.id, 30)

    const events = await claimEvents('qual-test', 10, new Date(), { consultingFirmId: firm.id })
    expect(events.map((e) => e.eventType)).not.toContain('OPPORTUNITY_MATCH_HIGH')
  })

  it('does not emit again when a high match stays high', async () => {
    const opp = await makeOpportunity(firm.id)
    await persist(opp.id, 85)
    await claimEvents('qual-test', 10, new Date(), { consultingFirmId: firm.id })

    await persist(opp.id, 92)
    const second = await claimEvents('qual-test', 10, new Date(), { consultingFirmId: firm.id })
    expect(second.map((e) => e.eventType)).not.toContain('OPPORTUNITY_MATCH_HIGH')
  })

  it('emits again after the score drops below and crosses back', async () => {
    const opp = await makeOpportunity(firm.id)
    await persist(opp.id, 85)
    await claimEvents('qual-test', 10, new Date(), { consultingFirmId: firm.id })
    await persist(opp.id, 20)
    await claimEvents('qual-test', 10, new Date(), { consultingFirmId: firm.id })

    await persist(opp.id, 88)
    const third = await claimEvents('qual-test', 10, new Date(), { consultingFirmId: firm.id })
    expect(third.map((e) => e.eventType)).toContain('OPPORTUNITY_MATCH_HIGH')
  })

  it('carries the opportunity as the trigger entity', async () => {
    const opp = await makeOpportunity(firm.id)
    await persist(opp.id, 85)

    const events = await claimEvents('qual-test', 10, new Date(), { consultingFirmId: firm.id })
    const event = events.find((e) => e.eventType === 'OPPORTUNITY_MATCH_HIGH')!
    expect(event.entityType).toBe('Opportunity')
    expect(event.entityId).toBe(opp.id)
    expect(event.consultingFirmId).toBe(firm.id)
  })

  it('emits nothing when the match write itself fails', async () => {
    // A non-existent opportunity violates the foreign key inside the SAME
    // transaction that would have written the event.
    await expect(persist('00000000-0000-0000-0000-000000000000', 85)).rejects.toThrow()

    const events = await claimEvents('qual-test', 10, new Date(), { consultingFirmId: firm.id })
    expect(events.map((e) => e.eventType)).not.toContain('OPPORTUNITY_MATCH_HIGH')
  })

  it('never emits into another firm', async () => {
    const opp = await makeOpportunity(firm.id)
    await persist(opp.id, 85)
    expect(await claimEvents('qual-test', 10, new Date(), { consultingFirmId: otherFirm.id })).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// GET
// -------------------------------------------------------------

describe(`GET ${BASE}/:pursuitId`, () => {
  it('requires authentication', async () => {
    const res = await request(app).get(`${BASE}/some-id`)
    expect(res.status).toBe(401)
  })

  it('404s for a pursuit belonging to another firm', async () => {
    const opp = await makeOpportunity(otherFirm.id)
    const pursuit = await makePursuit(otherFirm.id, opp.id)
    const res = await request(app).get(`${BASE}/${pursuit.id}`).set(H(admin.token))
    expect(res.status).toBe(404)
  })

  it('returns a null recommendation before the agent has ever run', async () => {
    const opp = await makeOpportunity(firm.id)
    const pursuit = await makePursuit(firm.id, opp.id)

    const res = await request(app).get(`${BASE}/${pursuit.id}`).set(H(admin.token))
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.recommendation).toBeNull()
    expect(res.body.data.brief).toBeNull()
  })

  it('returns the recommendation, brief and policy after a run', async () => {
    const opp = await makeOpportunity(firm.id)
    const pursuit = await makePursuit(firm.id, opp.id)
    await qualify(firm.id)

    const res = await request(app).get(`${BASE}/${pursuit.id}`).set(H(admin.token))
    expect(res.status).toBe(200)
    expect(res.body.data.recommendation.pursuitId).toBe(pursuit.id)
    expect(res.body.data.brief.narrative.length).toBeGreaterThan(0)
    expect(res.body.data.policy.decisionBoundary).toBe(50)
    expect(res.body.data.policy.borderlineLower).toBe(40)
    expect(res.body.data.policy.borderlineUpper).toBe(60)
  })

  it('keeps the human decision separate from the agent recommendation', async () => {
    const opp = await makeOpportunity(firm.id)
    const pursuit = await makePursuit(firm.id, opp.id)
    await qualify(firm.id)

    const res = await request(app).get(`${BASE}/${pursuit.id}`).set(H(admin.token))
    expect(res.body.data).toHaveProperty('recommendation')
    expect(res.body.data).toHaveProperty('humanDecision')
    expect(res.body.data.humanDecision).toBeNull()
  })

  it('is readable by a non-admin consultant', async () => {
    const opp = await makeOpportunity(firm.id)
    const pursuit = await makePursuit(firm.id, opp.id)
    await qualify(firm.id)

    const res = await request(app).get(`${BASE}/${pursuit.id}`).set(H(consultant.token))
    expect(res.status).toBe(200)
  })
})

describe(`GET ${BASE}/:pursuitId/history`, () => {
  it('returns every version newest first', async () => {
    const opp = await makeOpportunity(firm.id, { probabilityScore: 90 })
    const pursuit = await makePursuit(firm.id, opp.id)
    await qualify(firm.id)
    await prisma.opportunity.update({ where: { id: opp.id }, data: { probabilityScore: 10 } })
    await qualify(firm.id)

    const res = await request(app).get(`${BASE}/${pursuit.id}/history`).set(H(admin.token))
    expect(res.status).toBe(200)
    expect(res.body.data.versions).toHaveLength(2)
    expect(res.body.data.versions[0].version).toBe(2)
    expect(res.body.data.versions[1].version).toBe(1)
    expect(res.body.data.versions[1].status).toBe('SUPERSEDED')
  })

  it('404s across firms', async () => {
    const opp = await makeOpportunity(otherFirm.id)
    const pursuit = await makePursuit(otherFirm.id, opp.id)
    const res = await request(app).get(`${BASE}/${pursuit.id}/history`).set(H(admin.token))
    expect(res.status).toBe(404)
  })
})

// -------------------------------------------------------------
// Accept — the human's decision, never the agent's
// -------------------------------------------------------------

describe(`POST ${BASE}/recommendation/:id/accept`, () => {
  async function activeBidRecommendation() {
    await seedDecisiveEvidence(firm.id)
    const opp = await makeOpportunity(firm.id, { probabilityScore: 90 })
    await prisma.opportunityMatch.create({
      data: {
        opportunityId: opp.id, consultingFirmId: firm.id, overallScore: 88,
        capabilityScore: 88, naicsScore: 95, evidence: {},
        eligibility: 'ELIGIBLE', eligibilityReason: 'seeded', eligibilityEvidence: {},
      },
    })
    const pursuit = await makePursuit(firm.id, opp.id)
    await startScorecard(firm.id, pursuit.id, opp.id)
    await qualify(firm.id)
    return { pursuit, recommendation: await currentRecommendation(firm.id) }
  }

  it('rejects a non-admin', async () => {
    const { recommendation } = await activeBidRecommendation()
    const res = await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/accept`)
      .set(H(consultant.token)).send({})
    expect(res.status).toBe(403)
  })

  it('rejects an unauthenticated caller', async () => {
    const { recommendation } = await activeBidRecommendation()
    const res = await request(app).post(`${BASE}/recommendation/${recommendation.id}/accept`).send({})
    expect(res.status).toBe(401)
  })

  it('404s across firms', async () => {
    const { recommendation } = await activeBidRecommendation()
    const res = await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/accept`)
      .set(H(otherAdmin.token)).send({})
    expect(res.status).toBe(404)
  })

  it('records the decision with the ADMIN as the actor', async () => {
    const { pursuit, recommendation } = await activeBidRecommendation()
    const res = await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/accept`)
      .set(H(admin.token)).send({})
    expect(res.status).toBe(200)

    const scorecard = await prisma.scorecard.findFirstOrThrow({ where: { bidPursuitId: pursuit.id } })
    expect(scorecard.finalDecision).toBe('BID')
    expect(scorecard.decidedByUserId).toBe(admin.id)
  })

  it('marks the recommendation ACCEPTED and stores the human decision beside it', async () => {
    const { recommendation } = await activeBidRecommendation()
    await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/accept`)
      .set(H(admin.token)).send({})

    const after = await prisma.qualificationRecommendation.findUniqueOrThrow({ where: { id: recommendation.id } })
    expect(after.status).toBe('ACCEPTED')
    expect(after.acceptedByUserId).toBe(admin.id)
    expect(after.humanDecision).toBe('BID')
    // The agent's own result is untouched.
    expect(after.recommendation).toBe(recommendation.recommendation)
    expect(after.narrative).toBe(recommendation.narrative)
  })

  it('writes a ScorecardDecision history row through the canonical path', async () => {
    const { pursuit, recommendation } = await activeBidRecommendation()
    await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/accept`)
      .set(H(admin.token)).send({})

    const history = await prisma.scorecardDecision.findMany({ where: { consultingFirmId: firm.id } })
    expect(history).toHaveLength(1)
    expect(history[0].changedByUserId).toBe(admin.id)
    expect(history[0].bidPursuitId).toBe(pursuit.id)
  })

  it('writes an audit entry naming both the agent result and the human decision', async () => {
    const { recommendation } = await activeBidRecommendation()
    await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/accept`)
      .set(H(admin.token)).send({})

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { consultingFirmId: firm.id, entityType: 'QualificationRecommendation' },
    })
    expect(audit.actorUserId).toBe(admin.id)
    expect(audit.rationale).toContain('Agent recommended')
    expect(audit.rationale).toContain('accepted by an administrator')
  })

  it('refuses to accept twice', async () => {
    const { recommendation } = await activeBidRecommendation()
    await request(app).post(`${BASE}/recommendation/${recommendation.id}/accept`).set(H(admin.token)).send({})
    const second = await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/accept`)
      .set(H(admin.token)).send({})
    expect(second.status).toBe(422)
    expect(second.body.error).toContain('ACCEPTED')
  })

  it('requires an explicit decision when the agent reached no conclusion', async () => {
    const opp = await makeOpportunity(firm.id, { isScored: false, probabilityScore: 0 })
    await makePursuit(firm.id, opp.id)
    await qualify(firm.id)
    const recommendation = await currentRecommendation(firm.id)
    expect(recommendation.recommendation).toBe('INSUFFICIENT_DATA')

    const res = await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/accept`)
      .set(H(admin.token)).send({})
    expect(res.status).toBe(422)
    expect(res.body.error).toContain('Choose the decision explicitly')
  })

  it('refuses when no human has started a scorecard', async () => {
    await seedDecisiveEvidence(firm.id)
    const opp = await makeOpportunity(firm.id, { probabilityScore: 90 })
    await makePursuit(firm.id, opp.id)
    await qualify(firm.id)
    const recommendation = await currentRecommendation(firm.id)

    const res = await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/accept`)
      .set(H(admin.token)).send({ decision: 'BID' })
    expect(res.status).toBe(404)
    expect(res.body.error).toContain('Scorecard not started')
    expect(
      (await prisma.qualificationRecommendation.findUniqueOrThrow({ where: { id: recommendation.id } })).status,
    ).toBe('ACTIVE')
  })

  it('accepts an explicit decision on a borderline recommendation', async () => {
    const opp = await makeOpportunity(firm.id, { probabilityScore: 52 })
    const pursuit = await makePursuit(firm.id, opp.id)
    await startScorecard(firm.id, pursuit.id, opp.id)
    await qualify(firm.id)
    const recommendation = await currentRecommendation(firm.id)
    expect(recommendation.recommendation).toBe('BORDERLINE_REVIEW')

    const res = await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/accept`)
      .set(H(admin.token)).send({ decision: 'NO_BID', overrideReason: 'The scorecard favours a bid; the reviewer disagrees on capacity.' })
    expect(res.status).toBe(200)
    expect(res.body.data.recommendation.humanDecision).toBe('NO_BID')
  })
})

// -------------------------------------------------------------
// Reject
// -------------------------------------------------------------

describe(`POST ${BASE}/recommendation/:id/reject`, () => {
  async function activeBidRecommendation() {
    await seedDecisiveEvidence(firm.id)
    const opp = await makeOpportunity(firm.id, { probabilityScore: 90 })
    await prisma.opportunityMatch.create({
      data: {
        opportunityId: opp.id, consultingFirmId: firm.id, overallScore: 88,
        capabilityScore: 88, naicsScore: 95, evidence: {},
        eligibility: 'ELIGIBLE', eligibilityReason: 'seeded', eligibilityEvidence: {},
      },
    })
    const pursuit = await makePursuit(firm.id, opp.id)
    await startScorecard(firm.id, pursuit.id, opp.id)
    await qualify(firm.id)
    return { pursuit, recommendation: await currentRecommendation(firm.id) }
  }

  it('rejects a non-admin', async () => {
    const { recommendation } = await activeBidRecommendation()
    const res = await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/reject`)
      .set(H(consultant.token)).send({ decision: 'NO_BID' })
    expect(res.status).toBe(403)
  })

  it('requires the human to state their own decision', async () => {
    const { recommendation } = await activeBidRecommendation()
    const res = await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/reject`)
      .set(H(admin.token)).send({})
    expect(res.status).toBe(422)
  })

  it('preserves the agent recommendation and records the human decision beside it', async () => {
    const { recommendation } = await activeBidRecommendation()
    expect(recommendation.recommendation).toBe('RECOMMEND_BID')

    const res = await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/reject`)
      .set(H(admin.token)).send({ decision: 'NO_BID', overrideReason: 'Capacity is committed elsewhere.' })
    expect(res.status).toBe(200)

    const after = await prisma.qualificationRecommendation.findUniqueOrThrow({ where: { id: recommendation.id } })
    expect(after.status).toBe('REJECTED')
    expect(after.recommendation).toBe('RECOMMEND_BID')
    expect(after.humanDecision).toBe('NO_BID')
    expect(after.rejectedByUserId).toBe(admin.id)
  })

  it('records the human decision on the scorecard, not the agent\'s', async () => {
    const { pursuit, recommendation } = await activeBidRecommendation()
    await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/reject`)
      .set(H(admin.token)).send({ decision: 'NO_BID', overrideReason: 'Capacity is committed elsewhere.' })

    const scorecard = await prisma.scorecard.findFirstOrThrow({ where: { bidPursuitId: pursuit.id } })
    expect(scorecard.finalDecision).toBe('NO_BID')
    expect(scorecard.decidedByUserId).toBe(admin.id)
  })

  it('audits the disagreement as a decision override', async () => {
    const { recommendation } = await activeBidRecommendation()
    await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/reject`)
      .set(H(admin.token)).send({ decision: 'NO_BID', overrideReason: 'Capacity is committed elsewhere.' })

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { consultingFirmId: firm.id, entityType: 'QualificationRecommendation' },
    })
    expect(audit.action).toBe('DECISION_OVERRIDE')
    expect(audit.rationale).toContain('a human decided NO_BID instead')
  })

  it('404s across firms', async () => {
    const { recommendation } = await activeBidRecommendation()
    const res = await request(app)
      .post(`${BASE}/recommendation/${recommendation.id}/reject`)
      .set(H(otherAdmin.token)).send({ decision: 'NO_BID' })
    expect(res.status).toBe(404)
  })
})

// -------------------------------------------------------------
// The decision still belongs to a person
// -------------------------------------------------------------

describe('no decision exists until a person makes one', () => {
  it('leaves the scorecard undecided no matter how many times the agent runs', async () => {
    const opp = await makeOpportunity(firm.id, { probabilityScore: 95 })
    const pursuit = await makePursuit(firm.id, opp.id)
    await qualify(firm.id)
    await qualify(firm.id)
    await qualify(firm.id)

    const scorecard = await prisma.scorecard.findFirst({ where: { bidPursuitId: pursuit.id } })
    expect(scorecard?.finalDecision ?? null).toBeNull()
    expect(await prisma.scorecardDecision.count({ where: { consultingFirmId: firm.id } })).toBe(0)
    expect(await prisma.bidDecision.count({ where: { consultingFirmId: firm.id } })).toBe(0)
  })

  it('reports the recommendation as still ACTIVE and awaiting a person', async () => {
    const opp = await makeOpportunity(firm.id, { probabilityScore: 95 })
    const pursuit = await makePursuit(firm.id, opp.id)
    await qualify(firm.id)

    const res = await request(app).get(`${BASE}/${pursuit.id}`).set(H(admin.token))
    expect(res.body.data.recommendation.status).toBe('ACTIVE')
    expect(res.body.data.recommendation.humanDecision).toBeNull()
    expect(res.body.data.recommendation.acceptedByUserId).toBeNull()
    expect(res.body.data.recommendation.rejectedByUserId).toBeNull()
  })
})
