// =============================================================
// Opportunity Expiry Worker
// BullMQ cron: daily at 05:00 UTC (before the 06:00 SAM sync).
//
// Ages opportunities whose response deadline has passed from ACTIVE to
// EXPIRED. Nothing else in the pipeline sets EXPIRED, so historically every
// opportunity stayed ACTIVE forever (~89% of the board was expired but still
// counted "active"). Because search filters status=ACTIVE and ranks by
// responseDeadline asc, that stale backlog buried genuinely-open work and
// inflated the "overdue" KPI. This sweep keeps the ACTIVE set to what is
// actually still open.
//
// Cross-firm by design: this is a time-based maintenance transition, not a
// tenant data access, mirroring recalibrationWorker's firm-wide sweep. The
// first run after deploy clears the whole backlog in one updateMany; steady
// state touches only the day's newly-passed deadlines.
// =============================================================
import { Worker, Queue, Job } from 'bullmq'
import { redis } from '../config/redis'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'

export const OPPORTUNITY_EXPIRY_QUEUE_NAME = 'opportunity-expiry'

export const opportunityExpiryQueue = new Queue(OPPORTUNITY_EXPIRY_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 30000 },
    removeOnComplete: 5,
    removeOnFail: 10,
  },
})

/**
 * Transition ACTIVE opportunities whose responseDeadline is in the past to
 * EXPIRED. Returns the number of rows aged. Only ACTIVE rows are touched —
 * ARCHIVED / AWARDED are left untouched.
 */
export async function ageExpiredOpportunities(now: Date = new Date()): Promise<number> {
  const result = await prisma.opportunity.updateMany({
    where: { status: 'ACTIVE', responseDeadline: { lt: now } },
    data: { status: 'EXPIRED' },
  })
  if (result.count > 0) {
    logger.info('Opportunity expiry sweep aged opportunities', { expired: result.count })
  }
  return result.count
}

/**
 * Auto-pass REVIEWING bid pursuits whose opportunity deadline lapsed more
 * than 7 days ago. The firm never declared submitted/passed, so the pursuit
 * is closed as a PASSED no-bid (source AUTO_EXPIRED) — this keeps the
 * dashboard widget bounded and gives the calibration data a deliberate
 * "did not bid" label instead of an eternal maybe.
 */
export async function autoPassStalePursuits(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const result = await prisma.bidPursuit.updateMany({
    where: {
      status: 'REVIEWING',
      opportunity: { responseDeadline: { lt: cutoff } },
    },
    data: { status: 'PASSED', source: 'AUTO_EXPIRED', decidedAt: now },
  })
  if (result.count > 0) {
    logger.info('Pursuit sweep auto-passed stale pursuits', { autoPassed: result.count })
  }
  return result.count
}

export function startOpportunityExpiryWorker(): Worker {
  const worker = new Worker(
    OPPORTUNITY_EXPIRY_QUEUE_NAME,
    async (_job: Job) => {
      const count = await ageExpiredOpportunities()
      const autoPassed = await autoPassStalePursuits()
      return { expired: count, autoPassed }
    },
    { connection: redis, concurrency: 1 },
  )

  // Daily at 05:00 UTC.
  opportunityExpiryQueue
    .add('age-expired', {}, { repeat: { pattern: '0 5 * * *' }, removeOnComplete: 5 })
    .catch((err) => logger.error('Failed to schedule opportunity expiry', { error: err.message }))

  // One-off run on startup so the existing backlog is cleared promptly after a
  // deploy instead of waiting for the next 05:00 window.
  opportunityExpiryQueue
    .add('age-expired', {}, { removeOnComplete: 5 })
    .catch((err) => logger.error('Failed to enqueue startup opportunity expiry', { error: err.message }))

  worker.on('completed', (job, result) =>
    logger.info('Opportunity expiry job complete', { jobId: job.id, result }),
  )
  worker.on('failed', (job, err) =>
    logger.error('Opportunity expiry job failed', { jobId: job?.id, error: err.message }),
  )
  worker.on('error', (err) => logger.error('Opportunity expiry worker error', { error: err.message }))

  logger.info('Opportunity expiry worker started — schedule: 05:00 UTC daily')
  return worker
}
