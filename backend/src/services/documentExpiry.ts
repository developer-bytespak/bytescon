// =============================================================
// §6.3G — Document expiry against the period of performance.
//
// Compares a required standing document's expiry against every milestone in the
// award lifecycle and returns the EARLIEST problem it creates.
//
// Two rules the spec is explicit about, enforced here:
//  - INSUFFICIENT_DATA is returned when the comparison cannot honestly be made
//    (no expiry known AND no dates to compare against) — never a false VALID.
//  - Option periods are only treated as required coverage when the solicitation
//    EXPLICITLY requires it (`optionCoverageRequired`). By default, expiry
//    during an option period is reported as information, and the caller decides.
// =============================================================

export type ExpiryState =
  | 'VALID'
  | 'EXPIRES_BEFORE_SUBMISSION'
  | 'EXPIRES_BEFORE_AWARD'
  | 'EXPIRES_DURING_BASE_PERIOD'
  | 'EXPIRES_DURING_OPTION_PERIOD'
  | 'EXPIRED'
  | 'NO_EXPIRY'
  | 'INSUFFICIENT_DATA'

export interface LifecycleDates {
  proposalDeadline?: Date | null
  anticipatedAward?: Date | null
  contractStart?: Date | null
  basePeriodEnd?: Date | null
  /** Ordered option period ends, earliest first. */
  optionPeriodEnds?: Date[]
  /** Latest possible end including all options. */
  fullPeriodEnd?: Date | null
}

export interface ExpiryCheckInput {
  expiryDate: Date | null
  lifecycle: LifecycleDates
  /**
   * True only when the solicitation explicitly requires coverage through the
   * option periods. Default false — we do not invent that requirement.
   */
  optionCoverageRequired?: boolean
  now?: Date
}

export interface ExpiryCheckResult {
  state: ExpiryState
  message: string
  /** Whether this should block submission readiness. */
  isBlocking: boolean
  /** The lifecycle date the expiry was measured against. */
  comparedAgainst: string | null
  comparedDate: Date | null
  daysOfMargin: number | null
}

const DAY = 86400000

/**
 * Evaluate one document's expiry. Pure and deterministic.
 * The earliest failing milestone wins, because that is the first real problem.
 */
export function checkExpiryAgainstLifecycle(input: ExpiryCheckInput): ExpiryCheckResult {
  const now = input.now ?? new Date()
  const { expiryDate, lifecycle } = input

  const hasAnyDate = Boolean(
    lifecycle.proposalDeadline || lifecycle.anticipatedAward || lifecycle.contractStart ||
    lifecycle.basePeriodEnd || (lifecycle.optionPeriodEnds?.length) || lifecycle.fullPeriodEnd,
  )

  if (!expiryDate) {
    // No expiry AND no lifecycle dates is genuinely unknowable.
    if (!hasAnyDate) {
      return {
        state: 'INSUFFICIENT_DATA', isBlocking: false, comparedAgainst: null, comparedDate: null, daysOfMargin: null,
        message: 'No expiry date is recorded for this document, and no proposal, award or performance dates are available to compare against.',
      }
    }
    return {
      state: 'NO_EXPIRY', isBlocking: false, comparedAgainst: null, comparedDate: null, daysOfMargin: null,
      message: 'No expiry date is recorded for this document. If it does expire, add the date so it can be checked against the performance period.',
    }
  }

  if (expiryDate.getTime() < now.getTime()) {
    return {
      state: 'EXPIRED', isBlocking: true, comparedAgainst: 'today', comparedDate: now,
      daysOfMargin: Math.floor((expiryDate.getTime() - now.getTime()) / DAY),
      message: `This document expired on ${expiryDate.toISOString().slice(0, 10)}. An expired document cannot satisfy a submission requirement.`,
    }
  }

  if (!hasAnyDate) {
    return {
      state: 'INSUFFICIENT_DATA', isBlocking: false, comparedAgainst: null, comparedDate: null, daysOfMargin: null,
      message: `This document expires on ${expiryDate.toISOString().slice(0, 10)}, but no proposal, award or performance dates are recorded to compare it against.`,
    }
  }

  const margin = (target: Date) => Math.floor((expiryDate.getTime() - target.getTime()) / DAY)

  // Earliest failing milestone first.
  if (lifecycle.proposalDeadline && expiryDate < lifecycle.proposalDeadline) {
    return {
      state: 'EXPIRES_BEFORE_SUBMISSION', isBlocking: true,
      comparedAgainst: 'proposal deadline', comparedDate: lifecycle.proposalDeadline, daysOfMargin: margin(lifecycle.proposalDeadline),
      message: `Expires ${expiryDate.toISOString().slice(0, 10)}, which is before the ${lifecycle.proposalDeadline.toISOString().slice(0, 10)} proposal deadline. Renew it before submitting.`,
    }
  }

  if (lifecycle.anticipatedAward && expiryDate < lifecycle.anticipatedAward) {
    return {
      state: 'EXPIRES_BEFORE_AWARD', isBlocking: true,
      comparedAgainst: 'anticipated award', comparedDate: lifecycle.anticipatedAward, daysOfMargin: margin(lifecycle.anticipatedAward),
      message: `Expires ${expiryDate.toISOString().slice(0, 10)}, before the anticipated award on ${lifecycle.anticipatedAward.toISOString().slice(0, 10)}.`,
    }
  }

  const baseEnd = lifecycle.basePeriodEnd
  if (baseEnd && expiryDate < baseEnd) {
    return {
      state: 'EXPIRES_DURING_BASE_PERIOD', isBlocking: true,
      comparedAgainst: 'base period end', comparedDate: baseEnd, daysOfMargin: margin(baseEnd),
      message: `Expires ${expiryDate.toISOString().slice(0, 10)}, during the base period which runs to ${baseEnd.toISOString().slice(0, 10)}. Plan the renewal now.`,
    }
  }

  const optionEnds = (lifecycle.optionPeriodEnds ?? []).filter(Boolean).sort((a, b) => a.getTime() - b.getTime())
  const lastOptionEnd = lifecycle.fullPeriodEnd ?? optionEnds[optionEnds.length - 1] ?? null
  if (lastOptionEnd && expiryDate < lastOptionEnd) {
    const required = input.optionCoverageRequired === true
    return {
      state: 'EXPIRES_DURING_OPTION_PERIOD',
      // Only blocking when the solicitation actually demands that coverage.
      isBlocking: required,
      comparedAgainst: 'full period of performance', comparedDate: lastOptionEnd, daysOfMargin: margin(lastOptionEnd),
      message: required
        ? `Expires ${expiryDate.toISOString().slice(0, 10)}, before the ${lastOptionEnd.toISOString().slice(0, 10)} end of the option periods, and this solicitation requires coverage through them.`
        : `Expires ${expiryDate.toISOString().slice(0, 10)}, before the ${lastOptionEnd.toISOString().slice(0, 10)} end of the option periods. This solicitation has not been recorded as requiring coverage through the options, so it is flagged for awareness rather than treated as a blocker.`,
    }
  }

  const furthest = lastOptionEnd ?? baseEnd ?? lifecycle.anticipatedAward ?? lifecycle.proposalDeadline
  return {
    state: 'VALID', isBlocking: false,
    comparedAgainst: lastOptionEnd ? 'full period of performance' : baseEnd ? 'base period end' : 'anticipated award',
    comparedDate: furthest ?? null,
    daysOfMargin: furthest ? margin(furthest) : null,
    message: `Valid through ${expiryDate.toISOString().slice(0, 10)}, which covers the recorded performance period.`,
  }
}

/** Human-readable label for each state, used verbatim in the UI. */
export const EXPIRY_STATE_LABELS: Record<ExpiryState, string> = {
  VALID: 'Valid',
  EXPIRES_BEFORE_SUBMISSION: 'Expires before submission',
  EXPIRES_BEFORE_AWARD: 'Expires before award',
  EXPIRES_DURING_BASE_PERIOD: 'Expires during base period',
  EXPIRES_DURING_OPTION_PERIOD: 'Expires during option period',
  EXPIRED: 'Expired',
  NO_EXPIRY: 'No expiry recorded',
  INSUFFICIENT_DATA: 'Insufficient data',
}
