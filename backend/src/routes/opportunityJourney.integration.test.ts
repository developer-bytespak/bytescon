// =============================================================
// Status and next step: GET /api/opportunities/:id/journey, and the
// pipeline stage moving forward with the work (services/pursuitProgress.ts):
// starting a proposal → PROPOSAL, recording a submission → SUBMITTED.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const DAY = 86_400_000
let app: Express
let firm: TestFirm
let admin: TestUser

const makeOpp = () => prisma.opportunity.create({
  data: { consultingFirmId: firm.id, title: 'Journey notice', agency: 'GSA', naicsCode: '541512', responseDeadline: new Date(Date.now() + 30 * DAY) },
})
const stageOf = async (opportunityId: string) =>
  (await prisma.bidPursuit.findUniqueOrThrow({ where: { consultingFirmId_opportunityId: { consultingFirmId: firm.id, opportunityId } } })).pipelineStage
const journey = async (opportunityId: string) =>
  (await request(app).get(`/api/opportunities/${opportunityId}/journey`).set(H(admin.token)).expect(200)).body.data

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Journey Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
})
afterAll(async () => {
  await cleanupFirm(firm.id)
  await disconnectDb()
})

describe('opportunity journey', () => {
  it('reports the next step for a notice in each stage', async () => {
    const opp = await makeOpp()
    expect((await journey(opp.id)).status.text).toBe('Not in your pipeline yet.')
    await prisma.bidPursuit.create({ data: { consultingFirmId: firm.id, opportunityId: opp.id, pipelineStage: 'CAPTURE' } })
    const j = await journey(opp.id)
    expect(j).toMatchObject({ stage: 'CAPTURE', lastDone: 'Decision recorded: Bid.', status: { where: { label: 'Pipeline → Capture', to: '/pipeline' } } })
    expect(j.next.action.to).toBe(`/opportunities/${opp.id}/proposal`)
  })

  it('moves to PROPOSAL when a proposal is started, then to SUBMITTED when the submission is recorded', async () => {
    const opp = await makeOpp()
    await prisma.bidPursuit.create({ data: { consultingFirmId: firm.id, opportunityId: opp.id, pipelineStage: 'CAPTURE' } })

    await request(app).post(`/api/proposal/opportunity/${opp.id}`).set(H(admin.token)).send({ title: 'Our proposal' }).expect(201)
    expect(await stageOf(opp.id)).toBe('PROPOSAL')
    expect((await journey(opp.id)).next.text).toBe('Outline the proposal and draft its sections.')

    const sub = await request(app).post(`/api/submission/opportunity/${opp.id}`).set(H(admin.token)).send({ title: 'Package' }).expect(201)
    const id = sub.body.data.submission?.id ?? sub.body.data.id
    await request(app).post(`/api/submission/${id}/submit`).set(H(admin.token))
      .send({ submissionMethod: 'EMAIL', overrideReason: 'Submitted by email before the checklist was finished' }).expect(200)
    expect(await stageOf(opp.id)).toBe('SUBMITTED')
    const j = await journey(opp.id)
    expect(j.outcomeActions).toBe(true)
    expect(j.lastDone).toMatch(/^Proposal submitted on /)
  })

  it('never moves a pursuit that was closed or passed on', async () => {
    const opp = await makeOpp()
    await prisma.bidPursuit.create({ data: { consultingFirmId: firm.id, opportunityId: opp.id, pipelineStage: 'NO_BID' } })
    await request(app).post(`/api/proposal/opportunity/${opp.id}`).set(H(admin.token)).send({ title: 'Changed our mind?' }).expect(201)
    expect(await stageOf(opp.id)).toBe('NO_BID')
  })

  it('records each forward move like a manual one (event and audit)', async () => {
    const opp = await makeOpp()
    const pursuit = await prisma.bidPursuit.create({ data: { consultingFirmId: firm.id, opportunityId: opp.id, pipelineStage: 'CAPTURE' } })
    await request(app).post(`/api/proposal/opportunity/${opp.id}`).set(H(admin.token)).send({ title: 'Audited' }).expect(201)
    const audit = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, entityType: 'BidPursuit', entityId: pursuit.id }, orderBy: { createdAt: 'desc' } })
    expect(audit?.rationale).toBe('Stage CAPTURE → PROPOSAL: proposal started')
  })
})
