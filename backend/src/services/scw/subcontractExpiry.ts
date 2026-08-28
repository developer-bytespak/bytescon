// =============================================================
// Subcontracting opportunity expiry helpers (shared, pure).
//
// A subcontracting opportunity "expires" when its responseDeadline
// passes. Expired rows stay VISIBLE for a grace window so the operator
// can still see what just closed, then they are purged (UI hides them
// and the maintenance worker hard-deletes them — POC already captured).
//
// Used by:
//   - routes/subcontracting.ts        (GET /opportunities list filter + per-row expiryState)
//   - workers/subcontractMaintenanceWorker.ts (purge cutoff)
//
// Pure functions only (no DB, no clock side-effects — `now` is injected)
// so they unit-test cleanly. See subcontractExpiry.test.ts.
// =============================================================

/** Days an expired opportunity remains visible before it is purged. */
export const EXPIRY_GRACE_DAYS = 7

/** Window (days) before the deadline within which a row is "expiring soon". */
export const EXPIRING_SOON_DAYS = 7

const MS_PER_DAY = 24 * 60 * 60 * 1000

export type ExpiryState = 'active' | 'expiring_soon' | 'expired'

/**
 * Classify an opportunity by its responseDeadline relative to `now`.
 *   - null deadline            -> 'active' (rolling / no stated close)
 *   - deadline in the past     -> 'expired'
 *   - deadline within 7 days   -> 'expiring_soon'
 *   - otherwise                -> 'active'
 */
export function computeExpiryState(
  responseDeadline: Date | string | null | undefined,
  now: Date = new Date()
): ExpiryState {
  if (!responseDeadline) return 'active'
  const deadline = responseDeadline instanceof Date ? responseDeadline : new Date(responseDeadline)
  if (isNaN(deadline.getTime())) return 'active'

  const diffMs = deadline.getTime() - now.getTime()
  if (diffMs < 0) return 'expired'
  if (diffMs <= EXPIRING_SOON_DAYS * MS_PER_DAY) return 'expiring_soon'
  return 'active'
}

/**
 * The lower bound for a deadline to still be shown. Rows whose deadline is
 * strictly before this are past the grace window and should be hidden/purged.
 * (Rows with a null deadline are never filtered out by this cutoff.)
 */
export function graceCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - EXPIRY_GRACE_DAYS * MS_PER_DAY)
}

/** Whole days since the deadline passed (>= 0); null if not yet/never expired. */
export function daysSinceExpiry(
  responseDeadline: Date | string | null | undefined,
  now: Date = new Date()
): number | null {
  if (!responseDeadline) return null
  const deadline = responseDeadline instanceof Date ? responseDeadline : new Date(responseDeadline)
  if (isNaN(deadline.getTime())) return null
  const diffMs = now.getTime() - deadline.getTime()
  if (diffMs < 0) return null
  return Math.floor(diffMs / MS_PER_DAY)
}
