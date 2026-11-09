// =============================================================
// The fetch history page: every fetch of opportunities for one firm, why each
// ran, and a breakdown of what the firm now holds.
//
// On the demo it shows the shared SAM.gov pool to the pool administrator. In
// the full version it shows a firm's own fetches (SAM.gov and every Discovery
// source) to that firm's admins.
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import { DEMO_BUSINESS_TYPES } from './demoBusinessTypes'
import { demoDataFirms } from './demoFirms'
import { isDemo } from './appEnvironment'

const DAY = 86_400_000
export const HISTORY_DAYS_DEFAULT = 30
const HISTORY_DAYS_MAX = 180
const NOTICES_PAGE_SIZE = 50
const TOP_AGENCIES = 10
const WEEKS = 8

export interface FetchRow {
  id: string
  kind: 'sam' | 'source'
  source: string
  trigger: string | null
  triggerDetail: string | null
  status: string
  startedAt: Date | null
  completedAt: Date | null
  durationMs: number | null
  requests: number | null
  pages: number | null
  fetched: number | null
  added: number | null
  updated: number | null
  error: string | null
}

const sinceFor = (days: number, now: Date) => new Date(now.getTime() - Math.min(Math.max(1, days), HISTORY_DAYS_MAX) * DAY)

/** Every SAM.gov fetch and Discovery source run for the firm in the window, newest first. */
export async function fetchHistory(consultingFirmId: string, days: number = HISTORY_DAYS_DEFAULT, now: Date = new Date()): Promise<FetchRow[]> {
  const since = sinceFor(days, now)
  const [jobs, runs] = await Promise.all([
    prisma.ingestionJob.findMany({
      where: { consultingFirmId, type: 'INGEST', startedAt: { gte: since } },
      orderBy: { startedAt: 'desc' },
    }),
    prisma.sourceSyncRun.findMany({
      where: { consultingFirmId, startedAt: { gte: since } },
      orderBy: { startedAt: 'desc' },
      include: { sourceConfig: { select: { displayName: true, adapterKey: true } } },
    }),
  ])
  const rows: FetchRow[] = [
    ...jobs.map((j) => ({
      id: j.id,
      kind: 'sam' as const,
      source: 'SAM.gov',
      trigger: j.trigger,
      triggerDetail: j.triggerDetail,
      status: j.status,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      durationMs: j.startedAt && j.completedAt ? j.completedAt.getTime() - j.startedAt.getTime() : null,
      requests: j.samRequests,
      pages: null,
      fetched: j.opportunitiesFound,
      added: j.opportunitiesNew,
      updated: null,
      error: j.errorDetail,
    })),
    ...runs.map((r) => ({
      id: r.id,
      kind: 'source' as const,
      source: r.sourceConfig.displayName || r.sourceConfig.adapterKey,
      trigger: r.trigger,
      triggerDetail: r.triggerDetail,
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.finishedAt,
      durationMs: r.durationMs,
      requests: null,
      pages: r.pagesFetched,
      fetched: r.recordsFetched,
      added: r.recordsCreated,
      updated: r.recordsUpdated,
      error: r.errorMessage,
    })),
  ]
  return rows.sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0))
}

/** The business type a NAICS code falls in, or null. Longest matching prefix wins. */
export function businessTypeOf(naicsCode: string | null): string | null {
  if (!naicsCode) return null
  let best: { label: string; length: number } | null = null
  for (const type of DEMO_BUSINESS_TYPES) {
    for (const prefix of type.naicsPrefixes) {
      if (naicsCode.startsWith(prefix) && (!best || prefix.length > best.length)) best = { label: type.label, length: prefix.length }
    }
  }
  return best?.label ?? null
}

const counted = <T extends string | null>(rows: Array<{ key: T; count: number }>) =>
  rows.sort((a, b) => b.count - a.count).map(({ key, count }) => ({ key: key ?? 'Not given', count }))

/** What the firm holds now: open, closed, deadlines, and how it divides up. */
export async function holdingsBreakdown(consultingFirmId: string, now: Date = new Date()) {
  const base = { consultingFirmId, isDemo: false }
  const open = { ...base, responseDeadline: { gte: now } }
  const within = (days: number) => ({ ...base, responseDeadline: { gte: now, lt: new Date(now.getTime() + days * DAY) } })
  const [total, openCount, closed, due7, due30, due90, byStatus, byNaics, byNotice, bySetAside, byAgency, bySource, weeks] = await Promise.all([
    prisma.opportunity.count({ where: base }),
    prisma.opportunity.count({ where: open }),
    prisma.opportunity.count({ where: { ...base, responseDeadline: { lt: now } } }),
    prisma.opportunity.count({ where: within(7) }),
    prisma.opportunity.count({ where: within(30) }),
    prisma.opportunity.count({ where: within(90) }),
    prisma.opportunity.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    prisma.opportunity.groupBy({ by: ['naicsCode'], where: open, _count: { _all: true } }),
    prisma.opportunity.groupBy({ by: ['noticeType'], where: open, _count: { _all: true } }),
    prisma.opportunity.groupBy({ by: ['setAsideType'], where: open, _count: { _all: true } }),
    prisma.opportunity.groupBy({ by: ['agency'], where: open, _count: { _all: true }, orderBy: { _count: { agency: 'desc' } }, take: TOP_AGENCIES }),
    prisma.opportunity.groupBy({ by: ['source'], where: base, _count: { _all: true } }),
    prisma.$queryRaw<Array<{ week: Date; count: bigint }>>(Prisma.sql`
      SELECT date_trunc('week', "postedDate") AS week, COUNT(*) AS count
      FROM opportunities
      WHERE "consultingFirmId" = ${consultingFirmId} AND "isDemo" = false AND "postedDate" >= ${new Date(now.getTime() - WEEKS * 7 * DAY)}
      GROUP BY 1 ORDER BY 1`),
  ])

  const types = new Map<string, number>()
  for (const row of byNaics) {
    const label = businessTypeOf(row.naicsCode) ?? (row.naicsCode ? 'No matching business type' : 'No NAICS code')
    types.set(label, (types.get(label) ?? 0) + row._count._all)
  }

  return {
    total,
    open: openCount,
    closed,
    dueWithin: { days7: due7, days30: due30, days90: due90, later: Math.max(0, openCount - due90) },
    byStatus: counted(byStatus.map((r) => ({ key: r.status as string, count: r._count._all }))),
    bySource: counted(bySource.map((r) => ({ key: r.source as string, count: r._count._all }))),
    byBusinessType: counted([...types].map(([key, count]) => ({ key, count }))),
    byNoticeType: counted(byNotice.map((r) => ({ key: r.noticeType, count: r._count._all }))),
    bySetAside: counted(bySetAside.map((r) => ({ key: r.setAsideType as string | null, count: r._count._all }))),
    topAgencies: byAgency.map((r) => ({ key: r.agency || 'Not given', count: r._count._all })),
    postedByWeek: weeks.map((w) => ({ week: w.week, count: Number(w.count) })),
  }
}

/** Demo only: what each account has received from the pool, real and invented. */
export async function demoAccountsBreakdown(now: Date = new Date()) {
  if (!isDemo()) return null
  const firms = await prisma.consultingFirm.findMany({ where: demoDataFirms(now), select: { id: true, name: true, demoBusinessType: true, demoExpiresAt: true } })
  if (firms.length === 0) return []
  const ids = firms.map((f) => f.id)
  const openWhere = { consultingFirmId: { in: ids }, status: 'ACTIVE' as const, responseDeadline: { gte: now } }
  const [real, invented] = await Promise.all([
    prisma.opportunity.groupBy({ by: ['consultingFirmId'], where: { ...openWhere, NOT: { samNoticeId: { startsWith: 'DEMO-' } } }, _count: { _all: true } }),
    prisma.opportunity.groupBy({ by: ['consultingFirmId'], where: { ...openWhere, samNoticeId: { startsWith: 'DEMO-' } }, _count: { _all: true } }),
  ])
  const of = (rows: typeof real, id: string) => rows.find((r) => r.consultingFirmId === id)?._count._all ?? 0
  const label = (key: string | null) => DEMO_BUSINESS_TYPES.find((t) => t.key === key)?.label ?? 'All business types'
  return firms
    .map((f) => ({ name: f.name, businessType: f.demoExpiresAt ? label(f.demoBusinessType) : 'All (operators)', realOpen: of(real, f.id), inventedOpen: of(invented, f.id) }))
    .sort((a, b) => b.realOpen - a.realOpen)
}

/**
 * Notices the firm holds, optionally only those a given fetch added: created while
 * that fetch ran (and, for a Discovery run, from its source).
 */
export async function fetchedNotices(
  consultingFirmId: string,
  opts: { runKind?: 'sam' | 'source'; runId?: string; search?: string; page?: number },
  now: Date = new Date(),
) {
  const where: Prisma.OpportunityWhereInput = { consultingFirmId, isDemo: false }
  if (opts.runId) {
    const run = opts.runKind === 'source'
      ? await prisma.sourceSyncRun.findFirst({ where: { id: opts.runId, consultingFirmId }, select: { startedAt: true, finishedAt: true, sourceConfigId: true } })
          .then((r) => r && { from: r.startedAt, to: r.finishedAt, sourceConfigId: r.sourceConfigId })
      : await prisma.ingestionJob.findFirst({ where: { id: opts.runId, consultingFirmId, type: 'INGEST' }, select: { startedAt: true, completedAt: true } })
          .then((j) => j && { from: j.startedAt, to: j.completedAt, sourceConfigId: null as string | null })
    if (!run?.from) return { notices: [], total: 0, page: 1, pageSize: NOTICES_PAGE_SIZE }
    where.createdAt = { gte: run.from, lte: run.to ?? now }
    if (run.sourceConfigId) where.sourceConfigId = run.sourceConfigId
  }
  const search = opts.search?.trim()
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { agency: { contains: search, mode: 'insensitive' } },
      { samNoticeId: { contains: search, mode: 'insensitive' } },
      { solicitationNumber: { contains: search, mode: 'insensitive' } },
    ]
  }
  const page = Math.max(1, opts.page ?? 1)
  const [total, rows] = await Promise.all([
    prisma.opportunity.count({ where }),
    prisma.opportunity.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * NOTICES_PAGE_SIZE,
      take: NOTICES_PAGE_SIZE,
      select: { id: true, title: true, agency: true, naicsCode: true, noticeType: true, source: true, responseDeadline: true, postedDate: true, sourceUrl: true, createdAt: true },
    }),
  ])
  return {
    notices: rows.map((o) => ({ ...o, open: o.responseDeadline >= now, businessType: businessTypeOf(o.naicsCode) })),
    total,
    page,
    pageSize: NOTICES_PAGE_SIZE,
  }
}
