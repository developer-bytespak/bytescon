// A prime saved in Agency View is the same company as a partner on Subs &
// Primes: created once per UEI, marked as a prime you work under, and its
// saved entries show on that partner's page.
import { describe, it, expect, vi, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../config/database'
import { createTestFirm, createTestUser, cleanupFirm, disconnectDb } from '../test-utils/testClient'

vi.mock('../middleware/addonGate', () => ({
  requireActiveBase: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAddon: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

import agencyRoutes from './agency'
import crmRoutes from './crm'
import { errorHandler } from '../middleware/errorHandler'

const app = express()
app.use(express.json())
app.use('/api/agency', agencyRoutes)
app.use('/api/crm', crmRoutes)
app.use(errorHandler)
const firms: string[] = []
afterAll(async () => { for (const id of firms) await cleanupFirm(id); await disconnectDb() })

describe('a prime saved in Agency View', () => {
  it('becomes one partner per UEI, marked as a prime, with its saved entries on its page', async () => {
    const f = await createTestFirm({ name: 'Saved Prime Firm' })
    firms.push(f.id)
    const a = await createTestUser(f.id, { role: 'ADMIN' })
    const auth = { Authorization: `Bearer ${a.token}` }
    const [c1, c2] = await Promise.all(['First Client', 'Second Client'].map((name) => prisma.clientCompany.create({ data: { consultingFirmId: f.id, name } })))
    const save = (clientId: string) => request(app).post('/api/agency/relationships').set(auth).send({ clientId, primeUei: 'PRIMEUEI00001', agencyCode: '9700' })
    expect((await save(c1.id)).status).toBe(200)
    expect((await save(c2.id)).status).toBe(200)

    const partners = await prisma.partner.findMany({ where: { consultingFirmId: f.id } })
    expect(partners).toHaveLength(1)
    expect(partners[0]).toMatchObject({ uei: 'PRIMEUEI00001', partnerType: 'PRIME' })
    const page = await request(app).get(`/api/crm/partners/${partners[0].id}`).set(auth).expect(200)
    expect(page.body.data.savedPrimeEntries.map((e: { clientCompany: { name: string } }) => e.clientCompany.name).sort()).toEqual(['First Client', 'Second Client'])
  })

  it('turns a partner kept only as a sub into "either"', async () => {
    const f = await createTestFirm({ name: 'Sub Then Prime Firm' })
    firms.push(f.id)
    const a = await createTestUser(f.id, { role: 'ADMIN' })
    const client = await prisma.clientCompany.create({ data: { consultingFirmId: f.id, name: 'Only Client' } })
    const sub = await prisma.partner.create({ data: { consultingFirmId: f.id, name: 'Both Ways LLC', uei: 'BOTHWAYS0001', partnerType: 'SUB' } })
    await request(app).post('/api/agency/relationships').set({ Authorization: `Bearer ${a.token}` }).send({ clientId: client.id, primeUei: 'BOTHWAYS0001', agencyCode: '7000' }).expect(200)
    expect((await prisma.partner.findUniqueOrThrow({ where: { id: sub.id } })).partnerType).toBe('BOTH')
    expect(await prisma.partner.count({ where: { consultingFirmId: f.id } })).toBe(1)
  })
})
