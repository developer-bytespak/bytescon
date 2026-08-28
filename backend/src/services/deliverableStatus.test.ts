// =============================================================
// Section 5 Module 8E — deliverable transition validation + derived OVERDUE /
// UPCOMING logic under a controlled clock.
// =============================================================
import { describe, it, expect } from 'vitest'
import { isValidDeliverableTransition, isOverdue, deriveStatus, isUpcoming } from './deliverableStatus'

const NOW = new Date('2026-08-04T00:00:00.000Z')
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000)

describe('isValidDeliverableTransition', () => {
  it('allows the standard forward path', () => {
    expect(isValidDeliverableTransition('NOT_STARTED', 'IN_PROGRESS')).toBe(true)
    expect(isValidDeliverableTransition('IN_PROGRESS', 'SUBMITTED')).toBe(true)
    expect(isValidDeliverableTransition('SUBMITTED', 'ACCEPTED')).toBe(true)
    expect(isValidDeliverableTransition('SUBMITTED', 'REJECTED')).toBe(true)
    expect(isValidDeliverableTransition('REJECTED', 'IN_PROGRESS')).toBe(true)
  })
  it('rejects illegal jumps and transitions out of terminal states', () => {
    expect(isValidDeliverableTransition('NOT_STARTED', 'ACCEPTED')).toBe(false)
    expect(isValidDeliverableTransition('ACCEPTED', 'IN_PROGRESS')).toBe(false)
    expect(isValidDeliverableTransition('CANCELLED', 'IN_PROGRESS')).toBe(false)
  })
  it('treats a same-status transition as an idempotent no-op', () => {
    expect(isValidDeliverableTransition('IN_PROGRESS', 'IN_PROGRESS')).toBe(true)
  })
})

describe('isOverdue / deriveStatus', () => {
  it('is overdue when past due and still open', () => {
    expect(isOverdue(inDays(-1), 'IN_PROGRESS', NOW)).toBe(true)
    expect(deriveStatus(inDays(-1), 'NOT_STARTED', NOW)).toBe('OVERDUE')
  })
  it('is NOT overdue when submitted/accepted/terminal, or future, or no date', () => {
    expect(isOverdue(inDays(-1), 'SUBMITTED', NOW)).toBe(false)
    expect(isOverdue(inDays(-1), 'ACCEPTED', NOW)).toBe(false)
    expect(isOverdue(inDays(-1), 'WAIVED', NOW)).toBe(false)
    expect(isOverdue(inDays(5), 'IN_PROGRESS', NOW)).toBe(false)
    expect(isOverdue(null, 'IN_PROGRESS', NOW)).toBe(false)
  })
  it('deriveStatus passes through when not overdue', () => {
    expect(deriveStatus(inDays(5), 'IN_PROGRESS', NOW)).toBe('IN_PROGRESS')
    expect(deriveStatus(inDays(-1), 'SUBMITTED', NOW)).toBe('SUBMITTED')
  })
})

describe('isUpcoming', () => {
  it('is upcoming within the window for an open deliverable', () => {
    expect(isUpcoming(inDays(3), 'IN_PROGRESS', NOW, 14)).toBe(true)
    expect(isUpcoming(inDays(14), 'NOT_STARTED', NOW, 14)).toBe(true)
  })
  it('is not upcoming beyond the window, in the past, submitted, or dateless', () => {
    expect(isUpcoming(inDays(20), 'IN_PROGRESS', NOW, 14)).toBe(false)
    expect(isUpcoming(inDays(-1), 'IN_PROGRESS', NOW, 14)).toBe(false)
    expect(isUpcoming(inDays(3), 'SUBMITTED', NOW, 14)).toBe(false)
    expect(isUpcoming(null, 'IN_PROGRESS', NOW, 14)).toBe(false)
  })
})
