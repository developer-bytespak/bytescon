// =============================================================
// Shared opportunity filter builder unit tests — the where-building that both
// the live search and saved profiles depend on. Pure logic, no DB.
// =============================================================
import { describe, it, expect } from 'vitest'
import { buildOpportunityWhere, MonitoringFiltersSchema } from './opportunityFilters'

const FIRM = 'firm-1'
const ctx = (over: Record<string, unknown> = {}) => ({ consultingFirmId: FIRM, allowSetAside: true, now: new Date('2026-08-06T00:00:00Z'), ...over })

describe('buildOpportunityWhere', () => {
  it('always scopes by firm and hides demo rows by default', () => {
    const w = buildOpportunityWhere({}, ctx())
    expect(w.consultingFirmId).toBe(FIRM)
    expect(w.isDemo).toBe(false)
  })
  it('includes demo rows when includeDemo is set (string or boolean)', () => {
    expect(buildOpportunityWhere({ includeDemo: 'true' }, ctx()).isDemo).toBeUndefined()
    expect(buildOpportunityWhere({ includeDemo: true }, ctx()).isDemo).toBeUndefined()
  })
  it('defaults to non-expired and honours showExpired', () => {
    expect(buildOpportunityWhere({}, ctx()).responseDeadline).toEqual({ gte: new Date('2026-08-06T00:00:00Z') })
    expect(buildOpportunityWhere({ showExpired: true }, ctx()).responseDeadline).toBeUndefined()
  })
  it('maps NAICS prefix, agency contains, status and keywords', () => {
    const w = buildOpportunityWhere({ naicsCode: '5415', agency: 'Navy', status: 'ACTIVE', keywords: 'radar' }, ctx())
    expect(w.naicsCode).toEqual({ startsWith: '5415' })
    expect(w.agency).toEqual({ contains: 'Navy', mode: 'insensitive' })
    expect(w.status).toBe('ACTIVE')
    expect(Array.isArray(w.AND)).toBe(true)
  })
  it('only applies setAsideType when allowed', () => {
    expect(buildOpportunityWhere({ setAsideType: 'SDVOSB' }, ctx({ allowSetAside: true })).setAsideType).toBe('SDVOSB')
    expect(buildOpportunityWhere({ setAsideType: 'SDVOSB' }, ctx({ allowSetAside: false })).setAsideType).toBeUndefined()
  })
  it('builds an estimated-value range', () => {
    expect(buildOpportunityWhere({ estimatedValueMin: 1000, estimatedValueMax: 5000 }, ctx()).estimatedValue).toEqual({ gte: 1000, lte: 5000 })
  })
  it('builds a posted-date range', () => {
    const w = buildOpportunityWhere({ postedAfter: '2026-07-01T00:00:00Z', postedBefore: '2026-08-01T00:00:00Z' }, ctx())
    expect(w.postedDate).toEqual({ gte: new Date('2026-07-01T00:00:00Z'), lte: new Date('2026-08-01T00:00:00Z') })
  })
  it('merges dueBefore with the non-expired default', () => {
    const w = buildOpportunityWhere({ dueBefore: '2026-09-01T00:00:00Z' }, ctx())
    expect(w.responseDeadline).toEqual({ gte: new Date('2026-08-06T00:00:00Z'), lte: new Date('2026-09-01T00:00:00Z') })
  })
  it('daysUntilDeadline takes precedence over the default deadline window', () => {
    const w = buildOpportunityWhere({ daysUntilDeadline: 7 }, ctx())
    expect(w.responseDeadline).toEqual({ gt: new Date('2026-08-06T00:00:00Z'), lte: new Date('2026-08-13T00:00:00Z') })
  })
  it('applies client NAICS prefixes as an OR', () => {
    const w = buildOpportunityWhere({}, ctx({ clientNaicsPrefixes: ['5415', '5416'] }))
    expect(w.OR).toEqual([{ naicsCode: { startsWith: '5415' } }, { naicsCode: { startsWith: '5416' } }])
  })
  it('filters by source', () => {
    expect(buildOpportunityWhere({ source: 'MANUAL' }, ctx()).source).toBe('MANUAL')
  })
  it('filters by owner and pipeline stage via the pursuit relation', () => {
    expect(buildOpportunityWhere({ ownerUserId: 'u1' }, ctx()).bidPursuits).toEqual({ some: { ownerUserId: 'u1' } })
    expect(buildOpportunityWhere({ ownerUserId: 'u1', pipelineStage: 'CAPTURE' }, ctx()).bidPursuits).toEqual({ some: { ownerUserId: 'u1', pipelineStage: 'CAPTURE' } })
  })
  it('filters by bid/no-bid decision via the decision relation', () => {
    expect(buildOpportunityWhere({ bidDecision: 'GO' }, ctx()).bidDecisions).toEqual({ some: { decision: 'GO' } })
  })
})

describe('MonitoringFiltersSchema', () => {
  it('accepts a valid filter set', () => {
    expect(MonitoringFiltersSchema.safeParse({ naicsCode: '541512', agency: 'DoD', status: 'ACTIVE', keywords: 'radar', estimatedValueMin: 1000, estimatedValueMax: 5000, alertFrequency: undefined }).success).toBe(false) // alertFrequency is not a filter key → strict reject
    expect(MonitoringFiltersSchema.safeParse({ naicsCode: '541512', agency: 'DoD', status: 'ACTIVE', keywords: 'radar' }).success).toBe(true)
  })
  it('rejects unknown keys (malformed filters)', () => {
    expect(MonitoringFiltersSchema.safeParse({ bogus: 'x' }).success).toBe(false)
  })
  it('rejects a bad NAICS, bad status, and inverted value range', () => {
    expect(MonitoringFiltersSchema.safeParse({ naicsCode: 'ABC' }).success).toBe(false)
    expect(MonitoringFiltersSchema.safeParse({ status: 'NOPE' }).success).toBe(false)
    expect(MonitoringFiltersSchema.safeParse({ estimatedValueMin: 9000, estimatedValueMax: 100 }).success).toBe(false)
  })
})
