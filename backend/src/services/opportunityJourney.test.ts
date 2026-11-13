import { describe, it, expect } from 'vitest'
import { buildJourney, type JourneyFacts } from './opportunityJourney'

const NOW = new Date('2026-11-12T12:00:00Z')
const base: JourneyFacts = {
  opportunityId: 'o1',
  responseDeadline: new Date('2026-12-15T19:00:00Z'),
  isAwardNotice: false,
  pursuit: { stage: 'IDENTIFIED', closedAt: null },
  scorecard: null,
  proposal: null,
  pricing: null,
  submission: null,
  now: NOW,
}
const at = (stage: string, over: Partial<JourneyFacts> = {}) => buildJourney({ ...base, pursuit: { stage, closedAt: null }, ...over })

describe('buildJourney', () => {
  it('starts a new notice at qualifying, linking to the Qualify panel', () => {
    const j = at('IDENTIFIED')
    expect(j.lastDone).toBe('Opportunity identified and added to your pipeline.')
    expect(j.status).toEqual({ text: 'Identified: not qualified yet.', where: { label: 'Pipeline → Identified', to: '/pipeline' } })
    expect(j.next).toEqual({ text: 'Check eligibility and start the scorecard to decide whether to bid.', action: { label: 'Open the Qualify panel', to: '/opportunities/o1#qualify' } })
    expect(j.steps.map((s) => s.state)).toEqual(['current', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo'])
  })

  it('counts the criteria still to score during qualification', () => {
    const j = at('QUALIFICATION', { scorecard: { status: 'NOT_REVIEWED', finalDecision: null, totalScore: 42, unscoredRequired: 2, noBidReason: null } })
    expect(j.lastDone).toBe('Scorecard started (42/100 so far).')
    expect(j.next?.text).toBe('Score the 2 remaining required criteria, then record Bid or No-bid.')
    expect(at('QUALIFICATION', { scorecard: { status: 'NOT_REVIEWED', finalDecision: null, totalScore: 42, unscoredRequired: 1, noBidReason: null } }).next?.text)
      .toBe('Score the 1 remaining required criterion, then record Bid or No-bid.')
    expect(j.steps.map((s) => s.state)).toEqual(['done', 'current', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo'])
  })

  it('handles conditional and deferred decisions', () => {
    const cond = at('QUALIFICATION', { scorecard: { status: 'CONDITIONAL', finalDecision: 'CONDITIONAL', totalScore: 60, unscoredRequired: 0, noBidReason: null } })
    expect(cond.next?.text).toMatch(/Resolve the conditions/)
    const deferred = at('QUALIFICATION', { scorecard: { status: 'DEFERRED', finalDecision: 'DEFERRED', totalScore: 60, unscoredRequired: 0, noBidReason: null } })
    expect(deferred.next?.text).toBe('Come back to it before the deadline (Dec 15, 2026) and record Bid or No-bid.')
  })

  it('after a Bid, points to the proposal', () => {
    const j = at('CAPTURE')
    expect(j.lastDone).toBe('Decision recorded: Bid.')
    expect(j.next?.action).toEqual({ label: 'Open the proposal workspace', to: '/opportunities/o1/proposal' })
  })

  it('walks the proposal stage in order: sections, price, approval, submission', () => {
    expect(at('PROPOSAL', { proposal: { sections: 0, approved: 0 } }).next?.text).toBe('Outline the proposal and draft its sections.')
    const half = at('PROPOSAL', { proposal: { sections: 5, approved: 2 } })
    expect(half.lastDone).toBe('2 of 5 proposal sections approved.')
    expect(half.next?.text).toBe('Draft and approve the remaining 3 sections.')
    const done = { proposal: { sections: 5, approved: 5 } }
    expect(at('PROPOSAL', done).next?.action?.to).toBe('/opportunities/o1/pricing')
    expect(at('PROPOSAL', { ...done, pricing: { priced: true, approved: false } }).next?.text).toMatch(/get it approved/)
    expect(at('PROPOSAL', { ...done, pricing: { priced: true, approved: true } }).next?.action?.to).toBe('/opportunities/o1/submission')
    expect(at('PROPOSAL', { ...done, pricing: { priced: true, approved: true }, submission: { status: 'IN_PROGRESS', submittedAt: null } }).next?.text).toMatch(/submit to the agency, and record it/)
  })

  it('shows Price and Package as their own steps, writing and pricing side by side', () => {
    const state = (j: ReturnType<typeof at>) => Object.fromEntries(j.steps.map((s) => [s.key, s.state]))
    expect(at('PROPOSAL', { proposal: { sections: 4, approved: 1 } }).steps.map((s) => s.label)).toEqual(['Identified', 'Qualify', 'Capture', 'Proposal', 'Price', 'Package', 'Submitted', 'Award'])
    expect(state(at('PROPOSAL', { proposal: { sections: 4, approved: 1 } }))).toMatchObject({ CAPTURE: 'done', PROPOSAL: 'current', PRICING: 'current', PACKAGE: 'todo', SUBMITTED: 'todo' })
    // Priced before the writing is finished: Price is ticked, Proposal still current.
    expect(state(at('PROPOSAL', { proposal: { sections: 4, approved: 1 }, pricing: { priced: true, approved: true } }))).toMatchObject({ PROPOSAL: 'current', PRICING: 'done', PACKAGE: 'todo' })
    // Both done: the package is next, then done once set up.
    const both = { proposal: { sections: 4, approved: 4 }, pricing: { priced: true, approved: true } }
    expect(state(at('PROPOSAL', both))).toMatchObject({ PROPOSAL: 'done', PRICING: 'done', PACKAGE: 'current' })
    expect(state(at('PROPOSAL', { ...both, submission: { status: 'IN_PROGRESS', submittedAt: null } }))).toMatchObject({ PACKAGE: 'done' })
    expect(state(at('SUBMITTED'))).toMatchObject({ PROPOSAL: 'done', PRICING: 'done', PACKAGE: 'done', SUBMITTED: 'current' })
    // Priced during capture already counts.
    expect(state(at('CAPTURE', { pricing: { priced: true, approved: true } }))).toMatchObject({ CAPTURE: 'current', PROPOSAL: 'todo', PRICING: 'done' })
  })

  it('suggests pricing alongside writing, and stops once the price is approved or the writing is done', () => {
    const writing = at('PROPOSAL', { proposal: { sections: 4, approved: 1 } })
    expect(writing.also).toEqual({ text: 'You can build your price at the same time.', action: { label: 'Open the Pricing workspace', to: '/opportunities/o1/pricing' } })
    expect(at('PROPOSAL', { proposal: { sections: 4, approved: 1 }, pricing: { priced: true, approved: false } }).also?.text).toMatch(/reviewed and approved/)
    expect(at('PROPOSAL', { proposal: { sections: 4, approved: 1 }, pricing: { priced: true, approved: true } }).also).toBeNull()
    expect(at('PROPOSAL', { proposal: { sections: 4, approved: 4 } }).also).toBeNull() // pricing is then the main next step
    expect(at('CAPTURE').also).toBeNull()
  })

  it('once submitted, asks for the outcome', () => {
    const j = at('SUBMITTED', { submission: { status: 'SUBMITTED', submittedAt: new Date('2026-12-14T15:00:00Z') } })
    expect(j.lastDone).toBe('Proposal submitted on Dec 14, 2026.')
    expect(j.outcomeActions).toBe(true)
    expect(j.next?.action).toBeNull()
  })

  it('after a win, points to Contracts; marks every step done', () => {
    const j = at('AWARDED')
    expect(j.next?.action).toEqual({ label: 'Go to Contracts', to: '/contracts' })
    expect(j.steps.every((s) => s.state === 'done')).toBe(true)
  })

  it('a no-bid shows its reason and skips the rest of the journey', () => {
    const j = at('NO_BID', { scorecard: { status: 'NO_BID', finalDecision: 'NO_BID', totalScore: 30, unscoredRequired: 0, noBidReason: 'TOO_COMPETITIVE' } })
    expect(j.lastDone).toBe('Decided not to bid: Too competitive, or a strong incumbent.')
    expect(j.steps.map((s) => s.state)).toEqual(['done', 'done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped'])
  })

  it('warns when the deadline passed before submitting', () => {
    expect(at('PROPOSAL', { responseDeadline: new Date('2026-11-01T15:00:00Z') }).warning).toBe('The response deadline passed on Nov 1, 2026.')
    expect(at('SUBMITTED', { responseDeadline: new Date('2026-11-01T15:00:00Z') }).warning).toBeNull()
  })

  it('handles notices outside the pipeline and award notices', () => {
    const none = buildJourney({ ...base, pursuit: null })
    expect(none.status.text).toBe('Not in your pipeline yet.')
    expect(none.next?.action?.to).toBe('/opportunities/o1#qualify')
    expect(buildJourney({ ...base, isAwardNotice: true }).next).toBeNull()
  })
})
