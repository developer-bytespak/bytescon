// =============================================================
// Past-performance relevance — exact verbatim prompts, deterministic scoring,
// insufficient-data handling, adaptation label/placeholders/no-fabrication.
// =============================================================
import { describe, it, expect } from 'vitest'
import {
  PAST_PERFORMANCE_RELEVANCE_SYSTEM_PROMPT, PAST_PERFORMANCE_ADAPTATION_SYSTEM_PROMPT,
  AI_DRAFT_LABEL, scoreRelevance, buildDeterministicAdaptation, OpportunityContext, PastPerformanceContext,
} from './pastPerformanceRelevance'

describe('exact verbatim prompts', () => {
  it('relevance prompt is unshortened', () => {
    expect(PAST_PERFORMANCE_RELEVANCE_SYSTEM_PROMPT).toContain('You are the Past Performance Relevance Assistant inside Bytescon.')
    expect(PAST_PERFORMANCE_RELEVANCE_SYSTEM_PROMPT).toContain('"confidence": "HIGH | MEDIUM | LOW | INSUFFICIENT_DATA"')
    expect(PAST_PERFORMANCE_RELEVANCE_SYSTEM_PROMPT).toContain('The relevanceScore must be an integer from 0 to 100.')
    expect(PAST_PERFORMANCE_RELEVANCE_SYSTEM_PROMPT).toContain('Do not assume that a past-performance record is relevant merely because it has a similar title.')
  })
  it('adaptation prompt is unshortened', () => {
    expect(PAST_PERFORMANCE_ADAPTATION_SYSTEM_PROMPT).toContain('You are the Past Performance Adaptation Assistant inside Bytescon.')
    expect(PAST_PERFORMANCE_ADAPTATION_SYSTEM_PROMPT).toContain('[VERIFIED METRIC REQUIRED]')
    expect(PAST_PERFORMANCE_ADAPTATION_SYSTEM_PROMPT).toContain('Clearly mark the output as “AI-GENERATED DRAFT — REQUIRES HUMAN REVIEW.”')
    expect(PAST_PERFORMANCE_ADAPTATION_SYSTEM_PROMPT).toContain('End with a “Human Review Required” section listing all placeholders, conflicts, unsupported claims, and verification needs.')
  })
})

const opp = (o: Partial<OpportunityContext> = {}): OpportunityContext => ({ agency: 'Department of the Navy', naicsCode: '541512', pscCode: 'D307', scope: 'cloud cybersecurity engineering services', setAside: 'SDVOSB', estimatedValue: 1_000_000, ...o })
const rec = (o: Partial<PastPerformanceContext> = {}): PastPerformanceContext => ({ id: 'pp1', customerAgency: 'Department of the Navy', naicsCode: '541512', pscCode: 'D307', scopeSummary: 'cloud cybersecurity engineering', relevanceTags: ['cybersecurity'], totalValue: 900_000, periodOfPerformanceEnd: new Date(Date.now() - 365 * 86_400_000), performerRole: 'PRIME', setAsideRelevance: 'SDVOSB', ...o })

describe('scoreRelevance — deterministic + explainable', () => {
  it('scores a strong match high with matching factors and HIGH confidence', () => {
    const r = scoreRelevance(opp(), rec())
    expect(r.relevanceScore).toBeGreaterThanOrEqual(60)
    expect(r.confidence).toBe('HIGH')
    expect(r.matchingFactors.join(' ')).toMatch(/NAICS exact match/)
    expect(r.explanation).toMatch(/does not guarantee/i)
  })
  it('scores a weak/unrelated record low', () => {
    const r = scoreRelevance(opp(), rec({ customerAgency: 'USDA', naicsCode: '111110', pscCode: '1005', scopeSummary: 'farm equipment', relevanceTags: [], totalValue: 5000, setAsideRelevance: null }))
    expect(r.relevanceScore).toBeLessThan(30)
    expect(r.confidence).toBe('LOW')
  })
  it('returns INSUFFICIENT_DATA when the record has no NAICS/agency/scope', () => {
    const r = scoreRelevance(opp(), rec({ customerAgency: null, naicsCode: null, scopeSummary: null, relevanceTags: [] }))
    expect(r.confidence).toBe('INSUFFICIENT_DATA')
    expect(r.missingFactors.length).toBeGreaterThan(0)
  })
  it('keeps the score within 0..100', () => {
    const r = scoreRelevance(opp(), rec())
    expect(r.relevanceScore).toBeGreaterThanOrEqual(0)
    expect(r.relevanceScore).toBeLessThanOrEqual(100)
  })
})

describe('buildDeterministicAdaptation', () => {
  it('is AI-labelled, ends with Human Review Required, and inserts placeholders for missing facts', () => {
    const d = buildDeterministicAdaptation({ contractTitle: 'Navy Cloud', customerName: 'Navy', customerAgency: 'Navy', contractNumber: 'N001', totalValue: 900000, scopeSummary: 'cloud', workPerformed: null, resultsOutcomes: null, quantitativeMetrics: null, cparsRating: null, performerRole: 'PRIME', opportunityTitle: 'New Cloud RFP', userNotes: null })
    expect(d.startsWith(AI_DRAFT_LABEL)).toBe(true)
    expect(d).toContain('Human Review Required')
    expect(d).toContain('[VERIFIED METRIC REQUIRED]')
    expect(d).toContain('[CUSTOMER REFERENCE APPROVAL REQUIRED]')
    // does not fabricate a CPARS rating or metrics
    expect(d).not.toMatch(/EXCEPTIONAL|VERY_GOOD/)
  })
  it('preserves supplied approved facts verbatim', () => {
    const d = buildDeterministicAdaptation({ contractTitle: 'Navy Cloud', customerName: 'Navy', customerAgency: 'Navy', contractNumber: 'N001', totalValue: 900000, scopeSummary: 'cloud', workPerformed: 'Delivered zero-trust architecture across 12 enclaves', resultsOutcomes: 'Reduced incidents by an approved figure', quantitativeMetrics: '42% faster ATO', cparsRating: 'EXCEPTIONAL', performerRole: 'PRIME', opportunityTitle: null, userNotes: null })
    expect(d).toContain('Delivered zero-trust architecture across 12 enclaves')
    expect(d).toContain('42% faster ATO')
    expect(d).toContain('EXCEPTIONAL')
  })
})
