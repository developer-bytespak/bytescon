// =============================================================
// entitlementService — the single-plan + add-ons access matrix
// (unit, mocked prisma). Guards the revenue model: every all-access
// source resolves correctly, lapsed firms hit the locked floor, and
// legacy add-on slugs stay honored through the alias map.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config/database', () => ({
  prisma: { consultingFirm: { findUnique: vi.fn() } },
}))

import {
  getEntitlements,
  hasAddonEntitlement,
  computeMonthlyTokenGrant,
} from './entitlementService'
import { prisma } from '../config/database'

const findUnique = (prisma as any).consultingFirm.findUnique as ReturnType<typeof vi.fn>

const future = new Date(Date.now() + 7 * 86_400_000)
const past = new Date(Date.now() - 7 * 86_400_000)

function firm(overrides: Record<string, unknown> = {}) {
  return {
    isOwnerComp: false,
    lifetimeAccessAt: null,
    purchasedAddons: [] as string[],
    subscription: null,
    ...overrides,
  }
}

function sub(planSlug: string, overrides: Record<string, unknown> = {}) {
  return {
    status: 'ACTIVE',
    trialEndsAt: null,
    plan: { slug: planSlug },
    ...overrides,
  }
}

describe('getEntitlements — access matrix', () => {
  beforeEach(() => findUnique.mockReset())

  it('unknown firm → locked floor', async () => {
    findUnique.mockResolvedValue(null)
    const e = await getEntitlements('missing')
    expect(e.baseActive).toBe(false)
    expect(e.allAccess).toBe(false)
    expect(e.addons).toEqual([])
    expect(e.source).toBe('none')
  })

  it('owner-comp firm → all-access regardless of subscription', async () => {
    findUnique.mockResolvedValue(firm({ isOwnerComp: true }))
    const e = await getEntitlements('f')
    expect(e.allAccess).toBe(true)
    expect(e.baseActive).toBe(true)
    expect(e.source).toBe('owner')
    expect(hasAddonEntitlement(e, 'teaming_suite')).toBe(true)
  })

  it('lifetime flag → all-access even with no subscription row', async () => {
    findUnique.mockResolvedValue(firm({ lifetimeAccessAt: past }))
    const e = await getEntitlements('f')
    expect(e.allAccess).toBe(true)
    expect(e.source).toBe('lifetime')
  })

  it('legacy beta_lifetime ACTIVE subscription → all-access', async () => {
    findUnique.mockResolvedValue(firm({ subscription: sub('beta_lifetime') }))
    const e = await getEntitlements('f')
    expect(e.allAccess).toBe(true)
    expect(e.source).toBe('lifetime')
  })

  it('valid TRIALING → all-access trial', async () => {
    findUnique.mockResolvedValue(firm({ subscription: sub('base', { status: 'TRIALING', trialEndsAt: future }) }))
    const e = await getEntitlements('f')
    expect(e.allAccess).toBe(true)
    expect(e.source).toBe('trial')
    expect(hasAddonEntitlement(e, 'proposal_studio')).toBe(true)
  })

  it('expired TRIALING → locked floor, no addons', async () => {
    findUnique.mockResolvedValue(
      firm({ purchasedAddons: ['teaming_suite'], subscription: sub('base', { status: 'TRIALING', trialEndsAt: past }) }),
    )
    const e = await getEntitlements('f')
    expect(e.baseActive).toBe(false)
    expect(e.allAccess).toBe(false)
    expect(e.source).toBe('none')
  })

  it('ACTIVE all_access plan → bundle all-access', async () => {
    findUnique.mockResolvedValue(firm({ subscription: sub('all_access') }))
    const e = await getEntitlements('f')
    expect(e.allAccess).toBe(true)
    expect(e.source).toBe('bundle')
  })

  it('ACTIVE base plan + purchased addons → base + those addons only', async () => {
    findUnique.mockResolvedValue(
      firm({ purchasedAddons: ['teaming_suite', 'setaside_intel'], subscription: sub('base') }),
    )
    const e = await getEntitlements('f')
    expect(e.baseActive).toBe(true)
    expect(e.allAccess).toBe(false)
    expect(e.source).toBe('purchased')
    expect(hasAddonEntitlement(e, 'teaming_suite')).toBe(true)
    expect(hasAddonEntitlement(e, 'setaside_intel')).toBe(true)
    expect(hasAddonEntitlement(e, 'proposal_studio')).toBe(false)
  })

  it('legacy addon slugs resolve through the alias map', async () => {
    findUnique.mockResolvedValue(
      firm({ purchasedAddons: ['proposal_assistant', 'competitor_intel', 'compliance_matrix_ai'], subscription: sub('base') }),
    )
    const e = await getEntitlements('f')
    expect(hasAddonEntitlement(e, 'proposal_studio')).toBe(true)
    expect(hasAddonEntitlement(e, 'market_intel')).toBe(true)
    expect(hasAddonEntitlement(e, 'contract_analysis')).toBe(true)
    expect(hasAddonEntitlement(e, 'teaming_suite')).toBe(false)
  })

  it('legacy ACTIVE tier row (pre-cutover window) still counts as base-active', async () => {
    findUnique.mockResolvedValue(firm({ subscription: sub('professional') }))
    const e = await getEntitlements('f')
    expect(e.baseActive).toBe(true)
    expect(e.allAccess).toBe(false)
  })

  it('PAST_DUE base plan → locked floor', async () => {
    findUnique.mockResolvedValue(firm({ subscription: sub('base', { status: 'PAST_DUE' }) }))
    const e = await getEntitlements('f')
    expect(e.baseActive).toBe(false)
    expect(e.source).toBe('none')
  })

  it('unknown slugs in purchasedAddons are ignored', async () => {
    findUnique.mockResolvedValue(firm({ purchasedAddons: ['bogus_slug'], subscription: sub('base') }))
    const e = await getEntitlements('f')
    expect(e.addons).toEqual([])
  })
})

describe('computeMonthlyTokenGrant', () => {
  beforeEach(() => findUnique.mockReset())

  it('all-access sources get the flat 50', async () => {
    findUnique.mockResolvedValue(firm({ isOwnerComp: true }))
    expect(computeMonthlyTokenGrant(await getEntitlements('f'))).toBe(50)
  })

  it('à-la-carte firms sum their module grants (proposal 25 + contract 15 + teaming 5)', async () => {
    findUnique.mockResolvedValue(
      firm({ purchasedAddons: ['proposal_studio', 'contract_analysis', 'teaming_suite'], subscription: sub('base') }),
    )
    expect(computeMonthlyTokenGrant(await getEntitlements('f'))).toBe(45)
  })

  it('base with no addons grants 0', async () => {
    findUnique.mockResolvedValue(firm({ subscription: sub('base') }))
    expect(computeMonthlyTokenGrant(await getEntitlements('f'))).toBe(0)
  })

  it('locked floor grants 0', async () => {
    findUnique.mockResolvedValue(firm({ subscription: sub('base', { status: 'CANCELED' }) }))
    expect(computeMonthlyTokenGrant(await getEntitlements('f'))).toBe(0)
  })
})
