// =============================================================
// Backtest run reaper (Section 4 #5)
//
// A model backtest is tracked as a `BacktestRun` row that flips to
// COMPLETE / FAILED when the run finishes (services/backtest/historicalBacktest).
// If the backend process dies mid-run (deploy restart, OOM, power loss) the row
// is orphaned in RUNNING forever — the proposal observed a run stuck RUNNING for
// ~18 days. Unlike IngestionJob (see ingestReaper), BacktestRun had no timeout,
// stale detection, or cleanup, so stale RUNNING rows and old FAILED rows
// accumulated indefinitely.
//
// The pure predicate is dependency-free for trivial unit testing; the sweeps
// take an injectable `nowMs` so tests are deterministic.
// =============================================================

import { prisma } from '../config/database'
import { logger } from '../utils/logger'

/**
 * A healthy backtest completes well under the 30-minute HTTP cap on
 * POST /api/admin/backtest/run. Anything still RUNNING past this window is
 * assumed orphaned by a dead process and safe to reap.
 */
export const STALE_BACKTEST_MS = 60 * 60 * 1000 // 1 hour

/** Old FAILED runs are pruned after this window so they can't accumulate. */
export const FAILED_BACKTEST_RETENTION_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

/**
 * True when a RUNNING backtest should be reaped (marked FAILED). A missing
 * `startedAt` is treated as stale — a RUNNING row with no start time is already
 * inconsistent.
 */
export function isStaleBacktestRun(
  startedAt: Date | null | undefined,
  nowMs: number,
  staleMs: number = STALE_BACKTEST_MS,
): boolean {
  if (!startedAt) return true
  return nowMs - startedAt.getTime() > staleMs
}

/**
 * Mark every stale RUNNING backtest run as FAILED so it stops being counted as
 * in-flight. Returns the number reaped. COMPLETE runs (which may hold the active
 * calibration curve) are never touched.
 */
export async function reapStaleBacktestRuns(nowMs: number = Date.now()): Promise<number> {
  const cutoff = new Date(nowMs - STALE_BACKTEST_MS)
  const result = await prisma.backtestRun.updateMany({
    where: { status: 'RUNNING', startedAt: { lt: cutoff } },
    data: {
      status: 'FAILED',
      completedAt: new Date(nowMs),
      errorMessage: `reaped stale RUNNING backtest (exceeded ${STALE_BACKTEST_MS / 3_600_000}h; orphaned by a dead process)`,
    },
  })
  if (result.count > 0) {
    logger.warn('Reaped stale RUNNING backtest runs', { count: result.count })
  }
  return result.count
}

/**
 * Delete FAILED backtest runs older than the retention window so failures do not
 * accumulate unbounded. COMPLETE runs are retained (they carry calibration
 * history); only FAILED terminal rows are pruned.
 */
export async function cleanupOldFailedBacktestRuns(nowMs: number = Date.now()): Promise<number> {
  const cutoff = new Date(nowMs - FAILED_BACKTEST_RETENTION_MS)
  const result = await prisma.backtestRun.deleteMany({
    where: {
      status: 'FAILED',
      OR: [{ completedAt: { lt: cutoff } }, { completedAt: null, startedAt: { lt: cutoff } }],
    },
  })
  if (result.count > 0) {
    logger.info('Pruned old FAILED backtest runs', { count: result.count })
  }
  return result.count
}

/** Combined maintenance sweep for the hourly ops watchdog. */
export async function sweepBacktestRuns(nowMs: number = Date.now()): Promise<{ reaped: number; pruned: number }> {
  const reaped = await reapStaleBacktestRuns(nowMs)
  const pruned = await cleanupOldFailedBacktestRuns(nowMs)
  return { reaped, pruned }
}
