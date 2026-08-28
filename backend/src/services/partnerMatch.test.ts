// =============================================================
// Partner matching — deterministic score, explanation, cert/geo fit, missing
// requirements, insufficient-data honesty. Pure logic, no DB.
// =============================================================
import { describe, it, expect } from 'vitest'
import { matchPartnerToOpportunity, MatchPartner, MatchOpportunity, MatchPriorContext } from './partnerMatch'

const opp: MatchOpportunity = { naicsCode: '541512', setAsideType: 'SDVOSB', title: 'Radar cybersecurity engineering services', description: 'Requires cybersecurity and cloud migration.', placeOfPerformance: 'San Diego, CA' }
const noPrior: MatchPriorContext = { priorOppIds: new Set(), wonOppIds: new Set() }
const partner = (over: Partial<MatchPartner> = {}): MatchPartner => ({
  id: 'p1', name: 'Acme', uei: 'U1', cmmcLevel: 2,
  primaryNaicsCodes: ['541512'], primarySetAsides: ['SDVOSB'], capabilities: ['cybersecurity', 'cloud migration'], certifications: [], geography: 'CA', ...over,
})

describe('matchPartnerToOpportunity', () => {
  it('is deterministic', () => {
    const a = matchPartnerToOpportunity(partner(), opp, noPrior)
    const b = matchPartnerToOpportunity(partner(), opp, noPrior)
    expect(a).toEqual(b)
  })
  it('scores a strong match high with matching capabilities + cert fit', () => {
    const r = matchPartnerToOpportunity(partner(), opp, noPrior)
    expect(r.score).toBe(40 + 25 + 20 + 0) // exact NAICS + SDVOSB + 2 caps(20)
    expect(r.matchingCapabilities).toEqual(['cybersecurity', 'cloud migration'])
    expect(r.certificationFit.met).toBe(true)
    expect(r.geographyFit.level).toBe('FULL')
    expect(r.insufficientData).toBe(false)
    expect(r.whyRecommended).toMatch(/not a guarantee/i)
  })
  it('lists missing requirements for NAICS and set-aside gaps', () => {
    const r = matchPartnerToOpportunity(partner({ primaryNaicsCodes: ['236220'], primarySetAsides: [] }), opp, noPrior)
    expect(r.missingRequirements).toEqual(expect.arrayContaining([expect.stringMatching(/NAICS 541512/), expect.stringMatching(/SDVOSB set-aside/)]))
    expect(r.certificationFit.met).toBe(false)
  })
  it('credits prior teaming track record (won)', () => {
    const prior: MatchPriorContext = { priorOppIds: new Set(['o9']), wonOppIds: new Set(['o9']) }
    const r = matchPartnerToOpportunity(partner(), opp, prior)
    expect(r.factors.find((f) => f.factor === 'Track record')!.points).toBe(10)
  })
  it('flags insufficient data when the partner has nothing to match on', () => {
    const r = matchPartnerToOpportunity(partner({ primaryNaicsCodes: [], primarySetAsides: [], capabilities: [], certifications: [] }), opp, noPrior)
    expect(r.insufficientData).toBe(true)
    expect(r.whyRecommended).toMatch(/insufficient partner data/i)
  })
  it('records honest data limitations for geography and keyword matching', () => {
    const r = matchPartnerToOpportunity(partner({ geography: null }), { ...opp, placeOfPerformance: null }, noPrior)
    expect(r.geographyFit.level).toBe('UNKNOWN')
    expect(r.dataLimitations.some((d) => /keyword-based/i.test(d))).toBe(true)
    expect(r.dataLimitations.some((d) => /geography is not recorded/i.test(d))).toBe(true)
  })
  it('treats an unrestricted opportunity as a neutral set-aside pass', () => {
    const r = matchPartnerToOpportunity(partner({ primarySetAsides: [] }), { ...opp, setAsideType: 'NONE' }, noPrior)
    expect(r.certificationFit.required).toBeNull()
    expect(r.factors.find((f) => f.factor === 'Set-aside')!.points).toBe(10)
  })
})
