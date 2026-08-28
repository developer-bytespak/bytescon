// =============================================================
// FIX-3 — GET /api/firm/audit-log/export: firm-scoped audit trail as CSV.
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
let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'Audit Firm A' })
  firmB = await createTestFirm({ name: 'Audit Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  await prisma.auditEvent.createMany({
    data: [
      { consultingFirmId: firmA.id, action: 'CREATE', entityType: 'TestEntityA', entityId: 'a1' },
      { consultingFirmId: firmA.id, action: 'UPDATE', entityType: 'TestEntityA', entityId: 'a2', rationale: 'has, comma and "quote"' },
      { consultingFirmId: firmB.id, action: 'DELETE', entityType: 'TestEntityB', entityId: 'b1' },
    ],
  })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

describe('FIX-3 — /api/firm/audit-log/export', () => {
  it('exports the firm-scoped audit trail as escaped CSV, excluding other firms', async () => {
    const res = await request(app).get('/api/firm/audit-log/export').set('Authorization', `Bearer ${adminA.token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.text).toContain('timestamp,action,entityType')
    expect(res.text).toContain('TestEntityA')
    expect(res.text).not.toContain('TestEntityB') // tenant isolation
    expect(res.text).toContain('"has, comma and ""quote"""') // CSV escaping
  })

  it('rejects a non-admin (CONSULTANT) with 403', async () => {
    const consultant = await createTestUser(firmA.id, { role: 'CONSULTANT' })
    const res = await request(app).get('/api/firm/audit-log/export').set('Authorization', `Bearer ${consultant.token}`)
    expect(res.status).toBe(403)
  })
})
