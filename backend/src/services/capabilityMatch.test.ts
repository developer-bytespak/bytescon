// =============================================================
// §6.1E — Capability matching.
//
// Under test: absent dimensions are excluded rather than scored zero, keyword
// overlap cannot carry a match on its own, insufficient data is reported, and
// the whole computation is deterministic.
// =============================================================
import { describe, it, expect } from 'vitest'
import { EligibilityState } from '@prisma/client'
import {
  computeCapabilityMatch,
  naicsPrefixScore,
  pscScore,
  tokenize,
  dimensionScore,
  MIN_ASSESSABLE_DIMENSIONS,
  type CapabilityInput,
  type MatchOpportunityInput,
  type MatchFirmInput,
} from './capabilityMatch'
import type { EligibilityResult } from './setAsideEligibility'

const eligibility = (state: EligibilityState): EligibilityResult => ({
  state,
  reason: `state is ${state}`,
  requiredCertKeys: [],
  matchedCertificationIds: [],
  expiringCertificationIds: [],
  partnerCoverage: [],
  evidence: [],
  disclaimer: 'test',
})

const capability = (over: Partial<CapabilityInput> = {}): CapabilityInput => ({
  id: 'cap-1',
  name: 'Cybersecurity engineering',
  category: 'TECHNICAL',
  keywords: ['cybersecurity', 'zero trust'],
  naicsCodes: ['541512'],
  pscCodes: ['D310'],
  geographies: ['Virginia'],
  contractVehicles: ['GSA MAS'],
  concurrentCapacity: null,
  capacityNote: null,
  verification: 'VERIFIED',
  ...over,
})

const opportunity = (over: Partial<MatchOpportunityInput> = {}): MatchOpportunityInput => ({
  id: 'opp-1',
  title: 'Zero trust cybersecurity engineering support',
  description: 'The contractor shall provide cybersecurity engineering and zero trust architecture services.',
  agency: 'Department of Defense',
  naicsCode: '541512',
  psc: 'D310',
  setAsideType: 'SDVOSB',
  placeOfPerformance: 'Arlington, Virginia',
  contractVehicle: 'GSA MAS',
  ...over,
})

const firm = (over: Partial<MatchFirmInput> = {}): MatchFirmInput => ({
  capabilities: [capability()],
  registrationNaics: ['541512'],
  pastPerformance: [{ id: 'pp-1', naicsCode: '541512', pscCode: 'D310', agency: 'Department of Defense', isArchived: false, verificationStatus: 'VERIFIED' }],
  activePursuitCount: 1,
  ...over,
})

describe('naicsPrefixScore', () => {
  it('scores an exact 6-digit match as 1', () => {
    expect(naicsPrefixScore(['541512'], '541512')).toBe(1)
  })
  it('scores a partial sector match proportionally', () => {
    expect(naicsPrefixScore(['541330'], '541512')).toBeCloseTo(3 / 6, 5)
  })
  it('returns null — not zero — when either side has no code', () => {
    expect(naicsPrefixScore([], '541512')).toBeNull()
    expect(naicsPrefixScore(['541512'], '')).toBeNull()
  })
})

describe('pscScore', () => {
  it('scores exact, group and category matches distinctly', () => {
    expect(pscScore(['D310'], 'D310')).toBe(1)
    expect(pscScore(['D399'], 'D310')).toBe(0.7)
    expect(pscScore(['R499'], 'D310')).toBe(0)
  })
  it('returns null when the notice has no PSC', () => {
    expect(pscScore(['D310'], null)).toBeNull()
  })
})

describe('computeCapabilityMatch — absent dimensions', () => {
  it('marks a dimension ABSENT rather than scoring it zero', () => {
    const result = computeCapabilityMatch(
      opportunity({ psc: null, placeOfPerformance: null, contractVehicle: null }),
      firm(),
      eligibility(EligibilityState.ELIGIBLE),
    )
    for (const key of ['psc', 'geography', 'vehicle'] as const) {
      const dim = result.dimensions.find((d) => d.key === key)
      expect(dim?.score, `${key} should be absent`).toBeNull()
      expect(dim?.absentReason).toBeTruthy()
    }
    // Absent dimensions must not drag the overall score down.
    expect(result.overallScore).toBeGreaterThan(70)
  })

  it('excludes absent dimensions from the weighted total (renormalises)', () => {
    const full = computeCapabilityMatch(opportunity(), firm(), eligibility(EligibilityState.ELIGIBLE))
    const partial = computeCapabilityMatch(
      opportunity({ psc: null, placeOfPerformance: null, contractVehicle: null }),
      firm(),
      eligibility(EligibilityState.ELIGIBLE),
    )
    // Both are perfect on the dimensions they can assess, so both score high.
    expect(full.overallScore).toBeGreaterThanOrEqual(90)
    expect(partial.overallScore).toBeGreaterThanOrEqual(90)
  })

  it('does not score eligibility when it is INSUFFICIENT_DATA', () => {
    const result = computeCapabilityMatch(opportunity(), firm(), eligibility(EligibilityState.INSUFFICIENT_DATA))
    expect(result.dimensions.find((d) => d.key === 'certification')?.score).toBeNull()
    expect(result.dataLimitations.some((l) => /eligibility/i.test(l))).toBe(true)
  })

  it('scores NOT_ELIGIBLE as a real zero, not as absent', () => {
    const result = computeCapabilityMatch(opportunity(), firm(), eligibility(EligibilityState.NOT_ELIGIBLE))
    expect(result.dimensions.find((d) => d.key === 'certification')?.score).toBe(0)
  })
})

describe('computeCapabilityMatch — keyword overlap is not the whole match', () => {
  it('reports keyword as one of eight dimensions with a small weight', () => {
    const result = computeCapabilityMatch(opportunity(), firm(), eligibility(EligibilityState.ELIGIBLE))
    const keyword = result.dimensions.find((d) => d.key === 'keyword')
    expect(keyword).toBeDefined()
    expect(keyword!.weight).toBeLessThanOrEqual(0.1)
    expect(keyword!.evidence).toMatch(/one input of eight/i)
  })

  it('cannot produce a high score from keyword overlap alone', () => {
    // The capability's wording matches the notice text, but every other
    // dimension genuinely misses: different NAICS, different PSC, different
    // geography, different vehicle, no past performance, not eligible.
    const result = computeCapabilityMatch(
      opportunity({ naicsCode: '111110', psc: 'Z999', placeOfPerformance: 'Alaska', contractVehicle: 'SEWP V' }),
      firm({
        registrationNaics: ['541512'],
        pastPerformance: [],
        // Codes are recorded (so these dimensions are assessable) but all miss.
        capabilities: [capability({ naicsCodes: [], pscCodes: ['R499'], geographies: ['Hawaii'], contractVehicles: ['OASIS+'] })],
      }),
      eligibility(EligibilityState.NOT_ELIGIBLE),
    )
    expect(result.overallScore).toBeLessThan(50)
    // These scored a genuine zero — they were assessable and they missed.
    for (const key of ['naics', 'psc', 'geography', 'vehicle'] as const) {
      expect(result.dimensions.find((d) => d.key === key)?.score, key).toBe(0)
    }
    // Keyword overlap was perfect, and still could not carry the match.
    expect(result.dimensions.find((d) => d.key === 'keyword')?.score).toBe(1)
  })
})

describe('computeCapabilityMatch — data sufficiency', () => {
  it('flags insufficient data when too few dimensions are assessable', () => {
    const result = computeCapabilityMatch(
      opportunity({ naicsCode: '', psc: null, placeOfPerformance: null, contractVehicle: null, description: null, title: 'x' }),
      firm({ capabilities: [], registrationNaics: [], pastPerformance: [], activePursuitCount: 0 }),
      eligibility(EligibilityState.INSUFFICIENT_DATA),
    )
    expect(result.hasSufficientData).toBe(false)
    expect(result.dataLimitations[0]).toMatch(new RegExp(`minimum ${MIN_ASSESSABLE_DIMENSIONS}`))
  })

  it('reports sufficient data on a fully populated opportunity', () => {
    const result = computeCapabilityMatch(opportunity(), firm(), eligibility(EligibilityState.ELIGIBLE))
    expect(result.hasSufficientData).toBe(true)
  })
})

describe('computeCapabilityMatch — capacity and capabilities', () => {
  it('warns when active pursuits reach the recorded concurrent capacity', () => {
    const result = computeCapabilityMatch(
      opportunity(),
      firm({ capabilities: [capability({ concurrentCapacity: 2 })], activePursuitCount: 3 }),
      eligibility(EligibilityState.ELIGIBLE),
    )
    expect(result.capacityWarning).toMatch(/3 active pursuit\(s\) against a recorded concurrent capacity of 2/)
  })

  it('never invents a capability that is not recorded', () => {
    const result = computeCapabilityMatch(
      opportunity(),
      firm({ capabilities: [] }),
      eligibility(EligibilityState.ELIGIBLE),
    )
    expect(result.matchedCapabilityIds).toEqual([])
    expect(result.dimensions.find((d) => d.key === 'capability')?.score).toBeNull()
  })

  it('ignores REJECTED capability records', () => {
    const result = computeCapabilityMatch(
      opportunity(),
      firm({ capabilities: [capability({ verification: 'REJECTED' })] }),
      eligibility(EligibilityState.ELIGIBLE),
    )
    expect(result.matchedCapabilityIds).toEqual([])
  })
})

describe('computeCapabilityMatch — determinism', () => {
  it('produces identical results for identical inputs', () => {
    const a = computeCapabilityMatch(opportunity(), firm(), eligibility(EligibilityState.ELIGIBLE))
    const b = computeCapabilityMatch(opportunity(), firm(), eligibility(EligibilityState.ELIGIBLE))
    expect(a).toEqual(b)
  })

  it('exposes per-dimension sub-scores as integers or null', () => {
    const result = computeCapabilityMatch(opportunity({ psc: null }), firm(), eligibility(EligibilityState.ELIGIBLE))
    expect(dimensionScore(result, 'naics')).toBe(100)
    expect(dimensionScore(result, 'psc')).toBeNull()
  })
})

describe('tokenize', () => {
  it('drops stop words and short tokens', () => {
    const tokens = tokenize('The contractor shall provide cybersecurity services')
    expect(tokens.has('cybersecurity')).toBe(true)
    expect(tokens.has('the')).toBe(false)
    expect(tokens.has('shall')).toBe(false)
  })
})
