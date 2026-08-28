// =============================================================
// GB-107 SAM.gov rate limiter — Redis-backed daily budget with
// burst spacing and a full-day halt after a SAM 429/403.
//
// SAM.gov allows 1,000 calls/day for non-federal accounts; the
// default budget of 900 keeps a 10% safety margin. The counter is
// scoped per-UTC-day and shared across processes via Redis, so the
// poll worker, batch worker, and any manual trigger all draw from
// the same budget.
// =============================================================
import type { Redis } from 'ioredis'

const COUNT_KEY_PREFIX = 'gb107:sam:count:'
const HALT_KEY_PREFIX = 'gb107:sam:halt:'
const LAST_CALL_KEY = 'gb107:sam:lastCall'
const KEY_TTL_SECONDS = 48 * 60 * 60

export type AcquireResult =
  | { ok: true; used: number; remaining: number }
  | { ok: false; reason: 'daily_budget' | 'halted'; retryAfter: Date }

function utcDayStamp(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function nextUtcMidnight(now: Date): Date {
  const next = new Date(now)
  next.setUTCHours(24, 0, 0, 0)
  return next
}

export class Gb107RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly perDay: number,
    private readonly burstIntervalMs: number,
  ) {}

  /**
   * Reserve one API call. Enforces the daily budget and the burst
   * interval (sleeps until the gap has elapsed — callers run with
   * concurrency 1, so this is a simple last-call timestamp).
   */
  async acquire(now: Date = new Date()): Promise<AcquireResult> {
    const day = utcDayStamp(now)

    const halted = await this.redis.get(HALT_KEY_PREFIX + day)
    if (halted) {
      return { ok: false, reason: 'halted', retryAfter: nextUtcMidnight(now) }
    }

    const countKey = COUNT_KEY_PREFIX + day
    const used = await this.redis.incr(countKey)
    if (used === 1) {
      await this.redis.expire(countKey, KEY_TTL_SECONDS)
    }
    if (used > this.perDay) {
      // Leave the counter above the ceiling; subsequent calls also refuse.
      return { ok: false, reason: 'daily_budget', retryAfter: nextUtcMidnight(now) }
    }

    await this.enforceBurstGap()
    return { ok: true, used, remaining: this.perDay - used }
  }

  /** SAM returned 429/403 — stop all enrichment calls until UTC midnight. */
  async haltForDay(now: Date = new Date()): Promise<void> {
    const day = utcDayStamp(now)
    const secondsToMidnight = Math.max(
      60,
      Math.ceil((nextUtcMidnight(now).getTime() - now.getTime()) / 1000),
    )
    await this.redis.set(HALT_KEY_PREFIX + day, '1', 'EX', secondsToMidnight)
  }

  async isHalted(now: Date = new Date()): Promise<boolean> {
    return (await this.redis.get(HALT_KEY_PREFIX + utcDayStamp(now))) !== null
  }

  async remaining(now: Date = new Date()): Promise<number> {
    const raw = await this.redis.get(COUNT_KEY_PREFIX + utcDayStamp(now))
    const used = raw ? parseInt(raw, 10) : 0
    return Math.max(0, this.perDay - used)
  }

  private async enforceBurstGap(): Promise<void> {
    const last = await this.redis.get(LAST_CALL_KEY)
    if (last) {
      const elapsed = Date.now() - parseInt(last, 10)
      const wait = this.burstIntervalMs - elapsed
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
    await this.redis.set(LAST_CALL_KEY, String(Date.now()), 'EX', 300)
  }
}
