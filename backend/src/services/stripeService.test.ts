// =============================================================
// stripeService / mapStripeSubscriptionStatus (unit)
//
// Guards the webhook -> local Subscription sync: a Stripe status must map to
// the correct local SubscriptionStatus that tierGate reads. The critical
// property is the FAIL-SAFE default — any unrecognized status maps to PAST_DUE
// (downgrade), never ACTIVE — so a future/unknown Stripe state can't silently
// grant paid access.
// =============================================================
import { describe, it, expect, vi } from 'vitest'

vi.mock('../config/database', () => ({ prisma: {} }))
vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { mapStripeSubscriptionStatus } from './stripeService'

describe('stripeService / mapStripeSubscriptionStatus', () => {
  it('maps active -> ACTIVE', () => expect(mapStripeSubscriptionStatus('active')).toBe('ACTIVE'))
  it('maps trialing -> TRIALING', () => expect(mapStripeSubscriptionStatus('trialing')).toBe('TRIALING'))
  it('maps canceled -> CANCELED', () => expect(mapStripeSubscriptionStatus('canceled')).toBe('CANCELED'))
  it('maps incomplete_expired -> CANCELED', () =>
    expect(mapStripeSubscriptionStatus('incomplete_expired')).toBe('CANCELED'))
  it('maps past_due -> PAST_DUE', () => expect(mapStripeSubscriptionStatus('past_due')).toBe('PAST_DUE'))
  it('maps unpaid -> PAST_DUE', () => expect(mapStripeSubscriptionStatus('unpaid')).toBe('PAST_DUE'))
  it('maps incomplete -> PAST_DUE', () => expect(mapStripeSubscriptionStatus('incomplete')).toBe('PAST_DUE'))

  it('fail-safe: an unknown status maps to PAST_DUE, never ACTIVE', () => {
    expect(mapStripeSubscriptionStatus('some_future_status')).toBe('PAST_DUE')
    expect(mapStripeSubscriptionStatus('')).toBe('PAST_DUE')
  })
})
