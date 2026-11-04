// =============================================================
// Route-level checks for B22 (agency cards), B24 (8(a) on clients) and B26
// (switching Winners Intel on without touching the database).
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

const SAVED = process.env.ENABLE_WINNERS_INTEL
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

let app: Express
let firm: TestFirm
let admin: TestUser
let member: TestUser

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Remaining Bugs Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  member = await createTestUser(firm.id, { role: 'CONSULTANT' })
})

afterAll(async () => {
  if (SAVED === undefined) delete process.env.ENABLE_WINNERS_INTEL
  else process.env.ENABLE_WINNERS_INTEL = SAVED
  await prisma.agencyOffice.deleteMany({ where: { consultingFirmId: firm.id } })
  await cleanupFirm(firm.id)
  await disconnectDb()
})

describe('agency cards (B22)', () => {
  it('names every spelling merged into a card, so its offices can be listed', async () => {
    await prisma.agencyOffice.createMany({
      data: [
        { consultingFirmId: firm.id, agencyName: 'Department of Energy', officeName: 'Oak Ridge' },
        { consultingFirmId: firm.id, agencyName: 'DEPARTMENT OF ENERGY', officeName: 'Hanford' },
      ],
    })
    const res = await request(app).get('/api/crm/agencies').set(auth(admin.token)).expect(200)
    const card = res.body.data.items.find((a: { officeCount: number; agencyNames: string[] }) => a.agencyNames?.includes('Department of Energy'))
    expect(card.officeCount).toBe(2)
    expect(card.agencyNames.sort()).toEqual(['DEPARTMENT OF ENERGY', 'Department of Energy'])
  })
})

describe('8(a) on a client (B24)', () => {
  it('is saved and returned, with its term end', async () => {
    const created = await request(app).post('/api/clients').set(auth(admin.token))
      .send({ name: 'Eight A Co', eightA: true, eightACertExpiry: '2030-01-31' })
    expect(created.status).toBe(201)
    const row = await prisma.clientCompany.findFirstOrThrow({ where: { consultingFirmId: firm.id, name: 'Eight A Co' } })
    expect(row.eightA).toBe(true)
    expect(row.eightACertExpiry?.toISOString().slice(0, 10)).toBe('2030-01-31')
  })

  it('defaults to off', async () => {
    await request(app).post('/api/clients').set(auth(admin.token)).send({ name: 'Plain Co' })
    const row = await prisma.clientCompany.findFirstOrThrow({ where: { consultingFirmId: firm.id, name: 'Plain Co' } })
    expect(row.eightA).toBe(false)
  })
})

describe('the Winners Intel setting (B26)', () => {
  const URL = '/api/firm/winners-intel'

  it('lets an admin switch it on and off, and records it', async () => {
    process.env.ENABLE_WINNERS_INTEL = 'true'
    expect((await request(app).get(URL).set(auth(admin.token)).expect(200)).body.data).toEqual({ available: true, optIn: false })

    const on = await request(app).put(URL).set(auth(admin.token)).send({ optIn: true }).expect(200)
    expect(on.body.data.optIn).toBe(true)
    const row = await prisma.consultingFirm.findUniqueOrThrow({ where: { id: firm.id }, select: { winnersIntelOptIn: true } })
    expect(row.winnersIntelOptIn).toBe(true)

    const entry = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, rationale: 'Winners Intel switched on' } })
    expect(entry).not.toBeNull()

    expect((await request(app).put(URL).set(auth(admin.token)).send({ optIn: false }).expect(200)).body.data.optIn).toBe(false)
  })

  it('says when the platform switch is off', async () => {
    delete process.env.ENABLE_WINNERS_INTEL
    expect((await request(app).get(URL).set(auth(admin.token)).expect(200)).body.data.available).toBe(false)
  })

  it('is admin-only and rejects a bad value', async () => {
    await request(app).get(URL).set(auth(member.token)).expect(403)
    await request(app).put(URL).set(auth(member.token)).send({ optIn: true }).expect(403)
    await request(app).put(URL).set(auth(admin.token)).send({ optIn: 'yes' }).expect(400)
  })
})
