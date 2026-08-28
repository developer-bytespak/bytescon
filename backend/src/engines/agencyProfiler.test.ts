// =============================================================
// agencyProfiler.getAgencyHistoryScore — unit tests (P1-2)
//
// Asserts the disease fix: a DB/query error must SURFACE (throw), never be
// swallowed into a fabricated 0.5. A genuine no-profile case is still a
// neutral 0.5 (legitimate no-data, not an error).
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config/database', () => ({
  prisma: { agencyAwardProfile: { findUnique: vi.fn() } },
}))
vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { getAgencyHistoryScore } from './agencyProfiler'
import { prisma } from '../config/database'

const findUnique = prisma.agencyAwardProfile.findUnique as unknown as ReturnType<typeof vi.fn>
const SDVOSB_CLIENT = { sdvosb: true, wosb: false, hubzone: false, smallBusiness: true }

describe('getAgencyHistoryScore (P1-2 — error must not become a fabricated 0.5)', () => {
  beforeEach(() => findUnique.mockReset())

  it('computes a weighted score when a profile exists', async () => {
    findUnique.mockResolvedValue({ sdvosbRate: 0.4, womenOwnedRate: 0.1, hubzoneRate: 0.05, smallBizRate: 0.5 })
    const score = await getAgencyHistoryScore('Dept of VA', SDVOSB_CLIENT)
    // weighted avg over applicable components: (smallBiz 0.5*0.6 + sdvosb 0.4*0.8) / 1.4
    expect(score).toBeCloseTo((0.5 * 0.6 + 0.4 * 0.8) / 1.4, 4)
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(0.95)
  })

  it('returns a neutral 0.5 when there is genuinely no profile (no-data, NOT an error)', async () => {
    findUnique.mockResolvedValue(null)
    expect(await getAgencyHistoryScore('Unknown Agency', SDVOSB_CLIENT)).toBe(0.5)
  })

  it('THROWS on a DB/query error — never fabricates a 0.5', async () => {
    // Resolve a row whose property read throws (simulates a driver/deserialize
    // fault mid-read). getAgencyHistoryScore must SURFACE it, never return 0.5.
    findUnique.mockResolvedValue({
      get smallBizRate(): number { throw new Error('read fault') },
      womenOwnedRate: 0, hubzoneRate: 0, sdvosbRate: 0,
    })
    await expect(getAgencyHistoryScore('Dept of VA', SDVOSB_CLIENT)).rejects.toThrow(/unavailable/i)
  })
})
