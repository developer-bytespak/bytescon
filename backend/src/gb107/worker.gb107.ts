// =============================================================
// GB-107 worker — BullMQ queue with two repeatable jobs:
//
//   poll-queued    (every 60s)  — drains rows the MCP trigger_enrichment
//                                 tool marked QUEUED, nearest deadline first.
//   batch-backfill (every 6h)   — proactively enriches un-attempted rows:
//                                 deadline within the priority window,
//                                 client-NAICS-matched rows first, then
//                                 newest posted; FAILED rows retry after 24h.
//
// Concurrency 1 — SAM calls are serialized so the burst limiter's
// last-call timestamp is race-free. All budget state lives in Redis
// and is shared across job types.
// =============================================================
import { Worker, Queue, Job } from 'bullmq'
import { redis } from '../config/redis'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { getGb107Config } from './config.gb107'
import { Gb107RateLimiter } from './rateLimiter.gb107'
import { enrichOpportunityDescription } from './enrichmentService.gb107'
import { GB107_STATUS } from './types.gb107'

export const GB107_QUEUE_NAME = 'gb107-description-enrichment'

interface Gb107JobData {
  kind: 'poll-queued' | 'batch-backfill'
}

export const gb107Queue = new Queue<Gb107JobData>(GB107_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 50,
  },
})

const FAILED_RETRY_AFTER_MS = 24 * 60 * 60 * 1000
let warnedNoKey = false

const deps = { prisma, redis, logger }

async function processBatch(opportunityIds: string[], label: string): Promise<void> {
  let processed = 0
  for (const id of opportunityIds) {
    const outcome = await enrichOpportunityDescription(deps, id)
    processed++

    if (outcome.status === GB107_STATUS.RATE_LIMITED) {
      logger.warn(`GB-107 ${label}: budget exhausted — stopping cycle`, { processed })
      return
    }
    if (outcome.message.includes('No SAM.gov API key configured')) {
      if (!warnedNoKey) {
        logger.warn('GB-107: no SAM.gov API key configured — enrichment idle until SAM_GOV_API_KEY or SAM_API_KEY is set')
        warnedNoKey = true
      }
      return
    }
  }
  if (processed > 0) {
    logger.info(`GB-107 ${label}: cycle complete`, { processed })
  }
}

async function runPollQueued(): Promise<void> {
  const cfg = getGb107Config()
  const rows = await prisma.opportunity.findMany({
    where: { descriptionEnrichmentStatus: GB107_STATUS.QUEUED },
    select: { id: true },
    orderBy: [{ responseDeadline: 'asc' }],
    take: cfg.batchSize,
  })
  if (rows.length === 0) return
  await processBatch(
    rows.map((r) => r.id),
    'poll-queued',
  )
}

async function runBatchBackfill(): Promise<void> {
  const cfg = getGb107Config()
  const limiter = new Gb107RateLimiter(redis, cfg.ratePerDay, cfg.burstIntervalMs)
  if (await limiter.isHalted()) {
    logger.info('GB-107 batch-backfill: halted for the day (SAM rate limit)')
    return
  }
  const remaining = await limiter.remaining()
  if (remaining <= 0) {
    logger.info('GB-107 batch-backfill: no budget remaining today')
    return
  }

  const now = new Date()
  const windowEnd = new Date(now.getTime() + cfg.priorityWindowDays * 24 * 60 * 60 * 1000)
  const retryCutoff = new Date(now.getTime() - FAILED_RETRY_AFTER_MS)

  const candidates = await prisma.opportunity.findMany({
    where: {
      status: 'ACTIVE',
      responseDeadline: { gte: now, lte: windowEnd },
      OR: [
        { descriptionEnrichmentStatus: null },
        {
          descriptionEnrichmentStatus: GB107_STATUS.FAILED,
          descriptionEnrichmentAttemptedAt: { lt: retryCutoff },
        },
      ],
    },
    select: {
      id: true,
      consultingFirmId: true,
      naicsCode: true,
      responseDeadline: true,
      postedDate: true,
    },
    orderBy: [{ responseDeadline: 'asc' }, { postedDate: 'desc' }],
    // Overselect so NAICS-priority partitioning has room to reorder.
    take: cfg.batchSize * 4,
  })
  if (candidates.length === 0) return

  // Client-NAICS priority: rows whose NAICS matches one of the owning
  // firm's client NAICS codes are enriched first.
  const firms = await prisma.clientCompany.findMany({
    where: { isActive: true, consultingFirmId: { in: [...new Set(candidates.map((c) => c.consultingFirmId))] } },
    select: { consultingFirmId: true, naicsCodes: true },
  })
  const firmNaics = new Map<string, Set<string>>()
  for (const client of firms) {
    const set = firmNaics.get(client.consultingFirmId) ?? new Set<string>()
    for (const code of client.naicsCodes) set.add(code)
    firmNaics.set(client.consultingFirmId, set)
  }

  const matched: string[] = []
  const unmatched: string[] = []
  for (const c of candidates) {
    const isMatch = !!c.naicsCode && (firmNaics.get(c.consultingFirmId)?.has(c.naicsCode) ?? false)
    ;(isMatch ? matched : unmatched).push(c.id)
  }

  const budgetCap = Math.min(cfg.batchSize, remaining)
  const batch = [...matched, ...unmatched].slice(0, budgetCap)
  logger.info('GB-107 batch-backfill: starting cycle', {
    candidates: candidates.length,
    naicsMatched: matched.length,
    batch: batch.length,
    budgetRemaining: remaining,
  })
  await processBatch(batch, 'batch-backfill')
}

export function startGb107Worker(): Worker<Gb107JobData> {
  const worker = new Worker<Gb107JobData>(
    GB107_QUEUE_NAME,
    async (job: Job<Gb107JobData>) => {
      if (job.data.kind === 'poll-queued') await runPollQueued()
      else await runBatchBackfill()
    },
    { connection: redis, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    logger.error('GB-107 worker job failed', { jobId: job?.id, kind: job?.data?.kind, error: err.message })
  })

  void scheduleRepeatables()
  return worker
}

async function scheduleRepeatables(): Promise<void> {
  try {
    await gb107Queue.add(
      'poll-queued',
      { kind: 'poll-queued' },
      { repeat: { pattern: '* * * * *' }, jobId: 'gb107-poll-queued' },
    )
    await gb107Queue.add(
      'batch-backfill',
      { kind: 'batch-backfill' },
      { repeat: { pattern: '0 */6 * * *' }, jobId: 'gb107-batch-backfill' },
    )
    logger.info('GB-107 repeatable jobs scheduled (poll 60s, backfill 6h)')
  } catch (err) {
    logger.error('GB-107: failed to schedule repeatable jobs', { error: (err as Error).message })
  }
}
