// =============================================================
// portfolioDecisionEngine tests (P1-1 per-pair failure isolation)
//
// evaluateBidDecision now throws when the win-probability compute
// returns FAILED. The portfolio engine must isolate that failure to
// the single (opportunity, client) pair: log it, count it, and keep
// evaluating the rest of the batch. The function must resolve even
// when every pair fails, and the pre-existing return fields consumed
// by routes/opportunities.ts, routes/decision.ts, and the portfolio
// scoring worker must be preserved.
// =============================================================

import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------- mocks (must be hoisted above the import under test) ----------

vi.mock("../config/database", () => ({
  prisma: {
    opportunity: { findMany: vi.fn() },
    clientCompany: { findMany: vi.fn() },
    bidDecision: { findMany: vi.fn() },
  },
}))

vi.mock("./decisionEngine", () => ({
  evaluateBidDecision: vi.fn(),
  // Re-exported by portfolioDecisionEngine for the bulk opportunity load; the
  // mocked findMany ignores the actual select, so a stub shape is enough.
  OPPORTUNITY_SCORING_SELECT: { id: true },
}))

vi.mock("../utils/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { runPortfolioEvaluation } from "./portfolioDecisionEngine"
import { prisma } from "../config/database"
import { evaluateBidDecision } from "./decisionEngine"
import { logger } from "../utils/logger"

type Mock = ReturnType<typeof vi.fn>

const FIRM_ID = "firm-1"

function setupFixtures(opts?: {
  opportunities?: { id: string; probabilityScore: number }[]
  clients?: { id: string }[]
  recentDecisions?: { opportunityId: string; clientCompanyId: string }[]
}) {
  const opportunities = opts?.opportunities ?? [
    { id: "opp-1", probabilityScore: 80 },
    { id: "opp-2", probabilityScore: 60 },
  ]
  const clients = opts?.clients ?? [{ id: "client-1" }, { id: "client-2" }]

  ;(prisma.opportunity.findMany as Mock).mockResolvedValue(opportunities)
  ;(prisma.clientCompany.findMany as Mock).mockResolvedValue(clients)
  ;(prisma.bidDecision.findMany as Mock).mockResolvedValue(opts?.recentDecisions ?? [])
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("runPortfolioEvaluation (P1-1 per-pair failure isolation)", () => {
  it("a throwing pair does not prevent the other pairs from being evaluated and persisted", async () => {
    setupFixtures()

    // Poison exactly one pair (opp-1, client-2); the other three succeed.
    ;(evaluateBidDecision as Mock).mockImplementation(
      async (opportunityId: string, clientCompanyId: string) => {
        if (opportunityId === "opp-1" && clientCompanyId === "client-2") {
          throw new Error("Decision aborted: win probability unavailable (FAILED)")
        }
        return { id: `${opportunityId}:${clientCompanyId}` }
      }
    )

    const result = await runPortfolioEvaluation(FIRM_ID)

    // Every pair was attempted, including the ones after the poison pair.
    expect(evaluateBidDecision).toHaveBeenCalledTimes(4)
    const attemptedPairs = (evaluateBidDecision as Mock).mock.calls.map(
      ([oppId, clientId]) => `${oppId}:${clientId}`
    )
    expect(attemptedPairs).toEqual(
      expect.arrayContaining([
        "opp-1:client-1",
        "opp-1:client-2",
        "opp-2:client-1",
        "opp-2:client-2",
      ])
    )

    // Only the successful pairs count as created/updated; the failure is counted.
    expect(result.totalEvaluations).toBe(4)
    expect(result.decisionsCreatedOrUpdated).toBe(3)
    expect(result.failedPairs).toBe(1)

    // The failure was logged with the pair identifiers and a reason.
    expect(logger.warn).toHaveBeenCalledWith(
      "Portfolio pair evaluation failed (continuing batch)",
      expect.objectContaining({
        opportunityId: "opp-1",
        clientId: "client-2",
        reason: expect.stringContaining("win probability unavailable"),
      })
    )
  })

  it("threads ONE shared past-performance cache instance into every pair (N×M dedup wiring)", async () => {
    setupFixtures()
    ;(evaluateBidDecision as Mock).mockResolvedValue({ id: "d" })

    await runPortfolioEvaluation(FIRM_ID)

    // The 3rd arg to every evaluateBidDecision call is the per-run cache.
    const calls = (evaluateBidDecision as Mock).mock.calls
    const caches = calls.map((args) => args[2])
    expect(caches).toHaveLength(4)
    expect(caches.every((c) => c instanceof Map)).toBe(true)
    // Same Map instance across all pairs — a regression that allocates a fresh
    // Map per pair (reverting to N×M reads) or drops the arg fails here.
    expect(new Set(caches).size).toBe(1)

    // Each pair also receives its pre-loaded opportunity + client rows (4th arg)
    // so evaluateBidDecision skips the per-pair findUnique reads. Dropping this
    // reverts to N×M DB reads — caught here.
    expect(
      calls.every(
        ([oppId, clientId, , preloaded]) =>
          preloaded?.opportunity?.id === oppId && preloaded?.client?.id === clientId
      )
    ).toBe(true)
  })

  it("resolves with a correct failure count when every pair fails", async () => {
    setupFixtures()
    ;(evaluateBidDecision as Mock).mockRejectedValue(new Error("boom"))

    // Must resolve, never reject, even when the whole batch fails.
    const result = await runPortfolioEvaluation(FIRM_ID)

    expect(evaluateBidDecision).toHaveBeenCalledTimes(4)
    expect(result.totalEvaluations).toBe(4)
    expect(result.decisionsCreatedOrUpdated).toBe(0)
    expect(result.failedPairs).toBe(4)
    expect(logger.warn).toHaveBeenCalledTimes(5) // 4 per-pair + 1 batch summary
  })

  it("preserves the existing return fields consumed by the routes and the worker", async () => {
    setupFixtures()
    ;(evaluateBidDecision as Mock).mockResolvedValue({ id: "decision-1" })

    const result = await runPortfolioEvaluation(FIRM_ID)

    // Pre-existing shape (routes/decision.ts returns this object as JSON;
    // the worker reads totalEvaluations + decisionsCreatedOrUpdated).
    expect(result).toMatchObject({
      totalOpportunities: 2,
      totalClients: 2,
      totalEvaluations: 4,
      decisionsCreatedOrUpdated: 4,
    })
    expect(result.failedPairs).toBe(0)
  })

  it("keeps the early-return shapes intact (empty portfolio and all-fresh decisions)", async () => {
    // Empty portfolio: no opportunities.
    setupFixtures({ opportunities: [] })
    const empty = await runPortfolioEvaluation(FIRM_ID)
    expect(empty).toMatchObject({
      totalOpportunities: 0,
      totalClients: 0,
      totalEvaluations: 0,
      decisionsCreatedOrUpdated: 0,
    })

    // All pairs already have a fresh (< 24h) decision.
    setupFixtures({
      recentDecisions: [
        { opportunityId: "opp-1", clientCompanyId: "client-1" },
        { opportunityId: "opp-1", clientCompanyId: "client-2" },
        { opportunityId: "opp-2", clientCompanyId: "client-1" },
        { opportunityId: "opp-2", clientCompanyId: "client-2" },
      ],
    })
    const fresh = await runPortfolioEvaluation(FIRM_ID)
    expect(evaluateBidDecision).not.toHaveBeenCalled()
    expect(fresh).toMatchObject({
      totalOpportunities: 2,
      totalClients: 2,
      totalEvaluations: 0,
      decisionsCreatedOrUpdated: 0,
      note: "All decisions are fresh (< 24h old)",
    })
  })
})
