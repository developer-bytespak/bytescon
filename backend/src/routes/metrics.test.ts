// =============================================================
// Integration: GET /metrics (Prometheus exposition)
// Sprint 3.3 — covers the observability endpoint shipped in dc703b55.
// =============================================================
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { buildTestApp } from '../test-utils/testClient'

let app: Express

beforeAll(() => {
  app = buildTestApp()
})

afterEach(() => {
  delete process.env.METRICS_SECRET
})

describe('GET /metrics', () => {
  it('returns Prometheus exposition when METRICS_SECRET is unset', async () => {
    delete process.env.METRICS_SECRET
    const res = await request(app).get('/api/metrics')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/plain/)
    expect(res.text).toMatch(/bytescon_http_request_duration_seconds/)
    expect(res.text).toMatch(/# HELP/)
    expect(res.text).toMatch(/# TYPE/)
  })

  it('rejects requests with no token when METRICS_SECRET is set', async () => {
    process.env.METRICS_SECRET = 'shhh-very-secret'
    const res = await request(app).get('/api/metrics')
    expect(res.status).toBe(401)
    expect(res.text).toBe('unauthorized')
  })

  it('rejects requests with the wrong token', async () => {
    process.env.METRICS_SECRET = 'shhh-very-secret'
    const res = await request(app).get('/api/metrics?token=wrong-value')
    expect(res.status).toBe(401)
  })

  it('accepts ?token= query param when correct', async () => {
    process.env.METRICS_SECRET = 'shhh-very-secret'
    const res = await request(app).get('/api/metrics?token=shhh-very-secret')
    expect(res.status).toBe(200)
    expect(res.text).toMatch(/bytescon_/)
  })

  it('accepts Authorization: Bearer header when correct', async () => {
    process.env.METRICS_SECRET = 'shhh-very-secret'
    const res = await request(app)
      .get('/api/metrics')
      .set('Authorization', 'Bearer shhh-very-secret')
    expect(res.status).toBe(200)
    expect(res.text).toMatch(/bytescon_/)
  })

  it('exports the per-request counter incrementing as routes are hit', async () => {
    delete process.env.METRICS_SECRET
    // Generate a few requests so the counter is non-zero
    await request(app).get('/health')
    await request(app).get('/health')
    const res = await request(app).get('/api/metrics')
    expect(res.status).toBe(200)
    expect(res.text).toMatch(/bytescon_http_requests_total\{[^}]*\}\s+\d+/)
  })
})
