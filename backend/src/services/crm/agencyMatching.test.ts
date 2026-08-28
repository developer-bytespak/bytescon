// =============================================================
// §8.1 — Agency matching.
//
// The bug this pins: a contact typed as "Department of Energy" did not appear
// on a DOE opportunity, because SAM stores the agency as
// "ENERGY, DEPARTMENT OF.ENERGY, DEPARTMENT OF.EM-PORTSMOUTH/PADUCAH PROJECT OFC"
// and the lookup compared strings for equality.
// =============================================================
import { describe, it, expect } from 'vitest'
import { agencyKey, agencyMatchesPath, parseAgencyPath, readableAgencyName } from './agencyMatching'

const SAM_DOE = 'ENERGY, DEPARTMENT OF.ENERGY, DEPARTMENT OF.EM-PORTSMOUTH/PADUCAH PROJECT OFC'

describe('readableAgencyName', () => {
  it('un-inverts SAM’s comma form', () => {
    expect(readableAgencyName('ENERGY, DEPARTMENT OF')).toBe('Department of Energy')
    expect(readableAgencyName('DEFENSE, DEPARTMENT OF')).toBe('Department of Defense')
    expect(readableAgencyName('VETERANS AFFAIRS, DEPARTMENT OF')).toBe('Department of Veterans Affairs')
  })

  it('leaves a name that is already readable alone', () => {
    expect(readableAgencyName('National Energy Technology Laboratory')).toBe('National Energy Technology Laboratory')
  })

  it('does not invert a comma that is not an agency qualifier', () => {
    expect(readableAgencyName('ALLIANCE FOR ENERGY INNOVATION, LLC')).toBe('Alliance for Energy Innovation, Llc')
  })

  it('leaves an office symbol shouting, because that is how it is recognised', () => {
    expect(readableAgencyName('EM-PORTSMOUTH/PADUCAH PROJECT OFC')).toBe('EM-PORTSMOUTH/PADUCAH PROJECT OFC')
  })
})

describe('parseAgencyPath', () => {
  it('splits the dotted path and drops SAM’s repeated department', () => {
    const parsed = parseAgencyPath(SAM_DOE)
    expect(parsed.department).toBe('Department of Energy')
    expect(parsed.office).toBe('EM-PORTSMOUTH/PADUCAH PROJECT OFC')
    expect(parsed.segments).toEqual(['Department of Energy', 'EM-PORTSMOUTH/PADUCAH PROJECT OFC'])
    expect(parsed.display).toBe('Department of Energy — EM-PORTSMOUTH/PADUCAH PROJECT OFC')
  })

  it('handles a plain single-name agency', () => {
    const parsed = parseAgencyPath('National Energy Technology Laboratory')
    expect(parsed.department).toBe('National Energy Technology Laboratory')
    expect(parsed.office).toBeNull()
    expect(parsed.display).toBe('National Energy Technology Laboratory')
  })

  it('returns an empty path for nothing', () => {
    expect(parseAgencyPath(null).segments).toEqual([])
    expect(parseAgencyPath('').display).toBe('')
  })
})

describe('agencyMatchesPath — the reported defect', () => {
  it('matches a human-typed department against SAM’s inverted path', () => {
    expect(agencyMatchesPath('Department of Energy', SAM_DOE)).toBe(true)
  })

  it('matches whatever spelling the user chose', () => {
    for (const typed of ['Department of Energy', 'DEPARTMENT OF ENERGY', 'department of energy', 'ENERGY, DEPARTMENT OF']) {
      expect([typed, agencyMatchesPath(typed, SAM_DOE)]).toEqual([typed, true])
    }
  })

  it('matches the specific office too, not only the department', () => {
    expect(agencyMatchesPath('EM-PORTSMOUTH/PADUCAH PROJECT OFC', SAM_DOE)).toBe(true)
  })

  it('does NOT match a different agency', () => {
    expect(agencyMatchesPath('Department of Defense', SAM_DOE)).toBe(false)
    expect(agencyMatchesPath('Energy Solutions LLC', SAM_DOE)).toBe(false)
  })

  it('matches nothing on an empty name, rather than everything', () => {
    expect(agencyMatchesPath('', SAM_DOE)).toBe(false)
    expect(agencyMatchesPath(null, SAM_DOE)).toBe(false)
    expect(agencyMatchesPath('Department of Energy', null)).toBe(false)
  })

  it('gives one key for every spelling of one agency', () => {
    const key = agencyKey('Department of Energy')
    expect(agencyKey('ENERGY, DEPARTMENT OF')).toBe(key)
    expect(agencyKey('  department   of energy ')).toBe(key)
  })
})
