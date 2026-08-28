import { describe, it, expect } from 'vitest'
import { scoreTier } from './scoreTier'

describe('scoreTier — honest 3-band fit signal (FIX-1)', () => {
  it('maps a high probability to STRONG', () => {
    expect(scoreTier(0.8).tier).toBe('STRONG')
    expect(scoreTier(0.55).tier).toBe('STRONG')
  })
  it('maps a mid probability to MODERATE', () => {
    expect(scoreTier(0.4).tier).toBe('MODERATE')
    expect(scoreTier(0.3).tier).toBe('MODERATE')
  })
  it('maps a low probability to WEAK', () => {
    expect(scoreTier(0.1).tier).toBe('WEAK')
    expect(scoreTier(0).tier).toBe('WEAK')
  })
  it('treats null/undefined/NaN as UNSCORED', () => {
    expect(scoreTier(null).tier).toBe('UNSCORED')
    expect(scoreTier(undefined).tier).toBe('UNSCORED')
    expect(scoreTier(Number.NaN).tier).toBe('UNSCORED')
  })
  it('clamps out-of-range probabilities', () => {
    expect(scoreTier(1.5).tier).toBe('STRONG')
    expect(scoreTier(-0.3).tier).toBe('WEAK')
  })
  it('always returns a human label + description', () => {
    for (const p of [0.9, 0.4, 0.05, null]) {
      const s = scoreTier(p)
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
    }
  })
})
