// =============================================================
// Ingest warm-up cooldown guard
// -------------------------------------------------------------
// The auto-warm paths (client creation + the all-tiers market preview) trigger
// background BigQuery ingests for a client's NAICS codes. Without a guard,
// concurrent loads / hard refreshes / a second user in the same firm could each
// fire a full ingest for the same NAICS set before the first completes. Because
// ingestion is append-only, that double-inserts rows and inflates SUM(awardAmount)
// / COUNT(*) aggregates — making the headline market numbers look wrong.
//
// This is an in-memory, single-process cooldown (fine for the current
// single-replica backend). Keyed by the sorted, de-duped NAICS set.
// =============================================================

const lastWarm = new Map<string, number>()
const COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Returns true at most once per NAICS set per cooldown window. Call this
 * immediately before kicking a background warm-up ingest; only proceed if it
 * returns true.
 */
export function claimIngestWarm(naicsCodes: string[]): boolean {
  const key = [...new Set(naicsCodes)].sort().join(',')
  if (!key) return false

  const now = Date.now()
  const prev = lastWarm.get(key) ?? 0
  if (now - prev < COOLDOWN_MS) return false

  lastWarm.set(key, now)

  // Opportunistic cleanup so the map can't grow unbounded over a long uptime.
  if (lastWarm.size > 500) {
    for (const [k, t] of lastWarm) {
      if (now - t > COOLDOWN_MS) lastWarm.delete(k)
    }
  }
  return true
}
