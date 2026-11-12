import { describe, it, expect } from 'vitest'
import { selfClientFields } from './contractorAccount'

const reg = {
  uei: 'ABCDEF123456', cageCode: '1ABC2', naicsCodes: ['238210', '237130'],
  setAsideCerts: [] as string[], samStatus: 'ACTIVE', samExpiryDate: new Date('2027-05-01T00:00:00Z'),
}

describe('selfClientFields', () => {
  it('copies the firm name and the registration identifiers', () => {
    const f = selfClientFields({ firmName: 'ARK Telecom', contactEmail: 'ops@ark.test', registration: reg, activeCertificationNames: [] })
    expect(f).toMatchObject({
      name: 'ARK Telecom', email: 'ops@ark.test', uei: 'ABCDEF123456', cage: '1ABC2',
      naicsCodes: ['238210', '237130'], samRegStatus: 'Active', samRegExpiry: reg.samExpiryDate,
    })
  })

  it('has no identifiers or SAM status before a registration profile exists', () => {
    const f = selfClientFields({ firmName: 'New Co', contactEmail: null, registration: null, activeCertificationNames: [] })
    expect(f).toMatchObject({ uei: null, cage: null, naicsCodes: [], samRegStatus: null, samRegExpiry: null })
    expect([f.sdvosb, f.wosb, f.hubzone, f.eightA]).toEqual([false, false, false, false])
  })

  it('maps declared set-asides and active certifications onto the client flags', () => {
    const f = selfClientFields({
      firmName: 'X', contactEmail: null,
      registration: { ...reg, setAsideCerts: ['HUBZone'] },
      activeCertificationNames: ['SBA 8(a) Program', 'EDWOSB'],
    })
    expect(f).toMatchObject({ hubzone: true, eightA: true, wosb: true, sdvosb: false })
  })

  it('records an inactive or unknown SAM status honestly', () => {
    expect(selfClientFields({ firmName: 'X', contactEmail: null, registration: { ...reg, samStatus: 'INACTIVE' }, activeCertificationNames: [] }).samRegStatus).toBe('Inactive')
    expect(selfClientFields({ firmName: 'X', contactEmail: null, registration: { ...reg, samStatus: 'UNKNOWN' }, activeCertificationNames: [] }).samRegStatus).toBeNull()
  })
})
