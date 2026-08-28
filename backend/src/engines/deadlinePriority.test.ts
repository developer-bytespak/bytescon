// =============================================================
// Deadline Priority — Unit Tests
//
// Validates RED/YELLOW/GREEN deadline classification + sorting + windowing.
// FR-10 thresholds: RED ≤ 7d, YELLOW ≤ 20d, GREEN > 20d.
// =============================================================
import { describe, it, expect } from 'vitest'
import { classifyDeadline, sortByDeadlinePriority, filterByDeadlineWindow } from './deadlinePriority'

function inDays(days: number): Date {
  return new Date(Date.now() + days * 86400000)
}

describe('classifyDeadline', () => {
  it('returns EXPIRED on past deadlines', () => {
    const r = classifyDeadline(inDays(-3))
    expect(r.priority).toBe('RED')
    expect(r.label).toBe('EXPIRED')
  })

  it('returns RED CRITICAL within 7 days', () => {
    const r = classifyDeadline(inDays(5))
    expect(r.priority).toBe('RED')
    expect(r.label).toContain('CRITICAL')
  })

  it('returns YELLOW ELEVATED at 8-20 days', () => {
    const r = classifyDeadline(inDays(15))
    expect(r.priority).toBe('YELLOW')
    expect(r.label).toContain('ELEVATED')
  })

  it('returns GREEN NORMAL at > 20 days', () => {
    const r = classifyDeadline(inDays(45))
    expect(r.priority).toBe('GREEN')
    expect(r.label).toContain('NORMAL')
  })
})

describe('sortByDeadlinePriority', () => {
  it('orders RED before YELLOW before GREEN', () => {
    const opps = [
      { id: 'green', responseDeadline: inDays(60) },
      { id: 'red', responseDeadline: inDays(3) },
      { id: 'yellow', responseDeadline: inDays(15) },
    ]
    const sorted = sortByDeadlinePriority(opps)
    expect(sorted.map((o) => o.id)).toEqual(['red', 'yellow', 'green'])
  })

  it('within same priority, sorts by deadline ASC', () => {
    const opps = [
      { id: 'a', responseDeadline: inDays(5) },
      { id: 'b', responseDeadline: inDays(2) },
      { id: 'c', responseDeadline: inDays(7) },
    ]
    const sorted = sortByDeadlinePriority(opps)
    expect(sorted.map((o) => o.id)).toEqual(['b', 'a', 'c'])
  })

  it('does not mutate the input array', () => {
    const opps = [
      { id: 'a', responseDeadline: inDays(60) },
      { id: 'b', responseDeadline: inDays(3) },
    ]
    const before = opps.map((o) => o.id)
    sortByDeadlinePriority(opps)
    expect(opps.map((o) => o.id)).toEqual(before)
  })
})

describe('filterByDeadlineWindow', () => {
  it('includes opps within the window', () => {
    const opps = [
      { id: 'a', responseDeadline: inDays(5) },
      { id: 'b', responseDeadline: inDays(15) },
      { id: 'c', responseDeadline: inDays(45) },
    ]
    const filtered = filterByDeadlineWindow(opps, 20)
    expect(filtered.map((o) => o.id).sort()).toEqual(['a', 'b'])
  })

  it('excludes expired opportunities', () => {
    const opps = [
      { id: 'expired', responseDeadline: inDays(-2) },
      { id: 'live', responseDeadline: inDays(5) },
    ]
    const filtered = filterByDeadlineWindow(opps, 20)
    expect(filtered.map((o) => o.id)).toEqual(['live'])
  })
})
