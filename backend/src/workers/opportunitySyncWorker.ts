// =============================================================
// Opportunity Sync Worker
// BullMQ cron: daily SAM.gov ingest so opportunity data stays fresh.
//
// Cron: 0 6 * * *  (06:00 UTC daily — before US business hours)
//
// Previously SAM.gov ingest was MANUAL-only (POST /api/jobs/ingest), which is
// why opportunity intelligence was "a single-date snapshot." This runs the same
// incremental ingest (samApi uses firm.lastIngestedAt as postedFrom, so each run
// only pulls postings since the last sync) for every firm with active clients,
// then enqueues scoring + client-match notifications — identical to the manual
// path in routes/jobs.ts.
// =============================================================
import { Queue, Worker } from 'bullmq'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { config } from '../config/config'
import { samApiService } from '../services/samApi'
import { enqueueAllOpportunitiesForScoring } from './scoringWorker'
import { enqueueClientMatchNotifications } from './clientMatchNotificationWorker'
import { isStaleIngestJob, STALE_INGEST_MS } from './ingestReaper'

const QUEUE_NAME = 'opportunity-sync'
const INGEST_LIMIT = 50 // per-firm postings per daily run; samApi fetches incrementally

function parseRedisUrl(url: string) {
  try {
    const u = new URL(url)
    return { host: u.hostname || 'localhost', port: parseInt(u.port || '6379', 10), password: u.password || undefined }
  } catch {
    return { host: 'localhost', port: 6379 }
  }
}
const connection = parseRedisUrl(config.redis.url)

export const opportunitySyncQueue = new Queue(QUEUE_NAME, { connection })

async function runScheduledSync() {
  const startMs = Date.now()
  logger.info('Scheduled opportunity sync started')

  // Only firms with at least one active client — scoring needs client profiles,
  // so syncing for client-less firms is wasted work (same bound the portfolio
  // and market-intel workers use).
  const firms = await prisma.consultingFirm.findMany({
    where: { isActive: true, clientCompanies: { some: { isActive: true } } },
    select: { id: true, name: true },
  })

  let totalIngested = 0
  for (const firm of firms) {
    // Don't overlap a manual/previous ingest still RUNNING for this firm —
    // UNLESS that RUNNING row is stale (orphaned by a process that died
    // mid-run). A stale row is reaped (marked FAILED) so the sync proceeds;
    // otherwise a single crash would freeze the firm's feed forever.
    const running = await prisma.ingestionJob.findFirst({
      where: { consultingFirmId: firm.id, type: 'INGEST', status: 'RUNNING' },
      select: { id: true, startedAt: true },
      orderBy: { startedAt: 'asc' },
    })
    if (running) {
      if (isStaleIngestJob(running.startedAt, Date.now())) {
        await prisma.ingestionJob
          .update({
            where: { id: running.id },
            data: {
              status: 'FAILED',
              completedAt: new Date(),
              errorDetail: `reaped stale RUNNING ingest (exceeded ${STALE_INGEST_MS / 3_600_000}h; orphaned by a dead process)`,
            },
          })
          .catch(() => {})
        logger.warn('Opportunity sync reaped stale RUNNING ingest — proceeding', {
          firmId: firm.id,
          staleJobId: running.id,
          staleStartedAt: running.startedAt,
        })
      } else {
        logger.info('Opportunity sync skip — ingest already running', { firmId: firm.id })
        continue
      }
    }

    const job = await prisma.ingestionJob.create({
      data: { consultingFirmId: firm.id, type: 'INGEST', status: 'RUNNING', startedAt: new Date() },
    })

    try {
      const stats: any = await samApiService.searchAndIngest({ limit: INGEST_LIMIT }, firm.id)
      const scoringCount = await enqueueAllOpportunitiesForScoring(firm.id)
      enqueueClientMatchNotifications(firm.id).catch((err: Error) =>
        logger.warn('enqueueClientMatchNotifications failed after scheduled sync', { firmId: firm.id, error: err.message }),
      )
      await prisma.ingestionJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETE',
          completedAt: new Date(),
          opportunitiesFound: stats.found || 0,
          opportunitiesNew: stats.ingested || 0,
          scoringJobsQueued: scoringCount,
          errors: stats.errors || 0,
        },
      })
      totalIngested += stats.ingested || 0
      logger.info('Firm opportunity sync complete', { firmId: firm.id, found: stats.found, ingested: stats.ingested })
    } catch (err) {
      const errorMsg = (err as Error).message
      await prisma.ingestionJob
        .update({ where: { id: job.id }, data: { status: 'FAILED', completedAt: new Date(), errorDetail: errorMsg } })
        .catch(() => {})
      logger.error('Firm opportunity sync failed (continuing)', { firmId: firm.id, error: errorMsg })
    }
  }

  logger.info('Scheduled opportunity sync complete', {
    firmsProcessed: firms.length,
    totalIngested,
    durationMs: Date.now() - startMs,
  })
  return { firmsProcessed: firms.length, totalIngested }
}

export function startOpportunitySyncWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === 'daily-sync') return runScheduledSync()
      throw new Error(`Unknown job: ${job.name}`)
    },
    { connection, concurrency: 1 },
  )

  // Daily at 06:00 UTC.
  opportunitySyncQueue
    .add('daily-sync', {}, { repeat: { pattern: '0 6 * * *' }, removeOnComplete: 14, removeOnFail: 14 })
    .then(() => logger.info('Opportunity sync worker started — schedule: 06:00 UTC daily'))
    .catch((err) => logger.error('Failed to schedule opportunity sync', { error: err.message }))

  worker.on('completed', (job, result) => logger.info('Opportunity sync job complete', { jobId: job.id, result }))
  worker.on('failed', (job, err) => logger.error('Opportunity sync job failed', { jobId: job?.id, error: err.message }))
  worker.on('error', (err) => logger.error('Opportunity sync worker error', { error: err.message }))

  return worker
}

// Manual trigger for ops / testing.
export async function triggerOpportunitySync() {
  return runScheduledSync()
}
