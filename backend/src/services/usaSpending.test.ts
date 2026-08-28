// =============================================================
// usaSpending.getAgencySetAsideRates — unit tests (P1-2b)
//
// Asserts the disease fix: ANY failed count query (total, small business, or
// SDVOSB) SURFACES (throws) rather than being masked (by Promise.allSettled)
// into the federal-default prior or a fabricated 0% rate.
// A genuine zero-contract agency still gets the federal-default prior — that's
// legitimate no-data, not error-hiding.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { usaSpendingService } from './usaSpending'

const post = vi.fn()
// Inject a mock axios client in place of the real one (private field).
;(usaSpendingService as any).client = { post }

const countResp = (contracts: number) => ({ data: { results: { contracts } } })

describe('getAgencySetAsideRates (P1-2b — error surfaces, never fabricated federal defaults)', () => {
  beforeEach(() => post.mockReset())

  it('computes rates from contract counts when all queries succeed', async () => {
    // call order: total, small_business, sdvosb
    post
      .mockResolvedValueOnce(countResp(1000))
      .mockResolvedValueOnce(countResp(400))
      .mockResolvedValueOnce(countResp(50))
    const r = await usaSpendingService.getAgencySetAsideRates('Department of Veterans Affairs')
    expect(r.smallBizRate).toBeCloseTo(0.4, 6)
    expect(r.sdvosbRate).toBeCloseTo(0.05, 6)
  })

  it('returns the federal-default prior when the agency genuinely has zero contracts (no-data)', async () => {
    post
      .mockResolvedValueOnce(countResp(0))
      .mockResolvedValueOnce(countResp(0))
      .mockResolvedValueOnce(countResp(0))
    const r = await usaSpendingService.getAgencySetAsideRates('Tiny Agency')
    expect(r).toEqual({ smallBizRate: 0.25, sdvosbRate: 0.05 })
  })

  it('THROWS when the total-count query fails — never fabricates federal defaults', async () => {
    // The total query rejects; Promise.allSettled captures it (so no floating
    // rejection), and the SUT must surface it rather than emit the prior.
    post
      .mockRejectedValueOnce(new Error('502 bad gateway'))
      .mockResolvedValueOnce(countResp(400))
      .mockResolvedValueOnce(countResp(50))
    await expect(
      usaSpendingService.getAgencySetAsideRates('Department of Veterans Affairs'),
    ).rejects.toThrow(/unavailable/i)
  })

  it('THROWS when the small-business count query fails even though the total succeeds (partial rejection)', async () => {
    // totalRes fulfills, sbRes rejects: must NOT coerce the rejection to 0 and
    // return a fabricated smallBizRate=0 that gets persisted as isEnriched.
    post
      .mockResolvedValueOnce(countResp(1000))
      .mockRejectedValueOnce(new Error('502 bad gateway'))
      .mockResolvedValueOnce(countResp(50))
    await expect(
      usaSpendingService.getAgencySetAsideRates('Department of Veterans Affairs'),
    ).rejects.toThrow(/small business count/i)
  })

  it('THROWS when the SDVOSB count query fails even though the total succeeds (partial rejection)', async () => {
    post
      .mockResolvedValueOnce(countResp(1000))
      .mockResolvedValueOnce(countResp(400))
      .mockRejectedValueOnce(new Error('socket hang up'))
    await expect(
      usaSpendingService.getAgencySetAsideRates('Department of Veterans Affairs'),
    ).rejects.toThrow(/SDVOSB count/)
  })
})
