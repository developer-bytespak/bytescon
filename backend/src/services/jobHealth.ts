// =============================================================
// Job health — heartbeats + dead-man's switch for every scheduled
// job on the platform.
//
// Two failure modes killed observability historically:
//   1. a job RUNS and FAILS       → its BullMQ 'failed' handler only
//                                   logged; nothing paged anyone
//   2. a job STOPS RUNNING at all → nothing even logs (the 34-night
//                                   silent backup death)
//
// wireJobObservability() covers (1): success → JobHeartbeat upsert,
// failure → heartbeat + ops alert. The EXPECTED_JOBS registry +
// checkJobHeartbeats() cover (2): the ops watchdog alerts when a
// registered job hasn't succeeded inside its expected window —
// whether it's a BullMQ worker or a host script reporting through
// POST /api/ops/heartbeat (nightly backup).
// =============================================================

import { Worker } from 'bullmq'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { sendOpsAlert, AlertSeverity } from './alertService'

export async function recordJobSuccess(jobName: string): Promise<void> {
  try {
    await prisma.jobHeartbeat.upsert({
      where: { jobName },
      update: { lastSuccessAt: new Date(), lastError: null },
      create: { jobName, lastSuccessAt: new Date() },
    })
  } catch (err) {
    logger.error('recordJobSuccess failed', { jobName, error: (err as Error).message })
  }
}

export async function recordJobFailure(jobName: string, error: string): Promise<void> {
  try {
    await prisma.jobHeartbeat.upsert({
      where: { jobName },
      update: { lastFailureAt: new Date(), lastError: error.slice(0, 1000) },
      create: { jobName, lastFailureAt: new Date(), lastError: error.slice(0, 1000) },
    })
  } catch (err) {
    logger.error('recordJobFailure failed', { jobName, error: (err as Error).message })
  }
}

/**
 * Attach observability to a BullMQ worker: completed runs record a
 * heartbeat, failures record + alert (throttled per job by alertService).
 * heartbeat: false for demand-driven workers (scoring, enrichment, …) whose
 * cadence depends on traffic — they get failure alerts but no staleness
 * expectations. Listener-only: never changes worker lifecycle or behavior.
 */
export function wireJobObservability(
  worker: Worker,
  jobName: string,
  opts: { heartbeat?: boolean; severity?: AlertSeverity } = {},
): Worker {
  const heartbeat = opts.heartbeat !== false
  const severity = opts.severity ?? 'critical'

  worker.on('completed', () => {
    if (heartbeat) void recordJobSuccess(jobName)
  })
  worker.on('failed', (_job, err) => {
    const message = err?.message ?? 'unknown error'
    void recordJobFailure(jobName, message)
    void sendOpsAlert({
      key: `job-failed:${jobName}`,
      severity,
      title: `Background job failed: ${jobName}`,
      detail: message,
    })
  })
  worker.on('error', (err) => {
    void sendOpsAlert({
      key: `worker-error:${jobName}`,
      severity: 'warning',
      title: `Worker error: ${jobName}`,
      detail: err?.message,
    })
  })
  return worker
}

// -------------------------------------------------------------
// Dead-man's switch registry — every job that MUST keep running,
// with the window inside which a success is expected. Daily jobs
// get 26h (2h grace), twice-daily 14h, weekly 170h. Gated jobs are
// only watched while their feature flag is on.
// -------------------------------------------------------------

export interface ExpectedJob {
  jobName: string
  expectEveryHours: number
  enabled?: () => boolean
}

export const EXPECTED_JOBS: ExpectedJob[] = [
  { jobName: 'recalibration', expectEveryHours: 26 },
  { jobName: 'subcontract-maintenance', expectEveryHours: 26 },
  { jobName: 'opportunity-expiry', expectEveryHours: 26 },
  { jobName: 'opportunity-sync', expectEveryHours: 26 },
  { jobName: 'portfolio-scoring', expectEveryHours: 14 },
  { jobName: 'deadline-notifications', expectEveryHours: 26 },
  { jobName: 'stripe-rotation-reminder', expectEveryHours: 26 },
  { jobName: 'watchlist-digest', expectEveryHours: 170 },
  { jobName: 'market-intel-refresh', expectEveryHours: 170 },
  // Host script — reports via POST /api/ops/heartbeat/nightly-backup.
  // Watched unconditionally: if the script or its token was never set up,
  // the staleness alert IS the reminder to finish the setup.
  { jobName: 'nightly-backup', expectEveryHours: 26 },
  // §7.0 — the agent runtime ticks every minute; 2h is generous grace while
  // still catching a runtime that has genuinely stopped scheduling.
  { jobName: 'agent-runtime', expectEveryHours: 2 },
  {
    jobName: 'client-match-notifications',
    expectEveryHours: 26,
    enabled: () => String(process.env.CLIENT_NOTIFICATIONS_ENABLED || '').toLowerCase() === 'true',
  },
  {
    jobName: 'winners-intel-refresh',
    expectEveryHours: 170,
    enabled: () => String(process.env.ENABLE_WINNERS_INTEL || '').toLowerCase() === 'true',
  },
]

export interface StaleJob {
  jobName: string
  hoursSinceSuccess: number | null
  lastError: string | null
}

/**
 * Alert for every registered job whose last success is outside its window.
 * A job with no row yet gets a placeholder so a fresh deployment has one
 * full window to produce its first success before alerting. Returns the
 * stale list (also used by GET /api/ops/status and tests).
 */
export async function checkJobHeartbeats(
  registry: ExpectedJob[] = EXPECTED_JOBS,
  now: Date = new Date(),
): Promise<StaleJob[]> {
  const stale: StaleJob[] = []

  for (const expected of registry) {
    if (expected.enabled && !expected.enabled()) continue

    let row = await prisma.jobHeartbeat.findUnique({ where: { jobName: expected.jobName } })
    if (!row) {
      row = await prisma.jobHeartbeat
        .create({ data: { jobName: expected.jobName } })
        .catch(() => null)
      continue // grace: one full window from first sighting
    }

    const reference = row.lastSuccessAt ?? row.createdAt
    const ageHours = (now.getTime() - reference.getTime()) / 3_600_000
    if (ageHours <= expected.expectEveryHours) continue

    const hoursSinceSuccess = row.lastSuccessAt ? Math.round(ageHours) : null
    stale.push({ jobName: expected.jobName, hoursSinceSuccess, lastError: row.lastError })

    void sendOpsAlert({
      key: `job-stale:${expected.jobName}`,
      severity: 'critical',
      title: row.lastSuccessAt
        ? `Scheduled job silent for ${Math.round(ageHours)}h: ${expected.jobName}`
        : `Scheduled job has NEVER succeeded: ${expected.jobName}`,
      detail: [
        `expected at least every ${expected.expectEveryHours}h`,
        row.lastSuccessAt ? `last success: ${row.lastSuccessAt.toISOString()}` : 'no success ever recorded',
        row.lastFailureAt ? `last failure: ${row.lastFailureAt.toISOString()}` : null,
        row.lastError ? `last error: ${row.lastError}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    })
  }

  if (stale.length > 0) {
    logger.warn('Ops watchdog found stale jobs', { jobs: stale.map((s) => s.jobName) })
  }
  return stale
}
