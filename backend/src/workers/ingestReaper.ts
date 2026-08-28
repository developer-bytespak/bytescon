// =============================================================
// Ingest job reaper
//
// A SAM.gov ingest is tracked as an `IngestionJob` row that flips to
// COMPLETE / FAILED when the run finishes. If the backend process dies
// mid-run (deploy restart, OOM, power loss) the row is orphaned in
// RUNNING forever. `opportunitySyncWorker`'s overlap guard skips any firm
// with a RUNNING ingest — so a single orphaned row silently freezes that
// firm's opportunity feed indefinitely (observed 2026-07-08: the Sandbox
// tenant went 6 days without fresh data).
//
// This pure predicate lets the guard treat a long-RUNNING job as stale and
// reap it instead of skipping. Kept dependency-free (no prisma / Redis) so
// it is trivially unit-testable.
// =============================================================

/**
 * A healthy ingest run completes in minutes. Anything still RUNNING past
 * this window is assumed orphaned by a dead process and safe to reap.
 */
export const STALE_INGEST_MS = 2 * 60 * 60 * 1000 // 2 hours

/**
 * True when a RUNNING ingest job should be reaped (marked FAILED) instead of
 * blocking the overlap guard. A missing `startedAt` is treated as stale — a
 * RUNNING row with no start time is already inconsistent.
 */
export function isStaleIngestJob(
  startedAt: Date | null | undefined,
  nowMs: number,
  staleMs: number = STALE_INGEST_MS,
): boolean {
  if (!startedAt) return true
  return nowMs - startedAt.getTime() > staleMs
}
