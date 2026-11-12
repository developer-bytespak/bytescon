import { describe, it, expect } from 'vitest'
import { suggestScores, type SuggestionInput } from './qualificationSuggestions'
import type { BidReadinessResult } from './bidReadiness'

const NOW = new Date('2026-11-12T12:00:00Z')
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000)

const ready: BidReadinessResult = {
  verdict: 'READY',
  disclaimer: '',
  items: [
    { key: 'SAM', label: 'SAM.gov registration', status: 'PASS', detail: 'Active through 2027-06-01' },
    { key: 'SET_ASIDE', label: 'Set-aside eligibility', status: 'PASS', detail: 'SDVOSB certification active' },
  ],
}

const base: SuggestionInput = {
  opportunity: {
    title: 'Structured cabling upgrade', description: 'Install fiber optic backbone and structured cabling at the medical center.',
    agency: 'Department of Veterans Affairs', naicsCode: '238210', responseDeadline: inDays(40),
    competitionCount: null, offersReceived: null, incumbentProbability: null, incumbentSignalDetected: false,
  },
  company: { name: 'ARK', naicsCodes: ['238210'], capabilityKeywords: ['structured cabling', 'fiber optic'] },
  readiness: ready,
  pastPerformance: [],
  now: NOW,
}
const one = (key: string, input: SuggestionInput = base) => suggestScores([key], input)[key]

describe('suggestScores', () => {
  it('scores capability fit from the NAICS match plus capability keywords found in the notice', () => {
    const s = one('capability_fit')
    expect(s.score).toBe(100)
    expect(s.note).toMatch(/NAICS 238210 is one of your codes/)
    expect(s.note).toMatch(/"structured cabling"/)
    const far = one('capability_fit', { ...base, company: { ...base.company, naicsCodes: ['311'], capabilityKeywords: [] } })
    expect(far.score).toBe(15)
    expect(far.note).toMatch(/does not match/)
  })

  it('takes eligibility from the worst of the SAM and set-aside checks', () => {
    expect(one('eligibility').score).toBe(100)
    const hard = { ...ready, items: [ready.items[0], { key: 'SET_ASIDE' as const, label: 'Set-aside eligibility', status: 'FAIL' as const, blocking: 'HARD' as const, detail: 'Requires 8(a), which you do not hold' }] }
    const s = one('eligibility', { ...base, readiness: hard })
    expect(s.score).toBe(0)
    expect(s.note).toMatch(/Requires 8\(a\)/)
    const warn = { ...ready, items: [{ ...ready.items[0], status: 'WARN' as const }, ready.items[1]] }
    expect(one('eligibility', { ...base, readiness: warn }).score).toBe(60)
  })

  it('counts relevant past performance by agency, industry or capabilities', () => {
    expect(one('past_performance').score).toBe(0)
    const pp = [
      { customerName: 'VA Medical Center Charleston', customerAgency: 'Veterans Affairs', naicsCode: null, relevanceTags: [], scopeSummary: '' },
      { customerName: 'Army', customerAgency: 'Department of the Army', naicsCode: '238210', relevanceTags: [], scopeSummary: '' },
      { customerName: 'City', customerAgency: null, naicsCode: '541511', relevanceTags: [], scopeSummary: 'Janitorial' },
    ]
    const s = one('past_performance', { ...base, pastPerformance: pp })
    expect(s.score).toBe(75)
    expect(s.note).toBe('2 of your 3 projects are relevant (same agency, industry or capabilities).')
  })

  it('scores the agency relationship from past work for that agency', () => {
    expect(one('relationship').score).toBe(20)
    const pp = [{ customerName: 'VA', customerAgency: 'U.S. Department of Veterans Affairs', naicsCode: null, relevanceTags: [], scopeSummary: '' }]
    expect(one('relationship', { ...base, pastPerformance: pp })).toMatchObject({ score: 60 })
  })

  it('scores the timeline from the days left', () => {
    expect(one('timeline')).toEqual({ score: 90, note: '40 days until the response deadline.' })
    expect(one('timeline', { ...base, opportunity: { ...base.opportunity, responseDeadline: inDays(5) } }).score).toBe(20)
    expect(one('timeline', { ...base, opportunity: { ...base.opportunity, responseDeadline: inDays(-1) } }).score).toBe(0)
  })

  it('leaves competition to a person when there is no data, and adjusts for bidders and incumbents', () => {
    expect(one('competition').score).toBeNull()
    const s = one('competition', { ...base, opportunity: { ...base.opportunity, offersReceived: 2, incumbentSignalDetected: true } })
    // 60 + few bidders 15 − incumbent 20 + set-aside you qualify for 10
    expect(s.score).toBe(65)
    expect(s.note).toMatch(/2 bidders.*incumbent/)
  })

  it('leaves capacity to a person, but lists the workload to weigh', () => {
    const bare = one('capacity')
    expect(bare.score).toBeNull()
    expect(bare.note).toMatch(/no workload records/)
    const busy = one('capacity', { ...base, company: { ...base.company, employeeCount: 12 }, workload: { activeContracts: 3, bidsInProgress: 1 } })
    expect(busy.score).toBeNull()
    expect(busy.note).toBe('Your call: do you have the people free to deliver this? To weigh: 3 active contracts, 1 other bid in progress, 12 employees on your profile.')
  })

  it('scores strategic value from market entry, incumbency and size against revenue', () => {
    // No past work with this agency: market entry.
    expect(one('strategic_value')).toMatchObject({ score: 65 })
    expect(one('strategic_value').note).toMatch(/new agency for you/)
    const incumbent = one('strategic_value', {
      ...base,
      company: { ...base.company, name: 'ARK Telecom', annualRevenue: 2_000_000 },
      opportunity: { ...base.opportunity, recompeteFlag: true, historicalWinner: 'ARK TELECOM LLC', estimatedValue: 1_500_000 },
      pastPerformance: [1, 2].map(() => ({ customerName: 'VA', customerAgency: 'Veterans Affairs', naicsCode: null, relevanceTags: [], scopeSummary: '' })),
    })
    // 50 + existing relationship 5 + incumbent 25 + large for size 10
    expect(incumbent.score).toBe(90)
    expect(incumbent.note).toMatch(/incumbent.*75% of annual revenue/)
    const tiny = one('strategic_value', { ...base, company: { ...base.company, annualRevenue: 50_000_000 }, opportunity: { ...base.opportunity, estimatedValue: 100_000 } })
    expect(tiny.score).toBe(55)
  })

  it('positions your priced scenario among comparable awards, like the Pricing agent', () => {
    const market = { cohortSize: 20, p25: 700_000, median: 950_000, p75: 1_300_000, percentile: 45 }
    const priced = (rangeState: 'WITHIN_HISTORICAL_RANGE' | 'BELOW_HISTORICAL_RANGE' | 'ABOVE_HISTORICAL_RANGE' | 'EXTREME_OUTLIER') =>
      one('pricing', { ...base, pricing: { ...market, proposedPrice: 1_100_000, rangeState } })
    expect(priced('WITHIN_HISTORICAL_RANGE')).toEqual({ score: 80, note: 'Your price $1.1M is within the usual range (45th percentile of 20 comparable awards).' })
    expect(priced('BELOW_HISTORICAL_RANGE').score).toBe(60)
    expect(priced('ABOVE_HISTORICAL_RANGE').score).toBe(35)
    expect(priced('EXTREME_OUTLIER').score).toBe(15)
  })

  it('before pricing, compares the estimate on the notice with what similar awards cost', () => {
    const market = { proposedPrice: null, rangeState: null, percentile: null, cohortSize: 20, p25: 700_000, median: 950_000, p75: 1_300_000 }
    const inRange = one('pricing', { ...base, pricing: market, opportunity: { ...base.opportunity, estimatedValue: 1_200_000 } })
    expect(inRange).toEqual({ score: 65, note: 'Similar awards: $700K–$1.3M, typically $950K. The estimate of $1.2M is in that range. Price it to compare your own number.' })
    expect(one('pricing', { ...base, pricing: market, opportunity: { ...base.opportunity, estimatedValue: 5_000_000 } }).note).toMatch(/above that range/)
    expect(one('pricing', { ...base, pricing: market }).score).toBe(60)
    const wide = one('pricing', { ...base, pricing: { ...market, p25: 47_000, median: 316_000, p75: 4_600_000 }, opportunity: { ...base.opportunity, estimatedValue: 4_200_000 } })
    expect(wide.score).toBe(60)
    expect(wide.note).toMatch(/vary too widely/)
    const thin = one('pricing', { ...base, pricing: { ...market, cohortSize: 3 } })
    expect(thin.score).toBeNull()
    expect(thin.note).toMatch(/Not enough comparable public awards \(3\)/)
  })

  it('never scores a custom criterion, or pricing without the benchmark', () => {
    expect(one('our_custom').score).toBeNull()
    expect(one('pricing').score).toBeNull()
  })
})
