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

  it('never scores capacity, strategic value, pricing or a firm\'s own criteria', () => {
    const s = suggestScores(['capacity', 'strategic_value', 'pricing', 'our_custom'], base)
    for (const key of Object.keys(s)) {
      expect(s[key].score).toBeNull()
      expect(s[key].note).toMatch(/Your judgement/)
    }
  })
})
