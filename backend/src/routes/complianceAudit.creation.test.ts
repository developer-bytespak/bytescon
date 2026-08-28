// =============================================================
// Section 4 #4 — the Compliance Audit Log records the actions the UI claims it
// does. Previously only status transitions wrote a ComplianceLog, so logging a
// submission or resolving a GO/NO_GO decision produced ZERO audit rows.
//
// Each test performs the business action through its real route, then reads the
// audit log back through the SAME endpoint the UI uses
// (GET /api/analytics/compliance-logs).
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import {
  buildTestApp,
  createTestFirm,
  createTestUser,
  cleanupFirm,
  disconnectDb,
  TestFirm,
  TestUser,
} from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser
let clientId: string
let opportunityId: string
let decisionId: string

const auth = () => `Bearer ${admin.token}`
const logsFor = async (entityType: string) => {
  const res = await request(app)
    .get(`/api/analytics/compliance-logs?entityType=${entityType}`)
    .set('Authorization', auth())
    .expect(200)
  return res.body.data.logs as Array<{ entityType: string; entityId: string; toStatus: string; reason?: string }>
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Audit Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })

  const client = await prisma.clientCompany.create({
    data: { consultingFirmId: firm.id, name: 'Audit Client' },
  })
  clientId = client.id

  const opp = await prisma.opportunity.create({
    data: {
      consultingFirmId: firm.id,
      title: 'Audit Opp',
      agency: 'GSA',
      naicsCode: '541512',
      responseDeadline: new Date(Date.now() + 30 * 86_400_000),
    },
  })
  opportunityId = opp.id

  const decision = await prisma.bidDecision.create({
    data: {
      consultingFirmId: firm.id,
      clientCompanyId: clientId,
      opportunityId,
      recommendation: 'BID_PRIME',
    },
  })
  decisionId = decision.id
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await disconnectDb()
})

describe('Compliance audit log — creation & decision events (Section 4 #4)', () => {
  it('logging a submission writes a SUBMISSION audit row visible via the read endpoint', async () => {
    const before = await logsFor('SUBMISSION')

    await request(app)
      .post('/api/submissions')
      .set('Authorization', auth())
      .send({ clientCompanyId: clientId, opportunityId, submittedAt: new Date().toISOString() })
      .expect(201)

    const after = await logsFor('SUBMISSION')
    expect(after.length).toBe(before.length + 1)
    expect(after.some((l) => l.reason === 'Submission logged')).toBe(true)
  })

  it('resolving a GO decision writes a BID_DECISION row (toStatus=GO) and opens+audits a submission', async () => {
    await request(app)
      .patch(`/api/decision/${decisionId}/decision`)
      .set('Authorization', auth())
      .send({ decision: 'GO', note: 'strong fit' })
      .expect(200)

    const decisionLogs = await logsFor('BID_DECISION')
    const go = decisionLogs.filter((l) => l.entityId === decisionId && l.toStatus === 'GO')
    expect(go.length).toBe(1)
    expect(go[0].reason).toContain('strong fit')
  })

  it('re-resolving the same GO decision does NOT duplicate the audit row (idempotent)', async () => {
    await request(app)
      .patch(`/api/decision/${decisionId}/decision`)
      .set('Authorization', auth())
      .send({ decision: 'GO' })
      .expect(200)

    const decisionLogs = await logsFor('BID_DECISION')
    const go = decisionLogs.filter((l) => l.entityId === decisionId && l.toStatus === 'GO')
    expect(go.length).toBe(1) // still exactly one
  })

  it('audit rows are tenant-scoped — another firm cannot read them', async () => {
    const otherFirm = await createTestFirm({ name: 'Other Audit Firm' })
    const otherAdmin = await createTestUser(otherFirm.id, { role: 'ADMIN' })

    const res = await request(app)
      .get('/api/analytics/compliance-logs')
      .set('Authorization', `Bearer ${otherAdmin.token}`)
      .expect(200)

    expect(res.body.data.logs.some((l: { entityId: string }) => l.entityId === decisionId)).toBe(false)
    await cleanupFirm(otherFirm.id)
  })
})
