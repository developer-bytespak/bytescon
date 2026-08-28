// =============================================================
// §8.4 — Public API rate limiting.
//
// A fixed window in Redis, keyed on the TOKEN and the window index. Redis
// because it is already a dependency and already shared across processes: an
// in-memory counter would reset on deploy and would not hold across workers,
// which is the difference between a limit and the appearance of one.
//
// The key contains the token id, so one tenant cannot consume another's quota,
// and two tokens belonging to the same tenant get their own allowances.
//
// The clock is injectable so the tests can advance a window deterministically
// instead of sleeping.
// =============================================================
import { redis } from '../../config/redis'
import { logger } from '../../utils/logger'

/** Per-minute request allowance by token tier. Reuses the existing tier field. */
export const TIER_RATE_LIMITS: Record<string, number> = {
  CORE: 60,
  PRO: 300,
  VAULT: 1000,
}

export const DEFAULT_RATE_LIMIT = 60
const WINDOW_MS = 60_000
const KEY_TTL_WINDOWS = 15

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  /** Epoch seconds at which the current window ends. */
  resetAt: number
  retryAfterSeconds: number
}

type Clock = () => number
let clock: Clock = () => Date.now()

/** Test seam. Production never calls this. */
export function setRateLimitClock(fn: Clock | null): void {
  clock = fn ?? (() => Date.now())
}

export function limitForTier(tier: string): number {
  return TIER_RATE_LIMITS[tier] ?? DEFAULT_RATE_LIMIT
}

/**
 * Count this request against the token's window.
 *
 * FAIL-OPEN on a Redis error, and loudly: refusing every request because the
 * counter is unreachable turns a cache outage into an outage. The failure is
 * logged so the gap is visible rather than silent.
 */
export async function consumeRateLimit(tokenId: string, tier: string): Promise<RateLimitDecision> {
  const limit = limitForTier(tier)
  const now = clock()
  const windowIndex = Math.floor(now / WINDOW_MS)
  const resetAtMs = (windowIndex + 1) * WINDOW_MS
  const resetAt = Math.floor(resetAtMs / 1000)
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - now) / 1000))

  try {
    const key = `publicapi:rl:${tokenId}:${windowIndex}`
    const count = await redis.incr(key)
    // The key only has to outlive its own window, but the TTL is wall-clock
    // while the window index can come from an injected clock — so a generous
    // multiple keeps a slow request (or a test advancing time) from losing the
    // count mid-window. One key per token per minute, so the keyspace stays
    // bounded either way.
    if (count === 1) await redis.pexpire(key, WINDOW_MS * KEY_TTL_WINDOWS)
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
      retryAfterSeconds,
    }
  } catch (err) {
    logger.error('Public API rate limit check skipped (Redis error)', { error: (err as Error).message })
    return { allowed: true, limit, remaining: limit, resetAt, retryAfterSeconds }
  }
}
