// =============================================================
// Market Intelligence Refresh Worker
// Auto-refreshes the BigQuery award_history table weekly so the
// /analytics dashboard stays current without manual intervention.
//
// Cron: 0 4 * * 0  (Sundays at 04:00 UTC)
//   - Low-traffic window
//   - 1h after the nightly DB backup at 03:00 UTC
//   - Before US business hours
//
// USAspending records federal contract awards with significant lag
// (typically 1–4 weeks after the action date), so a weekly cadence
// captures everything the API has without wasting BigQuery storage
// on duplicate inserts. The ingestionService adds rows with fresh
// UUIDs per call (no upsert key), so each weekly run accumulates
// new rows alongside historical ones.
// =============================================================

import { Queue, Worker } from 'bullmq'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { config } from '../config/config'
import { ensureBigQueryDataset } from '../config/bigquery'
import { ingestBulkNaics } from '../services/bigquery/ingestionService'

const QUEUE_NAME = 'market-intelligence-refresh'

// Per-run knobs. maxPages=5 × 100 results × N unique NAICS gives a
// reasonable refresh size without exhausting USAspending rate limits
// on a single Sunday-night run. yearsBack=5 matches the snapshot's
// default window.
const MAX_PAGES_PER_NAICS = 5
const YEARS_BACK = 5

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
const connection = parseRedisUrl(config.redis.url)

const queue = new Queue(QUEUE_NAME, { connection })

// -------------------------------------------------------------
// Job: weekly-refresh
// Collects every unique NAICS code referenced by an active client at
// any active firm, then runs the bulk USAspending → BigQuery ingest.
// -------------------------------------------------------------
async function runWeeklyRefresh() {
  logger.info('Market intelligence refresh started')
  const startMs = Date.now()

  try {
    await ensureBigQueryDataset()
  } catch (err) {
    logger.error('Market intelligence refresh: BigQuery dataset check failed', {
      error: (err as Error).message,
    })
    return { skipped: true, reason: 'bigquery_unavailable' }
  }

  // Pull every NAICS used by an active client at an active firm.
  // BigQuery award_history is firm-agnostic (the same NAICS row is
  // valuable to every firm tracking that code), so we deduplicate
  // globally before kicking off ingest.
  const clients = await prisma.clientCompany.findMany({
    where: {
      isActive: true,
      consultingFirm: { isActive: true },
    },
    select: { naicsCodes: true },
  })

  const uniqueNaics = [
    ...new Set(
      clients
        .flatMap((c) => c.naicsCodes ?? [])
        .map((code) => (typeof code === 'string' ? code.trim() : ''))
        .filter((code) => code.length >= 4),
    ),
  ]

  if (uniqueNaics.length === 0) {
    logger.info('Market intelligence refresh: no NAICS codes to refresh — skipping')
    return { skipped: true, reason: 'no_naics' }
  }

  logger.info('Market intelligence refresh: ingesting', {
    naicsCount: uniqueNaics.length,
    maxPages: MAX_PAGES_PER_NAICS,
    yearsBack: YEARS_BACK,
  })

  try {
    const results = await ingestBulkNaics(uniqueNaics, {
      maxPages: MAX_PAGES_PER_NAICS,
      yearsBack: YEARS_BACK,
    })

    const totalInserted = results.reduce((sum, r) => sum + (r.rowsInserted ?? 0), 0)
    const totalSkipped = results.reduce((sum, r) => sum + (r.skipped ?? 0), 0)
    const elapsedMs = Date.now() - startMs

    logger.info('Market intelligence refresh complete', {
      naicsCount: uniqueNaics.length,
      totalInserted,
      totalSkipped,
      elapsedMs,
    })
    return { skipped: false, naicsCount: uniqueNaics.length, totalInserted, totalSkipped, elapsedMs }
  } catch (err) {
    logger.error('Market intelligence refresh failed', {
      error: (err as Error).message,
      naicsCount: uniqueNaics.length,
    })
    return { skipped: false, error: (err as Error).message }
  }
}

// -------------------------------------------------------------
// Worker boot
// -------------------------------------------------------------
export function startMarketIntelligenceRefreshWorker() {
  const worker = new Worker(QUEUE_NAME, async (job) => {
    if (job.name === 'weekly-refresh') {
      return runWeeklyRefresh()
    }
    throw new Error(`Unknown job: ${job.name}`)
  }, { connection })

  // Sundays at 04:00 UTC.
  queue.add(
    'weekly-refresh',
    {},
    {
      repeat: { pattern: '0 4 * * 0' },
      removeOnComplete: 20,
      removeOnFail: 20,
    }
  ).then(() => {
    logger.info('Market intelligence refresh worker started (Sundays at 04:00 UTC)')
  }).catch(err => {
    logger.error('Failed to schedule market intelligence refresh', { error: err.message })
  })

  worker.on('completed', (job, result) => {
    logger.info('Market intelligence refresh job complete', { jobId: job.id, result })
  })
  worker.on('failed', (job, err) => {
    logger.error('Market intelligence refresh job failed', { jobId: job?.id, error: err.message })
  })

  return worker
}

// Manual trigger for ops / testing.
export async function triggerMarketIntelligenceRefresh() {
  return runWeeklyRefresh()
}
