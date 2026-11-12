// =============================================================
// The Opportunities list shows every notice by default; "Matches my business
// type" (?match=) narrows it to all clients' or one client's NAICS codes
// (services/opportunityMatch.ts). The demo's business type is covered in
// demo.integration.test.ts.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const DAY = 86_400_000
let app: Express
let firm: TestFirm
let admin: TestUser
let cabling: string
let noNaics: string

const notice = (title: string, naicsCode: string) => prisma.opportunity.create({
  data: { consultingFirmId: firm.id, title, agency: 'GSA', naicsCode, responseDeadline: new Date(Date.now() + 30 * DAY) },
})
const titles = async (query: string) => {
  const res = await request(app).get(`/api/opportunities?limit=100${query}`).set(H(admin.token)).expect(200)
  return { titles: (res.body.data as Array<{ title: string }>).map((o) => o.title).sort(), meta: res.body.meta }
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Match Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  cabling = (await prisma.clientCompany.create({ data: { consultingFirmId: firm.id, name: 'Cabling Co', naicsCodes: ['238210'] } })).id
  await prisma.clientCompany.create({ data: { consultingFirmId: firm.id, name: 'Software Co', naicsCodes: ['541511'] } })
  await prisma.clientCompany.create({ data: { consultingFirmId: firm.id, name: 'Archived Food Co', naicsCodes: ['311812'], isActive: false } })
  noNaics = (await prisma.clientCompany.create({ data: { consultingFirmId: firm.id, name: 'New Co' } })).id
  await notice('Fiber install', '238210')
  await notice('Electrical upgrade', '238219')
  await notice('App development', '541512')
  await notice('Bakery supplies', '311812')
  await notice('Aircraft parts', '336413')
})
afterAll(async () => {
  await cleanupFirm(firm.id)
  await disconnectDb()
})

describe('Opportunities: all notices, or matching my business', () => {
  it('shows every available notice by default', async () => {
    const r = await titles('')
    expect(r.titles).toEqual(['Aircraft parts', 'App development', 'Bakery supplies', 'Electrical upgrade', 'Fiber install'])
    expect(r.meta.match).toMatchObject({ mode: 'all', prefixes: null })
  })

  it('narrows to notices matching any active client (first 4 NAICS digits)', async () => {
    const r = await titles('&match=clients')
    expect(r.titles).toEqual(['App development', 'Electrical upgrade', 'Fiber install'])
    expect(r.meta.match.mode).toBe('clients')
  })

  it('narrows to one client, also through the older clientId parameter', async () => {
    expect((await titles(`&match=client:${cabling}`)).titles).toEqual(['Electrical upgrade', 'Fiber install'])
    expect((await titles(`&clientId=${cabling}`)).titles).toEqual(['Electrical upgrade', 'Fiber install'])
  })

  it('shows nothing, rather than everything, for a client without NAICS codes', async () => {
    const r = await titles(`&match=client:${noNaics}`)
    expect(r.titles).toEqual([])
    expect(r.meta.match.prefixes).toEqual([])
  })

  it('uses the clients for "business" outside the demo, and lists the choices', async () => {
    expect((await titles('&match=business')).titles).toEqual(['App development', 'Electrical upgrade', 'Fiber install'])
    const options = await request(app).get('/api/opportunities/match-options').set(H(admin.token)).expect(200)
    expect(options.body.data.businessType).toBeNull()
    expect(options.body.data.clients.map((c: { name: string }) => c.name)).toEqual(['Cabling Co', 'New Co', 'Software Co'])
    expect(options.body.data.clients.find((c: { name: string }) => c.name === 'New Co').hasNaics).toBe(false)
  })

  it('applies the same filter to the CSV export', async () => {
    const all = await request(app).get('/api/opportunities/export?limit=100').set(H(admin.token)).expect(200)
    const mine = await request(app).get(`/api/opportunities/export?limit=100&match=client:${cabling}`).set(H(admin.token)).expect(200)
    const rows = (r: request.Response) => JSON.stringify(r.body ?? r.text)
    expect(rows(all)).toMatch(/Bakery supplies/)
    expect(rows(mine)).not.toMatch(/Bakery supplies/)
    expect(rows(mine)).toMatch(/Fiber install/)
  })
})
