// =============================================================
// SECTION 7 — NINE-AGENT ACCEPTANCE AUDIT (authorization / IDOR)
//
// The per-slice suites each check their own routes. This file sweeps the
// WHOLE Section 7 HTTP surface at once and asks three questions of every
// endpoint:
//
//   1. Does it reject an anonymous caller?
//   2. Does it apply the platform's role model?
//   3. Given a VALID id belonging to another firm, does it refuse rather than
//      leak?
//
// The third is the one that matters. A route that filters by id alone will
// pass every single-tenant test ever written and still hand Firm A's runs to
// Firm B the first time someone guesses a uuid.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb,
  type TestFirm, type TestUser,
} from '../test-utils/testClient'
import { createRun } from '../services/agents/runService'
import { DOMAIN_AGENT_KEYS } from '../services/agents/types'

let app: Express
let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let consultantA: TestUser
let adminB: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

/** Firm B records with real ids, for the IDOR sweep. */
let bRunId: string
let bArtifactId: string
let bEscalationId: string
let bRecommendationId: string
let bNarrativeId: string
let bActualRateId: string

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'S7 Authz Firm A' })
  firmB = await createTestFirm({ name: 'S7 Authz Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  consultantA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })

  // Populate Firm B so every IDOR probe has a real, guessable target.
  const { run } = await createRun({
    consultingFirmId: firmB.id, agentKey: 'INTELLIGENCE', triggerType: 'MANUAL', idempotencyKey: uniq('b-run'),
  })
  bRunId = run.id

  bArtifactId = (await prisma.agentArtifact.create({
    data: {
      consultingFirmId: firmB.id, runId: bRunId, agentKey: 'INTELLIGENCE',
      artifactType: 'PORTFOLIO_INTELLIGENCE', title: 'FIRM B PRIVATE ANALYSIS',
      structuredData: { secret: 'FIRM_B_ONLY' },
    },
  })).id

  bEscalationId = (await prisma.agentEscalation.create({
    data: {
      consultingFirmId: firmB.id, runId: bRunId, agentKey: 'INTELLIGENCE', severity: 'HIGH',
      title: 'FIRM B PRIVATE ESCALATION', reason: 'FIRM_B_ONLY', dedupeKey: uniq('b-esc'),
    },
  })).id

  bRecommendationId = (await prisma.captureRecommendation.create({
    data: {
      consultingFirmId: firmB.id, segmentType: 'AGENCY', segmentKey: 'DoD', segmentLabel: 'FIRM B SEGMENT',
      periodStart: new Date(), periodEnd: new Date(), scoreState: 'SCORED', rank: 1,
      rationale: 'FIRM_B_ONLY', evidence: {}, sampleSize: 10, dataSufficiency: 'SUFFICIENT',
      inputHash: uniq('b-hash'), algorithmVersion: 'v1',
    },
  })).id

  bNarrativeId = (await prisma.capabilityNarrative.create({
    data: { consultingFirmId: firmB.id, title: 'FIRM B CAPABILITY', category: 'TECHNICAL_NARRATIVE' },
  })).id

  bActualRateId = (await prisma.actualIndirectRate.create({
    data: {
      consultingFirmId: firmB.id, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-06-30'),
      fiscalYear: 2026, rateType: 'FRINGE', actualRate: '99.0000',
    },
  })).id
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

// =============================================================
// 1. Anonymous access
// =============================================================

/** Every read surface the nine agents expose. */
const READ_ENDPOINTS = [
  '/api/agents/definitions',
  '/api/agents/overview',
  '/api/agents/schedules',
  '/api/agents/runs',
  '/api/agents/artifacts',
  '/api/agents/escalations',
  '/api/agents/notification-preferences',
  '/api/agents/intelligence/portfolio',
  '/api/agents/intelligence/segments',
  '/api/agents/intelligence/recommendations',
  '/api/agents/finance/status',
  '/api/agents/finance/readiness',
  '/api/agents/finance/cash-flow',
  '/api/agents/finance/actual-rates',
  '/api/agents/proposal/library',
]

describe('audit: no Section 7 endpoint answers an anonymous caller', () => {
  it.each(READ_ENDPOINTS)('%s rejects an unauthenticated request', async (path) => {
    const res = await request(app).get(path)
    expect(res.status, `${path} answered ${res.status}`).toBe(401)
  })

  it('rejects an anonymous write to every mutating surface', async () => {
    const writes: Array<[string, string]> = [
      ['post', '/api/agents/runs'],
      ['put', '/api/agents/schedules/INTELLIGENCE'],
      ['post', '/api/agents/artifacts/any-id/verify'],
      ['post', '/api/agents/intelligence/recommendations/any-id/dismiss'],
      ['post', '/api/agents/finance/actual-rates'],
      ['post', '/api/agents/proposal/library'],
    ]
    for (const [method, path] of writes) {
      const res = await (request(app) as never as Record<string, (p: string) => request.Test>)[method](path).send({})
      expect(res.status, `${method.toUpperCase()} ${path} answered ${res.status}`).toBe(401)
    }
  })

  it('rejects a garbage bearer token', async () => {
    expect((await request(app).get('/api/agents/overview').set(H('not-a-real-token'))).status).toBe(401)
  })
})

// =============================================================
// 2. Role model
// =============================================================

describe('audit: the platform role model holds across Section 7', () => {
  it('lets a team member READ the agent surface', async () => {
    for (const path of ['/api/agents/overview', '/api/agents/runs', '/api/agents/escalations']) {
      expect((await request(app).get(path).set(H(consultantA.token))).status, path).toBe(200)
    }
  })

  it('refuses every Section 7 WRITE from a team member', async () => {
    const writes: Array<[string, string, object]> = [
      ['post', '/api/agents/runs', { agentKey: 'INTELLIGENCE' }],
      ['put', '/api/agents/schedules/INTELLIGENCE', { isEnabled: true }],
      ['post', '/api/agents/finance/actual-rates', {
        periodStart: '2026-01-01', periodEnd: '2026-06-30', fiscalYear: 2026, rateType: 'FRINGE', actualRate: '30',
      }],
      ['post', '/api/agents/proposal/library', { title: 'x', category: 'TECHNICAL_NARRATIVE' }],
    ]
    for (const [method, path, body] of writes) {
      const res = await (request(app) as never as Record<string, (p: string) => request.Test>)[method](path)
        .set(H(consultantA.token)).send(body)
      expect(res.status, `${method.toUpperCase()} ${path} answered ${res.status}`).toBe(403)
    }
  })

  it('lets an admin perform those same writes', async () => {
    const res = await request(app).post('/api/agents/runs').set(H(adminA.token)).send({ agentKey: 'INTELLIGENCE' })
    expect([200, 201]).toContain(res.status)
  })
})

// =============================================================
// 3. IDOR — the sweep that matters
// =============================================================

describe('audit: IDOR across every Section 7 surface', () => {
  /**
   * A refusal is 403, 404 or 422.
   *
   * 422 is the artifact-verify convention: that route deliberately conflates
   * "no such artifact" with "already verified" so it discloses neither. What
   * matters is that it refuses and leaks nothing.
   */
  const refused = (status: number) => status === 403 || status === 404 || status === 422

  it('never serves Firm B’s agent run to Firm A', async () => {
    const res = await request(app).get(`/api/agents/runs/${bRunId}`).set(H(adminA.token))
    expect(refused(res.status), `answered ${res.status}`).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain(firmB.id)
  })

  it('never serves Firm B’s artifact to Firm A', async () => {
    const res = await request(app).get(`/api/agents/artifacts/${bArtifactId}`).set(H(adminA.token))
    expect(refused(res.status), `answered ${res.status}`).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain('FIRM_B_ONLY')
  })

  it('never serves Firm B’s escalation to Firm A', async () => {
    const res = await request(app).get(`/api/agents/escalations/${bEscalationId}`).set(H(adminA.token))
    expect(refused(res.status), `answered ${res.status}`).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain('FIRM_B_ONLY')
  })

  it('never lets Firm A verify Firm B’s artifact', async () => {
    const res = await request(app).post(`/api/agents/artifacts/${bArtifactId}/verify`).set(H(adminA.token)).send({})
    expect(refused(res.status), `answered ${res.status}`).toBe(true)
    const after = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: bArtifactId } })
    expect(after.isHumanVerified, 'Firm B artifact must remain unverified').toBe(false)
  })

  it('never lets Firm A cancel Firm B’s run', async () => {
    const res = await request(app).post(`/api/agents/runs/${bRunId}/cancel`).set(H(adminA.token)).send({})
    expect(refused(res.status), `answered ${res.status}`).toBe(true)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: bRunId } })
    expect(after.cancelledAt, 'Firm B run must remain uncancelled').toBeNull()
  })

  it('never lets Firm A dismiss Firm B’s capture recommendation', async () => {
    const res = await request(app)
      .post(`/api/agents/intelligence/recommendations/${bRecommendationId}/dismiss`)
      .set(H(adminA.token)).send({ reason: 'attempted cross-tenant dismissal' })
    expect(refused(res.status), `answered ${res.status}`).toBe(true)
    const after = await prisma.captureRecommendation.findUniqueOrThrow({ where: { id: bRecommendationId } })
    expect(after.status, 'Firm B recommendation must remain ACTIVE').toBe('ACTIVE')
  })

  it('never lets Firm A approve Firm B’s capability narrative', async () => {
    const version = await prisma.capabilityNarrativeVersion.create({
      data: {
        consultingFirmId: firmB.id, capabilityNarrativeId: bNarrativeId, versionNumber: 1,
        content: 'FIRM B WORDING', contentHash: uniq('h'), status: 'DRAFT',
      },
    })
    const res = await request(app).post(`/api/agents/proposal/library/versions/${version.id}/approve`).set(H(adminA.token)).send({})
    expect(refused(res.status), `answered ${res.status}`).toBe(true)
    const after = await prisma.capabilityNarrativeVersion.findUniqueOrThrow({ where: { id: version.id } })
    expect(after.status, 'Firm B version must remain DRAFT').toBe('DRAFT')
  })

  it('never lets Firm A verify Firm B’s actual indirect rate', async () => {
    const res = await request(app).post(`/api/agents/finance/actual-rates/${bActualRateId}/verify`).set(H(adminA.token)).send({})
    expect(refused(res.status), `answered ${res.status}`).toBe(true)
    const after = await prisma.actualIndirectRate.findUniqueOrThrow({ where: { id: bActualRateId } })
    expect(after.isHumanVerified, 'Firm B rate must remain unverified').toBe(false)
  })

  it('never includes another firm’s rows in any list endpoint', async () => {
    for (const path of READ_ENDPOINTS) {
      const res = await request(app).get(path).set(H(adminA.token))
      expect(res.status, path).toBe(200)
      const body = JSON.stringify(res.body)
      expect(body, `${path} leaked Firm B`).not.toContain(firmB.id)
      expect(body, `${path} leaked Firm B content`).not.toContain('FIRM_B_ONLY')
      expect(body, `${path} leaked Firm B content`).not.toContain('FIRM B')
    }
  })

  it('ignores a consultingFirmId in the body and scopes the run to the caller', async () => {
    const before = await prisma.agentRun.count({ where: { consultingFirmId: firmB.id } })
    const res = await request(app).post('/api/agents/runs').set(H(adminA.token))
      .send({ agentKey: 'INTELLIGENCE', consultingFirmId: firmB.id, idempotencyToken: uniq('idor') })

    if (res.status === 200 || res.status === 201) {
      const runId = res.body.data.run.id
      expect(runId, 'the response must identify the run it created').toBeTruthy()
      const created = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      expect(created.consultingFirmId, 'the run must belong to the CALLER, not the body').toBe(firmA.id)
    } else {
      expect(refused(res.status), `answered ${res.status}`).toBe(true)
    }
    // Firm B must have gained nothing either way.
    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmB.id } })).toBe(before)
  })
})

// =============================================================
// 4. Schedules and preferences are per tenant
// =============================================================

describe('audit: schedules and preferences are tenant-scoped', () => {
  it('gives each firm its own schedule row for the same agent', async () => {
    await request(app).put('/api/agents/schedules/INTELLIGENCE').set(H(adminA.token)).send({ isEnabled: true })
    await request(app).put('/api/agents/schedules/INTELLIGENCE').set(H(adminB.token)).send({ isEnabled: false })

    const a = await prisma.agentSchedule.findFirstOrThrow({ where: { consultingFirmId: firmA.id, agentKey: 'INTELLIGENCE' } })
    const b = await prisma.agentSchedule.findFirstOrThrow({ where: { consultingFirmId: firmB.id, agentKey: 'INTELLIGENCE' } })
    expect(a.isEnabled).toBe(true)
    expect(b.isEnabled).toBe(false)
    expect(a.id).not.toBe(b.id)
  })

  it('exposes all nine agents plus the definitions to every firm identically', async () => {
    const res = await request(app).get('/api/agents/definitions').set(H(adminA.token))
    const keys = res.body.data.map((d: { key: string }) => d.key)
    for (const key of DOMAIN_AGENT_KEYS) expect(keys, `definitions must include ${key}`).toContain(key)
    // The definitions endpoint is registry metadata; it carries no tenant data.
    expect(JSON.stringify(res.body)).not.toContain(firmB.id)
  })
})
