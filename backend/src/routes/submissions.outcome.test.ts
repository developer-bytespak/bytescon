// =============================================================
// Integration: PATCH /api/submissions/:id/outcome
// Sprint 3.3 — covers the outcome-tracking endpoint shipped in 0a488539.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import {
  buildTestApp,
  createTestFirm,
  createTestUser,
  createTestClient,
  createTestOpportunity,
  createTestSubmission,
  cleanupFirm,
  disconnectDb,
  TestFirm,
  TestUser,
} from '../test-utils/factories'
import { prisma } from '../config/database'

let app: Express
let firm: TestFirm
let admin: TestUser
let consultant: TestUser

beforeAll(async () => {
  app = buildTestApp()
})

beforeEach(async () => {
  firm = await createTestFirm({ name: 'Outcome Test Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
})

afterAll(async () => {
  await cleanupFirm(firm?.id).catch(() => {})
  await disconnectDb()
})

async function seedSubmission() {
  const client = await createTestClient(firm.id)
  const opp = await createTestOpportunity(firm.id)
  return createTestSubmission(firm.id, client.id, opp.id, { submittedById: admin.id })
}

describe('PATCH /api/submissions/:id/outcome', () => {
  it('admin can record WON outcome and gets back updated row', async () => {
    const submission = await seedSubmission()
    const res = await request(app)
      .patch(`/api/submissions/${submission.id}/outcome`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ outcome: 'WON', notes: 'Award notice received' })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.outcome).toBe('WON')
    expect(res.body.data.outcomeRecordedAt).toBeTruthy()

    const persisted = await prisma.submissionRecord.findUnique({ where: { id: submission.id } })
    expect(persisted?.outcome).toBe('WON')
    expect(persisted?.outcomeNotes).toBe('Award notice received')
  })

  it('consultant role is rejected with 403', async () => {
    const submission = await seedSubmission()
    const res = await request(app)
      .patch(`/api/submissions/${submission.id}/outcome`)
      .set('Authorization', `Bearer ${consultant.token}`)
      .send({ outcome: 'LOST' })
    expect(res.status).toBe(403)
    expect(res.body.success).toBe(false)
  })

  it('rejects an unknown outcome value with 422 / VALIDATION_ERROR', async () => {
    const submission = await seedSubmission()
    const res = await request(app)
      .patch(`/api/submissions/${submission.id}/outcome`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ outcome: 'MAYBE' })
    expect(res.status).toBe(422)
    expect(res.body.success).toBe(false)
  })

  it('admin from a DIFFERENT firm cannot record outcome (tenant isolation)', async () => {
    const submission = await seedSubmission()
    const otherFirm = await createTestFirm({ name: 'Other Firm' })
    const otherAdmin = await createTestUser(otherFirm.id, { role: 'ADMIN' })

    const res = await request(app)
      .patch(`/api/submissions/${submission.id}/outcome`)
      .set('Authorization', `Bearer ${otherAdmin.token}`)
      .send({ outcome: 'WON' })
    expect(res.status).toBe(404)
    expect(res.body.success).toBe(false)

    const persisted = await prisma.submissionRecord.findUnique({ where: { id: submission.id } })
    expect(persisted?.outcome).toBeNull()

    await cleanupFirm(otherFirm.id).catch(() => {})
  })

  it('writes an AUDIT_EVENT row capturing the outcome change', async () => {
    const submission = await seedSubmission()
    await request(app)
      .patch(`/api/submissions/${submission.id}/outcome`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ outcome: 'LOST' })
    // Audit writes are fire-and-forget — give them a tick.
    await new Promise((r) => setTimeout(r, 60))
    const events = await prisma.auditEvent.findMany({
      where: {
        consultingFirmId: firm.id,
        entityType: 'SubmissionRecord',
        entityId: submission.id,
      },
    })
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events.some((e) => (e.rationale ?? '').includes('LOST'))).toBe(true)
  })
})
