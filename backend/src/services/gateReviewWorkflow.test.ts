// =============================================================
// Gate review state-machine unit tests (pure logic).
// =============================================================
import { describe, it, expect } from 'vitest'
import { isValidGateTransition, allowedGateTargets, isGateOverdue } from './gateReviewWorkflow'

describe('gate review transitions', () => {
  it('allows the submit/decision flow', () => {
    expect(isValidGateTransition('NOT_STARTED', 'IN_PROGRESS')).toBe(true)
    expect(isValidGateTransition('IN_PROGRESS', 'APPROVED')).toBe(true)
    expect(isValidGateTransition('IN_PROGRESS', 'REJECTED')).toBe(true)
    expect(isValidGateTransition('IN_PROGRESS', 'CHANGES_REQUIRED')).toBe(true)
    expect(isValidGateTransition('CHANGES_REQUIRED', 'IN_PROGRESS')).toBe(true)
  })
  it('allows waiving from non-terminal states', () => {
    expect(isValidGateTransition('NOT_STARTED', 'WAIVED')).toBe(true)
    expect(isValidGateTransition('IN_PROGRESS', 'WAIVED')).toBe(true)
    expect(isValidGateTransition('CHANGES_REQUIRED', 'WAIVED')).toBe(true)
  })
  it('blocks transitions out of terminal states and same-state no-ops', () => {
    expect(isValidGateTransition('APPROVED', 'IN_PROGRESS')).toBe(false)
    expect(isValidGateTransition('REJECTED', 'IN_PROGRESS')).toBe(false)
    expect(isValidGateTransition('WAIVED', 'IN_PROGRESS')).toBe(false)
    expect(isValidGateTransition('IN_PROGRESS', 'IN_PROGRESS')).toBe(false)
  })
  it('blocks skipping straight to a decision', () => {
    expect(isValidGateTransition('NOT_STARTED', 'APPROVED')).toBe(false)
    expect(allowedGateTargets('NOT_STARTED')).toEqual(['IN_PROGRESS', 'WAIVED'])
  })
})

describe('gate review overdue', () => {
  const now = new Date('2026-08-06T12:00:00Z')
  it('is overdue when due date passed and status is not terminal', () => {
    expect(isGateOverdue('IN_PROGRESS', new Date('2026-08-05T00:00:00Z'), now)).toBe(true)
  })
  it('is not overdue with no due date or a future date', () => {
    expect(isGateOverdue('IN_PROGRESS', null, now)).toBe(false)
    expect(isGateOverdue('IN_PROGRESS', new Date('2026-08-07T00:00:00Z'), now)).toBe(false)
  })
  it('is never overdue in a terminal state', () => {
    expect(isGateOverdue('APPROVED', new Date('2026-08-01T00:00:00Z'), now)).toBe(false)
    expect(isGateOverdue('WAIVED', new Date('2026-08-01T00:00:00Z'), now)).toBe(false)
  })
})
