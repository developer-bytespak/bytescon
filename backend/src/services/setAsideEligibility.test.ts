// =============================================================
// §6.1F — Set-aside eligibility.
//
// The rules under test are the ones the spec calls out explicitly:
//   - an EXPIRED certification never counts as active eligibility
//   - missing data yields INSUFFICIENT_DATA, never NOT_ELIGIBLE
//   - a certification lapsing before the deadline is its own state
//   - eligibility is never claimed to be legally guaranteed
// =============================================================
import { describe, it, expect } from 'vitest'
import {
  evaluateEligibility,
  normalizeCertKey,
  SET_ASIDE_REQUIREMENTS,
  ELIGIBILITY_DISCLAIMER,
  type CertificationRecord,
} from './setAsideEligibility'

const NOW = new Date('2026-06-01T00:00:00Z')
const DEADLINE = new Date('2026-08-01T00:00:00Z')

const cert = (over: Partial<CertificationRecord> = {}): CertificationRecord => ({
  id: 'cert-1', name: 'SDVOSB', category: 'SET_ASIDE',
  expiryDate: new Date('2027-01-01T00:00:00Z'), isArchived: false, ...over,
})

const registration = (over: Partial<{ samStatus: string; samExpiryDate: Date | null; setAsideCerts: string[]; naicsCodes: string[] }> = {}) => ({
  samStatus: 'ACTIVE', samExpiryDate: new Date('2027-06-01T00:00:00Z'),
  setAsideCerts: [] as string[], naicsCodes: ['541330'], ...over,
})

describe('normalizeCertKey', () => {
  it('maps common naming variants onto canonical keys', () => {
    expect(normalizeCertKey('SDVOSB')).toBe('SDVOSB')
    expect(normalizeCertKey('Service-Disabled Veteran-Owned Small Business')).toBe('SDVOSB')
    expect(normalizeCertKey('WOSB Certification')).toBe('WOSB')
    expect(normalizeCertKey('EDWOSB')).toBe('EDWOSB')
    expect(normalizeCertKey('HUBZone')).toBe('HUBZONE')
    expect(normalizeCertKey('SBA 8(a)')).toBe('SBA_8A')
  })

  it('returns null rather than guessing for an unrecognised name', () => {
    expect(normalizeCertKey('ISO 9001')).toBeNull()
    expect(normalizeCertKey('CMMC Level 2')).toBeNull()
  })
})

describe('evaluateEligibility — the expired-certification rule', () => {
  it('does NOT count an expired certification as active eligibility', () => {
    const result = evaluateEligibility({
      setAsideType: 'SDVOSB',
      responseDeadline: DEADLINE,
      registration: registration(),
      certifications: [cert({ expiryDate: new Date('2026-01-01T00:00:00Z') })],
      now: NOW,
    })
    expect(result.state).toBe('NOT_ELIGIBLE')
    expect(result.matchedCertificationIds).toHaveLength(0)
    expect(result.reason).toMatch(/expired/i)
    expect(result.evidence.some((e) => /EXPIRED/.test(e.detail))).toBe(true)
  })

  it('counts an unexpired certification as eligible', () => {
    const result = evaluateEligibility({
      setAsideType: 'SDVOSB',
      responseDeadline: DEADLINE,
      registration: registration(),
      certifications: [cert()],
      now: NOW,
    })
    expect(result.state).toBe('ELIGIBLE')
    expect(result.matchedCertificationIds).toEqual(['cert-1'])
  })
})

describe('evaluateEligibility — expiry before the response deadline', () => {
  it('reports EXPIRING_BEFORE_DEADLINE rather than plain ELIGIBLE', () => {
    const result = evaluateEligibility({
      setAsideType: 'SDVOSB',
      responseDeadline: DEADLINE,
      registration: registration(),
      // Valid today, but lapses before the deadline.
      certifications: [cert({ expiryDate: new Date('2026-07-01T00:00:00Z') })],
      now: NOW,
    })
    expect(result.state).toBe('EXPIRING_BEFORE_DEADLINE')
    expect(result.expiringCertificationIds).toEqual(['cert-1'])
  })

  it('flags a SAM registration that lapses before the deadline', () => {
    const result = evaluateEligibility({
      setAsideType: 'SDVOSB',
      responseDeadline: DEADLINE,
      registration: registration({ samExpiryDate: new Date('2026-07-01T00:00:00Z') }),
      certifications: [cert()],
      now: NOW,
    })
    expect(result.state).toBe('EXPIRING_BEFORE_DEADLINE')
    expect(result.reason).toMatch(/SAM registration expires/i)
  })
})

describe('evaluateEligibility — absent data is never treated as ineligibility', () => {
  it('returns INSUFFICIENT_DATA when there is no registration and no certifications', () => {
    const result = evaluateEligibility({
      setAsideType: 'HUBZONE',
      responseDeadline: DEADLINE,
      registration: null,
      certifications: [],
      now: NOW,
    })
    expect(result.state).toBe('INSUFFICIENT_DATA')
    expect(result.state).not.toBe('NOT_ELIGIBLE')
  })

  it('returns INSUFFICIENT_DATA for a set-aside value it cannot map', () => {
    const result = evaluateEligibility({
      setAsideType: 'SOME_NEW_PROGRAM',
      responseDeadline: DEADLINE,
      registration: registration(),
      certifications: [cert()],
      now: NOW,
    })
    expect(result.state).toBe('INSUFFICIENT_DATA')
    expect(result.reason).toMatch(/not one this platform can map/i)
  })

  it('treats a self-declared status without a certification record as POSSIBLY_ELIGIBLE', () => {
    const result = evaluateEligibility({
      setAsideType: 'HUBZONE',
      responseDeadline: DEADLINE,
      registration: registration({ setAsideCerts: ['HUBZONE'] }),
      certifications: [],
      now: NOW,
    })
    expect(result.state).toBe('POSSIBLY_ELIGIBLE')
    expect(result.reason).toMatch(/no certification record with an expiry date/i)
  })
})

describe('evaluateEligibility — full and open notices', () => {
  it('is ELIGIBLE with an active SAM registration and no certification requirement', () => {
    const result = evaluateEligibility({
      setAsideType: 'NONE',
      responseDeadline: DEADLINE,
      registration: registration(),
      certifications: [],
      now: NOW,
    })
    expect(result.state).toBe('ELIGIBLE')
    expect(result.requiredCertKeys).toEqual([])
  })

  it('is POSSIBLY_ELIGIBLE when SAM is not active', () => {
    const result = evaluateEligibility({
      setAsideType: 'NONE',
      responseDeadline: DEADLINE,
      registration: registration({ samStatus: 'INACTIVE' }),
      certifications: [],
      now: NOW,
    })
    expect(result.state).toBe('POSSIBLY_ELIGIBLE')
  })
})

describe('evaluateEligibility — partner / joint-venture coverage', () => {
  it('is POSSIBLY_ELIGIBLE, not ELIGIBLE, when only a partner holds the certification', () => {
    const result = evaluateEligibility({
      setAsideType: 'WOSB',
      responseDeadline: DEADLINE,
      registration: registration(),
      certifications: [],
      partnerCertifications: [{ partnerId: 'p1', partnerName: 'Acme Partners', certifications: ['WOSB'] }],
      now: NOW,
    })
    expect(result.state).toBe('POSSIBLY_ELIGIBLE')
    expect(result.partnerCoverage).toEqual([{ partnerId: 'p1', partnerName: 'Acme Partners', certKey: 'WOSB' }])
    // The platform must not assert that a JV would qualify.
    expect(result.reason).toMatch(/not a determination/i)
  })
})

describe('evaluateEligibility — determinism and disclaimer', () => {
  it('is deterministic for identical inputs', () => {
    const input = {
      setAsideType: 'SDVOSB',
      responseDeadline: DEADLINE,
      registration: registration(),
      certifications: [cert()],
      now: NOW,
    }
    expect(evaluateEligibility(input)).toEqual(evaluateEligibility(input))
  })

  it('always attaches the not-a-legal-determination disclaimer', () => {
    for (const setAside of Object.keys(SET_ASIDE_REQUIREMENTS)) {
      const result = evaluateEligibility({
        setAsideType: setAside, responseDeadline: DEADLINE,
        registration: registration(), certifications: [cert()], now: NOW,
      })
      expect(result.disclaimer).toBe(ELIGIBILITY_DISCLAIMER)
      expect(result.disclaimer).toMatch(/not a legal determination/i)
    }
  })

  it('accepts SDVOSB as satisfying a VOSB set-aside', () => {
    const result = evaluateEligibility({
      setAsideType: 'VOSB',
      responseDeadline: DEADLINE,
      registration: registration(),
      certifications: [cert({ name: 'SDVOSB' })],
      now: NOW,
    })
    expect(result.state).toBe('ELIGIBLE')
  })

  it('ignores archived certifications', () => {
    const result = evaluateEligibility({
      setAsideType: 'SDVOSB',
      responseDeadline: DEADLINE,
      registration: registration(),
      certifications: [cert({ isArchived: true })],
      now: NOW,
    })
    expect(result.state).toBe('NOT_ELIGIBLE')
    expect(result.matchedCertificationIds).toHaveLength(0)
  })
})
