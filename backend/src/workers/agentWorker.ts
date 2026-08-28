// =============================================================
// §7.0 — Agent runtime worker.
//
// ONE queue and ONE worker for all nine agents. Nine queues would mean nine sets
// of repeatables, nine failure handlers, nine heartbeat registrations and nine
// shutdown closes — the exact "nine frameworks" failure mode this slice exists
// to avoid. Per-agent visibility comes from job names and metric labels instead,
// at no structural cost.
//
// Named jobs:
//   dispatch  execute one AgentRun (payload: { runId })
//   tick      scheduler pass + outbox drain (repeatable, every minute)
//   reaper    stale-run cleanup + stuck-event release (repeatable, every 5 min)
//
// Built on the section6Worker template: bounded retries with exponential
// backoff, a hard per-job timeout, per-item try/catch so one tenant never aborts
// a batch, and repeatable registration that is a safe no-op on restart.
// =============================================================
import { Worker, Queue, Job } from 'bullmq'
import { redis } from '../config/redis'
import { logger } from '../utils/logger'
import { dispatchAgentRun, AgentRetryableError } from '../services/agents/dispatch'
import { runAgentScheduler } from '../services/agents/scheduler'
import { processOutbox, releaseStuckEvents } from '../services/agents/outbox'
import { reapStaleAgentRuns } from '../services/agents/reaper'

export const AGENT_QUEUE_NAME = 'agent-runtime'

export const AGENT_DISPATCH_JOB = 'dispatch'
export const AGENT_TICK_JOB = 'tick'
export const AGENT_REAPER_JOB = 'reaper'

export const agentQueue = new Queue(AGENT_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 50,
    removeOnFail: 50,
  },
})

/** Ceiling for the runtime's own housekeeping jobs. Individual agent runs carry
 *  their own timeoutMs, enforced inside dispatchAgentRun. */
const HOUSEKEEPING_TIMEOUT_MS = 5 * 60 * 1000

const WORKER_ID = `agent-worker-${process.pid}`

async function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its ${HOUSEKEEPING_TIMEOUT_MS}ms budget`)), HOUSEKEEPING_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Enqueues one run for execution. Safe to call twice — dispatch itself is
 *  idempotent via the run's compare-and-set claim. */
export async function enqueueAgentRun(runId: string, delayMs = 0): Promise<void> {
  await agentQueue.add(
    AGENT_DISPATCH_JOB,
    { runId },
    { jobId: `run:${runId}`, delay: delayMs, removeOnComplete: 50, removeOnFail: 50 },
  )
}

// -------------------------------------------------------------
// tick — scheduler + outbox
// -------------------------------------------------------------

export async function runAgentTickJob(now: Date = new Date()): Promise<{
  scheduled: number
  eventsProcessed: number
  runsFromEvents: number
  enqueued: number
}> {
  const scheduler = await runAgentScheduler(now)
  const outbox = await processOutbox(WORKER_ID, 20, now)

  // Every run either side created is queued for the same worker to execute.
  const runIds = [...scheduler.runIds]
  if (outbox.runsCreated > 0) {
    const { prisma } = await import('../config/database')
    const pending = await prisma.agentRun.findMany({
      where: { status: 'QUEUED', triggerType: 'EVENT' },
      select: { id: true },
      take: 100,
    })
    runIds.push(...pending.map((r) => r.id))
  }

  let enqueued = 0
  for (const runId of new Set(runIds)) {
    try {
      await enqueueAgentRun(runId)
      enqueued++
    } catch (err) {
      logger.error('Failed to enqueue agent run', { runId, error: (err as Error).message })
    }
  }

  return {
    scheduled: scheduler.runsCreated,
    eventsProcessed: outbox.processed,
    runsFromEvents: outbox.runsCreated,
    enqueued,
  }
}

// -------------------------------------------------------------
// reaper
// -------------------------------------------------------------

export async function runAgentReaperJob(now: Date = new Date()): Promise<{ reaped: number; eventsReleased: number }> {
  const runs = await reapStaleAgentRuns(now)
  const eventsReleased = await releaseStuckEvents(5 * 60_000, now)
  return { reaped: runs.reaped, eventsReleased }
}

// -------------------------------------------------------------
// Worker
// -------------------------------------------------------------

export function startAgentWorker(): Worker {
  const worker = new Worker(
    AGENT_QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case AGENT_DISPATCH_JOB: {
          const runId = (job.data as { runId?: string })?.runId
          if (!runId) {
            logger.warn('Agent dispatch job with no runId — ignoring', { jobId: job.id })
            return null
          }
          return dispatchAgentRun(runId)
        }
        case AGENT_TICK_JOB:
          return withTimeout(AGENT_TICK_JOB, runAgentTickJob())
        case AGENT_REAPER_JOB:
          return withTimeout(AGENT_REAPER_JOB, runAgentReaperJob())
        default:
          logger.warn('Unknown agent runtime job name — ignoring', { jobName: job.name })
          return null
      }
    },
    // Modest concurrency: agent runs are IO-bound but may call an LLM, and the
    // budget guard is per-run rather than global.
    { connection: redis, concurrency: 3 },
  )

  // Repeatable registration is a no-op when the key already exists, so a restart
  // never duplicates a schedule.
  const schedules: Array<[string, string]> = [
    [AGENT_TICK_JOB, '* * * * *'],
    [AGENT_REAPER_JOB, '*/5 * * * *'],
  ]
  for (const [name, pattern] of schedules) {
    agentQueue
      .add(name, {}, { repeat: { pattern }, removeOnComplete: 20 })
      .catch(() => { /* the repeatable job already exists */ })
  }

  worker.on('completed', (job) => {
    if (job.name !== AGENT_TICK_JOB) {
      logger.info('Agent runtime job completed', { jobId: job.id, jobName: job.name })
    }
  })
  worker.on('failed', (job, err) => {
    // A retryable handler error is expected backpressure, not an incident.
    const level = err instanceof AgentRetryableError ? 'warn' : 'error'
    logger[level]('Agent runtime job failed', {
      jobId: job?.id,
      jobName: job?.name,
      attempt: job?.attemptsMade,
      error: err.message,
    })
  })
  worker.on('error', (err) => {
    logger.error('Agent runtime worker error', { error: err.message })
  })

  logger.info('Agent runtime worker started', {
    queue: AGENT_QUEUE_NAME,
    jobs: schedules.map(([name, pattern]) => `${name} (${pattern})`),
    concurrency: 3,
  })
  return worker
}
