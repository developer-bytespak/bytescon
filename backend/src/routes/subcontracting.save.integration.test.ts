// Saving a "Work from primes" lead: the prime is a partner you work under, the
// client (or a contractor's own company) is the sub, and the agency field is
// the government agency, never the prime.
import { describe, it, expect, vi, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../config/database'
import { createTestFirm, createTestUser, cleanupFirm, disconnectDb } from '../test-utils/testClient'

vi.mock('../middleware/addonGate', () => ({
  requireActiveBase: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAddon: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

import subcontractingRoutes from './subcontracting'
import { errorHandler } from '../middleware/errorHandler'

const app = express()
app.use(express.json())
app.use('/api/subcontracting', subcontractingRoutes)
app.use(errorHandler)
const firms: string[] = []
afterAll(async () => { for (const id of firms) await cleanupFirm(id); await disconnectDb() })

describe('save a subcontracting lead to the pipeline', () => {
  it('records the prime as a partner you work under and the client as the sub', async () => {
    const firm = await createTestFirm({ name: 'Lead Consulting' })
    firms.push(firm.id)
    const admin = await createTestUser(firm.id, { role: 'ADMIN' })
    const readOnly = await createTestUser(firm.id, { role: 'CONSULTANT' })
    const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
    const [c1, c2] = await Promise.all(['Meridian Federal', 'Beta Systems'].map((name) => prisma.clientCompany.create({ data: { consultingFirmId: firm.id, name } })))
    const lead = await prisma.subcontractOpportunity.create({ data: { consultingFirmId: firm.id, title: 'Network upgrade', primeContractor: 'Big Prime Inc', agency: null } })

    expect((await request(app).post(`/api/subcontracting/opportunities/${lead.id}/save-to-pipeline`).set(auth(readOnly.token)).send({ clientCompanyId: c2.id })).status).toBe(403)
    const noClient = await request(app).post(`/api/subcontracting/opportunities/${lead.id}/save-to-pipeline`).set(auth(admin.token)).send({})
    expect(noClient.status).toBe(422)
    expect(noClient.body.error).toMatch(/Choose which client/)

    const res = await request(app).post(`/api/subcontracting/opportunities/${lead.id}/save-to-pipeline`).set(auth(admin.token)).send({ clientCompanyId: c2.id })
    expect(res.status).toBe(201)
    const opp = await prisma.opportunity.findUniqueOrThrow({ where: { id: res.body.data.opportunityId } })
    expect(opp.agency).toBe('Agency not stated')
    const prime = await prisma.partner.findUniqueOrThrow({ where: { id: res.body.data.primePartnerId } })
    expect(prime).toMatchObject({ name: 'Big Prime Inc', partnerType: 'PRIME' })
    const deal = await prisma.teamingArrangement.findFirstOrThrow({ where: { opportunityId: opp.id } })
    expect(deal).toMatchObject({ partnerId: prime.id, clientCompanyId: c2.id, role: 'PRIME', arrangementType: 'SUBCONTRACT' })
    expect(c1.id).not.toBe(deal.clientCompanyId)
  })
})
