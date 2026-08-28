// =============================================================
// Subcontract expiry helper tests — pure, deterministic.
//
// `now` is always injected so these never depend on the wall clock.
// =============================================================

import { describe, it, expect } from 'vitest'
import {
  computeExpiryState,
  graceCutoff,
  daysSinceExpiry,
  EXPIRY_GRACE_DAYS,
  EXPIRING_SOON_DAYS,
} from './subcontractExpiry'

const NOW = new Date('2026-06-13T00:00:00Z')
const MS_PER_DAY = 24 * 60 * 60 * 1000
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * MS_PER_DAY)

describe('computeExpiryState', () => {
  it('treats null as active (rolling / no stated close)', () => {
    expect(computeExpiryState(null, NOW)).toBe('active')
  })

  it('treats undefined as active', () => {
    expect(computeExpiryState(undefined, NOW)).toBe('active')
  })

  it('classifies a clearly-past deadline as expired', () => {
    expect(computeExpiryState(daysFromNow(-30), NOW)).toBe('expired')
  })

  it('classifies a deadline 3 days out as expiring_soon', () => {
    expect(computeExpiryState(daysFromNow(3), NOW)).toBe('expiring_soon')
  })

  it('classifies a deadline 30 days out as active', () => {
    expect(computeExpiryState(daysFromNow(30), NOW)).toBe('active')
  })

  it('treats the exact 7-day boundary as expiring_soon', () => {
    expect(computeExpiryState(daysFromNow(EXPIRING_SOON_DAYS), NOW)).toBe('expiring_soon')
  })

  it('treats an invalid date string as active', () => {
    expect(computeExpiryState('not-a-date', NOW)).toBe('active')
  })

  it('accepts an ISO string deadline', () => {
    expect(computeExpiryState(daysFromNow(3).toISOString(), NOW)).toBe('expiring_soon')
  })
})

describe('graceCutoff', () => {
  it('equals now minus the grace window', () => {
    const cutoff = graceCutoff(NOW)
    expect(cutoff.getTime()).toBe(NOW.getTime() - EXPIRY_GRACE_DAYS * MS_PER_DAY)
  })
})

describe('daysSinceExpiry', () => {
  it('returns null for a null deadline', () => {
    expect(daysSinceExpiry(null, NOW)).toBeNull()
  })

  it('returns null for a future deadline', () => {
    expect(daysSinceExpiry(daysFromNow(5), NOW)).toBeNull()
  })

  it('returns null for an invalid date string', () => {
    expect(daysSinceExpiry('not-a-date', NOW)).toBeNull()
  })

  it('returns the whole-day count for a past deadline', () => {
    expect(daysSinceExpiry(daysFromNow(-10), NOW)).toBe(10)
  })

  it('floors partial days', () => {
    // 3.5 days past -> 3 whole days
    expect(daysSinceExpiry(new Date(NOW.getTime() - 3.5 * MS_PER_DAY), NOW)).toBe(3)
  })
})
