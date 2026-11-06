// =============================================================
// Real SAM.gov notices for the demo, without each account calling SAM.gov.
//
// Accounts start with invented notices. Once the pool has real ones in an
// account's business type, they're copied in and the invented ones go, except
// any the client has on the pipeline. If SAM.gov can't be reached, nothing is
// removed and the invented notices stay, so the demo keeps working.
//
// A public SAM.gov key allows only a handful of requests a day, so one hidden
// pool firm pulls everything new once a day (a page holds 1,000 notices), and
// every demo account is filled from it with the notices in its business type.
// Filling never calls SAM.gov, so a new account has data at once. The pool
// administrator can also pull further on demand (startPoolPull), continuing from
// where the last on-demand pull stopped.
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { ValidationError } from '../utils/errors'
import { samApiService } from './samApi'
import { businessTypeByKey } from './demoBusinessTypes'
import { inventOpenNotices } from './demoSampleData'
import { demoDataFirms, OPERATOR_FIRM_EMAIL, POOL_FIRM_EMAIL } from './demoFirms'
import { enqueueAllOpportunitiesForScoring } from '../workers/scoringWorker'

const DAY = 86_400_000
/** The first pull looks back this far; later pulls take what's new since the last one. */
const FIRST_PULL_DAYS = 30
/** At most three requests a pull, so a day's quota is never spent on one sync. */
const POOL_MAX_PAGES = 3
const POOL_MAX_RECORDS = 3000
const PAGE_SIZE = 1000
/** A pull younger than this is reused rather than repeated. */
const POOL_FRESH_MS = 20 * 60 * 60 * 1000
/** Newest notices first, and no more than this per fill, so scoring stays quick. */
const FILL_LIMIT = 200
/** Every account shows at least this many open notices; invented ones make up any shortfall. */
export const MIN_OPEN_NOTICES = 20
/** Invented notices are kept once they're on the pipeline, so a client's work isn't lost. */
const KEEP_STAGES = ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL', 'SUBMITTED'] as const
const INVENTED_PREFIX = 'DEMO-'
const COPY_BATCH = 1000
/** The most notices copied into one account. */
const MAX_NOTICES_PER_ACCOUNT = 50_000
/** A public key's daily allowance, and what on-demand pulls leave for the daily one. SAM.gov doesn't report what's left. */
export const SAM_DAILY_REQUESTS = 10
export const SAM_REQUESTS_KEPT_SPARE = 3
export const MAX_PULL_REQUESTS = 4
/** On-demand pulls look at this many days of notices. */
const PULL_WINDOW_DAYS = 30
/** Once every page is fetched, the same notices aren't fetched again for this long. */
const PULL_REPEAT_DAYS = 7
/** A running job older than this died with a restart, so it no longer blocks a pull. */
const JOB_STALE_MS = 30 * 60 * 1000

type PullCursor = { postedFrom: string; postedTo: string; deadlineFrom: string; nextPage: number | null; total: number | null; finishedAt: string | null }

export type PoolIngest = typeof samApiService.searchAndIngest

export async function ensurePoolFirm(): Promise<{ id: string; lastIngestedAt: Date | null }> {
  return prisma.consultingFirm.upsert({
    where: { contactEmail: POOL_FIRM_EMAIL },
    update: {},
    create: { name: 'Bytescon SAM.gov Pool', contactEmail: POOL_FIRM_EMAIL },
    select: { id: true, lastIngestedAt: true },
  })
}

/** Pulls what's new into the pool, unless a pull is still fresh. */
export async function syncDemoPool(opts: { ingest?: PoolIngest; force?: boolean } = {}): Promise<{ found: number; ingested: number; skipped: boolean }> {
  const pool = await ensurePoolFirm()
  if (!opts.force && pool.lastIngestedAt && Date.now() - pool.lastIngestedAt.getTime() < POOL_FRESH_MS) {
    return { found: 0, ingested: 0, skipped: true }
  }
  const ingest = opts.ingest ?? samApiService.searchAndIngest.bind(samApiService)
  // Recorded like any firm's sync, so the operator page can show how the last pull went.
  const job = await prisma.ingestionJob.create({ data: { consultingFirmId: pool.id, type: 'INGEST', status: 'RUNNING', startedAt: new Date() } })
  try {
    const stats = await ingest(
      { limit: PAGE_SIZE, maxPages: POOL_MAX_PAGES, maxRecords: POOL_MAX_RECORDS, deadlineFrom: new Date(), onPage: ({ requests }) => recordRequests(job.id, requests), ...(pool.lastIngestedAt ? {} : { sinceDate: new Date(Date.now() - FIRST_PULL_DAYS * DAY) }) },
      pool.id,
    ) as { found?: number; ingested?: number; errors?: number; requests?: number }
    await prisma.ingestionJob.update({
      where: { id: job.id },
      data: { status: 'COMPLETE', completedAt: new Date(), opportunitiesFound: stats.found ?? 0, opportunitiesNew: stats.ingested ?? 0, errors: stats.errors ?? 0, ...(stats.requests === undefined ? {} : { samRequests: stats.requests }) },
    })
    logger.info('Demo pool synced from SAM.gov', { found: stats.found ?? 0, ingested: stats.ingested ?? 0 })
    return { found: stats.found ?? 0, ingested: stats.ingested ?? 0, skipped: false }
  } catch (err) {
    await failJob(job.id, err as Error)
    throw err
  }
}

const recordRequests = (jobId: string, samRequests: number) =>
  prisma.ingestionJob.update({ where: { id: jobId }, data: { samRequests } }).then(() => undefined)

/** The request that failed still counts against the day, so it's added to those that worked. */
const failJob = (jobId: string, err: Error) =>
  prisma.ingestionJob
    .update({ where: { id: jobId }, data: { status: 'FAILED', completedAt: new Date(), errorDetail: err.message, samRequests: { increment: 1 } } })
    .catch(() => undefined)

/** A pull doesn't survive a restart, so at startup any still marked as running has died. */
export async function closeInterruptedPoolPulls(): Promise<void> {
  const pool = await ensurePoolFirm()
  await prisma.ingestionJob.updateMany({
    where: { consultingFirmId: pool.id, type: 'INGEST', status: 'RUNNING' },
    data: { status: 'FAILED', completedAt: new Date(), errorDetail: 'Interrupted by a server restart. Pull again to continue.' },
  })
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

/** Everything the pool administrator's page shows. */
export async function poolPullStatus(now: Date = new Date()) {
  const pool = await ensurePoolFirm()
  const jobs = { consultingFirmId: pool.id, type: 'INGEST' as const }
  const [today, running, last, openNotices, totalNotices] = await Promise.all([
    prisma.ingestionJob.aggregate({ where: { ...jobs, startedAt: { gte: startOfUtcDay(now) } }, _sum: { samRequests: true } }),
    prisma.ingestionJob.findFirst({ where: { ...jobs, status: 'RUNNING', startedAt: { gte: new Date(now.getTime() - JOB_STALE_MS) } }, select: { id: true } }),
    prisma.ingestionJob.findFirst({ where: { ...jobs, samCursor: { not: Prisma.DbNull } }, orderBy: { startedAt: 'desc' } }),
    prisma.opportunity.count({ where: { consultingFirmId: pool.id, status: 'ACTIVE', responseDeadline: { gte: now } } }),
    prisma.opportunity.count({ where: { consultingFirmId: pool.id } }),
  ])
  const requestsUsedToday = today._sum.samRequests ?? 0
  const cursor = (last?.samCursor ?? null) as PullCursor | null
  return {
    running: Boolean(running),
    requestsUsedToday,
    dailyRequests: SAM_DAILY_REQUESTS,
    keptSpare: SAM_REQUESTS_KEPT_SPARE,
    requestsAvailable: Math.max(0, SAM_DAILY_REQUESTS - SAM_REQUESTS_KEPT_SPARE - requestsUsedToday),
    maxPerPull: MAX_PULL_REQUESTS,
    openNotices,
    totalNotices,
    progress: cursor && {
      nextPage: cursor.nextPage,
      total: cursor.total,
      totalPages: cursor.total === null ? null : Math.ceil(cursor.total / PAGE_SIZE),
      finishedAt: cursor.finishedAt,
    },
    lastPull: last && {
      at: last.completedAt,
      ok: last.status === 'RUNNING' ? null : last.status === 'COMPLETE',
      error: last.errorDetail,
      found: last.opportunitiesFound,
      added: last.opportunitiesNew,
      requests: last.samRequests,
    },
  }
}

/**
 * Where the next on-demand pull starts: the last one's position, or a new window
 * once the last has finished and PULL_REPEAT_DAYS have passed.
 */
function nextCursor(last: PullCursor | null, now: Date): PullCursor {
  if (last && !last.finishedAt) return last
  if (last?.finishedAt && now.getTime() - new Date(last.finishedAt).getTime() < PULL_REPEAT_DAYS * DAY) {
    throw new ValidationError(`Every open notice has been fetched. New ones arrive with the daily pull, and this can run again ${PULL_REPEAT_DAYS} days after it finished.`)
  }
  return {
    postedFrom: new Date(now.getTime() - PULL_WINDOW_DAYS * DAY).toISOString(),
    postedTo: now.toISOString(),
    deadlineFrom: now.toISOString(),
    nextPage: 0,
    total: null,
    finishedAt: null,
  }
}

/**
 * Checks a pull can run and records it. The pull itself is slow, so it's handed
 * back to run in the background; call the returned function to start it.
 */
export async function startPoolPull(requested: number, opts: { ingest?: PoolIngest; now?: Date } = {}): Promise<{ requests: number; run: () => Promise<void> }> {
  const now = opts.now ?? new Date()
  const status = await poolPullStatus(now)
  if (status.running) throw new ValidationError('A pull is already running.')
  const requests = Math.min(requested, status.requestsAvailable)
  if (requests < 1) throw new ValidationError(`Today's SAM.gov requests are used up, apart from ${SAM_REQUESTS_KEPT_SPARE} kept for the daily pull. Try again tomorrow.`)
  const pool = await ensurePoolFirm()
  const last = await prisma.ingestionJob.findFirst({ where: { consultingFirmId: pool.id, type: 'INGEST', samCursor: { not: Prisma.DbNull } }, orderBy: { startedAt: 'desc' } })
  const cursor = nextCursor((last?.samCursor ?? null) as PullCursor | null, now)
  const job = await prisma.ingestionJob.create({
    data: { consultingFirmId: pool.id, type: 'INGEST', status: 'RUNNING', startedAt: now, samRequests: 0, samCursor: cursor as unknown as Prisma.InputJsonValue },
  })
  return { requests, run: () => runPoolPull(job.id, pool.id, cursor, requests, opts.ingest) }
}

async function runPoolPull(jobId: string, poolId: string, start: PullCursor, requests: number, ingestOverride?: PoolIngest): Promise<void> {
  const ingest = ingestOverride ?? samApiService.searchAndIngest.bind(samApiService)
  let cursor = start
  try {
    const stats = await ingest(
      {
        limit: PAGE_SIZE,
        maxPages: requests,
        page: start.nextPage ?? 0,
        sinceDate: new Date(start.postedFrom),
        postedTo: new Date(start.postedTo),
        deadlineFrom: new Date(start.deadlineFrom),
        keepWatermark: true,
        // Saved page by page, so a failure part-way loses neither the position nor the count.
        onPage: async (progress) => {
          cursor = { ...cursor, nextPage: progress.nextPage, total: progress.total, finishedAt: progress.nextPage === null ? new Date().toISOString() : null }
          await prisma.ingestionJob.update({ where: { id: jobId }, data: { samRequests: progress.requests, samCursor: cursor as unknown as Prisma.InputJsonValue } })
        },
      },
      poolId,
    ) as { found?: number; ingested?: number; errors?: number }
    await prisma.ingestionJob.update({ where: { id: jobId }, data: { opportunitiesFound: stats.found ?? 0, opportunitiesNew: stats.ingested ?? 0, errors: stats.errors ?? 0 } })
    // Still "running" while accounts fill, so another pull can't start on top of it.
    await fillAllDemoAccounts()
    await prisma.ingestionJob.update({ where: { id: jobId }, data: { status: 'COMPLETE', completedAt: new Date() } })
    logger.info('Demo pool pulled on demand', { found: stats.found ?? 0, ingested: stats.ingested ?? 0, nextPage: cursor.nextPage })
  } catch (err) {
    logger.error('On-demand pool pull failed', { error: (err as Error).message })
    await failJob(jobId, err as Error)
  }
}

/** How the last pull went and what the pool holds, for the operator page. */
export async function demoPoolStatus(now: Date = new Date()): Promise<{ lastPullAt: Date | null; ok: boolean | null; error: string | null; openNotices: number }> {
  const pool = await ensurePoolFirm()
  const [last, openNotices] = await Promise.all([
    prisma.ingestionJob.findFirst({ where: { consultingFirmId: pool.id, type: 'INGEST', status: { in: ['COMPLETE', 'FAILED'] } }, orderBy: { startedAt: 'desc' } }),
    prisma.opportunity.count({ where: { consultingFirmId: pool.id, status: 'ACTIVE', responseDeadline: { gte: now } } }),
  ])
  return { lastPullAt: last?.completedAt ?? null, ok: last ? last.status === 'COMPLETE' : null, error: last?.status === 'FAILED' ? last.errorDetail : null, openNotices }
}

/** Copies the pool's open notices the account doesn't have yet: those in its business type, or for the operators, all of them. */
export async function fillDemoAccount(consultingFirmId: string, now: Date = new Date()): Promise<number> {
  const firm = await prisma.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { demoBusinessType: true, contactEmail: true } })
  const type = businessTypeByKey(firm?.demoBusinessType)
  // The operators see the whole pool, all at once; clients get their business type, a batch at a time.
  const seesWholePool = firm?.contactEmail === OPERATOR_FIRM_EMAIL
  if (!type && !seesWholePool) return 0
  const pool = await ensurePoolFirm()
  const have = new Set(
    (await prisma.opportunity.findMany({ where: { consultingFirmId, samNoticeId: { not: null } }, select: { samNoticeId: true } })).map((o) => o.samNoticeId),
  )
  // Only the ids at first: this list can run to thousands, and the full records are large.
  const candidates = await prisma.opportunity.findMany({
    where: {
      consultingFirmId: pool.id,
      status: 'ACTIVE',
      responseDeadline: { gte: now },
      ...(seesWholePool || !type ? {} : { OR: type.naicsPrefixes.map((prefix) => ({ naicsCode: { startsWith: prefix } })) }),
    },
    orderBy: [{ postedDate: 'desc' }, { id: 'asc' }],
    select: { id: true, samNoticeId: true },
  })
  const room = Math.max(0, MAX_NOTICES_PER_ACCOUNT - have.size)
  const chosen = candidates.filter((o) => !have.has(o.samNoticeId)).slice(0, seesWholePool ? room : Math.min(FILL_LIMIT, room))
  if (chosen.length === 0) {
    await balanceInventedNotices(consultingFirmId, now)
    return 0
  }
  // In batches, since the whole pool can run to thousands of full records.
  for (let i = 0; i < chosen.length; i += COPY_BATCH) {
    const fresh = await prisma.opportunity.findMany({ where: { id: { in: chosen.slice(i, i + COPY_BATCH).map((o) => o.id) } } })
    await prisma.opportunity.createMany({
      // A fill started elsewhere may have copied some already.
      skipDuplicates: true,
      data: fresh.map((o) => ({
        consultingFirmId,
        samNoticeId: o.samNoticeId,
        solicitationNumber: o.solicitationNumber,
        title: o.title,
        agency: o.agency,
        subagency: o.subagency,
        office: o.office,
        naicsCode: o.naicsCode,
        psc: o.psc,
        pscDescription: o.pscDescription,
        setAsideType: o.setAsideType,
        marketCategory: o.marketCategory,
        estimatedValue: o.estimatedValue,
        postedDate: o.postedDate,
        responseDeadline: o.responseDeadline,
        archiveDate: o.archiveDate,
        placeOfPerformance: o.placeOfPerformance,
        sourceUrl: o.sourceUrl,
        description: o.description,
        noticeType: o.noticeType,
        contractVehicle: o.contractVehicle,
        vehicleType: o.vehicleType,
        vehicleConfidence: o.vehicleConfidence,
        source: 'SAM_GOV' as const,
        status: 'ACTIVE' as const,
        isDemo: false,
        probabilityScore: 0,
        expectedValue: 0,
        isScored: false,
      })),
    })
  }
  await balanceInventedNotices(consultingFirmId, now)
  return chosen.length
}

/**
 * Keeps the list at MIN_OPEN_NOTICES: with enough real notices, invented ones not
 * on the pipeline go; with too few, invented ones are added. Only invented ones
 * are ever removed, and never those on the pipeline.
 */
export async function balanceInventedNotices(consultingFirmId: string, now: Date = new Date()): Promise<{ retired: number; invented: number }> {
  const openWhere = { consultingFirmId, status: 'ACTIVE' as const, responseDeadline: { gte: now } }
  const open = await prisma.opportunity.count({ where: openWhere })
  if (open > MIN_OPEN_NOTICES) {
    const spare = await prisma.opportunity.findMany({
      where: { ...openWhere, samNoticeId: { startsWith: INVENTED_PREFIX }, bidPursuits: { none: { pipelineStage: { in: [...KEEP_STAGES] } } } },
      orderBy: { createdAt: 'desc' },
      take: open - MIN_OPEN_NOTICES,
      select: { id: true },
    })
    if (spare.length) {
      await prisma.opportunity.deleteMany({ where: { id: { in: spare.map((o) => o.id) } } })
      logger.info('Invented notices retired in favour of real ones', { consultingFirmId, retired: spare.length })
    }
    return { retired: spare.length, invented: 0 }
  }
  const invented = await inventOpenNotices(consultingFirmId, MIN_OPEN_NOTICES - open)
  if (invented) logger.info('Invented notices added to reach the minimum', { consultingFirmId, invented })
  return { retired: 0, invented }
}

/** Fills every demo account from the pool and queues their scoring. */
export async function fillAllDemoAccounts(now: Date = new Date()): Promise<{ accounts: number; copied: number }> {
  const firms = await prisma.consultingFirm.findMany({ where: demoDataFirms(now), select: { id: true } })
  let copied = 0
  for (const { id } of firms) {
    try {
      copied += await fillDemoAccount(id, now)
      await enqueueAllOpportunitiesForScoring(id)
    } catch (err) {
      // One account's problem mustn't stop the rest.
      logger.error('Could not fill a demo account from the pool', { consultingFirmId: id, error: (err as Error).message })
    }
  }
  if (copied) logger.info('Demo accounts filled from the pool', { accounts: firms.length, copied })
  return { accounts: firms.length, copied }
}

/** The daily job on the demo: one pull, then every account topped up. */
export async function syncDemoPoolAndFill(): Promise<{ accounts: number; copied: number; ingested: number }> {
  let ingested = 0
  try {
    ingested = (await syncDemoPool()).ingested
  } catch (err) {
    // The pool keeps what it has; accounts are still topped up from that.
    logger.error('Demo pool sync failed', { error: (err as Error).message })
  }
  const filled = await fillAllDemoAccounts()
  return { ...filled, ingested }
}
