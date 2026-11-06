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
// Filling never calls SAM.gov, so a new account has data at once.
// =============================================================
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { samApiService } from './samApi'
import { businessTypeByKey } from './demoBusinessTypes'
import { demoDataFirms, POOL_FIRM_EMAIL } from './demoFirms'
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
/** Invented notices are kept once they're on the pipeline, so a client's work isn't lost. */
const KEEP_STAGES = ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL', 'SUBMITTED'] as const
const INVENTED_PREFIX = 'DEMO-'

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
      { limit: PAGE_SIZE, maxPages: POOL_MAX_PAGES, maxRecords: POOL_MAX_RECORDS, ...(pool.lastIngestedAt ? {} : { sinceDate: new Date(Date.now() - FIRST_PULL_DAYS * DAY) }) },
      pool.id,
    ) as { found?: number; ingested?: number; errors?: number }
    await prisma.ingestionJob.update({
      where: { id: job.id },
      data: { status: 'COMPLETE', completedAt: new Date(), opportunitiesFound: stats.found ?? 0, opportunitiesNew: stats.ingested ?? 0, errors: stats.errors ?? 0 },
    })
    logger.info('Demo pool synced from SAM.gov', { found: stats.found ?? 0, ingested: stats.ingested ?? 0 })
    return { found: stats.found ?? 0, ingested: stats.ingested ?? 0, skipped: false }
  } catch (err) {
    await prisma.ingestionJob.update({ where: { id: job.id }, data: { status: 'FAILED', completedAt: new Date(), errorDetail: (err as Error).message } }).catch(() => undefined)
    throw err
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

/** Copies the pool's open notices in the account's business type that it doesn't have yet. */
export async function fillDemoAccount(consultingFirmId: string, now: Date = new Date()): Promise<number> {
  const firm = await prisma.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { demoBusinessType: true } })
  const type = businessTypeByKey(firm?.demoBusinessType)
  if (!type) return 0
  const pool = await ensurePoolFirm()
  const have = new Set(
    (await prisma.opportunity.findMany({ where: { consultingFirmId, samNoticeId: { not: null } }, select: { samNoticeId: true } })).map((o) => o.samNoticeId),
  )
  const candidates = await prisma.opportunity.findMany({
    where: {
      consultingFirmId: pool.id,
      status: 'ACTIVE',
      responseDeadline: { gte: now },
      OR: type.naicsPrefixes.map((prefix) => ({ naicsCode: { startsWith: prefix } })),
    },
    orderBy: [{ postedDate: 'desc' }, { id: 'asc' }],
    take: FILL_LIMIT + have.size,
  })
  const fresh = candidates.filter((o) => !have.has(o.samNoticeId)).slice(0, FILL_LIMIT)
  if (fresh.length === 0) {
    await retireInventedNotices(consultingFirmId)
    return 0
  }
  await prisma.opportunity.createMany({
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
  await retireInventedNotices(consultingFirmId)
  return fresh.length
}

/** Once an account has real notices, its invented ones go, unless they're on the pipeline. */
async function retireInventedNotices(consultingFirmId: string): Promise<number> {
  const real = await prisma.opportunity.count({ where: { consultingFirmId, samNoticeId: { not: null }, NOT: { samNoticeId: { startsWith: INVENTED_PREFIX } } } })
  if (real === 0) return 0
  const { count } = await prisma.opportunity.deleteMany({
    where: { consultingFirmId, samNoticeId: { startsWith: INVENTED_PREFIX }, bidPursuits: { none: { pipelineStage: { in: [...KEEP_STAGES] } } } },
  })
  if (count) logger.info('Invented notices retired in favour of real ones', { consultingFirmId, retired: count })
  return count
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
