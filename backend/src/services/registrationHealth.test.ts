// =============================================================
// Section 5 Module 2 — expiry classification + health rollup must be
// deterministic under a controlled clock (date-based reminder behaviour).
// =============================================================
import { describe, it, expect } from 'vitest'
import { classifyExpiry, daysUntil, buildRegistrationHealth } from './registrationHealth'

const NOW = new Date('2026-08-04T00:00:00.000Z')
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000)

describe('classifyExpiry', () => {
  it('MISSING when no expiry date', () => {
    expect(classifyExpiry(null, NOW, 60)).toBe('MISSING')
    expect(classifyExpiry(undefined, NOW, 60)).toBe('MISSING')
  })
  it('EXPIRED when in the past', () => {
    expect(classifyExpiry(inDays(-1), NOW, 60)).toBe('EXPIRED')
  })
  it('EXPIRING_SOON within the lead window (inclusive of the boundary)', () => {
    expect(classifyExpiry(inDays(30), NOW, 60)).toBe('EXPIRING_SOON')
    expect(classifyExpiry(inDays(60), NOW, 60)).toBe('EXPIRING_SOON')
  })
  it('ACTIVE beyond the lead window', () => {
    expect(classifyExpiry(inDays(61), NOW, 60)).toBe('ACTIVE')
    expect(classifyExpiry(inDays(400), NOW, 60)).toBe('ACTIVE')
  })
  it('respects a custom lead time', () => {
    expect(classifyExpiry(inDays(20), NOW, 10)).toBe('ACTIVE')
    expect(classifyExpiry(inDays(20), NOW, 30)).toBe('EXPIRING_SOON')
  })
})

describe('daysUntil', () => {
  it('is positive for future, negative for past, null for missing', () => {
    expect(daysUntil(inDays(10), NOW)).toBe(10)
    expect(daysUntil(inDays(-3), NOW)).toBe(-3)
    expect(daysUntil(null, NOW)).toBeNull()
  })
})

describe('buildRegistrationHealth', () => {
  const profile = { samExpiryDate: inDays(400), reminderLeadDays: 60, ownerUserId: 'u1' }
  const certs = [
    { id: 'c1', name: 'SDVOSB', expiryDate: inDays(15), reminderLeadDays: 60, ownerUserId: null }, // EXPIRING_SOON
    { id: 'c2', name: 'ISO 9001', expiryDate: inDays(-5), reminderLeadDays: 60, ownerUserId: null }, // EXPIRED
    { id: 'c3', name: '8(a)', expiryDate: null, reminderLeadDays: 60, ownerUserId: null }, // MISSING
  ]
  const policies = [
    { id: 'p1', policyType: 'GENERAL_LIABILITY', expiryDate: inDays(500), reminderLeadDays: 60, ownerUserId: null }, // ACTIVE
  ]

  it('rolls up a correct summary across SAM + certs + insurance', () => {
    const h = buildRegistrationHealth(profile, certs, policies, NOW)
    expect(h.summary).toEqual({ active: 2, expiringSoon: 1, expired: 1, missing: 1, total: 5 })
  })

  it('attention list contains only EXPIRED + EXPIRING_SOON, soonest first (expired first)', () => {
    const h = buildRegistrationHealth(profile, certs, policies, NOW)
    expect(h.attention.map((i) => i.id)).toEqual(['c2', 'c1']) // -5 days then +15 days
    expect(h.attention.every((i) => i.status === 'EXPIRED' || i.status === 'EXPIRING_SOON')).toBe(true)
  })

  it('handles a firm with no profile and no records (empty but valid)', () => {
    const h = buildRegistrationHealth(null, [], [], NOW)
    expect(h.summary.total).toBe(0)
    expect(h.attention).toEqual([])
  })
})
