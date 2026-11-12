// =============================================================
// The qualification flow: per-client scorecards pre-filled with suggested
// scores, no-bid reasons, quick no-bid, the "To qualify" queue and "why we
// pass" insights (routes/qualification.ts, services/qualificationQueue.ts).
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'
import { declinedOpportunityIds } from '../services/agents/bidDecisionGate'
import { refreshScorecardsForOpportunity } from '../services/qualificationRefresh'

const QUAL = '/api/qualification'
const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const DAY = 86_400_000

let app: Express
let consulting: TestFirm
let admin: TestUser
let clientA: string
let clientB: string
let contractor: TestFirm
let contractorAdmin: TestUser
let selfId: string

const makeOpp = (consultingFirmId: string, extra: Record<string, unknown> = {}) => prisma.opportunity.create({
  data: {
    consultingFirmId, title: 'Structured cabling upgrade', agency: 'Department of Veterans Affairs', naicsCode: '238210',
    description: 'Fiber optic backbone and structured cabling.', responseDeadline: new Date(Date.now() + 40 * DAY), ...extra,
  },
})
const makePursuit = async (consultingFirmId: string, extra: Record<string, unknown> = {}) => {
  const opp = await makeOpp(consultingFirmId, extra)
  const pursuit = await prisma.bidPursuit.create({ data: { consultingFirmId, opportunityId: opp.id } })
  return { opp, pursuit }
}
/** Score every criterion so a decision can be recorded. */
async function scoreAll(pursuitId: string, clientCompanyId: string, token: string, score = 80) {
  const sc = await request(app).get(`${QUAL}/${pursuitId}`).query({ clientCompanyId }).set(H(token)).expect(200)
  await request(app).patch(`${QUAL}/${pursuitId}/criteria`).query({ clientCompanyId }).set(H(token))
    .send({ scores: sc.body.data.scorecard.criteria.map((c: { key: string }) => ({ key: c.key, score })) }).expect(200)
}

beforeAll(async () => {
  app = buildTestApp()
  consulting = await createTestFirm({ name: 'Flow Consulting' })
  admin = await createTestUser(consulting.id, { role: 'ADMIN' })
  clientA = (await prisma.clientCompany.create({ data: { consultingFirmId: consulting.id, name: 'Cabling Co', naicsCodes: ['238210'], capabilityKeywords: ['structured cabling'], sdvosb: true } })).id
  clientB = (await prisma.clientCompany.create({ data: { consultingFirmId: consulting.id, name: 'Food Co', naicsCodes: ['311'] } })).id
  await prisma.pastPerformanceRecord.create({ data: { consultingFirmId: consulting.id, clientCompanyId: clientA, contractNumber: 'VA-1', customerName: 'VA Medical Center', customerAgency: 'Veterans Affairs' } })

  contractor = await createTestFirm({ name: 'Flow Contractor' })
  await prisma.consultingFirm.update({ where: { id: contractor.id }, data: { accountType: 'CONTRACTOR' } })
  selfId = (await prisma.clientCompany.create({ data: { consultingFirmId: contractor.id, name: 'Flow Contractor', isSelf: true, naicsCodes: ['238210'] } })).id
  contractorAdmin = await createTestUser(contractor.id, { role: 'ADMIN' })
})

afterAll(async () => {
  for (const f of [consulting, contractor]) await cleanupFirm(f.id)
  await disconnectDb()
})

describe('per-client scorecards with suggested scores', () => {
  it('asks a consulting firm with several clients which client it is qualifying for', async () => {
    const { pursuit } = await makePursuit(consulting.id)
    const res = await request(app).post(`${QUAL}/${pursuit.id}/start`).set(H(admin.token)).send({})
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/Choose which client/)
  })

  it('starts each client\'s scorecard pre-filled from that client\'s records, leaving judgement calls empty', async () => {
    const { pursuit } = await makePursuit(consulting.id)
    const a = await request(app).post(`${QUAL}/${pursuit.id}/start`).set(H(admin.token)).send({ clientCompanyId: clientA }).expect(201)
    const b = await request(app).post(`${QUAL}/${pursuit.id}/start`).set(H(admin.token)).send({ clientCompanyId: clientB }).expect(201)
    const crit = (r: request.Response, key: string) => r.body.data.scorecard.criteria.find((c: { key: string }) => c.key === key)

    expect(crit(a, 'capability_fit')).toMatchObject({ score: 90, suggestedScore: 90 })
    expect(crit(a, 'capability_fit').suggestionNote).toMatch(/NAICS 238210 is one of your codes/)
    expect(crit(b, 'capability_fit').score).toBe(15)
    expect(crit(a, 'past_performance').score).toBeGreaterThan(crit(b, 'past_performance').score)
    // Capacity has no data behind it, so the scorecard needs a person before deciding.
    expect(crit(a, 'capacity')).toMatchObject({ score: null, suggestedScore: null })
    expect(a.body.data.computed.recommendation).toBe('REVIEW_REQUIRED')
    expect(a.body.data.scorecard.id).not.toBe(b.body.data.scorecard.id)

    const view = await request(app).get(`${QUAL}/${pursuit.id}`).query({ clientCompanyId: clientA }).set(H(admin.token)).expect(200)
    expect(view.body.data.clients.map((c: { clientName: string }) => c.clientName).sort()).toEqual(['Cabling Co', 'Food Co'])
    expect(view.body.data.noBidReasons.length).toBeGreaterThan(3)
    expect(view.body.data.signals).toHaveProperty('winProbability')
  })

  it('keeps a person\'s scores when the suggestions are refreshed', async () => {
    const { pursuit } = await makePursuit(consulting.id)
    await request(app).post(`${QUAL}/${pursuit.id}/start`).set(H(admin.token)).send({ clientCompanyId: clientB }).expect(201)
    await request(app).patch(`${QUAL}/${pursuit.id}/criteria`).query({ clientCompanyId: clientB }).set(H(admin.token))
      .send({ scores: [{ key: 'capability_fit', score: 70 }] }).expect(200)
    await prisma.clientCompany.update({ where: { id: clientB }, data: { naicsCodes: ['311', '238210'] } })
    try {
      const res = await request(app).post(`${QUAL}/${pursuit.id}/suggestions/refresh`).query({ clientCompanyId: clientB }).set(H(admin.token)).expect(200)
      const fit = res.body.data.scorecard.criteria.find((c: { key: string }) => c.key === 'capability_fit')
      expect(fit).toMatchObject({ score: 70, suggestedScore: 80 })
    } finally {
      await prisma.clientCompany.update({ where: { id: clientB }, data: { naicsCodes: ['311'] } })
    }
  })

  it('uses a contractor\'s own company without being told', async () => {
    const { pursuit } = await makePursuit(contractor.id)
    const res = await request(app).post(`${QUAL}/${pursuit.id}/start`).set(H(contractorAdmin.token)).send({}).expect(201)
    expect((await prisma.scorecard.findUniqueOrThrow({ where: { id: res.body.data.scorecard.id } })).clientCompanyId).toBe(selfId)
  })
})

describe('pricing, strategic value and capacity suggestions', () => {
  it('suggests pricing from comparable public awards, then from your own priced scenario', async () => {
    const agency = 'Office of Qualification Testing'
    const { opp, pursuit } = await makePursuit(consulting.id, { naicsCode: '238291', agency, estimatedValue: 1_000_000 })
    // Ten comparable past awards: $0.7M–$1.3M.
    for (let k = 0; k < 10; k++) {
      await prisma.awardHistory.create({ data: { opportunityId: opp.id, awardingAgency: agency, recipientName: `Award ${k}`, awardAmount: 700_000 + k * 66_000, awardDate: new Date(Date.now() - (k + 1) * 30 * DAY), naics: '238291', contractNumber: `QT-${opp.id.slice(0, 6)}-${k}` } })
    }
    const started = await request(app).post(`${QUAL}/${pursuit.id}/start`).set(H(admin.token)).send({ clientCompanyId: clientA }).expect(201)
    const crit = (r: request.Response, key: string) => r.body.data.scorecard.criteria.find((c: { key: string }) => c.key === key)
    expect(crit(started, 'pricing')).toMatchObject({ score: 65, suggestedScore: 65 })
    expect(crit(started, 'pricing').suggestionNote).toMatch(/^Similar awards: .* The estimate of \$1\.0M is in that range/)
    // Strategic value: no past work with this agency, so market entry.
    expect(crit(started, 'strategic_value').score).toBe(65)
    expect(crit(started, 'capacity')).toMatchObject({ score: null })
    expect(crit(started, 'capacity').suggestionNote).toMatch(/To weigh: 0 active contracts, 0 other bids in progress/)

    // Price it: the suggestion now positions your own price.
    const ws = await prisma.pricingWorkspace.create({ data: { consultingFirmId: consulting.id, opportunityId: opp.id, clientCompanyId: clientA, title: 'Pricing' } })
    await prisma.pricingScenario.create({ data: { consultingFirmId: consulting.id, workspaceId: ws.id, name: 'Base', isPreferred: true, totalPrice: 1_000_000 } })
    const refreshed = await request(app).post(`${QUAL}/${pursuit.id}/suggestions/refresh`).query({ clientCompanyId: clientA }).set(H(admin.token)).expect(200)
    expect(crit(refreshed, 'pricing')).toMatchObject({ score: 80, suggestedScore: 80 })
    expect(crit(refreshed, 'pricing').suggestionNote).toMatch(/^Your price \$1\.0M is within the usual range/)
  })
})

describe('suggestions stay current', () => {
  it('refreshes an undecided scorecard when opened, keeping scores a person changed', async () => {
    const { pursuit, opp } = await makePursuit(consulting.id)
    await request(app).post(`${QUAL}/${pursuit.id}/start`).set(H(admin.token)).send({ clientCompanyId: clientA }).expect(201)
    await request(app).patch(`${QUAL}/${pursuit.id}/criteria`).query({ clientCompanyId: clientA }).set(H(admin.token))
      .send({ scores: [{ key: 'timeline', score: 10 }] }).expect(200)
    // Award history arrives after the scorecard was started.
    await prisma.opportunity.update({ where: { id: opp.id }, data: { isEnriched: true, offersReceived: 2, incumbentProbability: 0.7 } })

    const view = await request(app).get(`${QUAL}/${pursuit.id}`).query({ clientCompanyId: clientA }).set(H(admin.token)).expect(200)
    const crit = (key: string) => view.body.data.scorecard.criteria.find((c: { key: string }) => c.key === key)
    expect(crit('competition')).toMatchObject({ suggestedScore: 55, score: 55 }) // 60 + few bidders 15 − incumbent 20 (not set aside)
    expect(crit('timeline')).toMatchObject({ score: 10, suggestedScore: 90 }) // the person's 10 is kept
  })

  it('refreshes a notice\'s open scorecards when its award history arrives, but never a decided one', async () => {
    const { pursuit, opp } = await makePursuit(consulting.id)
    for (const c of [clientA, clientB]) await request(app).post(`${QUAL}/${pursuit.id}/start`).set(H(admin.token)).send({ clientCompanyId: c }).expect(201)
    await scoreAll(pursuit.id, clientB, admin.token, 30)
    await request(app).post(`${QUAL}/${pursuit.id}/decision`).set(H(admin.token)).send({ clientCompanyId: clientB, decision: 'NO_BID', noBidReason: 'CAPABILITY_GAP' }).expect(200)
    await prisma.opportunity.update({ where: { id: opp.id }, data: { isEnriched: true, offersReceived: 12 } })

    expect(await refreshScorecardsForOpportunity(opp.id)).toBe(1)
    const a = await prisma.scorecardCriterion.findFirstOrThrow({ where: { key: 'competition', scorecard: { bidPursuitId: pursuit.id, clientCompanyId: clientA } } })
    expect(a.suggestedScore).toBe(40) // 60 − many bidders 20 (not set aside)
    const b = await prisma.scorecardCriterion.findFirstOrThrow({ where: { key: 'competition', scorecard: { bidPursuitId: pursuit.id, clientCompanyId: clientB } } })
    expect(b.score).toBe(30) // decided: untouched
  })
})

describe('decisions per client', () => {
  it('requires a reason to pass, and only marks the pursuit NO_BID once every client passes', async () => {
    const { pursuit, opp } = await makePursuit(consulting.id)
    for (const c of [clientA, clientB]) {
      await request(app).post(`${QUAL}/${pursuit.id}/start`).set(H(admin.token)).send({ clientCompanyId: c }).expect(201)
      await scoreAll(pursuit.id, c, admin.token, 30)
    }
    const noReason = await request(app).post(`${QUAL}/${pursuit.id}/decision`).set(H(admin.token)).send({ clientCompanyId: clientA, decision: 'NO_BID' })
    expect(noReason.status).toBe(422)
    expect(noReason.body.error).toMatch(/why you are not bidding/)

    await request(app).post(`${QUAL}/${pursuit.id}/decision`).set(H(admin.token)).send({ clientCompanyId: clientA, decision: 'NO_BID', noBidReason: 'NO_CAPACITY' }).expect(200)
    expect((await prisma.bidPursuit.findUniqueOrThrow({ where: { id: pursuit.id } })).pipelineStage).not.toBe('NO_BID')
    expect(await declinedOpportunityIds(consulting.id, [opp.id])).toEqual(new Set())

    await request(app).post(`${QUAL}/${pursuit.id}/decision`).set(H(admin.token)).send({ clientCompanyId: clientB, decision: 'NO_BID', noBidReason: 'CAPABILITY_GAP' }).expect(200)
    expect((await prisma.bidPursuit.findUniqueOrThrow({ where: { id: pursuit.id } })).pipelineStage).toBe('NO_BID')
    expect(await declinedOpportunityIds(consulting.id, [opp.id])).toEqual(new Set([opp.id]))
  })

  it('moves the pursuit to capture when any client bids', async () => {
    const { pursuit } = await makePursuit(consulting.id)
    await request(app).post(`${QUAL}/${pursuit.id}/start`).set(H(admin.token)).send({ clientCompanyId: clientA }).expect(201)
    await scoreAll(pursuit.id, clientA, admin.token, 90)
    await request(app).post(`${QUAL}/${pursuit.id}/decision`).set(H(admin.token)).send({ clientCompanyId: clientA, decision: 'BID' }).expect(200)
    expect((await prisma.bidPursuit.findUniqueOrThrow({ where: { id: pursuit.id } })).pipelineStage).toBe('CAPTURE')
  })
})

describe('the qualify queue', () => {
  it('lists open undecided notices with readiness and passes on one without a full scorecard', async () => {
    const open = await makeOpp(consulting.id, { title: 'Queue cabling job' })
    const untyped = await makeOpp(consulting.id, { title: 'Queue untyped notice', noticeType: null })
    const award = await makeOpp(consulting.id, { title: 'Queue award', noticeType: 'Award Notice' })
    const expired = await makeOpp(consulting.id, { title: 'Queue expired', responseDeadline: new Date(Date.now() - DAY) })

    const res = await request(app).get(`${QUAL}/queue`).query({ clientCompanyId: clientA, limit: 100 }).set(H(admin.token)).expect(200)
    const ids = res.body.data.items.map((i: { opportunityId: string }) => i.opportunityId)
    expect(ids).toEqual(expect.arrayContaining([open.id, untyped.id]))
    expect(ids).not.toContain(award.id)
    expect(ids).not.toContain(expired.id)
    const item = res.body.data.items.find((i: { opportunityId: string }) => i.opportunityId === open.id)
    expect(item.readiness.verdict).toMatch(/READY|FIX_FIRST|NOT_ELIGIBLE/)
    expect(item.daysLeft).toBeGreaterThan(30)

    const pass = await request(app).post(`${QUAL}/opportunity/${open.id}/quick-no-bid`).set(H(admin.token))
      .send({ clientCompanyId: clientA, reason: 'TOO_COMPETITIVE', note: 'Strong incumbent' }).expect(200)
    const sc = await prisma.scorecard.findFirstOrThrow({ where: { bidPursuitId: pass.body.data.pursuitId, clientCompanyId: clientA } })
    expect(sc).toMatchObject({ finalDecision: 'NO_BID', noBidReason: 'TOO_COMPETITIVE', noBidNote: 'Strong incumbent', quickDecision: true })

    const after = await request(app).get(`${QUAL}/queue`).query({ clientCompanyId: clientA, limit: 100 }).set(H(admin.token)).expect(200)
    expect(after.body.data.items.map((i: { opportunityId: string }) => i.opportunityId)).not.toContain(open.id)
    // Client B hasn't decided, so it still sees the notice.
    const forB = await request(app).get(`${QUAL}/queue`).query({ clientCompanyId: clientB, limit: 100 }).set(H(admin.token)).expect(200)
    expect(forB.body.data.items.map((i: { opportunityId: string }) => i.opportunityId)).toContain(open.id)
  })

  it('refuses a quick no-bid without a reason, and from a team member', async () => {
    const opp = await makeOpp(consulting.id)
    const none = await request(app).post(`${QUAL}/opportunity/${opp.id}/quick-no-bid`).set(H(admin.token)).send({ clientCompanyId: clientA })
    expect(none.status).toBe(422)
    expect(none.body.error).toBe('Choose why you are not bidding')
    const member = await createTestUser(consulting.id, { role: 'CONSULTANT' })
    await request(app).post(`${QUAL}/opportunity/${opp.id}/quick-no-bid`).set(H(member.token)).send({ clientCompanyId: clientA, reason: 'OTHER' }).expect(403)
  })

  it('sums the reasons for passing', async () => {
    const res = await request(app).get(`${QUAL}/insights`).set(H(admin.token)).expect(200)
    const reasons = Object.fromEntries(res.body.data.noBidReasons.map((r: { reason: string; count: number }) => [r.reason, r.count]))
    expect(reasons.TOO_COMPETITIVE).toBeGreaterThanOrEqual(1)
    expect(reasons.NO_CAPACITY).toBeGreaterThanOrEqual(1)
    expect(res.body.data.quickNoBids).toBeGreaterThanOrEqual(1)
    expect(res.body.data.byDecision.NO_BID).toBeGreaterThanOrEqual(3)
  })
})
