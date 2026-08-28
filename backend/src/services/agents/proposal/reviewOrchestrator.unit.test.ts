// =============================================================
// §7.7 — the review orchestrator's pure decisions.
//
// The orchestrator schedules, reminds and escalates. It never decides a review.
// These tests fix that boundary: the colour-team order, the refusal to open a
// cycle while one is still open, the refusal to pick a reviewer, and a reminder
// ladder whose keys are stable across six-hourly sweeps so an unchanged review
// is never re-notified.
// =============================================================
import { describe, it, expect } from 'vitest'
import {
  CYCLE_ORDER,
  REVIEW_OVERDUE_WORKING_DAYS,
  CYCLE_STALL_WORKING_DAYS,
  REMINDER_LADDER,
  nextCycleToOpen,
  assessSectionReviews,
  proposeReminders,
  assessReviewEscalations,
  type CycleSummary,
  type SectionReviewState,
} from './reviewOrchestrator'
import { makeCalendar } from '../../milestones/workingDays'

const CALENDAR = makeCalendar()
// A Wednesday, so a fixed offset of working days is easy to reason about.
const NOW = new Date('2026-08-12T12:00:00.000Z')

const cycle = (over: Partial<CycleSummary> = {}): CycleSummary => ({
  cycleId: 'cyc-1',
  cycleType: 'PINK',
  status: 'APPROVED',
  startedAt: new Date('2026-07-01T00:00:00.000Z'),
  closedAt: new Date('2026-07-10T00:00:00.000Z'),
  approverUserId: 'human-1',
  workingDaysOpen: 7,
  isClosed: true,
  hasStalled: false,
  openComments: 0,
  blockerComments: 0,
  nextAction: 'None.',
  ...over,
})

const reviewState = (over: Partial<SectionReviewState> = {}): SectionReviewState => ({
  sectionId: 'sec-1',
  title: 'Technical Approach',
  status: 'IN_REVIEW',
  ownerUserId: 'owner-1',
  reviewerUserId: 'reviewer-1',
  submittedForReviewAt: new Date('2026-08-01T00:00:00.000Z'),
  workingDaysInReview: 0,
  isOverdue: false,
  reviewerAssignmentRequired: false,
  dueDate: null,
  ...over,
})

// =============================================================
// Colour-team ordering
// =============================================================

describe('nextCycleToOpen', () => {
  it('follows the colour-team order', () => {
    expect(CYCLE_ORDER).toEqual(['PINK', 'RED', 'GOLD', 'WHITE'])
  })

  it('opens PINK first when nothing exists', () => {
    expect(nextCycleToOpen([])).toBe('PINK')
  })

  it('opens the next colour once the previous one is closed', () => {
    expect(nextCycleToOpen([cycle({ cycleType: 'PINK' })])).toBe('RED')
    expect(nextCycleToOpen([cycle({ cycleType: 'PINK' }), cycle({ cycleId: 'c2', cycleType: 'RED' })])).toBe('GOLD')
  })

  it('opens nothing while a cycle is still open', () => {
    expect(nextCycleToOpen([cycle({ status: 'OPEN', isClosed: false, closedAt: null })])).toBeNull()
  })

  it('opens nothing once all four colours exist', () => {
    const all = CYCLE_ORDER.map((t, i) => cycle({ cycleId: `c${i}`, cycleType: t }))
    expect(nextCycleToOpen(all)).toBeNull()
  })

  it('is case-insensitive about a stored colour name', () => {
    expect(nextCycleToOpen([cycle({ cycleType: 'pink' })])).toBe('RED')
  })
})

// =============================================================
// Section review state
// =============================================================

describe('assessSectionReviews', () => {
  const base = {
    id: 'sec-1',
    title: 'Technical Approach',
    ownerUserId: 'owner-1',
    reviewerUserId: 'reviewer-1',
    dueDate: null,
  }

  it('measures time in review only for sections actually in review', () => {
    const [state] = assessSectionReviews(
      [{ ...base, status: 'DRAFTING', submittedForReviewAt: new Date('2026-08-01T00:00:00.000Z') }],
      NOW, CALENDAR,
    )
    expect(state.workingDaysInReview).toBeNull()
    expect(state.isOverdue).toBe(false)
  })

  it('flags a review that has run past the overdue threshold', () => {
    const [state] = assessSectionReviews(
      [{ ...base, status: 'IN_REVIEW', submittedForReviewAt: new Date('2026-08-01T00:00:00.000Z') }],
      NOW, CALENDAR,
    )
    expect(state.workingDaysInReview).toBeGreaterThan(REVIEW_OVERDUE_WORKING_DAYS)
    expect(state.isOverdue).toBe(true)
  })

  it('does not flag a review that is still inside the threshold', () => {
    const [state] = assessSectionReviews(
      [{ ...base, status: 'IN_REVIEW', submittedForReviewAt: new Date('2026-08-11T00:00:00.000Z') }],
      NOW, CALENDAR,
    )
    expect(state.isOverdue).toBe(false)
  })

  it('reports a missing reviewer instead of choosing one', () => {
    const [state] = assessSectionReviews(
      [{ ...base, reviewerUserId: null, status: 'IN_REVIEW', submittedForReviewAt: NOW }],
      NOW, CALENDAR,
    )
    expect(state.reviewerAssignmentRequired).toBe(true)
    expect(state.reviewerUserId).toBeNull()
  })

  it('does not demand a reviewer for a section nobody has submitted', () => {
    const [state] = assessSectionReviews(
      [{ ...base, reviewerUserId: null, status: 'DRAFTING', submittedForReviewAt: null }],
      NOW, CALENDAR,
    )
    expect(state.reviewerAssignmentRequired).toBe(false)
  })
})

// =============================================================
// The reminder ladder
// =============================================================

describe('proposeReminders', () => {
  it('climbs reviewer → owner → admin', () => {
    expect(REMINDER_LADDER.map((r) => r.audience)).toEqual(['REVIEWER', 'OWNER', 'ADMIN'])
  })

  it('sends nothing before the first rung', () => {
    expect(proposeReminders([reviewState({ workingDaysInReview: 1 })], ['admin-1'])).toHaveLength(0)
  })

  it('sends nothing for a section that is not in review', () => {
    expect(proposeReminders([reviewState({ workingDaysInReview: null })], ['admin-1'])).toHaveLength(0)
  })

  it('reminds only the reviewer at the first rung', () => {
    const out = proposeReminders([reviewState({ workingDaysInReview: 2 })], ['admin-1'])
    expect(out).toHaveLength(1)
    expect(out[0].audience).toBe('REVIEWER')
    expect(out[0].userId).toBe('reviewer-1')
  })

  it('escalates to the owner at the second rung and stops there', () => {
    const out = proposeReminders([reviewState({ workingDaysInReview: 5 })], ['admin-1'])
    expect(out).toHaveLength(1)
    expect(out[0].audience).toBe('OWNER')
    expect(out[0].userId).toBe('owner-1')
  })

  it('reaches every admin at the top rung', () => {
    const out = proposeReminders([reviewState({ workingDaysInReview: 9 })], ['admin-1', 'admin-2'])
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.audience === 'ADMIN')).toBe(true)
    expect(new Set(out.map((r) => r.dedupeKey)).size).toBe(2)
  })

  it('sends nothing when the rung’s audience does not exist', () => {
    expect(proposeReminders([reviewState({ workingDaysInReview: 2, reviewerUserId: null })], [])).toHaveLength(0)
    expect(proposeReminders([reviewState({ workingDaysInReview: 5, ownerUserId: null })], [])).toHaveLength(0)
    expect(proposeReminders([reviewState({ workingDaysInReview: 9 })], [])).toHaveLength(0)
  })

  it('produces a key that is stable across sweeps on the same rung', () => {
    const first = proposeReminders([reviewState({ workingDaysInReview: 2 })], [])
    const second = proposeReminders([reviewState({ workingDaysInReview: 3 })], [])
    expect(second[0].dedupeKey).toBe(first[0].dedupeKey)
  })

  it('produces a different key once the ladder advances', () => {
    const reviewer = proposeReminders([reviewState({ workingDaysInReview: 2 })], [])
    const owner = proposeReminders([reviewState({ workingDaysInReview: 5 })], [])
    expect(owner[0].dedupeKey).not.toBe(reviewer[0].dedupeKey)
  })
})

// =============================================================
// Escalation
// =============================================================

describe('assessReviewEscalations', () => {
  const call = (over: Partial<Parameters<typeof assessReviewEscalations>[0]> = {}) =>
    assessReviewEscalations({
      cycles: [], sections: [], workingDaysToDeadline: 30, deadlineRiskWindow: 10, ...over,
    })

  it('escalates nothing when reviews are healthy', () => {
    expect(call({ sections: [reviewState({ workingDaysInReview: 1 })] })).toHaveLength(0)
  })

  it('escalates a stalled cycle without closing it', () => {
    const out = call({ cycles: [cycle({ status: 'OPEN', isClosed: false, closedAt: null, hasStalled: true, workingDaysOpen: CYCLE_STALL_WORKING_DAYS + 1, openComments: 3 })] })
    expect(out).toHaveLength(1)
    expect(out[0].severity).toBe('MEDIUM')
    expect(out[0].reason).toContain('does not close a review cycle')
  })

  it('raises a missing reviewer to HIGH near the deadline', () => {
    const sections = [reviewState({ reviewerUserId: null, reviewerAssignmentRequired: true })]
    expect(call({ sections, workingDaysToDeadline: 30 })[0].severity).toBe('MEDIUM')
    expect(call({ sections, workingDaysToDeadline: 3 })[0].severity).toBe('HIGH')
  })

  it('says plainly that it will not choose a reviewer', () => {
    const out = call({ sections: [reviewState({ reviewerUserId: null, reviewerAssignmentRequired: true })] })
    expect(out[0].reason).toContain('does not choose a reviewer')
  })

  it('escalates an overdue review only after the ladder is exhausted', () => {
    const top = REMINDER_LADDER[REMINDER_LADDER.length - 1].afterWorkingDays
    expect(call({ sections: [reviewState({ workingDaysInReview: top - 1, isOverdue: true })] })).toHaveLength(0)
    expect(call({ sections: [reviewState({ workingDaysInReview: top, isOverdue: true })] })).toHaveLength(1)
  })

  it('gives every escalation a stable dedupe hint', () => {
    const sections = [reviewState({ reviewerUserId: null, reviewerAssignmentRequired: true })]
    expect(call({ sections })[0].dedupeHint).toBe(call({ sections })[0].dedupeHint)
  })
})
