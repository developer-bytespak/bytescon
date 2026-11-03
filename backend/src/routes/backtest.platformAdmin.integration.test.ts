// =============================================================
// B8 — the model backtest is for platform operators only.
//
// /api/admin/backtest holds platform-wide data (runs started by any firm, the
// Who-Wins model) and its calibration refresh changes the scoring curve used by
// every firm. A firm's own ADMIN must not reach any of it; an operator listed in
// PLATFORM_ADMIN_EMAILS can.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

const BASE = '/api/admin/backtest'
const ORIGINAL = process.env.PLATFORM_ADMIN_EMAILS

let app: Express
let firm: TestFirm
let firmAdmin: TestUser
let operator: TestUser

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

const ROUTES: Array<['get' | 'post', string]> = [
  ['post', '/run'],
  ['post', '/calibration/refresh'],
  ['get', '/runs'],
  ['get', '/runs/00000000-0000-0000-0000-000000000000'],
  ['get', '/calibration/status'],
  ['get', '/who-wins/status'],
]

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'B8 Backtest Firm' })
  firmAdmin = await createTestUser(firm.id, { role: 'ADMIN' })
  operator = await createTestUser(firm.id, { role: 'ADMIN' })
  process.env.PLATFORM_ADMIN_EMAILS = operator.email
})

afterAll(async () => {
  if (ORIGINAL === undefined) delete process.env.PLATFORM_ADMIN_EMAILS
  else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL
  await cleanupFirm(firm.id)
  await disconnectDb()
})

describe('a firm admin who is not a platform operator', () => {
  it.each(ROUTES)('is refused on %s %s', async (method, path) => {
    const res = await request(app)[method](`${BASE}${path}`).set(auth(firmAdmin.token)).send({ sampleSize: 50 })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toMatch(/Platform administrator access required/)
  })
})

describe('with no platform operators configured', () => {
  it('refuses everyone, including firm admins', async () => {
    process.env.PLATFORM_ADMIN_EMAILS = ''
    try {
      const res = await request(app).get(`${BASE}/calibration/status`).set(auth(operator.token))
      expect(res.status).toBe(403)
    } finally {
      process.env.PLATFORM_ADMIN_EMAILS = operator.email
    }
  })
})

describe('a platform operator', () => {
  it('can read the calibration status and run list', async () => {
    expect((await request(app).get(`${BASE}/calibration/status`).set(auth(operator.token))).status).toBe(200)
    expect((await request(app).get(`${BASE}/runs`).set(auth(operator.token))).status).toBe(200)
    expect((await request(app).get(`${BASE}/who-wins/status`).set(auth(operator.token))).status).toBe(200)
  })

  it('can refresh the calibration curve', async () => {
    const res = await request(app).post(`${BASE}/calibration/refresh`).set(auth(operator.token))
    expect(res.status).toBe(200)
  })
})
