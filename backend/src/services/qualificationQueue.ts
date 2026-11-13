// =============================================================
// The "To qualify" queue and "why we pass" insights.
//
// Queue: open notices the bidding company (a contractor's own company, or one
// client of a consulting firm) hasn't decided on yet, each with what Bytescon
// already knows — win probability, the readiness verdict, and any scorecard in
// progress — so a person can bid, pass or look closer, one after another.
//
// Insights: the decisions recorded in a period, and the reasons for passing
// (qualificationDecision.NO_BID_REASONS).
// =============================================================
import { prisma } from '../config/database'
import { readinessChecker } from './bidReadinessLoader'
import { NO_BID_REASONS, NO_BID_REASON_KEYS, type NoBidReason } from './qualificationDecision'
import type { ReadinessVerdict } from './bidReadiness'

const DAY_MS = 86_400_000
export const QUEUE_MAX = 100
/** How many open notices are looked at before sorting, newest deadlines first. */
const CANDIDATES = 400

export interface QueueItem {
  opportunityId: string
  title: string
  agency: string
  naicsCode: string | null
  setAsideType: string | null
  responseDeadline: string
  daysLeft: number
  estimatedValue: number | null
  pursuitId: string | null
  pipelineStage: string | null
  /** 0–1 from the scoring engine for this company, or null if not scored yet. */
  winProbability: number | null
  readiness: { verdict: ReadinessVerdict; problems: string[] }
  scorecard: { status: string; finalDecision: string | null; totalScore: number; recommendation: string | null; noBidReason: string | null } | null
}

export interface QueueOptions {
  includeDecided?: boolean
  sort?: 'fit' | 'deadline'
  limit?: number
  now?: Date
}

const DECIDED = ['BID', 'NO_BID', 'CONDITIONAL', 'DEFERRED']

/**
 * The queue for one bidding company. `clientCompanyId` is that company's
 * ClientCompany id (a contractor's own company is one too).
 */
export async function qualifyQueue(consultingFirmId: string, clientCompanyId: string, opts: QueueOptions = {}): Promise<QueueItem[]> {
  const now = opts.now ?? new Date()
  const limit = Math.min(QUEUE_MAX, Math.max(1, opts.limit ?? 50))

  const opportunities = await prisma.opportunity.findMany({
    where: {
      consultingFirmId,
      status: 'ACTIVE',
      responseDeadline: { gt: now },
      // Award notices carry no decision. A notice with no type stays in (a bare
      // NOT would drop it too, since NULL never matches).
      OR: [{ noticeType: null }, { NOT: { noticeType: { contains: 'award', mode: 'insensitive' } } }],
    },
    orderBy: { responseDeadline: 'asc' },
    take: CANDIDATES,
    select: {
      id: true, title: true, agency: true, naicsCode: true, setAsideType: true, responseDeadline: true,
      estimatedValue: true, isScored: true, probabilityScore: true,
    },
  })
  const ids = opportunities.map((o) => o.id)

  const [client, pursuits, decisions, check] = await Promise.all([
    prisma.clientCompany.findFirst({ where: { id: clientCompanyId, consultingFirmId }, select: { isSelf: true } }),
    prisma.bidPursuit.findMany({
      where: { consultingFirmId, opportunityId: { in: ids } },
      select: {
        id: true, opportunityId: true, pipelineStage: true,
        scorecards: {
          where: { clientCompanyId },
          select: { status: true, finalDecision: true, totalScore: true, recommendation: true, noBidReason: true },
        },
      },
    }),
    prisma.bidDecision.findMany({
      where: { consultingFirmId, clientCompanyId, opportunityId: { in: ids } },
      select: { opportunityId: true, winProbability: true },
    }),
    readinessChecker(consultingFirmId, clientCompanyId),
  ])
  const pursuitByOpp = new Map(pursuits.map((p) => [p.opportunityId, p]))
  const probByOpp = new Map(decisions.map((d) => [d.opportunityId, d.winProbability]))

  const items: QueueItem[] = []
  for (const o of opportunities) {
    const pursuit = pursuitByOpp.get(o.id)
    const sc = pursuit?.scorecards[0] ?? null
    if (!opts.includeDecided && sc?.finalDecision && DECIDED.includes(sc.finalDecision)) continue
    // The stored score belongs to the firm's best client; for a contractor
    // that is its own company, so it stands in until a per-company decision exists.
    const winProbability = probByOpp.get(o.id) ?? (client?.isSelf && o.isScored ? o.probabilityScore : null)
    const readiness = check({ setAsideType: o.setAsideType, naicsCode: o.naicsCode, responseDeadline: o.responseDeadline, estimatedValue: o.estimatedValue })
    items.push({
      opportunityId: o.id,
      title: o.title,
      agency: o.agency,
      naicsCode: o.naicsCode,
      setAsideType: o.setAsideType,
      responseDeadline: o.responseDeadline.toISOString(),
      daysLeft: Math.max(0, Math.floor((o.responseDeadline.getTime() - now.getTime()) / DAY_MS)),
      estimatedValue: o.estimatedValue == null ? null : Number(o.estimatedValue),
      pursuitId: pursuit?.id ?? null,
      pipelineStage: pursuit?.pipelineStage ?? null,
      winProbability: winProbability ?? null,
      readiness: {
        verdict: readiness.verdict,
        problems: readiness.items.filter((it) => it.status === 'FAIL').map((it) => it.label),
      },
      scorecard: sc,
    })
  }

  if ((opts.sort ?? 'fit') === 'fit') {
    // Ready and likely first; not eligible last; then the nearer deadline.
    const rank = { READY: 0, CHECK: 1, FIX_FIRST: 2, NOT_ELIGIBLE: 3 } as const
    items.sort((a, b) =>
      rank[a.readiness.verdict] - rank[b.readiness.verdict]
      || (b.winProbability ?? -1) - (a.winProbability ?? -1)
      || a.daysLeft - b.daysLeft)
  }
  return items.slice(0, limit)
}

export interface QualificationInsights {
  days: number
  decided: number
  byDecision: Record<string, number>
  noBidReasons: Array<{ reason: NoBidReason | 'NOT_GIVEN'; label: string; count: number }>
  quickNoBids: number
  overrides: number
}

/** Decisions recorded in the last `days` days, for one company or the whole firm. */
export async function qualificationInsights(consultingFirmId: string, opts: { days?: number; clientCompanyId?: string | null; now?: Date } = {}): Promise<QualificationInsights> {
  const days = Math.min(365, Math.max(1, opts.days ?? 90))
  const since = new Date((opts.now ?? new Date()).getTime() - days * DAY_MS)
  const decided = await prisma.scorecard.findMany({
    where: {
      consultingFirmId,
      decidedAt: { gte: since },
      finalDecision: { not: null },
      ...(opts.clientCompanyId ? { clientCompanyId: opts.clientCompanyId } : {}),
    },
    select: { finalDecision: true, noBidReason: true, quickDecision: true, isOverride: true },
  })

  const byDecision: Record<string, number> = {}
  const reasons = new Map<string, number>()
  for (const d of decided) {
    byDecision[d.finalDecision!] = (byDecision[d.finalDecision!] ?? 0) + 1
    if (d.finalDecision === 'NO_BID') {
      const key = d.noBidReason && (NO_BID_REASON_KEYS as string[]).includes(d.noBidReason) ? d.noBidReason : 'NOT_GIVEN'
      reasons.set(key, (reasons.get(key) ?? 0) + 1)
    }
  }
  return {
    days,
    decided: decided.length,
    byDecision,
    noBidReasons: [...reasons.entries()]
      .map(([reason, count]) => ({
        reason: reason as NoBidReason | 'NOT_GIVEN',
        label: reason === 'NOT_GIVEN' ? 'No reason recorded' : NO_BID_REASONS[reason as NoBidReason],
        count,
      }))
      .sort((a, b) => b.count - a.count),
    quickNoBids: decided.filter((d) => d.quickDecision).length,
    overrides: decided.filter((d) => d.isOverride).length,
  }
}
