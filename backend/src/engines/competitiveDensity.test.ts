// =============================================================
// competitiveDensity.getDensityScore — unit tests (P1-2)
//
// Asserts the disease fix: a DB/query error SURFACES (throws), never a
// fabricated 0.5. Genuine no-data cases (no offers received, no density row)
// remain a neutral 0.5 — those are legitimate, not errors.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config/database', () => ({
  prisma: { naicsCompetitiveDensity: { findUnique: vi.fn() } },
}))
vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { getDensityScore } from './competitiveDensity'
import { prisma } from '../config/database'

const findUnique = prisma.naicsCompetitiveDensity.findUnique as unknown as ReturnType<typeof vi.fn>

describe('getDensityScore (P1-2 — error must not become a fabricated 0.5)', () => {
  beforeEach(() => findUnique.mockReset())

  it('returns neutral 0.5 / null when offersReceived is missing (no-data, no DB hit)', async () => {
    const r = await getDensityScore('541512', null)
    expect(r).toEqual({ score: 0.5, densityRatio: null })
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('returns neutral 0.5 / null when no density row exists (no-data)', async () => {
    findUnique.mockResolvedValue(null)
    expect(await getDensityScore('541512', 5)).toEqual({ score: 0.5, densityRatio: null })
  })

  it('computes a score and densityRatio when density data exists', async () => {
    findUnique.mockResolvedValue({ avgBidders: 10 })
    const r = await getDensityScore('541512', 5) // ratio 0.5 → score 0.75
    expect(r.densityRatio).toBeCloseTo(0.5, 6)
    expect(r.score).toBeGreaterThan(0.5)
    expect(r.score).toBeLessThanOrEqual(0.95)
  })

  it('THROWS on a DB/query error — never fabricates a 0.5', async () => {
    // Resolve a row whose property read throws (simulates a driver/deserialize
    // fault mid-read). getDensityScore must SURFACE it, never return a 0.5.
    findUnique.mockResolvedValue({ get avgBidders(): number { throw new Error('read fault') } })
    await expect(getDensityScore('541512', 5)).rejects.toThrow(/unavailable/i)
  })
})
