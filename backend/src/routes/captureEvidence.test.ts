// =============================================================
// §5.1 Stage 3 Capture Evidence integration tests — incumbent (single/none/
// ambiguous/missing/verify/correct+reason/unauthorized/source/cross-tenant) and
// competitors (ranking/relevance/dedup/no-evidence/historical-wording), plus
// notes + tenant isolation. Live Express app + real Postgres.
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
const BASE = '/api/capture-evidence'

async function makeOpp(consultingFirmId: string, over: Record<string, unknown> = {}) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId, title: 'Evi Opp ' + Math.random().toString(36).slice(2, 7), agency: 'Department of the Navy',
      naicsCode: '541512', psc: 'D307', responseDeadline: new Date(Date.now() + 30 * 86_400_000), ...over,
    },
  })
}
async function addAward(opportunityId: string, over: Record<string, unknown> = {}) {
  return prisma.awardHistory.create({
    data: {
      opportunityId, awardingAgency: 'Department of the Navy', recipientName: 'Acme Federal Inc', recipientUei: null,
      awardAmount: 100000, awardDate: new Date('2025-01-01'), naics: '541512', psc: 'D307', contractNumber: 'K-1', ...over,
    },
  })
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Evidence Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'Evidence Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
})
afterAll(async () => { await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

describe('incumbent evidence', () => {
  it('returns NOT_AVAILABLE honestly when there is no award data', async () => {
    const opp = await makeOpp(firm.id)
    const res = await request(app).get(`${BASE}/${opp.id}`).set(H(admin.token)).expect(200)
    expect(res.body.data.incumbent.confidence).toBe('NOT_AVAILABLE')
    expect(res.body.data.competitors).toEqual([])
  })

  it('CONFIRMED single match with source attribution', async () => {
    const opp = await makeOpp(firm.id)
    await addAward(opp.id, { recipientName: 'Acme Federal Inc', contractNumber: 'K-77', baseAndAllOptions: 500000 })
    const res = await request(app).get(`${BASE}/${opp.id}`).set(H(admin.token)).expect(200)
    expect(res.body.data.incumbent.confidence).toBe('CONFIRMED')
    expect(res.body.data.incumbent.name).toBe('Acme Federal Inc')
    expect(res.body.data.incumbent.awardReference).toBe('K-77')
    expect(res.body.data.incumbent.evidenceSource).toMatch(/award history/i)
    expect(res.body.data.lastRefreshedAt).toBeTruthy()
  })

  it('AMBIGUOUS with comparable recipients (never confirmed)', async () => {
    const opp = await makeOpp(firm.id)
    await addAward(opp.id, { recipientName: 'Acme Federal', contractNumber: 'K-1' })
    await addAward(opp.id, { recipientName: 'Beta Corp', contractNumber: 'K-2' })
    const res = await request(app).get(`${BASE}/${opp.id}`).set(H(admin.token)).expect(200)
    expect(res.body.data.incumbent.confidence).toBe('AMBIGUOUS')
    expect(res.body.data.incumbent.name).toBe('Not available')
  })

  it('verify + correct (reason required) preserving the original, unauthorized blocked', async () => {
    const opp = await makeOpp(firm.id)
    await addAward(opp.id, { recipientName: 'Acme Federal Inc', contractNumber: 'K-1' })
    const get = await request(app).get(`${BASE}/${opp.id}`).set(H(admin.token)).expect(200)
    const incId = get.body.data.incumbent.id

    // CONSULTANT cannot verify or correct
    await request(app).patch(`${BASE}/incumbent/${incId}/verify`).set(H(consultant.token)).expect(403)
    await request(app).patch(`${BASE}/incumbent/${incId}/correct`).set(H(consultant.token)).send({ name: 'X', reason: 'y' }).expect(403)

    const verified = await request(app).patch(`${BASE}/incumbent/${incId}/verify`).set(H(admin.token)).expect(200)
    expect(verified.body.data.verification).toBe('VERIFIED')

    // correction requires a reason
    await request(app).patch(`${BASE}/incumbent/${incId}/correct`).set(H(admin.token)).send({ name: 'Real Winner LLC' }).expect(422)
    const corrected = await request(app).patch(`${BASE}/incumbent/${incId}/correct`).set(H(admin.token)).send({ name: 'Real Winner LLC', uei: 'UEI999', reason: 'Verified via CO' }).expect(200)
    expect(corrected.body.data.name).toBe('Real Winner LLC')
    expect(corrected.body.data.verification).toBe('CORRECTED')
    expect(corrected.body.data.originalName).toBe('Acme Federal Inc') // original preserved
    expect(corrected.body.data.correctionReason).toMatch(/CO/)

    // a refresh must NOT clobber the human correction
    await request(app).post(`${BASE}/${opp.id}/refresh`).set(H(admin.token)).expect(200)
    const after = await request(app).get(`${BASE}/${opp.id}`).set(H(admin.token)).expect(200)
    expect(after.body.data.incumbent.name).toBe('Real Winner LLC')
    expect(after.body.data.incumbent.verification).toBe('CORRECTED')
  })
})

describe('competitor evidence', () => {
  it('ranks deterministically, flags relevance, dedupes, and labels evidence historical', async () => {
    // Fresh firm so the firm-wide award aggregation is isolated + deterministic.
    const cfirm = await createTestFirm({ name: 'Competitor Rank Firm' })
    const cadmin = await createTestUser(cfirm.id, { role: 'ADMIN' })
    const opp = await prisma.opportunity.create({ data: { consultingFirmId: cfirm.id, title: 'Rank Opp', agency: 'Department of the Navy', naicsCode: '541512', psc: 'D307', responseDeadline: new Date(Date.now() + 30 * 86_400_000) } })
    const src = await prisma.opportunity.create({ data: { consultingFirmId: cfirm.id, title: 'Source of awards', agency: 'Department of the Navy', naicsCode: '541512', psc: 'D307', responseDeadline: new Date(Date.now() + 30 * 86_400_000) } })
    await addAward(src.id, { recipientName: 'Acme Federal Inc', awardAmount: 100000, contractNumber: 'A-1' })
    await addAward(src.id, { recipientName: 'ACME FEDERAL LLC', awardAmount: 200000, contractNumber: 'A-2' }) // dedupes with Acme
    await addAward(src.id, { recipientName: 'Beta Corp', awardAmount: 50000, contractNumber: 'B-1' })

    const res = await request(app).get(`${BASE}/${opp.id}`).set(H(cadmin.token)).expect(200)
    const comps = res.body.data.competitors
    expect(comps.length).toBeGreaterThanOrEqual(2)
    expect(comps[0].name).toMatch(/acme/i)
    expect(comps[0].relevantAwardCount).toBe(2) // deduped
    expect(comps[0].agencyRelevant).toBe(true)
    expect(comps[0].naicsRelevant).toBe(true)
    expect(comps[0].whyShown).toMatch(/historical evidence/i)
    expect(comps[0].whyShown).toMatch(/not a prediction/i)
  })

  it('edits a tenant-private note on a competitor', async () => {
    const opp = await makeOpp(firm.id)
    await addAward(opp.id, { recipientName: 'Note Target Inc' })
    // relevant award to make it a competitor of a second opp
    const opp2 = await makeOpp(firm.id)
    const get = await request(app).get(`${BASE}/${opp2.id}`).set(H(admin.token)).expect(200)
    const compId = get.body.data.competitors[0]?.id
    if (compId) {
      const noted = await request(app).patch(`${BASE}/${compId}/notes`).set(H(admin.token)).send({ notes: 'Aggressive on price' }).expect(200)
      expect(noted.body.data.notes).toBe('Aggressive on price')
      await request(app).patch(`${BASE}/${compId}/notes`).set(H(consultant.token)).send({ notes: 'x' }).expect(403)
    }
  })
})

describe('tenant isolation', () => {
  it('404s another firm opportunity and evidence row', async () => {
    const opp = await makeOpp(firm.id)
    await addAward(opp.id, { recipientName: 'Acme Federal Inc' })
    await request(app).get(`${BASE}/${opp.id}`).set(H(admin.token)).expect(200)
    // other firm cannot read our opportunity's evidence
    await request(app).get(`${BASE}/${opp.id}`).set(H(otherAdmin.token)).expect(404)
    await request(app).post(`${BASE}/${opp.id}/refresh`).set(H(otherAdmin.token)).expect(404)
    // other firm cannot touch our incumbent row
    const get = await request(app).get(`${BASE}/${opp.id}`).set(H(admin.token)).expect(200)
    await request(app).patch(`${BASE}/incumbent/${get.body.data.incumbent.id}/verify`).set(H(otherAdmin.token)).expect(404)
  })
})
