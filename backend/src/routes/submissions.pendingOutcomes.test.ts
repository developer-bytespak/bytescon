// =============================================================
// FIX-1 flywheel — GET /api/submissions/pending-outcomes surfaces pursued bids
// awaiting a WON/LOST outcome (the nudge) and reports the capture-rate gauge.
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

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Flywheel Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  const client = await prisma.clientCompany.create({
    data: { consultingFirmId: firm.id, name: 'Flywheel Client' },
  })
  const past = new Date(Date.now() - 7 * 86_400_000)

  // Opp A + submission awaiting outcome (deadline passed, outcome still null).
  const oppA = await prisma.opportunity.create({
    data: { consultingFirmId: firm.id, title: 'Opp A', agency: 'GSA', naicsCode: '541512', responseDeadline: past },
  })
  await prisma.submissionRecord.create({
    data: { consultingFirmId: firm.id, clientCompanyId: client.id, opportunityId: oppA.id },
  })

  // Opp B + submission WITH an outcome recorded (should not be "pending").
  const oppB = await prisma.opportunity.create({
    data: { consultingFirmId: firm.id, title: 'Opp B', agency: 'VA', naicsCode: '541512', responseDeadline: past },
  })
  await prisma.submissionRecord.create({
    data: {
      consultingFirmId: firm.id,
      clientCompanyId: client.id,
      opportunityId: oppB.id,
      outcome: 'WON',
      outcomeRecordedAt: new Date(),
    },
  })
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await disconnectDb()
})

describe('FIX-1 flywheel — GET /api/submissions/pending-outcomes', () => {
  it('lists only deadline-passed submissions awaiting an outcome, with a capture-rate gauge', async () => {
    const res = await request(app)
      .get('/api/submissions/pending-outcomes')
      .set('Authorization', `Bearer ${admin.token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].opportunity.title).toBe('Opp A')
    expect(res.body.meta.total).toBe(2)
    expect(res.body.meta.withOutcome).toBe(1)
    expect(res.body.meta.captureRatePct).toBe(50)
  })
})
