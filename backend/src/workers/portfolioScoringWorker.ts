// =============================================================
// Portfolio Scoring Worker
// BullMQ cron: runs at 08:00 + 20:00 UTC (twice daily)
// For every consulting firm with at least one active client,
// runs the portfolio decision evaluation. Skips firms with zero
// active clients to keep the work bounded.
// =============================================================
import { Worker, Queue, Job } from 'bullmq'
import { redis } from '../config/redis'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { runPortfolioEvaluation } from '../services/portfolioDecisionEngine'

export const PORTFOLIO_SCORING_QUEUE_NAME = 'portfolio-scoring'

export const portfolioScoringQueue = new Queue(PORTFOLIO_SCORING_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 30000 },
    removeOnComplete: 10,
    removeOnFail: 10,
  },
})

async function runScheduledPortfolioScoring(): Promise<void> {
  const startTime = Date.now()
  logger.info('Scheduled portfolio scoring started')

  // Find every firm with at least one active client. The portfolio engine
  // returns early for firms with zero clients anyway; this just trims work.
  const firms = await prisma.consultingFirm.findMany({
    where: {
      isActive: true,
      clientCompanies: { some: { isActive: true } },
    },
    select: { id: true, name: true },
  })

  let totalDecisions = 0
  for (const firm of firms) {
    try {
      const result = await runPortfolioEvaluation(firm.id)
      totalDecisions += result.decisionsCreatedOrUpdated ?? 0
      logger.info('Firm portfolio scored', {
        firmId: firm.id,
        firmName: firm.name,
        evaluations: result.totalEvaluations,
        decisions: result.decisionsCreatedOrUpdated,
      })
    } catch (err) {
      logger.error('Firm portfolio scoring failed (continuing)', {
        firmId: firm.id,
        firmName: firm.name,
        error: (err as Error).message,
      })
    }
  }

  logger.info('Scheduled portfolio scoring complete', {
    firmsProcessed: firms.length,
    totalDecisions,
    durationMs: Date.now() - startTime,
  })
}

// On-demand single-firm portfolio evaluation. Enqueue from an HTTP handler and
// return 202 instead of running the O(N×M) sweep synchronously in the request
// path. Returns the job id for status polling.
//
// Idempotent per firm: the queue is fleet-shared with concurrency 1, so
// without dedup a double-click (or a hostile loop under the generous global
// rate limit) stacks hours of priority-1 work for one tenant ahead of every
// other tenant's evaluations AND the scheduled cron sweep. If this firm
// already has an evaluation queued or running, return that job instead.
export async function enqueuePortfolioEvaluation(consultingFirmId: string): Promise<string> {
  const pending = await portfolioScoringQueue.getJobs(['waiting', 'active', 'delayed', 'prioritized'])
  const existing = pending.find(
    (j) => (j?.data as { consultingFirmId?: string } | undefined)?.consultingFirmId === consultingFirmId,
  )
  if (existing?.id) return String(existing.id)

  const job = await portfolioScoringQueue.add(
    'portfolio-eval-on-demand',
    { consultingFirmId },
    // priority 1 (highest) so an interactive on-demand eval jumps ahead of the
    // twice-daily all-firms cron sweep on this concurrency-1 queue.
    { removeOnComplete: 50, removeOnFail: 50, priority: 1 },
  )
  return String(job.id)
}

export function startPortfolioScoringWorker(): Worker {
  const worker = new Worker(
    PORTFOLIO_SCORING_QUEUE_NAME,
    async (job: Job) => {
      // On-demand jobs carry a consultingFirmId and evaluate just that firm.
      // The scheduled cron job carries no data and sweeps every firm.
      const firmId = (job.data as { consultingFirmId?: string } | undefined)?.consultingFirmId
      if (firmId) return runPortfolioEvaluation(firmId)
      return runScheduledPortfolioScoring()
    },
    { connection: redis, concurrency: 1 },
  )

  // Twice daily — 08:00 and 20:00 UTC
  portfolioScoringQueue
    .add('portfolio-scoring-cron', {}, {
      repeat: { pattern: '0 8,20 * * *' },
      removeOnComplete: 10,
    })
    .catch(() => {
      /* repeat job may already exist — non-fatal */
    })

  worker.on('completed', (job) => {
    logger.info('Portfolio scoring job completed', { jobId: job.id })
  })
  worker.on('failed', (job, err) => {
    logger.error('Portfolio scoring job failed', { jobId: job?.id, error: err.message })
  })
  worker.on('error', (err) => {
    logger.error('Portfolio scoring worker error', { error: err.message })
  })

  logger.info('Portfolio scoring worker started — schedule: 08:00 and 20:00 UTC daily')
  return worker
}
