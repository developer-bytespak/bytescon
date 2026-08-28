// =============================================================
// Monthly token refresh cap semantics (unit, pure).
//
// Regression guard: the 500 cap bounds what the MONTHLY GRANT accumulates
// to — it must never clamp the balance itself. Token packs are sold as
// "tokens never expire" and increment without a cap, so a firm can hold
// more than 500 legitimately; the old Math.min(500, balance + grant) form
// deleted the excess on the first refresh of a new month.
//
// The formula is asserted directly (rather than through the two call sites)
// because it is duplicated in middleware/tierGate.ts maybeRefreshTokens and
// services/billingService.ts refreshProposalTokens — this pins the shared
// contract both must satisfy.
// =============================================================
import { describe, it, expect } from 'vitest'

const CAP = 500

/** The exact expression used at both refresh sites. */
function refreshedBalance(balance: number, grant: number): number {
  return balance + Math.max(0, Math.min(grant, CAP - balance))
}

describe('monthly token refresh cap', () => {
  it('adds the full grant when it fits under the cap', () => {
    expect(refreshedBalance(100, 25)).toBe(125)
  })

  it('tops up only to the cap when the grant would overshoot', () => {
    expect(refreshedBalance(490, 25)).toBe(500)
  })

  it('lands exactly on the cap without exceeding it', () => {
    expect(refreshedBalance(475, 25)).toBe(500)
  })

  it('NEVER reduces a purchased balance already above the cap', () => {
    // The bug: Math.min(500, 600 + 25) destroyed 100 paid tokens.
    expect(refreshedBalance(600, 25)).toBe(600)
    expect(refreshedBalance(1000, 50)).toBe(1000)
  })

  it('is a no-op at the cap rather than a reduction', () => {
    expect(refreshedBalance(500, 25)).toBe(500)
  })

  it('handles a zero grant (no entitlements) without touching the balance', () => {
    expect(refreshedBalance(0, 0)).toBe(0)
    expect(refreshedBalance(750, 0)).toBe(750)
  })

  it('is monotonic — a refresh can only ever increase or hold the balance', () => {
    for (const balance of [0, 1, 250, 499, 500, 501, 600, 2000]) {
      for (const grant of [0, 5, 25, 50, 200]) {
        expect(refreshedBalance(balance, grant)).toBeGreaterThanOrEqual(balance)
      }
    }
  })
})
