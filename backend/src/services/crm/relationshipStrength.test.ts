// =============================================================
// §8.1 — Relationship strength boundaries and no-data honesty.
// =============================================================
import { describe, it, expect } from 'vitest'
import { CrmActivityType } from '@prisma/client'
import { computeRelationshipStrength, StrengthActivityInput } from './relationshipStrength'

const NOW = new Date('2026-08-15T12:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

const act = (activityType: CrmActivityType, days: number): StrengthActivityInput => ({
  activityType,
  occurredAt: daysAgo(days),
})

const base = { activeOpportunityCount: 0, openFollowUpCount: 0, now: NOW }

describe('computeRelationshipStrength', () => {
  it('returns NO_DATA — never WEAK — when nothing has been logged', () => {
    const r = computeRelationshipStrength({ ...base, activities: [] })
    expect(r.state).toBe('NO_DATA')
    expect(r.score).toBeNull()
    expect(r.reason).toMatch(/not a judgement that the relationship is weak/i)
    expect(r.evidence).toHaveLength(0)
  })

  it('never reports a zero score in place of no data', () => {
    const r = computeRelationshipStrength({ ...base, activities: [] })
    expect(r.score).not.toBe(0)
  })

  it('caps a notes-only history below ACTIVE however much is logged', () => {
    const activities = Array.from({ length: 12 }, (_, i) => act(CrmActivityType.NOTE, i))
    const r = computeRelationshipStrength({
      ...base,
      activities,
      activeOpportunityCount: 5,
      openFollowUpCount: 5,
    })
    expect(r.meaningfulInteractions).toBe(0)
    expect(['WEAK', 'DEVELOPING']).toContain(r.state)
    expect(r.score).toBeLessThan(55)
    expect(r.reason).toMatch(/none of them is a call, meeting or event/i)
  })

  it('does not reach STRONG on a single recent call', () => {
    const r = computeRelationshipStrength({ ...base, activities: [act(CrmActivityType.CALL, 1)] })
    expect(r.state).not.toBe('STRONG')
    expect(r.state).toBe('DEVELOPING')
  })

  it('reaches STRONG on sustained, meaningful, recent engagement', () => {
    const r = computeRelationshipStrength({
      ...base,
      activities: [
        act(CrmActivityType.MEETING, 5),
        act(CrmActivityType.CALL, 20),
        act(CrmActivityType.CAPABILITY_BRIEFING, 60),
        act(CrmActivityType.SITE_VISIT, 120),
        act(CrmActivityType.CALL, 200),
      ],
      activeOpportunityCount: 2,
      openFollowUpCount: 2,
    })
    expect(r.state).toBe('STRONG')
    expect(r.score).toBeGreaterThanOrEqual(75)
  })

  it('decays to a weaker state as the last contact ages, on identical history', () => {
    const shape = (offset: number) => ({
      ...base,
      activities: [
        act(CrmActivityType.MEETING, 5 + offset),
        act(CrmActivityType.CALL, 20 + offset),
        act(CrmActivityType.CALL, 60 + offset),
      ],
    })
    const fresh = computeRelationshipStrength(shape(0))
    const stale = computeRelationshipStrength(shape(300))
    expect(stale.score!).toBeLessThan(fresh.score!)
  })

  it('counts an email as an interaction but not as a meaningful touchpoint', () => {
    const r = computeRelationshipStrength({ ...base, activities: [act(CrmActivityType.EMAIL, 2)] })
    expect(r.totalInteractions).toBe(1)
    expect(r.meaningfulInteractions).toBe(0)
  })

  it('always returns the evidence the score was computed from', () => {
    const r = computeRelationshipStrength({ ...base, activities: [act(CrmActivityType.CALL, 3)] })
    const factors = r.evidence.map((e) => e.factor)
    expect(factors).toEqual([
      'Recency',
      'Frequency',
      'Meaningful touchpoints',
      'Active pursuits',
      'Follow-ups in flight',
    ])
    expect(r.evidence.every((e) => typeof e.points === 'number')).toBe(true)
  })

  it('is deterministic — identical input yields an identical result', () => {
    const input = {
      ...base,
      activities: [act(CrmActivityType.CALL, 4), act(CrmActivityType.MEETING, 40)],
      activeOpportunityCount: 1,
      openFollowUpCount: 1,
    }
    expect(computeRelationshipStrength(input)).toEqual(computeRelationshipStrength(input))
  })

  it('reports days since the most recent interaction, not the first', () => {
    const r = computeRelationshipStrength({
      ...base,
      activities: [act(CrmActivityType.CALL, 200), act(CrmActivityType.MEETING, 3)],
    })
    expect(r.daysSinceLastInteraction).toBe(3)
  })
})
