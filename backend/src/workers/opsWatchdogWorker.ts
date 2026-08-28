// =============================================================
// Ops watchdog — hourly dead-man's-switch sweep over the
// EXPECTED_JOBS registry (services/jobHealth). Alerts when any
// registered job hasn't succeeded inside its expected window.
//
// The watchdog can't watch itself: if this worker (or the whole
// backend container) dies, /health stops answering — external
// uptime monitoring on https://bytescon.com/health is the layer
// above this one. It still records its own heartbeat so
// GET /api/ops/status shows when the last sweep ran.
// =============================================================

import { Worker, Queue } from 'bullmq'
import { redis as connection } from '../config/redis'
import { logger } from '../utils/logger'
import { checkJobHeartbeats, recordJobSuccess, wireJobObservability } from '../services/jobHealth'
import { sweepBacktestRuns } from './backtestReaper'

const QUEUE_NAME = 'ops-watchdog'

export const opsWatchdogQueue = new Queue(QUEUE_NAME, { connection })

export function startOpsWatchdogWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name !== 'heartbeat-sweep') throw new Error(`Unknown job: ${job.name}`)
      const stale = await checkJobHeartbeats()
      // Section 4 #5: recover backtest runs orphaned in RUNNING and prune old
      // FAILED rows so stale jobs cannot accumulate. Never blocks the heartbeat
      // sweep — a failure here is logged but does not fail the whole job.
      const backtest = await sweepBacktestRuns().catch((err) => {
        logger.error('Backtest reaper sweep failed', { error: (err as Error).message })
        return { reaped: 0, pruned: 0 }
      })
      await recordJobSuccess('ops-watchdog')
      return {
        checked: true,
        staleCount: stale.length,
        stale: stale.map((s) => s.jobName),
        backtestReaped: backtest.reaped,
        backtestPruned: backtest.pruned,
      }
    },
    { connection, concurrency: 1 },
  )

  // Hourly at :15 — offset from the platform's on-the-hour cron jobs so the
  // sweep never races a job that is just starting its scheduled run.
  opsWatchdogQueue
    .add('heartbeat-sweep', {}, { repeat: { pattern: '15 * * * *' }, removeOnComplete: 48, removeOnFail: 48 })
    .then(() => logger.info('Ops watchdog started — hourly heartbeat sweep at :15'))
    .catch((err) => logger.error('Failed to schedule ops watchdog', { error: err.message }))

  worker.on('failed', (job, err) => logger.error('Ops watchdog sweep failed', { jobId: job?.id, error: err.message }))
  worker.on('error', (err) => logger.error('Ops watchdog worker error', { error: err.message }))

  // No heartbeat expectation on itself (it can't report its own death), but
  // a sweep that RUNS and FAILS should still page like any other job.
  wireJobObservability(worker, 'ops-watchdog', { heartbeat: false })

  return worker
}
