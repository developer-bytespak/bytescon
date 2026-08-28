// =============================================================
// Ops heartbeat route (integration, live test DB; alerts mocked).
// This is the door host scripts (nightly backup) report through —
// it must fail closed on auth and record exactly what was reported.
// =============================================================
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'

vi.mock('../services/alertService', () => ({
  sendOpsAlert: vi.fn(async () => ({ sent: true, channels: ['email'] })),
}))

import { prisma } from '../config/database'
import { sendOpsAlert } from '../services/alertService'
import { buildTestApp } from '../test-utils/testClient'

const mockedAlert = vi.mocked(sendOpsAlert)

let app: Express
const TOKEN = 'test-ops-token-123'
let seq = 0
const uniq = (prefix: string) => `${prefix}-${Date.now()}-${process.pid}-${++seq}`
const createdJobs: string[] = []
const job = (prefix: string) => {
  const name = uniq(prefix).toLowerCase()
  createdJobs.push(name)
  return name
}
const savedToken = process.env.OPS_HEARTBEAT_TOKEN

beforeAll(() => {
  app = buildTestApp()
})

beforeEach(() => {
  process.env.OPS_HEARTBEAT_TOKEN = TOKEN
  vi.clearAllMocks()
})

afterAll(async () => {
  if (savedToken === undefined) delete process.env.OPS_HEARTBEAT_TOKEN
  else process.env.OPS_HEARTBEAT_TOKEN = savedToken
  await prisma.jobHeartbeat.deleteMany({ where: { jobName: { in: createdJobs } } })
  await prisma.$disconnect()
})

describe('POST /api/ops/heartbeat/:jobName', () => {
  it('answers 503 when the token is not configured (fail closed)', async () => {
    delete process.env.OPS_HEARTBEAT_TOKEN
    const res = await request(app).post(`/api/ops/heartbeat/${job('hb')}`).send({})
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('OPS_TOKEN_NOT_CONFIGURED')
  })

  it('rejects a wrong token with 401', async () => {
    const res = await request(app)
      .post(`/api/ops/heartbeat/${job('hb')}`)
      .set('X-Ops-Token', 'nope')
      .send({})
    expect(res.status).toBe(401)
  })

  it('rejects malformed job names', async () => {
    const res = await request(app)
      .post('/api/ops/heartbeat/Not%20A%20Job!')
      .set('X-Ops-Token', TOKEN)
      .send({})
    expect(res.status).toBe(400)
  })

  it('records a success heartbeat (default status)', async () => {
    const name = job('hb-ok')
    const res = await request(app)
      .post(`/api/ops/heartbeat/${name}`)
      .set('X-Ops-Token', TOKEN)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ jobName: name, status: 'success' })

    const row = await prisma.jobHeartbeat.findUnique({ where: { jobName: name } })
    expect(row?.lastSuccessAt).toBeTruthy()
    expect(mockedAlert).not.toHaveBeenCalled()
  })

  it('records a reported failure and pages immediately', async () => {
    const name = job('hb-fail')
    const res = await request(app)
      .post(`/api/ops/heartbeat/${name}`)
      .set('X-Ops-Token', TOKEN)
      .send({ status: 'failure', error: 'pg_dump exploded' })
    expect(res.status).toBe(200)

    const row = await prisma.jobHeartbeat.findUnique({ where: { jobName: name } })
    expect(row?.lastFailureAt).toBeTruthy()
    expect(row?.lastError).toBe('pg_dump exploded')
    expect(row?.lastSuccessAt).toBeNull()
    expect(mockedAlert).toHaveBeenCalledTimes(1)
    expect(mockedAlert.mock.calls[0][0]).toMatchObject({
      key: `job-reported-failure:${name}`,
      severity: 'critical',
    })
  })
})

describe('GET /api/ops/status', () => {
  it('requires the token', async () => {
    const res = await request(app).get('/api/ops/status')
    expect(res.status).toBe(401)
  })

  it('returns heartbeat rows', async () => {
    const name = job('hb-status')
    await request(app).post(`/api/ops/heartbeat/${name}`).set('X-Ops-Token', TOKEN).send({})
    const res = await request(app).get('/api/ops/status').set('X-Ops-Token', TOKEN)
    expect(res.status).toBe(200)
    const row = res.body.data.find((r: any) => r.jobName === name)
    expect(row).toBeTruthy()
    expect(row.lastSuccessAt).toBeTruthy()
  })
})
