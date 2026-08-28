import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { redis } from '../config/redis'
import { Gb107RateLimiter, nextUtcMidnight } from './rateLimiter.gb107'

// Fixed clock so the Redis keys are deterministic and never collide
// with a real deployment's current-day keys.
const FAKE_NOW = new Date('2020-06-15T10:00:00.000Z')
const DAY_KEYS = [
  'gb107:sam:count:2020-06-15',
  'gb107:sam:halt:2020-06-15',
  'gb107:sam:lastCall',
]

async function cleanup(): Promise<void> {
  await redis.del(...DAY_KEYS)
}

describe('GB-107 rate limiter (real Redis)', () => {
  beforeEach(cleanup)
  afterAll(cleanup)

  it('grants calls until the daily budget is exhausted, then refuses with a retry time', async () => {
    const limiter = new Gb107RateLimiter(redis, 3, 0)

    for (let i = 1; i <= 3; i++) {
      const result = await limiter.acquire(FAKE_NOW)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.remaining).toBe(3 - i)
    }

    const refused = await limiter.acquire(FAKE_NOW)
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.reason).toBe('daily_budget')
      expect(refused.retryAfter.toISOString()).toBe('2020-06-16T00:00:00.000Z')
    }
  })

  it('haltForDay blocks all further calls for the day', async () => {
    const limiter = new Gb107RateLimiter(redis, 100, 0)
    await limiter.haltForDay(FAKE_NOW)

    expect(await limiter.isHalted(FAKE_NOW)).toBe(true)
    const refused = await limiter.acquire(FAKE_NOW)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe('halted')
  })

  it('reports remaining budget without consuming it', async () => {
    const limiter = new Gb107RateLimiter(redis, 5, 0)
    expect(await limiter.remaining(FAKE_NOW)).toBe(5)
    await limiter.acquire(FAKE_NOW)
    await limiter.acquire(FAKE_NOW)
    expect(await limiter.remaining(FAKE_NOW)).toBe(3)
  })

  it('enforces the burst gap between consecutive calls', async () => {
    const limiter = new Gb107RateLimiter(redis, 10, 120)
    const started = Date.now()
    await limiter.acquire(FAKE_NOW)
    await limiter.acquire(FAKE_NOW)
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })

  it('nextUtcMidnight rolls to the next day boundary', () => {
    expect(nextUtcMidnight(new Date('2020-06-15T23:59:59.000Z')).toISOString()).toBe(
      '2020-06-16T00:00:00.000Z',
    )
  })
})
