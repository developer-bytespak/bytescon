// The state filter on the opportunity list (Civilian Programs uses it) and the
// state a page filters to by default for a consulting firm.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser
const H = (t: string) => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm()
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  const soon = new Date(Date.now() + 10 * 86400000)
  const civilian = (id: string, title: string, place: string | null, jurisdiction: string | null) => prisma.opportunity.create({
    data: {
      consultingFirmId: firm.id, samNoticeId: `usac_erate:${id}-${firm.id}`, title, agency: 'School District',
      source: 'CIVILIAN', responseDeadline: soon, placeOfPerformance: place, sourceMetadata: jurisdiction ? { jurisdiction } : undefined,
    },
  })
  await civilian('a', 'Texas fiber', 'Austin, TX', 'TX')
  await civilian('b', 'Ohio Wi-Fi', 'Akron, OH', 'OH')
  await civilian('c', 'Texas by place only', 'El Paso, TX', null)
  for (const [name, state] of [['One', 'VA'], ['Two', 'VA'], ['Three', 'MD']]) {
    await prisma.clientCompany.create({ data: { consultingFirmId: firm.id, name, state } })
  }
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await disconnectDb()
})

const titles = async (query: string) => {
  const res = await request(app).get(`/api/opportunities?source=CIVILIAN&${query}`).set(H(admin.token)).expect(200)
  return res.body.data.map((o: { title: string }) => o.title).sort()
}

describe('state filter', () => {
  it("shows one state's notices, by the feed's state or the place of performance", async () => {
    expect(await titles('state=TX')).toEqual(['Texas by place only', 'Texas fiber'])
    expect(await titles('state=oh')).toEqual(['Ohio Wi-Fi'])
    expect(await titles('')).toEqual(['Ohio Wi-Fi', 'Texas by place only', 'Texas fiber'])
  })

  it("defaults a consulting firm to the state most of its clients are in", async () => {
    const res = await request(app).get('/api/opportunities/home-state').set(H(admin.token)).expect(200)
    expect(res.body.data).toEqual({ state: 'VA' })
  })
})
