import { describe, it, expect } from 'vitest'
import {
  setAsideAlignmentBoost,
  credibleInterval95,
  applyAdditiveLayers,
  ClientCertifications,
} from './probabilityLayers'

const certs = (overrides: Partial<ClientCertifications> = {}): ClientCertifications => ({
  sdvosb: false,
  wosb: false,
  hubzone: false,
  smallBusiness: false,
  ...overrides,
})

describe('setAsideAlignmentBoost', () => {
  it('returns multiplier 1.0 (OPEN) for null/empty/NONE set-aside', () => {
    expect(setAsideAlignmentBoost(null, certs()).match).toBe('OPEN')
    expect(setAsideAlignmentBoost('', certs()).match).toBe('OPEN')
    expect(setAsideAlignmentBoost('NONE', certs()).match).toBe('OPEN')
    expect(setAsideAlignmentBoost(null, certs()).multiplier).toBe(1.0)
  })

  it('returns multiplier 1.05 (FULL) for matching SDVOSB cert and SDVOSB set-aside', () => {
    const r = setAsideAlignmentBoost('SDVOSBC', certs({ sdvosb: true }))
    expect(r.multiplier).toBe(1.05)
    expect(r.match).toBe('FULL')
  })

  it('treats SDVOSB / SDVOSBC / VSA codes equivalently for SDVOSB cert', () => {
    expect(setAsideAlignmentBoost('SDVOSB', certs({ sdvosb: true })).multiplier).toBe(1.05)
    expect(setAsideAlignmentBoost('VSA', certs({ sdvosb: true })).multiplier).toBe(1.05)
  })

  it('returns FULL match for WOSB cert on WOSB set-aside, PARTIAL on EDWOSB', () => {
    expect(setAsideAlignmentBoost('WOSB', certs({ wosb: true })).match).toBe('FULL')
    expect(setAsideAlignmentBoost('EDWOSB', certs({ wosb: true })).match).toBe('PARTIAL')
    expect(setAsideAlignmentBoost('EDWOSB', certs({ wosb: true })).multiplier).toBe(1.02)
  })

  it('returns FULL match for HUBZone and small-biz', () => {
    expect(setAsideAlignmentBoost('HZC', certs({ hubzone: true })).match).toBe('FULL')
    expect(setAsideAlignmentBoost('SBA', certs({ smallBusiness: true })).match).toBe('FULL')
    expect(setAsideAlignmentBoost('SBP', certs({ smallBusiness: true })).match).toBe('FULL')
  })

  it('returns PARTIAL for 8(a) set-aside when client has small-business cert', () => {
    expect(setAsideAlignmentBoost('8A', certs({ smallBusiness: true })).match).toBe('PARTIAL')
    expect(setAsideAlignmentBoost('8AN', certs({ smallBusiness: true })).match).toBe('PARTIAL')
  })

  it('returns NONE (multiplier 1.0) when set-aside is present but cert is missing', () => {
    const r = setAsideAlignmentBoost('SDVOSBC', certs({ wosb: true }))
    expect(r.multiplier).toBe(1.0)
    expect(r.match).toBe('NONE')
  })

  it('handles case and whitespace in set-aside type', () => {
    expect(setAsideAlignmentBoost('  sdvosbc  ', certs({ sdvosb: true })).match).toBe('FULL')
    expect(setAsideAlignmentBoost('wosb', certs({ wosb: true })).match).toBe('FULL')
  })
})

describe('credibleInterval95', () => {
  it('returns null for degenerate alpha/beta', () => {
    expect(credibleInterval95(0, 0)).toBeNull()
    expect(credibleInterval95(-1, 5)).toBeNull()
    expect(credibleInterval95(5, 0)).toBeNull()
  })

  it('produces a wider interval for small samples and narrower for large samples', () => {
    const small = credibleInterval95(2, 2)!
    const large = credibleInterval95(200, 200)!
    expect(small.widthPct).toBeGreaterThan(large.widthPct)
    expect(small.low).toBeLessThan(0.5)
    expect(small.high).toBeGreaterThan(0.5)
  })

  it('produces a symmetric interval centered near the posterior mean', () => {
    const r = credibleInterval95(50, 50)!
    const mid = (r.low + r.high) / 2
    expect(Math.abs(mid - 0.5)).toBeLessThan(0.01)
  })

  it('clamps low to 0 and high to 1', () => {
    const r = credibleInterval95(1, 1)!
    expect(r.low).toBeGreaterThanOrEqual(0)
    expect(r.high).toBeLessThanOrEqual(1)
  })
})

describe('applyAdditiveLayers', () => {
  it('passes baseProbability through unchanged for an open opportunity with no cert match', () => {
    const r = applyAdditiveLayers({
      baseProbability: 0.5,
      setAsideType: 'NONE',
      certifications: certs(),
      posteriorAlpha: null,
      posteriorBeta: null,
    })
    expect(r.probability).toBe(0.5)
    expect(r.layersApplied).toEqual([])
    expect(r.credibleInterval).toBeNull()
    expect(r.setAsideMatch).toBe('OPEN')
  })

  it('applies set-aside boost when client cert matches', () => {
    const r = applyAdditiveLayers({
      baseProbability: 0.40,
      setAsideType: 'SDVOSBC',
      certifications: certs({ sdvosb: true }),
      posteriorAlpha: null,
      posteriorBeta: null,
    })
    expect(r.probability).toBeCloseTo(0.42, 4) // 0.40 * 1.05
    expect(r.setAsideMatch).toBe('FULL')
    expect(r.layersApplied.length).toBe(1)
  })

  it('emits a credible interval when posterior parameters are provided', () => {
    const r = applyAdditiveLayers({
      baseProbability: 0.5,
      setAsideType: 'NONE',
      certifications: certs(),
      posteriorAlpha: 10,
      posteriorBeta: 10,
    })
    expect(r.credibleInterval).not.toBeNull()
    expect(r.credibleInterval!.low).toBeGreaterThanOrEqual(0)
    expect(r.credibleInterval!.high).toBeLessThanOrEqual(1)
  })

  it('clamps the output probability to engine bounds [0.01, 0.95]', () => {
    const high = applyAdditiveLayers({
      baseProbability: 0.94,
      setAsideType: 'SDVOSBC',
      certifications: certs({ sdvosb: true }),
      posteriorAlpha: null,
      posteriorBeta: null,
    })
    expect(high.probability).toBeLessThanOrEqual(0.95)

    const low = applyAdditiveLayers({
      baseProbability: 0.001,
      setAsideType: 'NONE',
      certifications: certs(),
      posteriorAlpha: null,
      posteriorBeta: null,
    })
    expect(low.probability).toBeGreaterThanOrEqual(0.01)
  })
})
