// =============================================================
// §6 — Section 6 background worker.
//
// One worker with four named repeatable jobs, so scheduling, retry, timeout,
// failure state and shutdown all live in one place:
//
//   source-sync        hourly   §6.1A  run every enabled, due source
//   discovery-intel    6-hourly §6.1B/C/E/F  forecast linking, re-compete
//                                      detection, match + eligibility refresh,
//                                      incumbent/competitor evidence
//   profile-alerts     15-min   §6.1G  evaluate due saved profiles
//   milestone-reminders hourly  §6.3F/§6.4D milestone reminders, escalations,
//                                      overdue requirement notices, calibration
//                                      staleness
//
// Every job is idempotent (the services own their dedupe keys), records real
// counters in the logs, and never lets one firm's failure abort the batch.
// =============================================================
import { Worker, Queue, Job } from 'bullmq'
import { redis } from '../config/redis'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { runSourceSync } from '../services/discovery/sourceSync'
import { linkForecastsToSolicitations } from '../services/discovery/forecastIngest'
import { detectRecompetes } from '../services/discovery/recompeteDetection'
import { refreshFirmMatches } from '../services/discovery/matchRefresh'
import { evaluateDueProfiles } from '../services/discovery/profileAlerts'
import { refreshIncumbentRetention, refreshCompetitorStats } from '../services/scoring/evidenceStats'
import { markStaleCalibrations } from '../services/scoring/tenantCalibration'
import { runReminderScan } from '../services/milestones/reminderEngine'
import { notifyDueFollowUps } from '../services/crm/followUpReminders'
import { notifyOverdueRequirements } from '../services/requirements/requirementWorkflow'

export const SECTION6_QUEUE_NAME = 'section6-jobs'

export const SOURCE_SYNC_JOB = 'source-sync'
export const DISCOVERY_INTEL_JOB = 'discovery-intel'
export const PROFILE_ALERTS_JOB = 'profile-alerts'
export const MILESTONE_REMINDERS_JOB = 'milestone-reminders'

export const section6Queue = new Queue(SECTION6_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    // Bounded retry with backoff; a permanently failing job stops rather than
    // looping forever.
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 25,
    removeOnFail: 25,
  },
})

/** Hard per-job budget so one bad provider cannot occupy the worker. */
const JOB_TIMEOUT_MS = 10 * 60 * 1000

async function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its ${JOB_TIMEOUT_MS}ms budget`)), JOB_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// -------------------------------------------------------------
// §6.1A — source sync
// -------------------------------------------------------------

export async function runSourceSyncJob(now: Date = new Date()): Promise<{ sourcesRun: number; failures: number }> {
  const due = await prisma.opportunitySourceConfig.findMany({
    where: {
      isEnabled: true,
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
      // Back off a source that has failed repeatedly rather than hammering it.
      consecutiveFailures: { lt: 10 },
    },
    select: { id: true, consultingFirmId: true, adapterKey: true },
    orderBy: { nextRunAt: 'asc' },
    take: 50,
  })

  let failures = 0
  for (const config of due) {
    try {
      const outcome = await runSourceSync(config.consultingFirmId, config.id, { now })
      logger.info('Section 6 source sync complete', {
        adapterKey: config.adapterKey, status: outcome.status,
        fetched: outcome.recordsFetched, created: outcome.recordsCreated, updated: outcome.recordsUpdated,
      })
    } catch (err) {
      failures++
      logger.error('Section 6 source sync failed', { sourceConfigId: config.id, adapterKey: config.adapterKey, error: (err as Error).message })
    }
  }
  return { sourcesRun: due.length, failures }
}

// -------------------------------------------------------------
// §6.1B/C/E/F + §6.2C/D — discovery intelligence refresh
// -------------------------------------------------------------

export async function runDiscoveryIntelJob(): Promise<{ firms: number; failures: number }> {
  const firms = await prisma.consultingFirm.findMany({
    where: { isActive: true, isTest: false },
    select: { id: true },
    take: 200,
  })

  let failures = 0
  for (const firm of firms) {
    try {
      const [linked, recompetes, matches, retention, competitors] = await Promise.all([
        linkForecastsToSolicitations(firm.id),
        detectRecompetes(firm.id),
        refreshFirmMatches(firm.id, { limit: 200 }),
        refreshIncumbentRetention(firm.id),
        refreshCompetitorStats(firm.id),
      ])
      logger.info('Section 6 discovery intel refreshed', {
        firmId: firm.id,
        forecastsAutoLinked: linked.autoLinked,
        forecastsForReview: linked.flaggedForReview,
        recompetesCreated: recompetes.created,
        matchesRefreshed: matches.refreshed,
        incumbentsWithRate: retention.withRate,
        competitorsWithShare: competitors.withAwardShare,
      })
    } catch (err) {
      failures++
      logger.error('Section 6 discovery intel failed for firm (continuing)', { firmId: firm.id, error: (err as Error).message })
    }
  }
  return { firms: firms.length, failures }
}

// -------------------------------------------------------------
// §6.1G — saved-profile alerts
// -------------------------------------------------------------

export async function runProfileAlertsJob(): Promise<{ evaluated: number; newAlerts: number; reAlerts: number; failures: number }> {
  const result = await evaluateDueProfiles({ batchSize: 100 })
  logger.info('Section 6 profile alerts evaluated', result)
  return { evaluated: result.evaluated, newAlerts: result.totalNewAlerts, reAlerts: result.totalReAlerts, failures: result.failures }
}

// -------------------------------------------------------------
// §6.3F + §6.4D — reminders, escalations, calibration staleness
// -------------------------------------------------------------

export async function runMilestoneRemindersJob(): Promise<{
  remindersSent: number
  escalations: number
  overdueRequirements: number
  staleCalibrations: number
  crmFollowUps: number
}> {
  const reminders = await runReminderScan()
  const requirements = await notifyOverdueRequirements()
  // §8.1 — CRM follow-ups ride this existing scan rather than adding a worker.
  const crmFollowUps = await notifyDueFollowUps()
  // Aged calibrations stop being applied rather than silently going stale.
  const staleCalibrations = await markStaleCalibrations()

  logger.info('Section 6 reminder scan complete', {
    scanned: reminders.scanned,
    remindersSent: reminders.remindersSent,
    escalations: reminders.escalations,
    suppressed: reminders.suppressed,
    overdueRequirementsNotified: requirements.notified,
    staleCalibrations,
    crmFollowUpsNotified: crmFollowUps.notified,
  })

  return {
    remindersSent: reminders.remindersSent,
    escalations: reminders.escalations,
    overdueRequirements: requirements.notified,
    staleCalibrations,
    crmFollowUps: crmFollowUps.notified,
  }
}

// -------------------------------------------------------------
// Worker
// -------------------------------------------------------------

export function startSection6Worker(): Worker {
  const worker = new Worker(
    SECTION6_QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case SOURCE_SYNC_JOB: return withTimeout(SOURCE_SYNC_JOB, runSourceSyncJob())
        case DISCOVERY_INTEL_JOB: return withTimeout(DISCOVERY_INTEL_JOB, runDiscoveryIntelJob())
        case PROFILE_ALERTS_JOB: return withTimeout(PROFILE_ALERTS_JOB, runProfileAlertsJob())
        case MILESTONE_REMINDERS_JOB: return withTimeout(MILESTONE_REMINDERS_JOB, runMilestoneRemindersJob())
        default:
          logger.warn('Unknown Section 6 job name — ignoring', { jobName: job.name })
          return null
      }
    },
    { connection: redis, concurrency: 1 },
  )

  // Repeatable schedules. Re-adding an existing repeat key is a no-op, so a
  // restart never duplicates the schedule.
  const schedules: Array<[string, string]> = [
    [SOURCE_SYNC_JOB, '5 * * * *'],          // hourly at :05
    [DISCOVERY_INTEL_JOB, '20 */6 * * *'],   // every 6 hours at :20
    [PROFILE_ALERTS_JOB, '*/15 * * * *'],    // every 15 minutes
    [MILESTONE_REMINDERS_JOB, '35 * * * *'], // hourly at :35
  ]
  for (const [name, pattern] of schedules) {
    section6Queue
      .add(name, {}, { repeat: { pattern }, removeOnComplete: 25 })
      .catch(() => { /* the repeatable job already exists */ })
  }

  worker.on('completed', (job) => {
    logger.info('Section 6 job completed', { jobId: job.id, jobName: job.name })
  })
  worker.on('failed', (job, err) => {
    logger.error('Section 6 job failed', { jobId: job?.id, jobName: job?.name, attempt: job?.attemptsMade, error: err.message })
  })
  worker.on('error', (err) => {
    logger.error('Section 6 worker error', { error: err.message })
  })

  logger.info('Section 6 worker started', {
    jobs: schedules.map(([name, pattern]) => `${name} (${pattern})`),
  })
  return worker
}
