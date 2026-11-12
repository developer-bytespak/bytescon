import { describe, it, expect } from 'vitest'
import { evaluateProfile, REQUIRED_FIELDS, type ProfileInput } from './profileCompleteness'

const complete: ProfileInput = {
  name: 'ARK Telecom', state: 'TX', naicsCodes: ['238210'], uei: 'ABCDEF123456', samRegStatus: 'Active',
  setAsideStatusConfirmedAt: new Date('2026-11-01'), capabilityKeywords: ['fiber'], pastPerformanceCount: 1,
  city: null, streetAddress: null, zipCode: null, phone: null, website: null, cage: null,
  pscCodes: [], contractVehicles: [], employeeCount: null, annualRevenue: null,
  securityClearances: [], isoCertifications: [], brandingLogoUrl: null,
}

describe('evaluateProfile', () => {
  it('is complete, and 100%, when every required field is filled, whatever the optional ones say', () => {
    const r = evaluateProfile(complete, 'PROFILE')
    expect(r.complete).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.percent).toBe(100)
    expect(r.optional).toMatchObject({ filled: 1, total: 14 }) // its one past-performance project
    expect(r.optional.missing).toContain('Logo')
  })

  it('counts the percentage over required fields only', () => {
    // 6 of 7 required filled → 86%, however many optional ones are filled.
    const r = evaluateProfile({ ...complete, uei: null, pastPerformanceCount: 0, city: 'Austin', phone: '5125550100' }, 'PROFILE')
    expect(r.percent).toBe(86)
    expect(r.optional.filled).toBe(2)
  })

  it('reports every optional field filled', () => {
    const r = evaluateProfile({
      ...complete, city: 'Austin', streetAddress: '1 Main St', zipCode: '73301', phone: '555', website: 'ark.test', cage: '1ABC2',
      pscCodes: ['Z2AA'], contractVehicles: ['SEWP V'], employeeCount: 12, annualRevenue: 4_000_000,
      securityClearances: ['Secret'], isoCertifications: ['ISO 9001'], brandingLogoUrl: '/logo.png',
    }, 'PROFILE')
    expect(r.optional).toEqual({ filled: 14, total: 14, missing: [] })
  })

  it('lists each missing required field with its label', () => {
    const r = evaluateProfile({ ...complete, uei: null, capabilityKeywords: [], pastPerformanceCount: 0 }, 'PROFILE')
    expect(r.complete).toBe(false)
    expect(r.missing.map((m) => m.key)).toEqual(['uei', 'capabilityKeywords'])
  })

  it('treats blank text and empty lists as missing', () => {
    const r = evaluateProfile({ ...complete, name: '  ', state: '', naicsCodes: [] }, 'PROFILE')
    expect(r.missing.map((m) => m.key)).toEqual(['name', 'state', 'naicsCodes'])
  })

  it('requires the set-aside status to be confirmed, not just defaulted', () => {
    const r = evaluateProfile({ ...complete, setAsideStatusConfirmedAt: null }, 'PROFILE')
    expect(r.missing.map((m) => m.key)).toEqual(['setAsideStatus'])
  })

  it('points a contractor to My Company for every field but past performance', () => {
    const r = evaluateProfile({ ...complete, uei: null, naicsCodes: [], samRegStatus: null, setAsideStatusConfirmedAt: null, state: null }, 'CONTRACTOR')
    expect(new Set(r.missing.map((m) => m.where))).toEqual(new Set(['PROFILE']))
  })

  it('does not require past performance: a company with no projects is complete', () => {
    const r = evaluateProfile({ ...complete, pastPerformanceCount: 0 }, 'PROFILE')
    expect(r.complete).toBe(true)
    expect(r.percent).toBe(100)
    expect(r.optional.missing).toContain('Past-performance projects')
  })

  it('keeps the required list in a stable order', () => {
    expect(REQUIRED_FIELDS.map((f) => f.key)).toEqual([
      'name', 'state', 'naicsCodes', 'uei', 'samRegStatus', 'setAsideStatus', 'capabilityKeywords',
    ])
  })
})
