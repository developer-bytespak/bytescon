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
  it('is complete when every required field is filled, whatever the optional ones say', () => {
    const r = evaluateProfile(complete, 'PROFILE')
    expect(r.complete).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.percent).toBeGreaterThan(0)
    expect(r.percent).toBeLessThan(100)
  })

  it('reaches 100% only when the optional fields are filled too', () => {
    const r = evaluateProfile({
      ...complete, city: 'Austin', streetAddress: '1 Main St', zipCode: '73301', phone: '555', website: 'ark.test', cage: '1ABC2',
      pscCodes: ['Z2AA'], contractVehicles: ['SEWP V'], employeeCount: 12, annualRevenue: 4_000_000,
      securityClearances: ['Secret'], isoCertifications: ['ISO 9001'], brandingLogoUrl: '/logo.png',
    }, 'PROFILE')
    expect(r.percent).toBe(100)
  })

  it('lists each missing required field with its label', () => {
    const r = evaluateProfile({ ...complete, uei: null, capabilityKeywords: [], pastPerformanceCount: 0 }, 'PROFILE')
    expect(r.complete).toBe(false)
    expect(r.missing.map((m) => m.key)).toEqual(['uei', 'capabilityKeywords', 'pastPerformance'])
    expect(r.missing.find((m) => m.key === 'pastPerformance')?.label).toMatch(/past-performance/i)
  })

  it('treats blank text and empty lists as missing', () => {
    const r = evaluateProfile({ ...complete, name: '  ', state: '', naicsCodes: [] }, 'PROFILE')
    expect(r.missing.map((m) => m.key)).toEqual(['name', 'state', 'naicsCodes'])
  })

  it('requires the set-aside status to be confirmed, not just defaulted', () => {
    const r = evaluateProfile({ ...complete, setAsideStatusConfirmedAt: null }, 'PROFILE')
    expect(r.missing.map((m) => m.key)).toEqual(['setAsideStatus'])
  })

  it('points a contractor to Registration for the fields kept there', () => {
    const r = evaluateProfile({ ...complete, uei: null, naicsCodes: [], samRegStatus: null, setAsideStatusConfirmedAt: null, state: null }, 'CONTRACTOR')
    const where = Object.fromEntries(r.missing.map((m) => [m.key, m.where]))
    expect(where).toEqual({ state: 'PROFILE', naicsCodes: 'REGISTRATION', uei: 'REGISTRATION', samRegStatus: 'REGISTRATION', setAsideStatus: 'REGISTRATION' })
  })

  it('points everyone to the past-performance library for projects', () => {
    const r = evaluateProfile({ ...complete, pastPerformanceCount: 0 }, 'PROFILE')
    expect(r.missing[0]).toMatchObject({ key: 'pastPerformance', where: 'PAST_PERFORMANCE' })
  })

  it('keeps the required list in a stable order', () => {
    expect(REQUIRED_FIELDS.map((f) => f.key)).toEqual([
      'name', 'state', 'naicsCodes', 'uei', 'samRegStatus', 'setAsideStatus', 'capabilityKeywords', 'pastPerformance',
    ])
  })
})
