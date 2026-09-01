// =============================================================
// tierGate / getFirmPlan downgrade rules (unit, mocked prisma)
//
// Guards the revenue-enforcement fix: a subscription that is not in good
// standing (CANCELED, PAST_DUE, or an expired trial) must fall back to the
// free floor so paid features are not granted for free. ACTIVE subs and
// unexpired trials keep their paid plan.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config/database', () => ({
  prisma: { subscription: { findUnique: vi.fn() } },
}))
vi.mock('../services/auditService', () => ({ logAudit: vi.fn() }))
vi.mock('../services/entitlementService', () => ({
  getEntitlements: vi.fn(),
  computeMonthlyTokenGrant: vi.fn(() => 0),
}))

import { getFirmPlan } from './tierGate'
import { prisma } from '../config/database'
import { getEntitlements } from '../services/entitlementService'

const findUnique = (prisma as any).subscription.findUnique as ReturnType<typeof vi.fn>
const entitlements = getEntitlements as ReturnType<typeof vi.fn>
const NO_ACCESS = { baseActive: false, allAccess: false, addons: [], source: 'none', planSlug: null, subscriptionStatus: null, trialEndsAt: null }

const PAID_PLAN = { slug: 'enterprise', maxUsers: 10, maxClients: 100, aiCallsPerMonth: 5000 }
const future = new Date(Date.now() + 7 * 86_400_000)
const past = new Date(Date.now() - 7 * 86_400_000)

function sub(overrides: Record<string, unknown>) {
  return { status: 'ACTIVE', currentPeriodEnd: future, trialEndsAt: null, plan: PAID_PLAN, ...overrides }
}

describe('tierGate / getFirmPlan', () => {
  beforeEach(() => {
    findUnique.mockReset()
    entitlements.mockReset()
    entitlements.mockResolvedValue({ ...NO_ACCESS })
  })

  it('returns the locked floor (none) when no subscription exists', async () => {
    findUnique.mockResolvedValue(null)
    expect((await getFirmPlan('firm1')).slug).toBe('none')
  })

  // No Subscription row but flag-based all-access (owner comp / Founders
  // Lifetime): the usage layer must agree with the entitlement layer, so
  // limits are unlimited rather than the 0-AI-call floor.
  it('grants unlimited usage to an owner-comp firm with no subscription row', async () => {
    findUnique.mockResolvedValue(null)
    entitlements.mockResolvedValue({ ...NO_ACCESS, baseActive: true, allAccess: true, source: 'owner' })
    const plan = await getFirmPlan('firm1')
    expect(plan.slug).toBe('owner_comp')
    expect(plan.aiCallsPerMonth).toBe(-1)
    expect(plan.maxClients).toBe(-1)
  })

  it('grants unlimited usage to a lifetime firm with no subscription row', async () => {
    findUnique.mockResolvedValue(null)
    entitlements.mockResolvedValue({ ...NO_ACCESS, baseActive: true, allAccess: true, source: 'lifetime' })
    const plan = await getFirmPlan('firm1')
    expect(plan.slug).toBe('all_access')
    expect(plan.aiCallsPerMonth).toBe(-1)
  })

  it('returns the paid plan for an ACTIVE subscription', async () => {
    findUnique.mockResolvedValue(sub({ status: 'ACTIVE' }))
    expect((await getFirmPlan('firm1')).slug).toBe('enterprise')
  })

  it('downgrades a CANCELED subscription to the locked floor', async () => {
    findUnique.mockResolvedValue(sub({ status: 'CANCELED' }))
    expect((await getFirmPlan('firm1')).slug).toBe('none')
  })

  it('downgrades a PAST_DUE subscription to the locked floor', async () => {
    findUnique.mockResolvedValue(sub({ status: 'PAST_DUE' }))
    expect((await getFirmPlan('firm1')).slug).toBe('none')
  })

  it('downgrades an expired TRIALING subscription to the locked floor', async () => {
    findUnique.mockResolvedValue(sub({ status: 'TRIALING', trialEndsAt: past }))
    expect((await getFirmPlan('firm1')).slug).toBe('none')
  })

  it('keeps the paid plan for an active (unexpired) trial', async () => {
    findUnique.mockResolvedValue(sub({ status: 'TRIALING', trialEndsAt: future }))
    expect((await getFirmPlan('firm1')).slug).toBe('enterprise')
  })
})
