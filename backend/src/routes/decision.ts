import { Router } from "express"
import { z } from "zod"
import { prisma } from "../config/database"
import { evaluateBidDecision } from "../services/decisionEngine"
import { runPortfolioEvaluation } from "../services/portfolioDecisionEngine"
import { enqueuePortfolioEvaluation, portfolioScoringQueue } from "../workers/portfolioScoringWorker"
import { Prisma } from "@prisma/client"
import { authenticateJWT, requireRole } from "../middleware/auth"
import { requireActiveBase } from "../middleware/addonGate"
import { enforceTenantScope, getTenantId } from "../middleware/tenant"
import { AuthenticatedRequest } from "../types"
import {
  transitionBidDecisionStatus,
  recordComplianceEvent,
  ComplianceStatus,
} from "../services/complianceStateMachine"
import { logger } from "../utils/logger"

const StatusTransitionSchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "BLOCKED", "REJECTED"]),
  reason: z.string().optional(),
})

const ResolveDecisionSchema = z.object({
  decision: z.enum(["GO", "NO_GO"]),
  note: z.string().max(2000).optional(),
})

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

// ============================================================
// POST /api/decision/run
// ============================================================

router.post("/run", async (req: AuthenticatedRequest, res) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId, clientCompanyId } = req.body

    if (!opportunityId || !clientCompanyId) {
      return res.status(400).json({
        success: false,
        error: "opportunityId and clientCompanyId are required",
      })
    }

    const opportunity = await prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId },
    })

    if (!opportunity) {
      return res.status(404).json({ success: false, error: "Opportunity not found" })
    }

    const client = await prisma.clientCompany.findFirst({
      where: { id: clientCompanyId, consultingFirmId, isActive: true },
      select: { id: true },
    })
    if (!client) {
      return res.status(404).json({ success: false, error: "Client not found" })
    }

    const decision = await evaluateBidDecision(opportunityId, clientCompanyId)

    const winProb = decision.winProbability ?? 0
    const roiRatio = decision.roiRatio ?? 0
    const riskScore = decision.riskScore ?? 0

    const winProbabilityPercent = Math.round(winProb * 100)
    const roiMultiple = roiRatio.toFixed(1) + "x"

    let riskLevel = "LOW"
    if (riskScore >= 20) riskLevel = "HIGH"
    else if (riskScore >= 10) riskLevel = "MODERATE"

    const decisionScore = Math.min(
      Math.round(
        (winProb * 0.4 +
          Math.min(roiRatio / 20, 1) * 0.3 +
          (1 - riskScore / 100) * 0.3) *
          100
      ),
      99
    )

    let deadlineSummary: string | null = null
    let lifetimeValue: number | null = null
    let expectedLifetimeValue: number | null = null
    let subContractShare: number | null = null
    let timeToAwardDiscount: number | null = null
    let credibleInterval: { low: number; high: number; widthPct: number } | null = null
    let setAsideMatch: string | null = null

    if (
      decision.explanationJson &&
      typeof decision.explanationJson === "object" &&
      !Array.isArray(decision.explanationJson)
    ) {
      const explanation = decision.explanationJson as Prisma.JsonObject
      if ("daysToDeadline" in explanation && typeof explanation.daysToDeadline === "number") {
        deadlineSummary = `${Math.floor(explanation.daysToDeadline)}d remaining`
      }
      if ("lifetimeValue" in explanation && typeof explanation.lifetimeValue === "number") {
        lifetimeValue = explanation.lifetimeValue
      }
      if ("expectedLifetimeValue" in explanation && typeof explanation.expectedLifetimeValue === "number") {
        expectedLifetimeValue = explanation.expectedLifetimeValue
      }
      if (
        "credibleInterval" in explanation &&
        explanation.credibleInterval &&
        typeof explanation.credibleInterval === "object" &&
        !Array.isArray(explanation.credibleInterval)
      ) {
        const ci = explanation.credibleInterval as Prisma.JsonObject
        if (
          typeof ci.low === "number" &&
          typeof ci.high === "number" &&
          typeof ci.widthPct === "number"
        ) {
          credibleInterval = { low: ci.low, high: ci.high, widthPct: ci.widthPct }
        }
      }
      if ("setAsideMatch" in explanation && typeof explanation.setAsideMatch === "string") {
        setAsideMatch = explanation.setAsideMatch
      }
      if ("subContractShare" in explanation && typeof explanation.subContractShare === "number") {
        subContractShare = explanation.subContractShare
      }
      if ("timeToAwardDiscount" in explanation && typeof explanation.timeToAwardDiscount === "number") {
        timeToAwardDiscount = explanation.timeToAwardDiscount
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        id: decision.id,
        decisionScore,
        winProbabilityPercent: winProbabilityPercent + "%",
        roiMultiple,
        riskLevel,
        complianceStatus: decision.complianceStatus,
        recommendation: (decision.recommendation ?? "NO_BID").replace("_", " "),
        expectedRevenue: decision.expectedRevenue,
        netExpectedValue: decision.netExpectedValue,
        deadlineSummary,
        lifetimeValue,
        expectedLifetimeValue,
        subContractShare,
        timeToAwardDiscount,
        credibleInterval,
        setAsideMatch,
      },
    })
  } catch (error: any) {
    logger.error("Decision engine error", { error: error.message })
    return res.status(500).json({ success: false, error: "Decision evaluation failed" })
  }
})

// ============================================================
// POST /api/decision/run-all
// ============================================================

router.post("/run-all", async (req: AuthenticatedRequest, res) => {
  try {
    const consultingFirmId = getTenantId(req)
    const results = await runPortfolioEvaluation(consultingFirmId)
    return res.status(200).json({ success: true, data: results })
  } catch (error: any) {
    logger.error("Portfolio decision error", { error: error.message })
    return res.status(500).json({ success: false, error: "Portfolio evaluation failed" })
  }
})

// ============================================================
// POST /api/decision/run-all-async
// Enqueue the portfolio evaluation and return 202 immediately. Prefer this over
// the synchronous /run-all above for large portfolios — the O(N×M) sweep with
// per-pair DB writes should not run in the request path. Poll GET /job/:jobId.
// ============================================================

router.post("/run-all-async", async (req: AuthenticatedRequest, res) => {
  try {
    const consultingFirmId = getTenantId(req)
    const jobId = await enqueuePortfolioEvaluation(consultingFirmId)
    return res.status(202).json({ success: true, data: { jobId, status: "queued" } })
  } catch (error: any) {
    logger.error("Portfolio async enqueue error", { error: error.message })
    return res.status(500).json({ success: false, error: "Failed to queue portfolio evaluation" })
  }
})

// ============================================================
// GET /api/decision/job/:jobId
// Poll the status/result of an enqueued portfolio evaluation. Tenant-scoped:
// only the firm that created the job can read it.
// ============================================================

router.get("/job/:jobId", async (req: AuthenticatedRequest, res) => {
  try {
    const consultingFirmId = getTenantId(req)
    const job = await portfolioScoringQueue.getJob(req.params.jobId)
    if (!job || (job.data as { consultingFirmId?: string } | undefined)?.consultingFirmId !== consultingFirmId) {
      return res.status(404).json({ success: false, error: "Job not found" })
    }
    const state = await job.getState()
    return res.json({
      success: true,
      data: {
        jobId: String(job.id),
        status: state,
        result: state === "completed" ? job.returnvalue : null,
        failedReason: state === "failed" ? job.failedReason : null,
      },
    })
  } catch (error: any) {
    logger.error("Portfolio job status error", { error: error.message })
    return res.status(500).json({ success: false, error: "Failed to read job status" })
  }
})

// ============================================================
// GET /api/decision
// ============================================================

router.get("/", async (req: AuthenticatedRequest, res) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { clientCompanyId, recommendation, complianceStatus, naics, decision, sortBy = "createdAt", order = "desc" } = req.query

    if (clientCompanyId) {
      const client = await prisma.clientCompany.findFirst({
        where: { id: String(clientCompanyId), consultingFirmId },
        select: { id: true },
      })
      if (!client) {
        return res.status(404).json({ success: false, error: "Client not found" })
      }
    }

    const where: any = { consultingFirmId }
    if (clientCompanyId) where.clientCompanyId = String(clientCompanyId)
    if (recommendation) where.recommendation = String(recommendation)
    if (complianceStatus) where.complianceStatus = String(complianceStatus)
    // Human GO / NO_GO (or PENDING) resolution filter. Guard the value so a bad
    // query param can't throw a Prisma enum validation error (500).
    if (decision && ["GO", "NO_GO", "PENDING"].includes(String(decision))) {
      where.decision = String(decision)
    }
    // NAICS filter — matched on the related opportunity (prefix match so a
    // 2–6 digit code works, e.g. "5415" catches all 5415xx).
    if (naics) where.opportunity = { naicsCode: { startsWith: String(naics).trim() } }

    // Whitelist sortBy — it is interpolated into Prisma orderBy, so an unknown
    // column would otherwise throw a validation error (500).
    const SORTABLE = new Set([
      "createdAt", "updatedAt", "winProbability", "fitScore",
      "marketScore", "expectedValue", "netExpectedValue", "roiRatio",
    ])
    const sortField = SORTABLE.has(String(sortBy)) ? String(sortBy) : "createdAt"

    // Bound the query: cap at 500 rows/page (was an unbounded full-table load)
    // with optional offset pagination; meta.total carries the real row count.
    const limitN = Number.parseInt(String(req.query.limit ?? "500"), 10)
    const limit = Number.isFinite(limitN) && limitN > 0 ? Math.min(limitN, 500) : 500
    const offsetN = Number.parseInt(String(req.query.offset ?? "0"), 10)
    const offset = Number.isFinite(offsetN) && offsetN > 0 ? offsetN : 0

    const [decisions, total] = await Promise.all([
      prisma.bidDecision.findMany({
        where,
        // `id` tiebreaker: every sortable column is non-unique (batch runs
        // produce same-ms createdAt and heavily tied scores), and Postgres
        // gives no stable order among ties — offset pages could skip or
        // duplicate rows between requests without it.
        orderBy: [{ [sortField]: order === "asc" ? "asc" : "desc" }, { id: "desc" }],
        // Select only what the Decisions page + CSV export render. A bare
        // `include: { opportunity: true }` shipped the full row INCLUDING the
        // savedProposalDraft/Outline/Answers JSON blobs — tens of MB per
        // 500-row export page to fill a handful of scalar CSV columns.
        include: {
          opportunity: {
            select: {
              id: true, title: true, agency: true, naicsCode: true, setAsideType: true,
              estimatedValue: true, responseDeadline: true, samNoticeId: true, status: true,
            },
          },
          clientCompany: { select: { id: true, name: true } },
        },
        take: limit,
        skip: offset,
      }),
      prisma.bidDecision.count({ where }),
    ])

    // `meta.total` is the canonical shape (matches the rest of the API).
    // `count` is kept as a deprecated alias for one release to avoid breaking
    // existing frontend consumers; remove once they read `meta.total`.
    return res.status(200).json({
      success: true,
      data: decisions,
      meta: { total, limit, offset, returned: decisions.length },
      count: total,
    })
  } catch (error: any) {
    logger.error("Decision fetch error", { error: error.message })
    return res.status(500).json({ success: false, error: "Failed to fetch decisions" })
  }
})

// ============================================================
// GET /api/decision/metrics
// ============================================================

router.get("/metrics", async (req: AuthenticatedRequest, res) => {
  try {
    const consultingFirmId = getTenantId(req)

    // Aggregate in the DB rather than loading every row into memory (was a
    // full-table scan + in-process reduce — unbounded memory at scale).
    const [agg, byRec] = await Promise.all([
      prisma.bidDecision.aggregate({
        where: { consultingFirmId },
        _count: { _all: true },
        _avg: { winProbability: true, roiRatio: true },
        _sum: { expectedRevenue: true, netExpectedValue: true },
      }),
      prisma.bidDecision.groupBy({
        by: ["recommendation"],
        where: { consultingFirmId },
        _count: { _all: true },
      }),
    ])

    const totalEvaluated = agg._count._all

    if (totalEvaluated === 0) {
      return res.status(200).json({
        success: true,
        data: {
          totalEvaluated: 0,
          totalPrime: 0,
          totalSub: 0,
          totalNoBid: 0,
          averageWinProbability: 0,
          averageROI: 0,
          totalExpectedRevenue: 0,
          totalNetExpectedValue: 0,
        },
      })
    }

    const recCount = (r: string) => byRec.find((g) => g.recommendation === r)?._count._all ?? 0
    const totalPrime = recCount("BID_PRIME")
    const totalSub = recCount("BID_SUB")
    const totalNoBid = recCount("NO_BID")
    const averageWinProbability = agg._avg.winProbability ?? 0
    const averageROI = agg._avg.roiRatio ?? 0
    const totalExpectedRevenue = Number(agg._sum.expectedRevenue ?? 0)
    const totalNetExpectedValue = Number(agg._sum.netExpectedValue ?? 0)

    return res.status(200).json({
      success: true,
      data: {
        totalEvaluated,
        totalPrime,
        totalSub,
        totalNoBid,
        averageWinProbability: Number((averageWinProbability * 100).toFixed(1)) + "%",
        averageROI: Number(averageROI.toFixed(2)) + "x",
        totalExpectedRevenue,
        totalNetExpectedValue,
      },
    })
  } catch (error: any) {
    logger.error("Decision metrics error", { error: error.message })
    return res.status(500).json({ success: false, error: "Failed to compute metrics" })
  }
})

// ============================================================
// GET /api/decision/queue
// Ranked shortlist of PENDING decisions the engine recommended bidding on,
// so they don't sit unactioned. Rank = fit x value x deadline-urgency.
// Filters to ACTIVE opps with a future deadline + a BID recommendation.
// ============================================================

router.get("/queue", async (req: AuthenticatedRequest, res) => {
  try {
    const consultingFirmId = getTenantId(req)
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200)
    const now = new Date()

    const rows = await prisma.bidDecision.findMany({
      where: {
        consultingFirmId,
        decision: "PENDING",
        recommendation: { in: ["BID_PRIME", "BID_SUB"] },
        opportunity: { status: "ACTIVE", responseDeadline: { gt: now } },
      },
      select: {
        id: true,
        recommendation: true,
        rationale: true,
        winProbability: true,
        fitScore: true,
        expectedValue: true,
        netExpectedValue: true,
        complianceGate: true,
        clientCompany: { select: { id: true, name: true } },
        opportunity: {
          select: {
            id: true, title: true, agency: true, setAsideType: true,
            responseDeadline: true, estimatedValue: true, probabilityScore: true,
          },
        },
      },
      take: 1000,
    })

    const scored = rows.map((d) => {
      const fit = d.winProbability ?? (d.fitScore != null ? d.fitScore / 100 : 0)
      const value = Number(d.expectedValue ?? d.opportunity.estimatedValue ?? 0)
      const valueWeight = Math.log10(Math.max(value, 0) + 10) // dampened so a huge contract can't dominate
      const days = Math.ceil(((d.opportunity.responseDeadline as Date).getTime() - now.getTime()) / 86_400_000)
      const urgency = days <= 0 ? 0 : days <= 7 ? 1.3 : days <= 21 ? 1.15 : days <= 45 ? 1.0 : 0.85
      return { ...d, daysToDeadline: days, rankScore: Number((fit * valueWeight * urgency).toFixed(4)) }
    })
    scored.sort((a, b) => b.rankScore - a.rankScore)

    return res.json({
      success: true,
      data: scored.slice(0, limit),
      meta: { total: scored.length, returned: Math.min(scored.length, limit) },
    })
  } catch (error: any) {
    logger.error("Decision queue error", { error: error.message })
    return res.status(500).json({ success: false, error: "Failed to build decision queue" })
  }
})

// ============================================================
// PATCH /api/decision/:id/decision  (ADMIN only)
// Resolve the human GO / NO_GO. On GO, enter the submission -> outcome track
// (idempotent) so the result can later be recorded — which feeds win-rate KPIs
// and the calibration backtest's labeled-outcome source.
// ============================================================

router.patch("/:id/decision", requireRole("ADMIN"), async (req: AuthenticatedRequest, res) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { decision, note } = ResolveDecisionSchema.parse(req.body)

    const existing = await prisma.bidDecision.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, opportunityId: true, clientCompanyId: true, rationale: true },
    })
    if (!existing) {
      return res.status(404).json({ success: false, error: "Decision not found" })
    }

    // Section 4 #4: resolve the decision, (idempotently) open the submission
    // track, and write the audit rows in ONE transaction so the compliance log
    // can never silently disagree with the business state.
    const { updated, submissionId } = await prisma.$transaction(async (tx) => {
      const updatedDecision = await tx.bidDecision.update({
        where: { id: existing.id },
        data: {
          decision,
          ...(note
            ? { rationale: existing.rationale ? `${existing.rationale}\n[${decision} note] ${note}` : `[${decision} note] ${note}` }
            : {}),
        },
        select: { id: true, decision: true },
      })

      // Audit the human GO/NO_GO decision itself.
      await recordComplianceEvent(tx, {
        entityType: "BID_DECISION",
        entityId: existing.id,
        toStatus: decision,
        consultingFirmId,
        triggeredBy: req.user?.userId,
        reason: note ? `Decision ${decision}: ${note}` : `Decision resolved: ${decision}`,
        dedupeOn: "entity-status",
      })

      let subId: string | null = null
      if (decision === "GO") {
        const existingSub = await tx.submissionRecord.findFirst({
          where: { consultingFirmId, opportunityId: existing.opportunityId, clientCompanyId: existing.clientCompanyId },
          select: { id: true },
        })
        if (existingSub) {
          subId = existingSub.id
        } else {
          const created = await tx.submissionRecord.create({
            data: {
              consultingFirmId,
              clientCompanyId: existing.clientCompanyId,
              opportunityId: existing.opportunityId,
              submittedById: req.user?.userId ?? null,
              submittedAt: null, // planned/in-progress until actually submitted
              status: "PENDING",
              notes: note ?? "Created from GO decision — pending submission + outcome.",
            },
            select: { id: true, status: true },
          })
          subId = created.id
          await recordComplianceEvent(tx, {
            entityType: "SUBMISSION",
            entityId: created.id,
            toStatus: created.status ?? "PENDING",
            consultingFirmId,
            triggeredBy: req.user?.userId,
            reason: "Submission opened from GO decision",
            dedupeOn: "entity-creation",
          })
        }
      }

      return { updated: updatedDecision, submissionId: subId }
    })

    return res.json({ success: true, data: { id: updated.id, decision: updated.decision, submissionId } })
  } catch (error: any) {
    if (error?.name === "ZodError") {
      return res.status(400).json({ success: false, error: "decision must be GO or NO_GO" })
    }
    logger.error("Decision resolve error", { error: error.message })
    return res.status(500).json({ success: false, error: "Failed to resolve decision" })
  }
})

// ============================================================
// PATCH /api/decision/:id/status  (ADMIN only)
// Manually transition a BidDecision compliance status.
// ============================================================

router.patch("/:id/status", requireRole("ADMIN"), async (req: AuthenticatedRequest, res) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { status, reason } = StatusTransitionSchema.parse(req.body)

    const result = await transitionBidDecisionStatus({
      decisionId: req.params.id,
      toStatus: status as ComplianceStatus,
      consultingFirmId,
      triggeredBy: req.user?.userId,
      reason,
    })

    if (!result.success) {
      return res.status(422).json({
        success: false,
        error: result.error,
        code: "INVALID_TRANSITION",
      })
    }

    return res.json({ success: true, data: { id: req.params.id, status } })
  } catch (error: any) {
    return res.status(500).json({ success: false, error: "Status transition failed" })
  }
})

export default router
