// =============================================================
// isStaleIngestJob — guards the overlap-skip so a crash-orphaned RUNNING
// ingest can't freeze a firm's SAM feed forever (regression: 2026-07-08).
// =============================================================
import { describe, it, expect } from 'vitest'
import { isStaleIngestJob, STALE_INGEST_MS } from './ingestReaper'

describe('isStaleIngestJob', () => {
  const now = Date.UTC(2026, 6, 8, 12, 0, 0) // 2026-07-08T12:00:00Z

  it('treats a null/undefined startedAt as stale (inconsistent RUNNING row)', () => {
    expect(isStaleIngestJob(null, now)).toBe(true)
    expect(isStaleIngestJob(undefined, now)).toBe(true)
  })

  it('is NOT stale for a recently-started run (within the window)', () => {
    const fiveMinAgo = new Date(now - 5 * 60 * 1000)
    expect(isStaleIngestJob(fiveMinAgo, now)).toBe(false)
  })

  it('is NOT stale exactly at the threshold boundary', () => {
    const atThreshold = new Date(now - STALE_INGEST_MS)
    expect(isStaleIngestJob(atThreshold, now)).toBe(false)
  })

  it('is stale once older than the threshold', () => {
    const justOver = new Date(now - STALE_INGEST_MS - 1)
    expect(isStaleIngestJob(justOver, now)).toBe(true)
  })

  it('reaps the real-world orphan (RUNNING for ~6 days)', () => {
    const sixDaysAgo = new Date(now - 6 * 24 * 60 * 60 * 1000)
    expect(isStaleIngestJob(sixDaysAgo, now)).toBe(true)
  })

  it('honors a custom staleMs override', () => {
    const tenMinAgo = new Date(now - 10 * 60 * 1000)
    expect(isStaleIngestJob(tenMinAgo, now, 5 * 60 * 1000)).toBe(true)
    expect(isStaleIngestJob(tenMinAgo, now, 30 * 60 * 1000)).toBe(false)
  })
})
