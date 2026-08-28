// =============================================================
// §7.0 — Agent operations API: authorization, tenant isolation, honesty.
//
// The security properties under test are the ones that matter most for a layer
// that will eventually act on its own: a CONSULTANT cannot configure or trigger
// anything, one firm can never see or touch another firm's runs, and an
// unimplemented agent can neither be enabled nor run.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import * as registry from '../services/agents/registry'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb,
  type TestFirm, type TestUser,
} from '../test-utils/testClient'

let app: Express
let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let consultantA: TestUser
let adminB: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const BASE = '/api/agents'
const DIAG = 'INTERNAL_DIAGNOSTIC'

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'Agent API Firm A' })
  firmB = await createTestFirm({ name: 'Agent API Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  consultantA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentNotificationPreference.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Definitions + overview
// -------------------------------------------------------------

describe('GET /api/agents/definitions', () => {
  it('returns exactly the nine domain agents and hides the internal one', async () => {
    const res = await request(app).get(`${BASE}/definitions`).set(H(adminA.token)).expect(200)
    const keys = res.body.data.map((d: { key: string }) => d.key)
    expect(keys).toHaveLength(9)
    expect(keys).not.toContain(DIAG)
    expect(keys).toEqual(expect.arrayContaining([
      'OPPORTUNITY', 'QUALIFICATION', 'COMPLIANCE', 'PROPOSAL', 'PRICING',
      'TEAMING', 'CONTRACT_ADMINISTRATION', 'FINANCE', 'INTELLIGENCE',
    ]))
  })

  it('reports implementation status honestly per agent, with a planned slice', async () => {
    const res = await request(app).get(`${BASE}/definitions`).set(H(adminA.token)).expect(200)
    // §7.1 Contract Administration · §7.2 Opportunity · §7.3 Compliance ·
    // §7.4 Qualification · §7.5 Teaming · §7.6 Pricing · §7.7 Proposal ·
    // §7.8 Finance · §7.9 Intelligence. Section 7 is complete.
    // §7.9 completed Section 7: every domain agent is delivered.
    const DELIVERED = new Set(['CONTRACT_ADMINISTRATION', 'OPPORTUNITY', 'COMPLIANCE', 'QUALIFICATION', 'TEAMING', 'PRICING', 'PROPOSAL', 'FINANCE', 'INTELLIGENCE'])
    for (const d of res.body.data) {
      expect(d.implemented, d.key).toBe(DELIVERED.has(d.key))
      expect(d.plannedSlice, d.key).toMatch(/^7\.\d$/)
      // Every agent, delivered or not, still defaults to PROPOSE.
      expect(d.defaultAutonomyLevel, d.key).toBe('PROPOSE')
    }
  })

  it('is readable by a CONSULTANT', async () => {
    await request(app).get(`${BASE}/definitions`).set(H(consultantA.token)).expect(200)
  })

  it('rejects an unauthenticated caller', async () => {
    await request(app).get(`${BASE}/definitions`).expect(401)
  })
})

describe('GET /api/agents/overview', () => {
  it('never reports an unimplemented agent as enabled or scheduled', async () => {
    // Even with a row that says enabled, the response must not claim it.
    await prisma.agentSchedule.create({
      data: {
        consultingFirmId: firmA.id, agentKey: 'FINANCE', isEnabled: true,
        scheduleType: 'CRON', cronExpression: '0 8 * * *', nextRunAt: new Date(),
      },
    })
    const res = await request(app).get(`${BASE}/overview`).set(H(adminA.token)).expect(200)
    // Every agent is implemented after §7.9, so what this now pins is that an
    // agent nobody has enabled is still reported as disabled and unscheduled.
    const intelligence = res.body.data.find((r: { key: string }) => r.key === 'INTELLIGENCE')
    expect(intelligence.implemented).toBe(true)
    expect(intelligence.isEnabled).toBe(false)
    expect(intelligence.nextRunAt).toBeNull()
  })

  it('reports open escalation counts per agent', async () => {
    await prisma.agentEscalation.create({
      data: {
        consultingFirmId: firmA.id, agentKey: 'PRICING', severity: 'HIGH', status: 'OPEN',
        title: 't', reason: 'r', dedupeKey: `k-${Date.now()}`,
      },
    })
    const res = await request(app).get(`${BASE}/overview`).set(H(adminA.token)).expect(200)
    const pricing = res.body.data.find((r: { key: string }) => r.key === 'PRICING')
    expect(pricing.openEscalations).toBe(1)
  })

  it('does not leak another firm’s escalation counts', async () => {
    await prisma.agentEscalation.create({
      data: {
        consultingFirmId: firmB.id, agentKey: 'PRICING', severity: 'HIGH', status: 'OPEN',
        title: 't', reason: 'r', dedupeKey: `k-${Date.now()}-b`,
      },
    })
    const res = await request(app).get(`${BASE}/overview`).set(H(adminA.token)).expect(200)
    const pricing = res.body.data.find((r: { key: string }) => r.key === 'PRICING')
    expect(pricing.openEscalations).toBe(0)
  })
})

// -------------------------------------------------------------
// Authorization
// -------------------------------------------------------------

describe('authorization — CONSULTANT is read-only platform-wide', () => {
  it('allows a CONSULTANT to read runs, escalations and preferences', async () => {
    await request(app).get(`${BASE}/runs`).set(H(consultantA.token)).expect(200)
    await request(app).get(`${BASE}/escalations`).set(H(consultantA.token)).expect(200)
    await request(app).get(`${BASE}/notification-preferences`).set(H(consultantA.token)).expect(200)
    await request(app).get(`${BASE}/overview`).set(H(consultantA.token)).expect(200)
  })

  it('blocks a CONSULTANT from configuring a schedule', async () => {
    await request(app).put(`${BASE}/schedules/PRICING`).set(H(consultantA.token)).send({ isEnabled: true }).expect(403)
  })

  it('blocks a CONSULTANT from triggering a run', async () => {
    await request(app).post(`${BASE}/runs`).set(H(consultantA.token)).send({ agentKey: 'PRICING' }).expect(403)
  })

  it('blocks a CONSULTANT from resolving an escalation', async () => {
    const esc = await prisma.agentEscalation.create({
      data: {
        consultingFirmId: firmA.id, agentKey: 'PRICING', severity: 'HIGH', status: 'OPEN',
        title: 't', reason: 'r', dedupeKey: `k-${Date.now()}-c`,
      },
    })
    await request(app).post(`${BASE}/escalations/${esc.id}/resolve`).set(H(consultantA.token)).send({ resolution: 'x' }).expect(403)
  })

  it('blocks a CONSULTANT from saving their own notification preference (documented platform contract)', async () => {
    // enforceTenantScope makes every non-GET 403 for a CONSULTANT. This slice
    // follows that contract rather than weakening it.
    await request(app).put(`${BASE}/notification-preferences/PRICING`).set(H(consultantA.token))
      .send({ inAppEnabled: false }).expect(403)
  })
})

// -------------------------------------------------------------
// Schedules
// -------------------------------------------------------------

describe('PUT /api/agents/schedules/:agentKey', () => {
/**
 * §7.9 completed Section 7, so no domain agent is unimplemented any more.
 *
 * The NOT_IMPLEMENTED guard must keep working regardless — it is what would
 * keep the product honest if an agent were ever added. These tests therefore
 * exercise the GUARD itself by making one registry entry report unimplemented,
 * rather than relying on an agent happening to be undelivered.
 */
  it('refuses to enable an agent that has no handler', async () => {
    const real = registry.requireAgentDefinition('INTELLIGENCE')
    const spy = vi.spyOn(registry, 'requireAgentDefinition').mockImplementation((key) =>
      key === 'INTELLIGENCE' ? { ...real, implemented: false, handler: null } : registry.AGENT_REGISTRY.find((d) => d.key === key)!,
    )
    const res = await request(app).put(`${BASE}/schedules/INTELLIGENCE`).set(H(adminA.token))
      .send({ isEnabled: true }).expect(422)
    spy.mockRestore()
    expect(res.body.error).toMatch(/not implemented yet/i)
  })

  it('allows configuring a disabled schedule for an unimplemented agent', async () => {
    const res = await request(app).put(`${BASE}/schedules/INTELLIGENCE`).set(H(adminA.token))
      .send({ isEnabled: false, cronExpression: '0 9 * * *', timezone: 'UTC' }).expect(200)
    expect(res.body.data.isEnabled).toBe(false)
    expect(res.body.data.cronExpression).toBe('0 9 * * *')
    // Disabled means no next fire time, so the due query cannot pick it up.
    expect(res.body.data.nextRunAt).toBeNull()
  })

  it('rejects an invalid cron expression', async () => {
    const res = await request(app).put(`${BASE}/schedules/INTELLIGENCE`).set(H(adminA.token))
      .send({ cronExpression: 'every other tuesday' }).expect(422)
    expect(res.body.error).toMatch(/not a valid cron/i)
  })

  it('rejects an interval schedule with no interval', async () => {
    await request(app).put(`${BASE}/schedules/INTELLIGENCE`).set(H(adminA.token))
      .send({ scheduleType: 'INTERVAL' }).expect(422)
  })

  it('rejects an unknown agent key', async () => {
    await request(app).put(`${BASE}/schedules/NOT_AN_AGENT`).set(H(adminA.token)).send({ isEnabled: false }).expect(422)
  })

  it('refuses to address the internal diagnostic agent through the product API', async () => {
    const res = await request(app).put(`${BASE}/schedules/${DIAG}`).set(H(adminA.token)).send({ isEnabled: true }).expect(422)
    expect(res.body.error).toMatch(/not addressable/i)
  })

  it('persists the autonomy level and defaults to PROPOSE', async () => {
    const created = await request(app).put(`${BASE}/schedules/PRICING`).set(H(adminA.token)).send({}).expect(200)
    expect(created.body.data.autonomyLevel).toBe('PROPOSE')

    const updated = await request(app).put(`${BASE}/schedules/PRICING`).set(H(adminA.token))
      .send({ autonomyLevel: 'OBSERVE' }).expect(200)
    expect(updated.body.data.autonomyLevel).toBe('OBSERVE')
  })

  it('writes an audit event for a schedule change', async () => {
    await request(app).put(`${BASE}/schedules/PRICING`).set(H(adminA.token)).send({ autonomyLevel: 'OBSERVE' }).expect(200)
    const audits = await prisma.auditEvent.findMany({
      where: { consultingFirmId: firmA.id, action: 'AGENT_SCHEDULE_CHANGED' },
    })
    expect(audits.length).toBeGreaterThanOrEqual(1)
    expect(audits[0].actorUserId).toBe(adminA.id)
  })

  it('keeps schedules tenant-scoped', async () => {
    await request(app).put(`${BASE}/schedules/PRICING`).set(H(adminA.token)).send({}).expect(200)
    const res = await request(app).get(`${BASE}/schedules`).set(H(adminB.token)).expect(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('never lists the internal diagnostic schedule', async () => {
    await prisma.agentSchedule.create({ data: { consultingFirmId: firmA.id, agentKey: DIAG } })
    const res = await request(app).get(`${BASE}/schedules`).set(H(adminA.token)).expect(200)
    expect(res.body.data.map((s: { agentKey: string }) => s.agentKey)).not.toContain(DIAG)
  })
})

// -------------------------------------------------------------
// Runs
// -------------------------------------------------------------

describe('POST /api/agents/runs', () => {
  it('refuses to run an unimplemented agent', async () => {
    const real = registry.requireAgentDefinition('INTELLIGENCE')
    const spy = vi.spyOn(registry, 'requireAgentDefinition').mockImplementation((key) =>
      key === 'INTELLIGENCE' ? { ...real, implemented: false, handler: null } : registry.AGENT_REGISTRY.find((d) => d.key === key)!,
    )
    const res = await request(app).post(`${BASE}/runs`).set(H(adminA.token)).send({ agentKey: 'INTELLIGENCE' }).expect(422)
    spy.mockRestore()
    expect(res.body.error).toMatch(/not implemented yet/i)
    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('refuses to run the internal diagnostic agent through the product API', async () => {
    await request(app).post(`${BASE}/runs`).set(H(adminA.token)).send({ agentKey: DIAG }).expect(422)
  })

  it('rejects a malformed payload', async () => {
    await request(app).post(`${BASE}/runs`).set(H(adminA.token)).send({}).expect(422)
  })
})

describe('GET /api/agents/runs', () => {
  async function seedRun(firmId: string, overrides: Record<string, unknown> = {}) {
    return prisma.agentRun.create({
      data: {
        consultingFirmId: firmId,
        agentKey: 'PRICING',
        triggerType: 'MANUAL',
        idempotencyKey: `k-${firmId}-${Math.random()}`,
        status: 'COMPLETED',
        ...overrides,
      },
    })
  }

  it('paginates and reports totals', async () => {
    for (let i = 0; i < 3; i++) await seedRun(firmA.id)
    const res = await request(app).get(`${BASE}/runs?pageSize=2&page=1`).set(H(adminA.token)).expect(200)
    expect(res.body.data.items).toHaveLength(2)
    expect(res.body.data.total).toBe(3)
    expect(res.body.data.totalPages).toBe(2)
  })

  it('filters by status and agent', async () => {
    await seedRun(firmA.id, { status: 'FAILED' })
    await seedRun(firmA.id, { status: 'COMPLETED' })

    const failed = await request(app).get(`${BASE}/runs?status=FAILED`).set(H(adminA.token)).expect(200)
    expect(failed.body.data.items).toHaveLength(1)

    const pricing = await request(app).get(`${BASE}/runs?agentKey=PRICING`).set(H(adminA.token)).expect(200)
    expect(pricing.body.data.items).toHaveLength(2)

    const finance = await request(app).get(`${BASE}/runs?agentKey=FINANCE`).set(H(adminA.token)).expect(200)
    expect(finance.body.data.items).toHaveLength(0)
  })

  it('never returns another firm’s runs', async () => {
    await seedRun(firmA.id)
    await seedRun(firmB.id)
    const res = await request(app).get(`${BASE}/runs`).set(H(adminB.token)).expect(200)
    expect(res.body.data.total).toBe(1)
    expect(res.body.data.items[0].id).not.toBe((await prisma.agentRun.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })).id)
  })

  it('404s on a cross-tenant run detail request', async () => {
    const run = await seedRun(firmA.id)
    await request(app).get(`${BASE}/runs/${run.id}`).set(H(adminB.token)).expect(404)
    await request(app).get(`${BASE}/runs/${run.id}`).set(H(adminA.token)).expect(200)
  })

  it('403s a cross-tenant cancel and does not change the run', async () => {
    const run = await seedRun(firmA.id, { status: 'QUEUED' })
    await request(app).post(`${BASE}/runs/${run.id}/cancel`).set(H(adminB.token)).expect(404)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('QUEUED')
  })

  it('refuses to cancel a terminal run', async () => {
    const run = await seedRun(firmA.id, { status: 'COMPLETED' })
    await request(app).post(`${BASE}/runs/${run.id}/cancel`).set(H(adminA.token)).expect(422)
  })

  it('cancels a queued run', async () => {
    const run = await seedRun(firmA.id, { status: 'QUEUED' })
    await request(app).post(`${BASE}/runs/${run.id}/cancel`).set(H(adminA.token)).expect(200)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('CANCELLED')
  })
})

// -------------------------------------------------------------
// Escalations
// -------------------------------------------------------------

describe('escalation workflow', () => {
  async function seedEscalation(firmId: string, status: 'OPEN' | 'RESOLVED' = 'OPEN') {
    return prisma.agentEscalation.create({
      data: {
        consultingFirmId: firmId, agentKey: 'PRICING', severity: 'HIGH', status,
        title: 'Needs review', reason: 'Because.', dedupeKey: `k-${firmId}-${Math.random()}`,
      },
    })
  }

  it('acknowledges then resolves, recording the actor and an audit event', async () => {
    const esc = await seedEscalation(firmA.id)

    await request(app).post(`${BASE}/escalations/${esc.id}/acknowledge`).set(H(adminA.token)).expect(200)
    let after = await prisma.agentEscalation.findUniqueOrThrow({ where: { id: esc.id } })
    expect(after.status).toBe('ACKNOWLEDGED')

    await request(app).post(`${BASE}/escalations/${esc.id}/resolve`).set(H(adminA.token))
      .send({ resolution: 'Reviewed and accepted.' }).expect(200)
    after = await prisma.agentEscalation.findUniqueOrThrow({ where: { id: esc.id } })
    expect(after.status).toBe('RESOLVED')
    expect(after.resolvedByUserId).toBe(adminA.id)

    const audits = await prisma.auditEvent.findMany({
      where: { consultingFirmId: firmA.id, entityType: 'AgentEscalation', entityId: esc.id },
    })
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['AGENT_ESCALATION_ACKNOWLEDGED', 'AGENT_ESCALATION_RESOLVED']),
    )
  })

  it('supports dismissal', async () => {
    const esc = await seedEscalation(firmA.id)
    await request(app).post(`${BASE}/escalations/${esc.id}/dismiss`).set(H(adminA.token)).send({ resolution: 'Not relevant.' }).expect(200)
    const after = await prisma.agentEscalation.findUniqueOrThrow({ where: { id: esc.id } })
    expect(after.status).toBe('DISMISSED')
  })

  it('refuses to re-resolve an escalation that is already terminal', async () => {
    const esc = await seedEscalation(firmA.id, 'RESOLVED')
    await request(app).post(`${BASE}/escalations/${esc.id}/acknowledge`).set(H(adminA.token)).expect(422)
  })

  it('refuses a cross-tenant resolution and leaves the row untouched', async () => {
    const esc = await seedEscalation(firmA.id)
    await request(app).post(`${BASE}/escalations/${esc.id}/resolve`).set(H(adminB.token)).send({ resolution: 'x' }).expect(422)
    const after = await prisma.agentEscalation.findUniqueOrThrow({ where: { id: esc.id } })
    expect(after.status).toBe('OPEN')
  })

  it('404s a cross-tenant escalation detail request', async () => {
    const esc = await seedEscalation(firmA.id)
    await request(app).get(`${BASE}/escalations/${esc.id}`).set(H(adminB.token)).expect(404)
  })

  it('filters by status and severity', async () => {
    await seedEscalation(firmA.id, 'OPEN')
    await seedEscalation(firmA.id, 'RESOLVED')
    const open = await request(app).get(`${BASE}/escalations?status=OPEN`).set(H(adminA.token)).expect(200)
    expect(open.body.data.items.every((i: { status: string }) => i.status === 'OPEN')).toBe(true)
    const high = await request(app).get(`${BASE}/escalations?severity=HIGH`).set(H(adminA.token)).expect(200)
    expect(high.body.data.items.length).toBeGreaterThan(0)
  })
})

// -------------------------------------------------------------
// Notification preferences
// -------------------------------------------------------------

describe('notification preferences', () => {
  it('returns an effective row for every public agent, defaulted where unset', async () => {
    const res = await request(app).get(`${BASE}/notification-preferences`).set(H(adminA.token)).expect(200)
    expect(res.body.data).toHaveLength(9)
    for (const row of res.body.data) {
      expect(row.isExplicit).toBe(false)
      expect(row.notifyOnFailure).toBe(true)
      // Routine successes are off by default — nine agents would be unusable.
      expect(row.notifyOnSuccess).toBe(false)
    }
  })

  it('persists an explicit preference for the calling user only', async () => {
    await request(app).put(`${BASE}/notification-preferences/PRICING`).set(H(adminA.token))
      .send({ notifyOnSuccess: true, minimumSeverity: 'CRITICAL' }).expect(200)

    const mine = await request(app).get(`${BASE}/notification-preferences`).set(H(adminA.token)).expect(200)
    const pricing = mine.body.data.find((r: { agentKey: string }) => r.agentKey === 'PRICING')
    expect(pricing.isExplicit).toBe(true)
    expect(pricing.notifyOnSuccess).toBe(true)
    expect(pricing.minimumSeverity).toBe('CRITICAL')

    // Another firm's admin is unaffected.
    const theirs = await request(app).get(`${BASE}/notification-preferences`).set(H(adminB.token)).expect(200)
    expect(theirs.body.data.every((r: { isExplicit: boolean }) => !r.isExplicit)).toBe(true)
  })

  it('rejects an invalid severity', async () => {
    await request(app).put(`${BASE}/notification-preferences/PRICING`).set(H(adminA.token))
      .send({ minimumSeverity: 'CATASTROPHIC' }).expect(422)
  })
})

// -------------------------------------------------------------
// Artifacts
// -------------------------------------------------------------

describe('artifacts API', () => {
  async function seedArtifact(firmId: string) {
    const run = await prisma.agentRun.create({
      data: {
        consultingFirmId: firmId, agentKey: 'PRICING', triggerType: 'MANUAL',
        idempotencyKey: `k-${firmId}-${Math.random()}`, status: 'COMPLETED',
      },
    })
    return prisma.agentArtifact.create({
      data: {
        consultingFirmId: firmId, runId: run.id, agentKey: 'PRICING',
        artifactType: 'PRICING_ASSESSMENT', title: 'Test artifact', structuredData: { a: 1 },
      },
    })
  }

  it('lists and fetches an artifact', async () => {
    const a = await seedArtifact(firmA.id)
    const list = await request(app).get(`${BASE}/artifacts`).set(H(adminA.token)).expect(200)
    expect(list.body.data.total).toBe(1)
    const detail = await request(app).get(`${BASE}/artifacts/${a.id}`).set(H(adminA.token)).expect(200)
    expect(detail.body.data.title).toBe('Test artifact')
  })

  it('404s a cross-tenant artifact fetch', async () => {
    const a = await seedArtifact(firmA.id)
    await request(app).get(`${BASE}/artifacts/${a.id}`).set(H(adminB.token)).expect(404)
  })

  it('marks an artifact human-verified and refuses to do it twice', async () => {
    const a = await seedArtifact(firmA.id)
    await request(app).post(`${BASE}/artifacts/${a.id}/verify`).set(H(adminA.token)).expect(200)
    const after = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: a.id } })
    expect(after.isHumanVerified).toBe(true)
    expect(after.verifiedByUserId).toBe(adminA.id)

    await request(app).post(`${BASE}/artifacts/${a.id}/verify`).set(H(adminA.token)).expect(422)
  })

  it('blocks a CONSULTANT from verifying an artifact', async () => {
    const a = await seedArtifact(firmA.id)
    await request(app).post(`${BASE}/artifacts/${a.id}/verify`).set(H(consultantA.token)).expect(403)
  })
})
