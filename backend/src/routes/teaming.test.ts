// =============================================================
// Teaming Partner CRM + Graph — /api/teaming (FIX-2 moat)
// Covers CRUD, write-role gating, cross-tenant containment, and the
// graph aggregation (roles, teamed value, agency coverage, win rate).
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
let firm: TestFirm
let admin: TestUser
let member: TestUser
let otherFirm: TestFirm
let otherAdmin: TestUser
let oppId: string
let otherOppId: string

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Teaming Firm A' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  member = await createTestUser(firm.id, { role: 'CONSULTANT' })
  otherFirm = await createTestFirm({ name: 'Teaming Firm B' })
  otherAdmin = await createTestUser(otherFirm.id, { role: 'ADMIN' })

  const past = new Date(Date.now() - 7 * 86_400_000)
  const opp = await prisma.opportunity.create({
    data: { consultingFirmId: firm.id, title: 'Team Bid Alpha', agency: 'GSA', naicsCode: '541512', responseDeadline: past },
  })
  oppId = opp.id
  const otherOpp = await prisma.opportunity.create({
    data: { consultingFirmId: otherFirm.id, title: 'Other Firm Bid', agency: 'DHS', naicsCode: '541512', responseDeadline: past },
  })
  otherOppId = otherOpp.id
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await cleanupFirm(otherFirm.id)
  await disconnectDb()
})

describe('FIX-2 teaming — /api/teaming', () => {
  let partnerId: string

  it('rejects a non-admin creating a partner (403)', async () => {
    const res = await request(app)
      .post('/api/teaming/partners')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: 'Should Not Save' })
    expect(res.status).toBe(403)
  })

  it('creates a partner as admin (201)', async () => {
    const res = await request(app)
      .post('/api/teaming/partners')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'Acme Federal LLC',
        uei: 'ABC123DEF456',
        primarySetAsides: ['SDVOSB'],
        primaryNaicsCodes: ['541512'],
        capabilities: ['cloud', 'cyber'],
        cmmcLevel: 2,
      })
    expect(res.status).toBe(201)
    expect(res.body.data.partner.name).toBe('Acme Federal LLC')
    partnerId = res.body.data.partner.id
  })

  it('lists partners with arrangement counts (member can read)', async () => {
    const res = await request(app).get('/api/teaming/partners').set('Authorization', `Bearer ${member.token}`)
    expect(res.status).toBe(200)
    const p = res.body.data.partners.find((x: { id: string }) => x.id === partnerId)
    expect(p).toBeTruthy()
    expect(p.arrangementCount).toBe(0)
  })

  it('creates an arrangement linking partner ⇄ in-tenant opportunity (201)', async () => {
    const res = await request(app)
      .post('/api/teaming/arrangements')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        opportunityId: oppId,
        partnerId,
        role: 'SUB',
        arrangementType: 'TEAMING_AGREEMENT',
        scopePercent: 30,
        dollarShare: 250000,
      })
    expect(res.status).toBe(201)
    expect(res.body.data.arrangement.partner.name).toBe('Acme Federal LLC')
  })

  it("rejects an arrangement pointing at another firm's opportunity (404)", async () => {
    const res = await request(app)
      .post('/api/teaming/arrangements')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ opportunityId: otherOppId, partnerId, role: 'SUB', arrangementType: 'JV' })
    expect(res.status).toBe(404)
  })

  it("does not leak partners across tenants", async () => {
    const res = await request(app).get('/api/teaming/partners').set('Authorization', `Bearer ${otherAdmin.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.partners.find((x: { id: string }) => x.id === partnerId)).toBeFalsy()
  })

  it('graph rolls up value, agency coverage, role mix and a win rate', async () => {
    // Record a WON outcome on the teamed opportunity so the graph win-rate lights up.
    const client = await prisma.clientCompany.create({ data: { consultingFirmId: firm.id, name: 'Teaming Client' } })
    await prisma.submissionRecord.create({
      data: { consultingFirmId: firm.id, clientCompanyId: client.id, opportunityId: oppId, outcome: 'WON', outcomeRecordedAt: new Date() },
    })

    const res = await request(app).get('/api/teaming/graph').set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(200)
    const { summary, partners } = res.body.data
    expect(summary.partners).toBe(1)
    expect(summary.arrangements).toBe(1)
    expect(summary.totalTeamedValue).toBe(250000)
    expect(summary.agencyCoverage).toBe(1)
    expect(summary.roleMix.SUB).toBe(1)
    expect(summary.teamedBidWinRatePct).toBe(100)

    const node = partners.find((n: { partnerId: string }) => n.partnerId === partnerId)
    expect(node.arrangements).toBe(1)
    expect(node.agencies).toContain('GSA')
    expect(node.teamedValue).toBe(250000)
    expect(node.won).toBe(1)
    expect(node.winRatePct).toBe(100)
  })

  it('deletes a partner and cascades its arrangements (admin)', async () => {
    const del = await request(app).delete(`/api/teaming/partners/${partnerId}`).set('Authorization', `Bearer ${admin.token}`)
    expect(del.status).toBe(200)
    const remaining = await prisma.teamingArrangement.count({ where: { partnerId } })
    expect(remaining).toBe(0)
  })
})

describe('FIX-2 teaming — GET /api/teaming/recommend/:opportunityId', () => {
  it('ranks a well-matched partner above a poorly-matched one, with explainable factors', async () => {
    const opp = await prisma.opportunity.create({
      data: {
        consultingFirmId: firm.id,
        title: 'Enterprise Cybersecurity Support Services',
        agency: 'DHS',
        naicsCode: '541512',
        setAsideType: 'SDVOSB',
        description: 'Zero-trust cybersecurity engineering and SOC operations.',
        responseDeadline: new Date(Date.now() + 20 * 86_400_000),
      },
    })

    const strong = await prisma.partner.create({
      data: {
        consultingFirmId: firm.id,
        name: 'Strong Match Inc',
        primaryNaicsCodes: ['541512'],
        primarySetAsides: ['SDVOSB'],
        capabilities: ['cybersecurity'],
      },
    })
    const weak = await prisma.partner.create({
      data: {
        consultingFirmId: firm.id,
        name: 'Weak Match LLC',
        primaryNaicsCodes: ['236220'], // construction — different sector
        primarySetAsides: [],
        capabilities: [],
      },
    })

    const res = await request(app).get(`/api/teaming/recommend/${opp.id}`).set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(200)
    const recs = res.body.data.recommendations as Array<{ partnerId: string; score: number; factors: unknown[] }>
    const strongRec = recs.find((r) => r.partnerId === strong.id)!
    const weakRec = recs.find((r) => r.partnerId === weak.id)!

    // Exact NAICS (40) + SDVOSB set-aside (25) + capability "cybersecurity" (10) = 75.
    expect(strongRec.score).toBe(75)
    expect(weakRec.score).toBe(0)
    expect(recs[0].partnerId).toBe(strong.id) // sorted best-first
    expect(strongRec.factors).toHaveLength(4)
  })

  it("404s on another firm's opportunity", async () => {
    const res = await request(app).get(`/api/teaming/recommend/${otherOppId}`).set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(404)
  })
})
