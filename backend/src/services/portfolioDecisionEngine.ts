import { prisma } from "../config/database"
import { evaluateBidDecision, OPPORTUNITY_SCORING_SELECT } from "./decisionEngine"
import { logger } from "../utils/logger"
import type { PpRelevanceCache } from "./pastPerformanceService"

const CONCURRENCY_LIMIT = 5

/**
 * Simple concurrency limiter (avoids needing p-limit dependency).
 * Runs async tasks with bounded parallelism.
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = []
  let index = 0

  async function worker() {
    while (index < tasks.length) {
      const i = index++
      results[i] = await tasks[i]()
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  )
  await Promise.all(workers)
  return results
}

export async function runPortfolioEvaluation(consultingFirmId: string) {
  // Only evaluate the top-scored, active opportunities that haven't been decided recently.
  // Cap is configurable via PORTFOLIO_SCORING_CAP (default 1000) to prevent O(N×M)
  // blowup at scale.
  const staleCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000) // 24 hours ago
  const cap = Math.max(50, parseInt(process.env.PORTFOLIO_SCORING_CAP || '1000', 10))

  const opportunities = await prisma.opportunity.findMany({
    where: {
      consultingFirmId,
      status: "ACTIVE",
      isScored: true,
      probabilityScore: { gt: 0 },
      responseDeadline: { gte: new Date() }, // skip expired
    },
    // Bulk-load the full scoring shape once (was select:{id} → a findUnique per
    // pair inside evaluateBidDecision). Rows are passed in via `preloaded`.
    select: OPPORTUNITY_SCORING_SELECT,
    orderBy: { probabilityScore: "desc" },
    take: cap,
  })

  const clients = await prisma.clientCompany.findMany({
    where: {
      consultingFirmId,
      isActive: true,
    },
    // Full client + performanceStats once per run (was select:{id} → a
    // findUnique per pair). Matches evaluateBidDecision's own client read.
    include: { performanceStats: true },
  })

  if (opportunities.length === 0 || clients.length === 0) {
    return { totalOpportunities: 0, totalClients: 0, totalEvaluations: 0, decisionsCreatedOrUpdated: 0, failedPairs: 0 }
  }

  // For each pair, skip if a recent decision already exists (updated within 24h)
  const existingDecisions = await prisma.bidDecision.findMany({
    where: {
      consultingFirmId,
      opportunityId: { in: opportunities.map((o) => o.id) },
      updatedAt: { gte: staleCutoff },
    },
    select: { opportunityId: true, clientCompanyId: true },
  })

  const recentSet = new Set(
    existingDecisions.map((d) => `${d.opportunityId}:${d.clientCompanyId}`)
  )

  // P1-1: isolate failures per (opportunity, client) pair. evaluateBidDecision
  // throws when the win-probability compute fails; one poison pair must not
  // reject the whole batch (which would 500 ingest/run-all and starve the
  // remaining pairs in the cron worker). Each task resolves to a success flag.
  // One cache shared across every pair in this run: each client's
  // past-performance rows are read at most once (opportunity-independent),
  // collapsing the prior N×M identical reads to ~M. No-op while the relevance
  // flag is off (the cache is simply never consulted).
  const ppCache: PpRelevanceCache = new Map()

  const tasks = opportunities.flatMap((opp) =>
    clients
      .filter((client) => !recentSet.has(`${opp.id}:${client.id}`))
      .map((client) => async (): Promise<boolean> => {
        try {
          // Pass the already-loaded rows so evaluateBidDecision skips its two
          // per-pair findUnique reads (the dominant N×M DB cost of the run).
          await evaluateBidDecision(opp.id, client.id, ppCache, { opportunity: opp, client })
          return true
        } catch (err) {
          logger.warn("Portfolio pair evaluation failed (continuing batch)", {
            opportunityId: opp.id,
            clientId: client.id,
            reason: err instanceof Error ? err.message : String(err),
          })
          return false
        }
      })
  )

  logger.info("Portfolio evaluation starting", {
    opportunities: opportunities.length,
    clients: clients.length,
    newPairs: tasks.length,
    skippedRecent: existingDecisions.length,
    concurrency: CONCURRENCY_LIMIT,
  })

  if (tasks.length === 0) {
    return {
      totalOpportunities: opportunities.length,
      totalClients: clients.length,
      totalEvaluations: 0,
      decisionsCreatedOrUpdated: 0,
      failedPairs: 0,
      note: "All decisions are fresh (< 24h old)",
    }
  }

  const results = await runWithConcurrency(tasks, CONCURRENCY_LIMIT)
  const failedPairs = results.filter((ok) => !ok).length
  const succeededPairs = results.length - failedPairs

  if (failedPairs > 0) {
    logger.warn("Portfolio evaluation finished with failures", {
      consultingFirmId,
      totalEvaluations: tasks.length,
      succeededPairs,
      failedPairs,
    })
  }

  return {
    totalOpportunities: opportunities.length,
    totalClients: clients.length,
    totalEvaluations: tasks.length,
    decisionsCreatedOrUpdated: succeededPairs,
    failedPairs,
  }
}
