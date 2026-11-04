// B12 — owner-comp and lifetime firms are unlimited, even with a Subscription row.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prisma } from '../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, type TestFirm } from '../test-utils/testClient'
import { checkClientLimit, checkUserLimit, getFirmPlan } from './tierGate'

let firm: TestFirm

beforeEach(async () => {
  firm = await createTestFirm({ name: 'Owner Plan Firm', plan: 'base' })
})

afterEach(async () => {
  await cleanupFirm(firm.id)
})

afterAll(async () => {
  await disconnectDb()
})

describe('plan limits', () => {
  it('leave an ordinary base-plan firm limited', async () => {
    const plan = await getFirmPlan(firm.id)
    expect(plan.slug).toBe('base')
    expect(plan.maxUsers).toBeGreaterThan(0)
  })

  it('do not apply to an owner-comp firm with a Subscription row', async () => {
    await prisma.consultingFirm.update({ where: { id: firm.id }, data: { isOwnerComp: true } })
    expect(await getFirmPlan(firm.id)).toMatchObject({ slug: 'owner_comp', maxUsers: -1, maxClients: -1, aiCallsPerMonth: -1 })
    expect((await checkUserLimit(firm.id)).allowed).toBe(true)
    expect((await checkClientLimit(firm.id)).allowed).toBe(true)
  })

  it('stay off when the owner firm has a cancelled subscription', async () => {
    await prisma.consultingFirm.update({ where: { id: firm.id }, data: { isOwnerComp: true } })
    await prisma.subscription.update({ where: { consultingFirmId: firm.id }, data: { status: 'CANCELED' } })
    expect((await getFirmPlan(firm.id)).maxUsers).toBe(-1)
  })

  it('do not apply to a lifetime firm with a Subscription row', async () => {
    await prisma.consultingFirm.update({ where: { id: firm.id }, data: { lifetimeAccessAt: new Date() } })
    expect(await getFirmPlan(firm.id)).toMatchObject({ slug: 'all_access', maxUsers: -1 })
  })
})
