// =============================================================
// §5.1 Stage 6 / §5.2 Pricing integration — workspace create + duplicate-active
// prevention, labour/indirect/ODC/subcontractor lines with decimal-safe recompute,
// negative + circular-base validation, scenarios (create/duplicate/select/compare),
// review workflow + APPROVED immutability + versioning, templates + snapshot apply,
// sensitive-rate redaction for non-ADMIN, honest benchmark, audit, cross-tenant.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser
let consultant: TestUser
let other: TestFirm
let otherAdmin: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const B = '/api/pricing'

async function makeOpp(consultingFirmId: string, over: Record<string, unknown> = {}) {
  return prisma.opportunity.create({ data: { consultingFirmId, title: 'Pricing opp', agency: 'GSA', naicsCode: '541512', responseDeadline: new Date(Date.now() + 30 * 86_400_000), ...over } })
}
async function makeWorkspace(token: string, opportunityId: string) {
  return (await request(app).post(`${B}/opportunity/${opportunityId}`).set(H(token)).send({ title: 'Volume III — Cost' }).expect(201)).body.data.workspace
}
function baseScenarioId(ws: { scenarios: { id: string; isPreferred: boolean }[] }) {
  return ws.scenarios[0].id
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Pricing Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'Pricing Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
})
afterAll(async () => { await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

describe('workspace — create, duplicate-active prevention, authz, audit', () => {
  it('creates a workspace with a Base scenario and audits it', async () => {
    const opp = await makeOpp(firm.id)
    const ws = await makeWorkspace(admin.token, opp.id)
    expect(ws.status).toBe('DRAFT')
    expect(ws.scenarios.length).toBe(1)
    expect(ws.scenarios[0].isPreferred).toBe(true)
    const audit = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, entityType: 'PricingWorkspace', entityId: ws.id, action: 'CREATE' } })
    expect(audit).toBeTruthy()
    await request(app).post(`${B}/opportunity/${opp.id}`).set(H(admin.token)).send({ title: 'Dup' }).expect(409)
  })
  it('forbids CONSULTANT create and blocks cross-tenant opportunity', async () => {
    const opp = await makeOpp(firm.id)
    await request(app).post(`${B}/opportunity/${opp.id}`).set(H(consultant.token)).send({ title: 'x' }).expect(403)
    await request(app).post(`${B}/opportunity/${opp.id}`).set(H(otherAdmin.token)).send({ title: 'x' }).expect(404)
  })
})

describe('lines — decimal-safe recompute, validation, circular prevention', () => {
  it('computes the full wrap deterministically', async () => {
    const opp = await makeOpp(firm.id)
    const ws = await makeWorkspace(admin.token, opp.id)
    const sid = baseScenarioId(ws)
    await request(app).post(`${B}/scenarios/${sid}/labor`).set(H(admin.token)).send({ categoryName: 'Engineer', hours: 1000, baseRate: 100 }).expect(201)
    await request(app).post(`${B}/scenarios/${sid}/indirect`).set(H(admin.token)).send({ name: 'Fringe', rateType: 'FRINGE', percent: 30, costBase: 'DIRECT_LABOUR' }).expect(201)
    await request(app).post(`${B}/scenarios/${sid}/indirect`).set(H(admin.token)).send({ name: 'Overhead', rateType: 'OVERHEAD', percent: 50, costBase: 'LABOUR_PLUS_FRINGE' }).expect(201)
    await request(app).post(`${B}/scenarios/${sid}/indirect`).set(H(admin.token)).send({ name: 'G&A', rateType: 'GA', percent: 10, costBase: 'TOTAL_DIRECT_COST' }).expect(201)
    await request(app).post(`${B}/scenarios/${sid}/other`).set(H(admin.token)).send({ costCategory: 'TRAVEL', description: 'Travel', quantity: 1, unitCost: 5000 }).expect(201)
    await request(app).post(`${B}/scenarios/${sid}/other`).set(H(admin.token)).send({ costCategory: 'SUBCONTRACTOR', description: 'Sub A', quantity: 1, unitCost: 20000 }).expect(201)
    const fee = await request(app).post(`${B}/scenarios/${sid}/indirect`).set(H(admin.token)).send({ name: 'Fee', rateType: 'FEE', percent: 8, costBase: 'TOTAL_DIRECT_COST' }).expect(201)
    expect(fee.body.data.totals.totalPrice).toBe('261360')
    expect(fee.body.data.totals.totalDirectLabor).toBe('100000')
    expect(fee.body.data.totals.totalGA).toBe('22000')
  })
  it('rejects negative values and circular cost bases', async () => {
    const opp = await makeOpp(firm.id)
    const ws = await makeWorkspace(admin.token, opp.id)
    const sid = baseScenarioId(ws)
    await request(app).post(`${B}/scenarios/${sid}/labor`).set(H(admin.token)).send({ categoryName: 'X', hours: -5, baseRate: 100 }).expect(422)
    await request(app).post(`${B}/scenarios/${sid}/indirect`).set(H(admin.token)).send({ name: 'Bad', rateType: 'FRINGE', percent: 10, costBase: 'TOTAL_DIRECT_COST' }).expect(422)
  })
})

describe('scenarios — duplicate, select, compare', () => {
  it('duplicates a scenario, selects a preferred one, and compares totals', async () => {
    const opp = await makeOpp(firm.id)
    const ws = await makeWorkspace(admin.token, opp.id)
    const sid = baseScenarioId(ws)
    await request(app).post(`${B}/scenarios/${sid}/labor`).set(H(admin.token)).send({ categoryName: 'Eng', hours: 100, baseRate: 100 }).expect(201)
    const dup = await request(app).post(`${B}/scenarios/${sid}/duplicate`).set(H(admin.token)).expect(201)
    const dupId = dup.body.data.scenario.id
    await request(app).post(`${B}/${ws.id}/scenarios/${dupId}/select`).set(H(admin.token)).expect(200)
    const cmp = await request(app).get(`${B}/${ws.id}/compare`).set(H(admin.token)).expect(200)
    expect(cmp.body.data.scenarios.length).toBe(2)
    expect(cmp.body.data.preferredScenarioId).toBe(dupId)
  })
})

describe('review workflow + APPROVED immutability + versioning', () => {
  it('submits, approves, blocks edits, then versions into a fresh DRAFT', async () => {
    const opp = await makeOpp(firm.id)
    const ws = await makeWorkspace(admin.token, opp.id)
    const sid = baseScenarioId(ws)
    await request(app).post(`${B}/scenarios/${sid}/labor`).set(H(admin.token)).send({ categoryName: 'Eng', hours: 10, baseRate: 100 }).expect(201)
    await request(app).post(`${B}/${ws.id}/submit`).set(H(admin.token)).expect(200)
    // reject requires a reason
    await request(app).post(`${B}/${ws.id}/reject`).set(H(admin.token)).send({}).expect(422)
    const appr = await request(app).post(`${B}/${ws.id}/approve`).set(H(admin.token)).expect(200)
    expect(appr.body.data.workspace.status).toBe('APPROVED')
    // APPROVED is immutable
    await request(app).post(`${B}/scenarios/${sid}/labor`).set(H(admin.token)).send({ categoryName: 'Y', hours: 1, baseRate: 1 }).expect(409)
    // new version supersedes the approved one, preserving it
    const ver = await request(app).post(`${B}/${ws.id}/version`).set(H(admin.token)).expect(201)
    expect(ver.body.data.workspace.version).toBe(2)
    expect(ver.body.data.workspace.status).toBe('DRAFT')
    const old = await prisma.pricingWorkspace.findUnique({ where: { id: ws.id } })
    expect(old?.status).toBe('SUPERSEDED')
  })
})

describe('templates — create + snapshot apply', () => {
  it('applies a template into a scenario as a snapshot', async () => {
    const opp = await makeOpp(firm.id)
    const ws = await makeWorkspace(admin.token, opp.id)
    const sid = baseScenarioId(ws)
    const tpl = await request(app).post(`${B}/templates`).set(H(admin.token)).send({
      name: 'Std Wrap',
      laborLinesJson: [{ categoryName: 'PM', hours: 100, baseRate: 120 }],
      indirectRatesJson: [{ name: 'Fringe', rateType: 'FRINGE', percent: 25, costBase: 'DIRECT_LABOUR' }],
    }).expect(201)
    const applied = await request(app).post(`${B}/scenarios/${sid}/apply-template/${tpl.body.data.template.id}`).set(H(admin.token)).expect(201)
    expect(applied.body.data.appliedLabor).toBe(1)
    expect(Number(applied.body.data.totals.totalDirectLabor)).toBe(12000)
  })
})

describe('sensitive-rate redaction + benchmark honesty + cross-tenant', () => {
  it('redacts cost rates for CONSULTANT but shows total price', async () => {
    const opp = await makeOpp(firm.id)
    const ws = await makeWorkspace(admin.token, opp.id)
    const sid = baseScenarioId(ws)
    await request(app).post(`${B}/scenarios/${sid}/labor`).set(H(admin.token)).send({ categoryName: 'Eng', hours: 100, baseRate: 100 }).expect(201)
    const view = await request(app).get(`${B}/${ws.id}`).set(H(consultant.token)).expect(200)
    const sc = view.body.data.workspace.scenarios[0]
    expect(sc.sensitiveRedacted).toBe(true)
    expect(sc.laborLines[0].baseRate).toBeNull()
    expect(sc.totalPrice).toBeTruthy() // total price still visible
    // admin sees the rate
    const adminView = await request(app).get(`${B}/${ws.id}`).set(H(admin.token)).expect(200)
    expect(adminView.body.data.workspace.scenarios[0].laborLines[0].baseRate).toBeTruthy()
  })
  it('returns an honest no-benchmark state without award enrichment', async () => {
    const opp = await makeOpp(firm.id)
    const bench = await request(app).get(`${B}/opportunity/${opp.id}/benchmark`).set(H(admin.token)).expect(200)
    expect(bench.body.data.available).toBe(false)
  })
  it('blocks cross-tenant workspace read', async () => {
    const opp = await makeOpp(firm.id)
    const ws = await makeWorkspace(admin.token, opp.id)
    await request(app).get(`${B}/${ws.id}`).set(H(otherAdmin.token)).expect(404)
  })
})
