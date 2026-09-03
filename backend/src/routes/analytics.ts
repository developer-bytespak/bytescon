import { Router, Response, NextFunction } from 'express'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { prisma } from '../config/database'
import {
  getSubmissionTrends,
  getPenaltyTrends,
  getWinRateTrends,
  getOpportunityVolumeTrends,
} from '../services/trendAnalysis'
import {
  getNaicsTrends,
  getAgencyProfiles,
  getCompetitiveLandscape,
} from '../services/marketIntelligence'
import { findTopMatches } from '../services/opportunityMatcher'
import { computeRiskRadar } from '../services/riskRadar'
import { getPortfolioHealth } from '../services/revenueForecaster'
import { logger } from '../utils/logger'

const router = Router()

// All analytics routes require auth + tenant scope
router.use(authenticateJWT, enforceTenantScope)
// Firm-pipeline KPIs (/trends, /pipeline, /predictions, /portfolio-health)
// power the BASE dashboard; only the deep external-market endpoints below
// carry the market_intel module gate.
router.use(requireActiveBase)

// =============================================================
// GET /api/analytics/trends
// Time-series data for all trend charts
// =============================================================
router.get(
  '/trends',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)
      const months = Math.min(parseInt(req.query.months as string) || 12, 24)

      const [submissions, penalties, winRate, volume] = await Promise.all([
        getSubmissionTrends(consultingFirmId, months),
        getPenaltyTrends(consultingFirmId, months),
        getWinRateTrends(consultingFirmId, months),
        getOpportunityVolumeTrends(consultingFirmId, months),
      ])

      res.json({
        success: true,
        data: { submissions, penalties, winRate, volume },
      })
    } catch (err) {
      next(err)
    }
  }
)

// =============================================================
// GET /api/analytics/pipeline
// Opportunity pipeline funnel
// =============================================================
router.get(
  '/pipeline',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)

      const [ingested, scored, decided, submitted, wonStats] = await Promise.all([
        prisma.opportunity.count({ where: { consultingFirmId } }),

        prisma.opportunity.count({
          where: { consultingFirmId, isScored: true },
        }),

        prisma.bidDecision.count({
          where: { consultingFirmId, recommendation: { not: null } },
        }),

        prisma.submissionRecord.count({ where: { consultingFirmId } }),

        prisma.performanceStats.aggregate({
          where: { clientCompany: { consultingFirmId } },
          _sum: { totalWon: true },
        }),
      ])

      const won = wonStats._sum.totalWon || 0

      const stages = [
        { label: 'Ingested', count: ingested },
        { label: 'Scored', count: scored },
        { label: 'Decided', count: decided },
        { label: 'Submitted', count: submitted },
        { label: 'Won', count: won },
      ]

      const conversionRates = []
      for (let i = 0; i < stages.length - 1; i++) {
        conversionRates.push({
          fromStage: stages[i].label,
          toStage: stages[i + 1].label,
          rate:
            stages[i].count > 0
              ? Math.round((stages[i + 1].count / stages[i].count) * 100)
              : 0,
        })
      }

      res.json({
        success: true,
        data: { stages, conversionRates },
      })
    } catch (err) {
      next(err)
    }
  }
)

// =============================================================
// GET /api/analytics/market-intelligence
// NAICS trends, agency profiles, competitive landscape
// =============================================================
router.get(
  '/market-intelligence',
  requireAddon('market_intel'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)

      const [naicsTrends, agencyProfiles, competitiveLandscape] = await Promise.all([
        getNaicsTrends(consultingFirmId),
        getAgencyProfiles(consultingFirmId),
        getCompetitiveLandscape(consultingFirmId),
      ])

      res.json({
        success: true,
        data: { naicsTrends, agencyProfiles, competitiveLandscape },
      })
    } catch (err) {
      next(err)
    }
  }
)

// =============================================================
// GET /api/analytics/predictions
// Opportunity suggestions + risk radar
// =============================================================
router.get(
  '/predictions',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)

      const [opportunitySuggestions, riskItems] = await Promise.all([
        findTopMatches(consultingFirmId, 10),
        computeRiskRadar(consultingFirmId),
      ])

      // Generate recommended actions from risk items
      const recommendedActions = riskItems
        .filter((r) => r.severity === 'CRITICAL' || r.severity === 'HIGH')
        .slice(0, 5)
        .map((r, i) => ({
          priority: i + 1,
          action:
            r.entityType === 'DEADLINE'
              ? `Submit proposal for "${r.title}" — ${r.description}`
              : r.entityType === 'COMPLIANCE'
              ? `Review compliance block: ${r.description}`
              : `Address: ${r.description}`,
          entityType: r.entityType,
          entityId: r.entityId,
        }))

      res.json({
        success: true,
        data: {
          opportunitySuggestions,
          riskItems,
          recommendedActions,
        },
      })
    } catch (err) {
      next(err)
    }
  }
)

// =============================================================
// GET /api/analytics/portfolio-health
// Revenue forecasting + diversification + risk indicators
// =============================================================
router.get(
  '/portfolio-health',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)
      const health = await getPortfolioHealth(consultingFirmId)

      res.json({
        success: true,
        data: health,
      })
    } catch (err) {
      next(err)
    }
  }
)

// =============================================================
// GET /api/analytics/compliance-logs
// Audit trail query — reads the first-class AuditEvent log (every
// mutation / decision / inference), not the legacy status-only
// ComplianceLog. Response shape is preserved for the existing UI:
// each row exposes fromStatus → toStatus, reason, triggeredBy.
// =============================================================
const AUDIT_STATUS_KEYS = [
  'status',
  'toStatus',
  'pipelineStage',
  'stage',
  'decision',
  'recommendation',
  'agreementStatus',
  'ndaStatus',
  'teamingStatus',
  'exerciseStatus',
]

function pickAuditStatus(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const obj = json as Record<string, unknown>
  for (const key of AUDIT_STATUS_KEYS) {
    if (obj[key] != null) return String(obj[key])
  }
  return null
}

router.get(
  '/compliance-logs',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)
      const {
        entityType,
        entityId,
        from,
        to,
        page = '1',
        limit = '50',
      } = req.query as Record<string, string>

      const pageNum = Math.max(1, parseInt(page) || 1)
      const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50))

      // The audit log stores model names (SubmissionRecord, BidDecision, ...)
      // while the UI and older callers filter with the legacy
      // ComplianceLogEntityType vocabulary (SUBMISSION, BID_DECISION, ...).
      // Translate the legacy values; unknown values pass through verbatim so
      // model-name filters keep working. Without this the entityType filter
      // silently matched nothing for every legacy value.
      const LEGACY_ENTITY_TYPE: Record<string, string> = {
        SUBMISSION: 'SubmissionRecord',
        BID_DECISION: 'BidDecision',
        OPPORTUNITY: 'Opportunity',
        CLIENT_COMPANY: 'ClientCompany',
        DOCUMENT_REQUIREMENT: 'DocumentRequirement',
        TEAMING_RELATIONSHIP: 'TeamingRelationship',
      }
      const where: any = { consultingFirmId }
      if (entityType) where.entityType = LEGACY_ENTITY_TYPE[entityType] ?? entityType
      if (entityId) where.entityId = entityId
      if (from || to) {
        where.createdAt = {}
        if (from) where.createdAt.gte = new Date(from)
        if (to) where.createdAt.lte = new Date(to)
      }

      const [events, total] = await Promise.all([
        prisma.auditEvent.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (pageNum - 1) * limitNum,
          take: limitNum,
        }),
        prisma.auditEvent.count({ where }),
      ])

      // Resolve actor ids → names for this page (single batched query).
      const actorIds = [...new Set(events.map((e) => e.actorUserId).filter(Boolean) as string[])]
      const actors = actorIds.length
        ? await prisma.user.findMany({ where: { id: { in: actorIds }, consultingFirmId }, select: { id: true, firstName: true, lastName: true, email: true } })
        : []
      const actorName = new Map(actors.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim() || u.email]))

      const logs = events.map((e) => {
        const derivedFrom = pickAuditStatus(e.beforeJson)
        const derivedTo = pickAuditStatus(e.afterJson)
        return {
          id: e.id,
          createdAt: e.createdAt,
          entityType: e.entityType,
          entityId: e.entityId,
          action: e.action,
          fromStatus: derivedFrom,
          toStatus: derivedTo ?? e.action,
          reason: e.rationale,
          triggeredBy: e.actorUserId,
          actorName: e.actorUserId ? actorName.get(e.actorUserId) ?? null : null,
          actorRole: e.actorRole,
        }
      })

      res.json({
        success: true,
        data: {
          logs,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            pages: Math.ceil(total / limitNum),
          },
        },
      })
    } catch (err) {
      next(err)
    }
  }
)

// =============================================================
// GET /api/analytics/pipeline-analysis
// Markov chain pipeline transitions + Wilson CI win rate by agency
// =============================================================
router.get(
  '/pipeline-analysis',
  requireAddon('market_intel'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)

      // Gather pipeline stage counts — separate BID vs NO_BID decisions
      const [ingested, scored, decidedBid, decidedNoBid, submitted, wonStats] = await Promise.all([
        prisma.opportunity.count({ where: { consultingFirmId } }),
        prisma.opportunity.count({ where: { consultingFirmId, isScored: true } }),
        // Only BID_PRIME / BID_SUB lead to submissions — exclude NO_BID from funnel
        prisma.bidDecision.count({
          where: { consultingFirmId, recommendation: { in: ['BID_PRIME', 'BID_SUB'] } },
        }),
        prisma.bidDecision.count({
          where: { consultingFirmId, recommendation: 'NO_BID' },
        }),
        prisma.submissionRecord.count({ where: { consultingFirmId } }),
        prisma.performanceStats.aggregate({
          where: { clientCompany: { consultingFirmId } },
          _sum: { totalWon: true },
        }),
      ])

      const totalWon    = wonStats._sum.totalWon ?? 0
      const totalDecided = decidedBid + decidedNoBid
      const isDataSparse = ingested < 10

      // Markov chain: each transition probability is P(next_stage | current_stage).
      // Capped at 1.0 to guard against count ordering inconsistencies in early data.
      // Laplace smoothing (+1 / +2) applied when data is sparse (< 10 records total)
      // so the chain never collapses to zero in a demo environment.
      const smooth = (num: number, den: number): number => {
        if (isDataSparse) return Math.min(1, (num + 1) / (den + 2))
        return Math.min(1, num / Math.max(den, 1))
      }

      const pScoredGivenIngested   = smooth(scored,     ingested)
      const pDecidedGivenScored    = smooth(totalDecided, scored)
      // Bid rate = fraction of decided that are actionable (BID not NO_BID)
      const pBidGivenDecided       = smooth(decidedBid, totalDecided)
      // Submission rate against BID decisions only
      const pSubmittedGivenBid     = smooth(submitted,  decidedBid)
      const pWonGivenSubmitted      = smooth(totalWon,   submitted)

      const endToEnd =
        pScoredGivenIngested *
        pDecidedGivenScored *
        pBidGivenDecided *
        pSubmittedGivenBid *
        pWonGivenSubmitted

      const markovChain = [
        {
          from: 'Ingested',
          to: 'Scored',
          probability: pScoredGivenIngested,
          fromCount: ingested,
          toCount: scored,
          label: 'AI Scoring Rate',
        },
        {
          from: 'Scored',
          to: 'Decided',
          probability: pDecidedGivenScored,
          fromCount: scored,
          toCount: totalDecided,
          label: 'Decision Coverage',
        },
        {
          from: 'Decided',
          to: 'Bid',
          probability: pBidGivenDecided,
          fromCount: totalDecided,
          toCount: decidedBid,
          label: 'Bid Rate (vs No-Bid)',
          noBid: decidedNoBid,
        },
        {
          from: 'Bid',
          to: 'Submitted',
          probability: pSubmittedGivenBid,
          fromCount: decidedBid,
          toCount: submitted,
          label: 'Proposal Completion Rate',
        },
        {
          from: 'Submitted',
          to: 'Won',
          probability: pWonGivenSubmitted,
          fromCount: submitted,
          toCount: totalWon,
          label: 'Win Rate',
        },
      ]

      // Agency win rate with Wilson 90% CI (z = 1.645)
      const submissions = await prisma.submissionRecord.findMany({
        where: { consultingFirmId },
        select: {
          wasOnTime: true,
          status: true,
          opportunity: { select: { agency: true, status: true } },
        },
      })

      const agencyMap: Record<string, { wins: number; n: number }> = {}
      for (const s of submissions) {
        const agency = s.opportunity?.agency ?? 'Unknown'
        if (!agencyMap[agency]) agencyMap[agency] = { wins: 0, n: 0 }
        agencyMap[agency].n += 1
        // Count as a win when the related opportunity was awarded
        if (s.opportunity?.status === 'AWARDED') agencyMap[agency].wins += 1
      }

      const z = 1.645
      const agencyWinRates = Object.entries(agencyMap)
        .filter(([, v]) => v.n >= 2)
        .map(([agency, v]) => {
          const { wins, n } = v
          const phat = wins / n
          const denom = 1 + (z * z) / n
          const center = (phat + (z * z) / (2 * n)) / denom
          const margin =
            (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom
          const ciLower = Math.max(0, center - margin)
          const ciUpper = Math.min(1, center + margin)
          return {
            agency,
            wins,
            losses: n - wins,
            n,
            winRate: phat,
            ciLower,
            ciUpper,
          }
        })
        .sort((a, b) => b.n - a.n)
        .slice(0, 10)

      res.json({
        success: true,
        data: {
          markovChain,
          agencyWinRates,
          endToEndConversion: endToEnd,
          expectedWinsPerHundred: endToEnd * 100,
          isDataSparse,
          summary: {
            ingested,
            scored,
            decidedBid,
            decidedNoBid,
            submitted,
            won: totalWon,
            bidRate: pBidGivenDecided,
            winRate: pWonGivenSubmitted,
          },
        },
      })
    } catch (err) {
      next(err)
    }
  }
)

export default router
