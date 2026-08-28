// =============================================================
// §7.6 — Pricing Agent events and HTTP surface.
//
// The two NEW triggers are proven through their REAL write paths: a committed
// mutation emits exactly one event, a rolled-back one emits none, a cosmetic
// change emits nothing, a duplicate never rolls the business write back, and no
// event crosses a tenant boundary.
//
// The HTTP surface is proven read-only: no route here changes a rate, a fee, a
// scenario selection or a review.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb,
  type TestFirm, type TestUser,
} from '../test-utils/testClient'
import { processOutbox, claimEvents } from '../services/agents/outbox'
import {
  PRICING_SCENARIO_CHANGED,
  INDIRECT_RATE_CHANGED,
  pricingFingerprint,
  pricingChangedMaterially,
  templateRateFingerprint,
  emitPricingScenarioChanged,
} from '../services/agents/pricing/pricingEvents'

const BASE = '/api/agents/pricing'
const DAY = 86_400_000
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)

let app: Express
let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let consultantA: TestUser
let adminB: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'Pricing Event Firm A' })
  firmB = await createTestFirm({ name: 'Pricing Event Firm B' })
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
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
    await prisma.awardBenchmarkCohort.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingLaborLine.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingIndirectRate.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingOtherCost.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingScenario.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingWorkspace.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingTemplate.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
  }
})

async function makeWorkspaceViaApi(token: string, firmId: string) {
  const opp = await prisma.opportunity.create({
    data: {
      consultingFirmId: firmId, samNoticeId: uniq('S7-PRICE-QA-EV'),
      title: 'S7-PRICE-QA event opportunity', agency: 'Department of Defense',
      naicsCode: '541512', setAsideType: 'NONE',
      responseDeadline: new Date(Date.now() + 60 * DAY), status: 'ACTIVE', isDemo: false,
    },
  })
  const created = await request(app).post(`/api/pricing/opportunity/${opp.id}`).set(H(token)).send({ title: 'S7-PRICE-QA' })
  expect(created.status).toBe(201)
  const workspaceId = created.body.data.workspace.id

  const scenario = await request(app).post(`/api/pricing/${workspaceId}/scenarios`).set(H(token)).send({ name: 'Base' })
  expect(scenario.status).toBe(201)
  return { opportunityId: opp.id, workspaceId, scenarioId: scenario.body.data.scenario.id }
}

const eventsOfType = (firmId: string, type: string) =>
  prisma.agentEvent.findMany({ where: { consultingFirmId: firmId, eventType: type }, orderBy: { createdAt: 'asc' } })

// -------------------------------------------------------------
// The fingerprint decides what is material
// -------------------------------------------------------------

describe('the pricing fingerprint', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    laborLines: [{ categoryName: 'Engineer', hours: 1000, baseRate: 95, escalationPct: 0, personnelCount: null, isActive: true }],
    indirectRates: [{ rateType: 'FRINGE', percent: 30, costBase: 'DIRECT_LABOUR', isActive: true }],
    otherCosts: [{ costCategory: 'TRAVEL', quantity: 1, unitCost: 500 }],
    ...over,
  })

  it('is stable for identical inputs', () => {
    expect(pricingFingerprint(input())).toBe(pricingFingerprint(input()))
  })

  it('is insensitive to line ordering', () => {
    const a = pricingFingerprint(input({
      laborLines: [
        { categoryName: 'A', hours: 1, baseRate: 1, escalationPct: 0, personnelCount: null, isActive: true },
        { categoryName: 'B', hours: 2, baseRate: 2, escalationPct: 0, personnelCount: null, isActive: true },
      ],
    }))
    const b = pricingFingerprint(input({
      laborLines: [
        { categoryName: 'B', hours: 2, baseRate: 2, escalationPct: 0, personnelCount: null, isActive: true },
        { categoryName: 'A', hours: 1, baseRate: 1, escalationPct: 0, personnelCount: null, isActive: true },
      ],
    }))
    expect(a).toBe(b)
  })

  it.each([
    ['hours', { laborLines: [{ categoryName: 'Engineer', hours: 1001, baseRate: 95, escalationPct: 0, personnelCount: null, isActive: true }] }],
    ['a rate', { laborLines: [{ categoryName: 'Engineer', hours: 1000, baseRate: 96, escalationPct: 0, personnelCount: null, isActive: true }] }],
    ['escalation', { laborLines: [{ categoryName: 'Engineer', hours: 1000, baseRate: 95, escalationPct: 3, personnelCount: null, isActive: true }] }],
    ['an indirect rate', { indirectRates: [{ rateType: 'FRINGE', percent: 31, costBase: 'DIRECT_LABOUR', isActive: true }] }],
    ['a cost base', { indirectRates: [{ rateType: 'FRINGE', percent: 30, costBase: 'MATERIAL_COST', isActive: true }] }],
    ['an ODC amount', { otherCosts: [{ costCategory: 'TRAVEL', quantity: 1, unitCost: 600 }] }],
    ['an ODC quantity', { otherCosts: [{ costCategory: 'TRAVEL', quantity: 2, unitCost: 500 }] }],
  ])('changes when %s changes', (_label, over) => {
    expect(pricingFingerprint(input(over))).not.toBe(pricingFingerprint(input()))
  })

  it('changes when a line is deactivated', () => {
    const off = pricingFingerprint(input({
      laborLines: [{ categoryName: 'Engineer', hours: 1000, baseRate: 95, escalationPct: 0, personnelCount: null, isActive: false }],
    }))
    expect(off).not.toBe(pricingFingerprint(input()))
  })

  it('detects a material change only when the numbers move', () => {
    const before = pricingFingerprint(input())
    expect(pricingChangedMaterially(before, pricingFingerprint(input()))).toBe(false)
    expect(pricingChangedMaterially(before, pricingFingerprint(input({
      indirectRates: [{ rateType: 'FRINGE', percent: 35, costBase: 'DIRECT_LABOUR', isActive: true }],
    })))).toBe(true)
  })

  it('treats a first fingerprint as a change', () => {
    expect(pricingChangedMaterially(null, pricingFingerprint(input()))).toBe(true)
  })
})

describe('the template rate fingerprint', () => {
  it('is stable and order-insensitive', () => {
    const a = templateRateFingerprint([{ rateType: 'GA', percent: 10 }, { rateType: 'FRINGE', percent: 30 }], null)
    const b = templateRateFingerprint([{ rateType: 'FRINGE', percent: 30 }, { rateType: 'GA', percent: 10 }], null)
    expect(a).toBe(b)
  })

  it('changes when a percentage changes', () => {
    const a = templateRateFingerprint([{ rateType: 'FRINGE', percent: 30 }], null)
    const b = templateRateFingerprint([{ rateType: 'FRINGE', percent: 31 }], null)
    expect(a).not.toBe(b)
  })

  it('changes when the default fee changes', () => {
    const a = templateRateFingerprint([{ rateType: 'FRINGE', percent: 30 }], D('8'))
    const b = templateRateFingerprint([{ rateType: 'FRINGE', percent: 30 }], D('9'))
    expect(a).not.toBe(b)
  })

  it('tolerates a malformed template row', () => {
    expect(() => templateRateFingerprint([{ nonsense: true }, null], null)).not.toThrow()
  })
})

// -------------------------------------------------------------
// PRICING_SCENARIO_CHANGED through the real routes
// -------------------------------------------------------------

describe('PRICING_SCENARIO_CHANGED', () => {
  it('emits when a labour line is added', async () => {
    const { scenarioId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    const res = await request(app).post(`/api/pricing/scenarios/${scenarioId}/labor`).set(H(adminA.token))
      .send({ categoryName: 'Engineer', hours: 1000, baseRate: 95 })
    expect(res.status).toBe(201)

    const events = await eventsOfType(firmA.id, PRICING_SCENARIO_CHANGED)
    expect(events).toHaveLength(1)
    expect(events[0].entityType).toBe('PricingScenario')
    expect(events[0].entityId).toBe(scenarioId)
  })

  it('emits when a rate changes', async () => {
    const { scenarioId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    const labor = await request(app).post(`/api/pricing/scenarios/${scenarioId}/labor`).set(H(adminA.token))
      .send({ categoryName: 'Engineer', hours: 1000, baseRate: 95 })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    await request(app).patch(`/api/pricing/labor/${labor.body.data.line.id}`).set(H(adminA.token)).send({ baseRate: 105 })
    expect(await eventsOfType(firmA.id, PRICING_SCENARIO_CHANGED)).toHaveLength(1)
  })

  it('emits when an indirect rate is added', async () => {
    const { scenarioId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    await request(app).post(`/api/pricing/scenarios/${scenarioId}/indirect`).set(H(adminA.token))
      .send({ name: 'Fringe', rateType: 'FRINGE', percent: 30, costBase: 'DIRECT_LABOUR' })
    expect(await eventsOfType(firmA.id, PRICING_SCENARIO_CHANGED)).toHaveLength(1)
  })

  it('emits when an other-cost line is added', async () => {
    const { scenarioId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    await request(app).post(`/api/pricing/scenarios/${scenarioId}/other`).set(H(adminA.token))
      .send({ costCategory: 'TRAVEL', description: 'Travel', quantity: 1, unitCost: 500 })
    expect(await eventsOfType(firmA.id, PRICING_SCENARIO_CHANGED)).toHaveLength(1)
  })

  it('does NOT emit for a cosmetic rename', async () => {
    const { scenarioId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    await request(app).post(`/api/pricing/scenarios/${scenarioId}/labor`).set(H(adminA.token))
      .send({ categoryName: 'Engineer', hours: 1000, baseRate: 95 })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    const res = await request(app).patch(`/api/pricing/scenarios/${scenarioId}`).set(H(adminA.token))
      .send({ name: 'Base — renamed', description: 'A different description' })
    expect(res.status).toBe(200)
    expect(await eventsOfType(firmA.id, PRICING_SCENARIO_CHANGED)).toHaveLength(0)
  })

  it('does NOT re-emit when the same numbers are written again', async () => {
    const { scenarioId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    const labor = await request(app).post(`/api/pricing/scenarios/${scenarioId}/labor`).set(H(adminA.token))
      .send({ categoryName: 'Engineer', hours: 1000, baseRate: 95 })
    const afterAdd = (await eventsOfType(firmA.id, PRICING_SCENARIO_CHANGED)).length
    expect(afterAdd).toBe(1)

    // The same values written back produce the same fingerprint, so the outbox
    // dedupe key matches the existing row and nothing new is emitted. The prior
    // event is deliberately NOT deleted first — its presence IS the dedupe.
    await request(app).patch(`/api/pricing/labor/${labor.body.data.line.id}`).set(H(adminA.token))
      .send({ hours: 1000, baseRate: 95 })
    expect(await eventsOfType(firmA.id, PRICING_SCENARIO_CHANGED)).toHaveLength(afterAdd)
  })

  it('carries ids and a fingerprint digest only — never a rate or a price', async () => {
    const { scenarioId, workspaceId, opportunityId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })
    await request(app).post(`/api/pricing/scenarios/${scenarioId}/labor`).set(H(adminA.token))
      .send({ categoryName: 'Engineer', hours: 1000, baseRate: 95 })

    const event = (await eventsOfType(firmA.id, PRICING_SCENARIO_CHANGED))[0]
    const payload = event.payload as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['fingerprintHash', 'opportunityId', 'scenarioId', 'workspaceId'])
    expect(payload.workspaceId).toBe(workspaceId)
    expect(payload.opportunityId).toBe(opportunityId)
    // The fingerprint travels as an opaque digest, so no rate, hour count or
    // price is recoverable from the event.
    expect(String(payload.fingerprintHash)).toMatch(/^[0-9a-f]{64}$/)
    for (const field of ['baseRate', 'hours', 'percent', 'totalPrice', 'unitCost']) {
      expect(payload, field).not.toHaveProperty(field)
    }
  })

  it('emits nothing when the surrounding transaction rolls back', async () => {
    const { scenarioId, workspaceId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.pricingLaborLine.create({
          data: {
            consultingFirmId: firmA.id, scenarioId, categoryName: 'Rollback',
            hours: D('1'), baseRate: D('1'),
          },
        })
        await emitPricingScenarioChanged(
          { consultingFirmId: firmA.id, scenarioId, workspaceId, opportunityId: null, fingerprintHash: 'abc' },
          tx,
        )
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')

    expect(await eventsOfType(firmA.id, PRICING_SCENARIO_CHANGED)).toHaveLength(0)
    expect(await prisma.pricingLaborLine.count({ where: { categoryName: 'Rollback' } })).toBe(0)
  })

  it('a benign duplicate never rolls the business write back', async () => {
    const { scenarioId, workspaceId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    await prisma.$transaction(async (tx) => {
      await tx.pricingLaborLine.create({
        data: { consultingFirmId: firmA.id, scenarioId, categoryName: 'Kept', hours: D('1'), baseRate: D('1') },
      })
      await emitPricingScenarioChanged({ consultingFirmId: firmA.id, scenarioId, workspaceId, opportunityId: null, fingerprintHash: 'dup' }, tx)
      await emitPricingScenarioChanged({ consultingFirmId: firmA.id, scenarioId, workspaceId, opportunityId: null, fingerprintHash: 'dup' }, tx)
    })

    expect(await prisma.pricingLaborLine.count({ where: { categoryName: 'Kept' } })).toBe(1)
    expect(await eventsOfType(firmA.id, PRICING_SCENARIO_CHANGED)).toHaveLength(1)
  })

  it('never emits into another firm', async () => {
    const { scenarioId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    await request(app).post(`/api/pricing/scenarios/${scenarioId}/labor`).set(H(adminA.token))
      .send({ categoryName: 'Engineer', hours: 1000, baseRate: 95 })
    expect(await claimEvents('t', 20, new Date(), { consultingFirmId: firmB.id })).toHaveLength(0)
  })

  it('creates exactly one targeted run when processed', async () => {
    await prisma.agentSchedule.create({
      data: { consultingFirmId: firmA.id, agentKey: 'PRICING', isEnabled: true, scheduleType: 'CRON', cronExpression: '0 */12 * * *' },
    })
    const { scenarioId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: firmA.id } })

    await request(app).post(`/api/pricing/scenarios/${scenarioId}/labor`).set(H(adminA.token))
      .send({ categoryName: 'Engineer', hours: 1000, baseRate: 95 })
    await processOutbox('worker-1', 20, new Date(), { consultingFirmId: firmA.id })

    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmA.id, agentKey: 'PRICING' } })).toBe(1)
  })
})

// -------------------------------------------------------------
// INDIRECT_RATE_CHANGED
// -------------------------------------------------------------

describe('INDIRECT_RATE_CHANGED', () => {
  async function makeTemplate(token: string) {
    const res = await request(app).post('/api/pricing/templates').set(H(token)).send({
      name: uniq('S7-PRICE-QA template'),
      indirectRatesJson: [{ rateType: 'FRINGE', percent: 30, costBase: 'DIRECT_LABOUR' }],
    })
    expect(res.status).toBe(201)
    return res.body.data.template.id as string
  }

  it('emits once when a template rate changes', async () => {
    const id = await makeTemplate(adminA.token)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    const res = await request(app).patch(`/api/pricing/templates/${id}`).set(H(adminA.token))
      .send({ indirectRatesJson: [{ rateType: 'FRINGE', percent: 35, costBase: 'DIRECT_LABOUR' }] })
    expect(res.status).toBe(200)

    const events = await eventsOfType(firmA.id, INDIRECT_RATE_CHANGED)
    expect(events).toHaveLength(1)
    expect(events[0].entityType).toBe('PricingTemplate')
    expect(events[0].entityId).toBe(id)
  })

  it('does NOT emit when only the template name changes', async () => {
    const id = await makeTemplate(adminA.token)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    await request(app).patch(`/api/pricing/templates/${id}`).set(H(adminA.token)).send({ name: 'Renamed only' })
    expect(await eventsOfType(firmA.id, INDIRECT_RATE_CHANGED)).toHaveLength(0)
  })

  it('does NOT emit when the same rates are written again', async () => {
    const id = await makeTemplate(adminA.token)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    await request(app).patch(`/api/pricing/templates/${id}`).set(H(adminA.token))
      .send({ indirectRatesJson: [{ rateType: 'FRINGE', percent: 30, costBase: 'DIRECT_LABOUR' }] })
    expect(await eventsOfType(firmA.id, INDIRECT_RATE_CHANGED)).toHaveLength(0)
  })

  it('emits one event per logical rate update, not one per rate', async () => {
    const id = await makeTemplate(adminA.token)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    await request(app).patch(`/api/pricing/templates/${id}`).set(H(adminA.token)).send({
      indirectRatesJson: [
        { rateType: 'FRINGE', percent: 35, costBase: 'DIRECT_LABOUR' },
        { rateType: 'OVERHEAD', percent: 45, costBase: 'LABOUR_PLUS_FRINGE' },
        { rateType: 'GA', percent: 12, costBase: 'TOTAL_DIRECT_COST' },
      ],
    })
    expect(await eventsOfType(firmA.id, INDIRECT_RATE_CHANGED)).toHaveLength(1)
  })

  it('carries the template id and a digest only', async () => {
    const id = await makeTemplate(adminA.token)
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })
    await request(app).patch(`/api/pricing/templates/${id}`).set(H(adminA.token))
      .send({ indirectRatesJson: [{ rateType: 'FRINGE', percent: 35, costBase: 'DIRECT_LABOUR' }] })

    const payload = (await eventsOfType(firmA.id, INDIRECT_RATE_CHANGED))[0].payload as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['rateSetHash', 'templateId'])
    expect(JSON.stringify(payload)).not.toContain('35')
  })

  it('never emits into another firm', async () => {
    const id = await makeTemplate(adminA.token)
    await request(app).patch(`/api/pricing/templates/${id}`).set(H(adminA.token))
      .send({ indirectRatesJson: [{ rateType: 'FRINGE', percent: 35, costBase: 'DIRECT_LABOUR' }] })
    expect(await claimEvents('t', 20, new Date(), { consultingFirmId: firmB.id })).toHaveLength(0)
  })

  it('does not change any scenario rate', async () => {
    const { scenarioId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    await request(app).post(`/api/pricing/scenarios/${scenarioId}/indirect`).set(H(adminA.token))
      .send({ name: 'Fringe', rateType: 'FRINGE', percent: 30, costBase: 'DIRECT_LABOUR' })

    const id = await makeTemplate(adminA.token)
    await request(app).patch(`/api/pricing/templates/${id}`).set(H(adminA.token))
      .send({ indirectRatesJson: [{ rateType: 'FRINGE', percent: 99, costBase: 'DIRECT_LABOUR' }] })

    const rate = await prisma.pricingIndirectRate.findFirstOrThrow({ where: { scenarioId } })
    expect(rate.percent.toFixed(0)).toBe('30')
  })
})

// -------------------------------------------------------------
// HTTP surface
// -------------------------------------------------------------

describe(`GET ${BASE}/assessment/:workspaceId`, () => {
  it('requires authentication', async () => {
    expect((await request(app).get(`${BASE}/assessment/x`)).status).toBe(401)
  })

  it('404s across firms', async () => {
    const { workspaceId } = await makeWorkspaceViaApi(adminB.token, firmB.id)
    expect((await request(app).get(`${BASE}/assessment/${workspaceId}`).set(H(adminA.token))).status).toBe(404)
  })

  it('returns a null assessment before the agent has run', async () => {
    const { workspaceId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    const res = await request(app).get(`${BASE}/assessment/${workspaceId}`).set(H(adminA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.assessment).toBeNull()
  })

  it('publishes the policy the UI displays', async () => {
    const { workspaceId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    const res = await request(app).get(`${BASE}/assessment/${workspaceId}`).set(H(adminA.token))
    expect(res.body.data.policy.minimumCohortSize).toBe(7)
    expect(res.body.data.policy.notes.join(' ')).toContain('public federal award records only')
    expect(res.body.data.policy.notes.join(' ')).toContain('never changes a rate')
  })

  it('is readable by a consultant', async () => {
    const { workspaceId } = await makeWorkspaceViaApi(adminA.token, firmA.id)
    expect((await request(app).get(`${BASE}/assessment/${workspaceId}`).set(H(consultantA.token))).status).toBe(200)
  })
})

describe(`GET ${BASE}/cohort/:cohortId`, () => {
  async function makeCohort(firmId: string) {
    return prisma.awardBenchmarkCohort.create({
      data: {
        consultingFirmId: firmId, inputHash: uniq('h'), filterLevel: 'LEVEL_1_NAICS_AGENCY_SETASIDE_BAND',
        periodStart: new Date(Date.now() - 365 * DAY), periodEnd: new Date(),
        cohortSize: 8, sourceIds: ['a1', 'a2'], dataSufficiency: 'PARTIAL',
      },
    })
  }

  it('returns the composition with its public provenance', async () => {
    const cohort = await makeCohort(firmA.id)
    const res = await request(app).get(`${BASE}/cohort/${cohort.id}`).set(H(adminA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.cohort.cohortSize).toBe(8)
    expect(res.body.data.provenance.sourceKind).toBe('PUBLIC_FEDERAL_AWARD_RECORDS')
    expect(res.body.data.provenance.note).toContain('No tenant-private pricing contributed')
  })

  it('404s across firms rather than disclosing existence', async () => {
    const cohort = await makeCohort(firmB.id)
    expect((await request(app).get(`${BASE}/cohort/${cohort.id}`).set(H(adminA.token))).status).toBe(404)
  })
})

describe('the API cannot change pricing', () => {
  it('declares only read routes', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(join(__dirname, 'pricingAgent.ts'), 'utf8')
    const verbs = [...src.matchAll(/router\.(get|post|put|patch|delete)\(/g)].map((m) => m[1])
    expect(verbs.length).toBeGreaterThan(0)
    expect([...new Set(verbs)]).toEqual(['get'])
  })

  it('performs no Prisma write', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const code = readFileSync(join(__dirname, 'pricingAgent.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    for (const write of ['.create(', '.update(', '.updateMany(', '.upsert(', '.delete(', '.deleteMany(']) {
      expect(code.includes(write), write).toBe(false)
    }
  })
})
