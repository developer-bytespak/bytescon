// =============================================================
// GB-103 Client Match Notification Worker — BullMQ
//
// Two entry points:
//   - Per-firm job ({ consultingFirmId }) enqueued from the
//     post-ingestion hook, so a fresh ingest notifies clients promptly.
//   - A repeatable sweep (no firm) as a safety net across all firms,
//     aligned to the daily ingestion cadence.
//
// All gating is via CLIENT_NOTIFICATIONS_ENABLED (default off in prod):
// when off, the repeatable job is not registered, the enqueue helper is
// a no-op, and the service itself early-returns. The idempotency ledger
// makes overlapping triggers safe.
// =============================================================
import { Worker, Queue, Job } from 'bullmq'
import { redis } from '../config/redis'
import { logger } from '../utils/logger'
import {
  runClientMatchNotifications,
  isClientNotificationsEnabled,
} from '../services/clientMatchNotificationService'

export const CLIENT_MATCH_NOTIFICATION_QUEUE_NAME = 'client-match-notification'

export interface ClientMatchNotificationJobData {
  /** Process a single firm; omit for the all-firms sweep. */
  consultingFirmId?: string
}

export const clientMatchNotificationQueue = new Queue<ClientMatchNotificationJobData>(
  CLIENT_MATCH_NOTIFICATION_QUEUE_NAME,
  {
    connection: redis,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 30000 },
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  },
)

/**
 * Enqueue a per-firm match-diff job. No-op when the feature flag is off
 * (so disabling the flag stops the enqueue, per §C.7).
 */
export async function enqueueClientMatchNotifications(consultingFirmId: string): Promise<boolean> {
  if (!isClientNotificationsEnabled()) return false
  await clientMatchNotificationQueue.add(
    'firm-match-diff',
    { consultingFirmId },
    { jobId: `match-diff:${consultingFirmId}:${Date.now()}` },
  )
  return true
}

export function startClientMatchNotificationWorker(): Worker<ClientMatchNotificationJobData> {
  const worker = new Worker<ClientMatchNotificationJobData>(
    CLIENT_MATCH_NOTIFICATION_QUEUE_NAME,
    async (job: Job<ClientMatchNotificationJobData>) => {
      await runClientMatchNotifications({ consultingFirmId: job.data.consultingFirmId })
    },
    { connection: redis, concurrency: 1 },
  )

  // Repeatable all-firms sweep — only when the feature is enabled, so the
  // flag is the single off-switch. Daily at 13:30 UTC, just after the
  // typical ingestion window.
  if (isClientNotificationsEnabled()) {
    clientMatchNotificationQueue
      .add('daily-match-sweep', {}, { repeat: { pattern: '30 13 * * *' }, removeOnComplete: 10 })
      .catch(() => { /* repeat job already exists */ })
  }

  worker.on('completed', (job) => {
    logger.info('Client match notification job completed', { jobId: job.id })
  })
  worker.on('failed', (job, err) => {
    logger.error('Client match notification job failed', { jobId: job?.id, error: err.message })
  })
  worker.on('error', (err) => {
    logger.error('Client match notification worker error', { error: err.message })
  })

  logger.info('Client match notification worker started', {
    enabled: isClientNotificationsEnabled(),
  })
  return worker
}
