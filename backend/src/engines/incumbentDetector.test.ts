// =============================================================
// Incumbent Detector — Unit Tests
//
// Validates pattern-based signal extraction that infers an incumbent's
// presence from opportunity text (title + description).
//
// Critical invariants:
//   - inferredProbability is always in [0, 1]
//   - "no signal" returns a defensible neutral baseline (0.25-0.30)
//   - any STRONG pattern (recompete / follow-on) flips detected=true
//   - 3+ SOFT patterns reach the "strong" classification
// =============================================================
import { describe, it, expect } from 'vitest'
import { detectIncumbent } from './incumbentDetector'

describe('detectIncumbent — empty / no signal cases', () => {
  it('returns neutral baseline (0.30) for empty input', () => {
    const r = detectIncumbent('')
    expect(r.detected).toBe(false)
    expect(r.strong).toBe(false)
    expect(r.confidence).toBe(0)
    expect(r.signals).toEqual([])
    expect(r.inferredProbability).toBe(0.3)
  })

  it('returns 0.25 baseline when text has no patterns matched', () => {
    const r = detectIncumbent('Provide janitorial services for federal building 1234.')
    expect(r.detected).toBe(false)
    expect(r.inferredProbability).toBe(0.25)
  })

  it('handles whitespace-only input gracefully', () => {
    const r = detectIncumbent('   \n\t  ')
    expect(r.detected).toBe(false)
    expect(r.inferredProbability).toBe(0.3)
  })
})

describe('detectIncumbent — STRONG pattern detection', () => {
  it('detects "recompete" as strong signal', () => {
    const r = detectIncumbent('This is a recompete of the existing IT services contract.')
    expect(r.detected).toBe(true)
    expect(r.strong).toBe(true)
    expect(r.signals).toContain('recompete')
    expect(r.inferredProbability).toBeGreaterThan(0.65)
  })

  it('detects "follow-on" as strong signal', () => {
    const r = detectIncumbent('Follow-on to contract W91234-20-C-5678.')
    expect(r.detected).toBe(true)
    expect(r.strong).toBe(true)
  })

  it('detects "bridge contract" as strong signal', () => {
    const r = detectIncumbent('Bridge contract to maintain service continuity.')
    expect(r.detected).toBe(true)
    expect(r.strong).toBe(true)
  })

  it('detects "transition period" as strong signal', () => {
    const r = detectIncumbent('Includes 60-day transition period from incumbent.')
    expect(r.detected).toBe(true)
    expect(r.strong).toBe(true)
  })
})

describe('detectIncumbent — SOFT pattern detection', () => {
  it('single soft pattern alone does NOT trigger detection', () => {
    const r = detectIncumbent('The current contractor will demobilize.')
    expect(r.detected).toBe(false)
    expect(r.signals.length).toBe(1)
  })

  it('two soft patterns DO trigger detection (but not strong)', () => {
    const r = detectIncumbent('The incumbent has held this contract through option periods.')
    expect(r.detected).toBe(true)
    expect(r.strong).toBe(false)
    expect(r.inferredProbability).toBeGreaterThan(0.40)
    expect(r.inferredProbability).toBeLessThanOrEqual(0.70)
  })

  it('three soft patterns reach STRONG classification', () => {
    const r = detectIncumbent('The incumbent contract extension during the option year continues this existing contract.')
    expect(r.detected).toBe(true)
    expect(r.strong).toBe(true)
    expect(r.inferredProbability).toBeGreaterThan(0.65)
  })
})

describe('detectIncumbent — invariants', () => {
  it('inferredProbability is always in [0, 1]', () => {
    const cases = [
      '',
      'unrelated text',
      'recompete',
      'recompete follow-on bridge contract transition period current contractor incumbent option year',
    ]
    for (const text of cases) {
      const r = detectIncumbent(text)
      expect(r.inferredProbability).toBeGreaterThanOrEqual(0)
      expect(r.inferredProbability).toBeLessThanOrEqual(1.0)
    }
  })

  it('confidence is always in [0, 1]', () => {
    const r = detectIncumbent('recompete follow-on bridge contract transition period')
    expect(r.confidence).toBeGreaterThanOrEqual(0)
    expect(r.confidence).toBeLessThanOrEqual(1.0)
  })

  it('caps inferredProbability at 0.90 even with maximum signal', () => {
    // 4 strong + 9 soft = max signals
    const text = `recompete follow-on bridge contract transition period current contractor
                  incumbent option period base period plus 4 option continuation of services
                  existing contract contract extension previous contract`
    const r = detectIncumbent(text)
    expect(r.inferredProbability).toBeLessThanOrEqual(0.90)
  })

  it('deduplicates signals when the same pattern matches multiple times', () => {
    const r = detectIncumbent('incumbent and incumbent and incumbent')
    expect(r.signals.filter((s) => s === 'incumbent').length).toBe(1)
  })

  it('case-insensitive: RECOMPETE and recompete produce same result', () => {
    const lo = detectIncumbent('this is a recompete')
    const hi = detectIncumbent('THIS IS A RECOMPETE')
    expect(lo.detected).toBe(hi.detected)
    expect(lo.strong).toBe(hi.strong)
    expect(lo.inferredProbability).toBe(hi.inferredProbability)
  })
})
