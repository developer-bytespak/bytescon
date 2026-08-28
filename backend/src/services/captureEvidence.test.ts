// =============================================================
// Capture evidence — pure incumbent/competitor collection + ranking unit tests.
// =============================================================
import { describe, it, expect } from 'vitest'
import { collectIncumbentEvidence, collectCompetitorEvidence, normalizeCompany, AwardRow, OppContext } from './captureEvidence'

const opp: OppContext = { agency: 'Department of the Navy', naicsCode: '541512', psc: 'D307' }
const award = (over: Partial<AwardRow> = {}): AwardRow => ({
  recipientName: 'Acme Federal Inc', recipientUei: null, awardAmount: 100000, baseAndAllOptions: null,
  awardDate: new Date('2025-01-01'), awardingAgency: 'Department of the Navy', naics: '541512', psc: 'D307', contractNumber: 'K-1', ...over,
})

describe('normalizeCompany', () => {
  it('strips suffixes/punctuation and uppercases for grouping', () => {
    expect(normalizeCompany('Acme Federal, Inc.')).toBe('ACME FEDERAL')
    expect(normalizeCompany('ACME FEDERAL LLC')).toBe('ACME FEDERAL')
    expect(normalizeCompany('Acme  Federal   Corporation')).toBe('ACME FEDERAL')
  })
})

describe('collectIncumbentEvidence', () => {
  it('returns NOT_AVAILABLE with no awards and no enrichment', () => {
    const e = collectIncumbentEvidence(opp, [])
    expect(e.confidence).toBe('NOT_AVAILABLE')
    expect(e.company).toBeNull()
  })
  it('CONFIRMED for a single award recipient, with a source reference', () => {
    const e = collectIncumbentEvidence(opp, [award({ contractNumber: 'K-9', awardAmount: 250000, baseAndAllOptions: 500000 })])
    expect(e.confidence).toBe('CONFIRMED')
    expect(e.company).toBe('Acme Federal Inc')
    expect(e.awardReference).toBe('K-9')
    expect(e.awardValue).toBe(500000) // base+all options preferred
    expect(e.evidenceSource).toMatch(/award history/i)
  })
  it('PROBABLE when one recipient dominates by award count', () => {
    const e = collectIncumbentEvidence(opp, [
      award({ recipientName: 'Acme Federal', contractNumber: 'K-1' }),
      award({ recipientName: 'Acme Federal', contractNumber: 'K-2' }),
      award({ recipientName: 'Beta Corp', contractNumber: 'K-3' }),
    ])
    expect(e.confidence).toBe('PROBABLE')
    expect(normalizeCompany(e.company!)).toBe('ACME FEDERAL')
    expect(e.candidates.length).toBeGreaterThanOrEqual(2)
  })
  it('AMBIGUOUS (never confirmed) when recipients are comparable', () => {
    const e = collectIncumbentEvidence(opp, [
      award({ recipientName: 'Acme Federal', contractNumber: 'K-1' }),
      award({ recipientName: 'Beta Corp', contractNumber: 'K-2' }),
    ])
    expect(e.confidence).toBe('AMBIGUOUS')
    expect(e.company).toBeNull()
    expect(e.candidates.length).toBe(2)
  })
  it('uses the enrichment winner as PROBABLE/AMBIGUOUS but never CONFIRMED', () => {
    const strong = collectIncumbentEvidence({ ...opp, historicalWinner: 'Gamma LLC', incumbentProbability: 0.8 }, [])
    expect(strong.confidence).toBe('PROBABLE')
    expect(strong.company).toBe('Gamma LLC')
    expect(strong.evidenceSource).toMatch(/enrichment/i)
    const weak = collectIncumbentEvidence({ ...opp, historicalWinner: 'Gamma LLC', incumbentProbability: 0.2 }, [])
    expect(weak.confidence).toBe('AMBIGUOUS')
  })
  it('groups by UEI when present (same company, different name spelling)', () => {
    const e = collectIncumbentEvidence(opp, [
      award({ recipientName: 'Acme Federal Inc', recipientUei: 'UEI123', contractNumber: 'K-1' }),
      award({ recipientName: 'ACME FEDERAL', recipientUei: 'UEI123', contractNumber: 'K-2' }),
    ])
    expect(e.confidence).toBe('CONFIRMED') // one distinct UEI
  })
})

describe('collectCompetitorEvidence', () => {
  const relevant: AwardRow[] = [
    award({ recipientName: 'Acme Federal', contractNumber: 'K-1', awardAmount: 100000 }),
    award({ recipientName: 'Acme Federal', contractNumber: 'K-2', awardAmount: 200000 }),
    award({ recipientName: 'Beta Corp', contractNumber: 'K-3', awardAmount: 50000, awardingAgency: 'Army', naics: '541512', psc: null }),
    award({ recipientName: 'Gamma LLC', contractNumber: 'K-4', awardAmount: 300000, naics: '999999', psc: null, awardingAgency: 'Other' }),
  ]
  it('ranks deterministically by award count then value then name', () => {
    const r = collectCompetitorEvidence(opp, relevant)
    expect(normalizeCompany(r[0].name)).toBe('ACME FEDERAL') // 2 awards → first
    expect(r[0].relevantAwardCount).toBe(2)
    expect(r[0].relevantAwardValue).toBe(300000)
    // Beta and Gamma both have 1 award; Gamma value 300k > Beta 50k → Gamma second
    expect(normalizeCompany(r[1].name)).toBe('GAMMA')
  })
  it('flags agency / NAICS / PSC relevance and labels evidence historical', () => {
    const r = collectCompetitorEvidence(opp, relevant)
    const acme = r.find((c) => normalizeCompany(c.name) === 'ACME FEDERAL')!
    expect(acme.agencyRelevant).toBe(true)
    expect(acme.naicsRelevant).toBe(true)
    expect(acme.pscRelevant).toBe(true)
    expect(acme.whyShown).toMatch(/historical evidence/i)
    expect(acme.whyShown).toMatch(/not a prediction/i) // never claims they will bid
  })
  it('dedupes companies by normalized name', () => {
    const r = collectCompetitorEvidence(opp, [
      award({ recipientName: 'Acme Federal, Inc.' }),
      award({ recipientName: 'ACME FEDERAL LLC' }),
    ])
    expect(r.length).toBe(1)
    expect(r[0].relevantAwardCount).toBe(2)
  })
  it('returns an empty list when there is no relevant award evidence', () => {
    expect(collectCompetitorEvidence(opp, [])).toEqual([])
  })
})
