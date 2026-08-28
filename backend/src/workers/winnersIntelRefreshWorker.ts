// =============================================================
// Winners Intel Refresh Worker
//
// Weekly USAspending pull → WinnersAwardStage. Sundays at 04:00 UTC,
// chosen to land after the nightly DB backup (03:00 UTC) and before
// US business hours.
//
// SHIPS DORMANT: gated on ENABLE_WINNERS_INTEL=true env var. server.ts
// calls startWinnersIntelRefreshWorker unconditionally; this function
// is the gatekeeper. Until an operator sets the env var on the droplet,
// no queue is created, no worker runs, and no USAspending traffic is
// generated. This lets us land worker code without any production-
// behavior risk.
// =============================================================

import { Queue, Worker } from 'bullmq'
import { config } from '../config/config'
import { logger } from '../utils/logger'
import { runWinnersIntelRefresh } from '../services/winnersIntel/refresh'

const QUEUE_NAME = 'winners-intel-refresh'
const SCHEDULE = '0 4 * * 0'  // Sundays 04:00 UTC

function parseRedisUrl(url: string) {
  try {
    const u = new URL(url)
    return {
      host: u.hostname || 'localhost',
      port: parseInt(u.port || '6379', 10),
      password: u.password || undefined,
    }
  } catch {
    return { host: 'localhost', port: 6379 }
  }
}

function isFeatureEnabled(): boolean {
  return String(process.env.ENABLE_WINNERS_INTEL || '').toLowerCase() === 'true'
}

/**
 * Boot the worker. No-op when the feature flag is off.
 * Returns the Worker instance when started, null when dormant — callers
 * can pass the return value to disconnect on graceful shutdown.
 */
export function startWinnersIntelRefreshWorker(): Worker | null {
  if (!isFeatureEnabled()) {
    logger.info('Winners intel worker dormant (ENABLE_WINNERS_INTEL not set)')
    return null
  }

  const connection = parseRedisUrl(config.redis.url)
  const queue = new Queue(QUEUE_NAME, { connection })

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === 'weekly-refresh') {
        return runWinnersIntelRefresh()
      }
      throw new Error(`Unknown job: ${job.name}`)
    },
    { connection },
  )

  queue
    .add(
      'weekly-refresh',
      {},
      {
        repeat: { pattern: SCHEDULE },
        removeOnComplete: 20,
        removeOnFail: 20,
      },
    )
    .then(() => {
      logger.info('Winners intel refresh worker started', { schedule: SCHEDULE })
    })
    .catch((err) => {
      logger.error('Failed to schedule winners intel refresh', { error: err.message })
    })

  worker.on('completed', (job, result) => {
    logger.info('Winners intel refresh job complete', {
      jobId: job.id,
      // Result is the RefreshSummary from runWinnersIntelRefresh; log a slim
      // version to keep app.log scannable.
      status: (result as { status?: string })?.status,
      rowsUpserted: (result as { totalRowsUpserted?: number })?.totalRowsUpserted,
      durationMs: (result as { durationMs?: number })?.durationMs,
    })
  })
  worker.on('failed', (job, err) => {
    logger.error('Winners intel refresh job failed', { jobId: job?.id, error: err.message })
  })

  return worker
}

/**
 * Manual trigger for ops / testing. Bypasses the BullMQ schedule and
 * runs the refresh in-process. Still respects the feature flag — no
 * accidental production pulls.
 */
export async function triggerWinnersIntelRefresh() {
  if (!isFeatureEnabled()) {
    logger.warn('triggerWinnersIntelRefresh called but ENABLE_WINNERS_INTEL is not set')
    return { skipped: true, reason: 'feature_disabled' }
  }
  return runWinnersIntelRefresh()
}
