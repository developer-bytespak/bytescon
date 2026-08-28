// =============================================================
// §6.3G — Document expiry against the period of performance.
//
// Under test: the earliest failing milestone wins, INSUFFICIENT_DATA is
// returned rather than a false VALID, and option-period coverage is only
// treated as blocking when the solicitation explicitly requires it.
// =============================================================
import { describe, it, expect } from 'vitest'
import { checkExpiryAgainstLifecycle, EXPIRY_STATE_LABELS, type LifecycleDates } from './documentExpiry'

const NOW = new Date('2026-06-01T00:00:00Z')

const lifecycle: LifecycleDates = {
  proposalDeadline: new Date('2026-08-01T00:00:00Z'),
  anticipatedAward: new Date('2026-11-01T00:00:00Z'),
  contractStart: new Date('2026-12-01T00:00:00Z'),
  basePeriodEnd: new Date('2027-11-30T00:00:00Z'),
  optionPeriodEnds: [new Date('2028-11-30T00:00:00Z'), new Date('2029-11-30T00:00:00Z')],
  fullPeriodEnd: new Date('2029-11-30T00:00:00Z'),
}

const check = (expiry: string | null, over: Partial<Parameters<typeof checkExpiryAgainstLifecycle>[0]> = {}) =>
  checkExpiryAgainstLifecycle({
    expiryDate: expiry ? new Date(expiry) : null,
    lifecycle,
    now: NOW,
    ...over,
  })

describe('checkExpiryAgainstLifecycle — ordered failure states', () => {
  it('reports EXPIRED for a date already in the past', () => {
    const result = check('2026-01-01T00:00:00Z')
    expect(result.state).toBe('EXPIRED')
    expect(result.isBlocking).toBe(true)
  })

  it('reports EXPIRES_BEFORE_SUBMISSION for the earliest failure', () => {
    const result = check('2026-07-01T00:00:00Z')
    expect(result.state).toBe('EXPIRES_BEFORE_SUBMISSION')
    expect(result.isBlocking).toBe(true)
    expect(result.comparedAgainst).toBe('proposal deadline')
  })

  it('reports EXPIRES_BEFORE_AWARD when it survives submission but not award', () => {
    const result = check('2026-09-01T00:00:00Z')
    expect(result.state).toBe('EXPIRES_BEFORE_AWARD')
    expect(result.isBlocking).toBe(true)
  })

  it('reports EXPIRES_DURING_BASE_PERIOD when it survives award but not the base period', () => {
    const result = check('2027-06-01T00:00:00Z')
    expect(result.state).toBe('EXPIRES_DURING_BASE_PERIOD')
    expect(result.isBlocking).toBe(true)
  })

  it('reports VALID when it covers the whole recorded period', () => {
    const result = check('2030-01-01T00:00:00Z')
    expect(result.state).toBe('VALID')
    expect(result.isBlocking).toBe(false)
    expect(result.daysOfMargin).toBeGreaterThan(0)
  })
})

describe('checkExpiryAgainstLifecycle — option periods', () => {
  it('does NOT block on option-period expiry by default', () => {
    const result = check('2028-06-01T00:00:00Z')
    expect(result.state).toBe('EXPIRES_DURING_OPTION_PERIOD')
    // The solicitation has not been recorded as requiring option coverage.
    expect(result.isBlocking).toBe(false)
    expect(result.message).toMatch(/has not been recorded as requiring coverage/i)
  })

  it('blocks on option-period expiry only when the solicitation requires it', () => {
    const result = check('2028-06-01T00:00:00Z', { optionCoverageRequired: true })
    expect(result.state).toBe('EXPIRES_DURING_OPTION_PERIOD')
    expect(result.isBlocking).toBe(true)
    expect(result.message).toMatch(/this solicitation requires coverage through them/i)
  })
})

describe('checkExpiryAgainstLifecycle — absent data', () => {
  it('returns INSUFFICIENT_DATA, never a false VALID, when nothing can be compared', () => {
    const result = checkExpiryAgainstLifecycle({ expiryDate: null, lifecycle: {}, now: NOW })
    expect(result.state).toBe('INSUFFICIENT_DATA')
    expect(result.isBlocking).toBe(false)
  })

  it('returns NO_EXPIRY when the document has no expiry but dates exist', () => {
    const result = check(null)
    expect(result.state).toBe('NO_EXPIRY')
    expect(result.isBlocking).toBe(false)
  })

  it('returns INSUFFICIENT_DATA when the document expires but no lifecycle dates exist', () => {
    const result = checkExpiryAgainstLifecycle({ expiryDate: new Date('2030-01-01Z'), lifecycle: {}, now: NOW })
    expect(result.state).toBe('INSUFFICIENT_DATA')
    expect(result.message).toMatch(/no proposal, award or performance dates/i)
  })

  it('handles a lifecycle with only a proposal deadline', () => {
    const result = checkExpiryAgainstLifecycle({
      expiryDate: new Date('2026-07-01Z'),
      lifecycle: { proposalDeadline: new Date('2026-08-01Z') },
      now: NOW,
    })
    expect(result.state).toBe('EXPIRES_BEFORE_SUBMISSION')
  })
})

describe('checkExpiryAgainstLifecycle — determinism and labels', () => {
  it('is deterministic', () => {
    expect(check('2027-06-01T00:00:00Z')).toEqual(check('2027-06-01T00:00:00Z'))
  })

  it('has a user-facing label for every state', () => {
    const states = [
      'VALID', 'EXPIRES_BEFORE_SUBMISSION', 'EXPIRES_BEFORE_AWARD',
      'EXPIRES_DURING_BASE_PERIOD', 'EXPIRES_DURING_OPTION_PERIOD',
      'EXPIRED', 'NO_EXPIRY', 'INSUFFICIENT_DATA',
    ] as const
    for (const state of states) {
      expect(EXPIRY_STATE_LABELS[state]).toBeTruthy()
    }
  })
})
