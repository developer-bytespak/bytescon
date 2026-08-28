// =============================================================
// §7.6 — Pricing Agent API.
//
// Deliberately small. Runs, schedules and escalations are already served by the
// generic `/api/agents` surface and are NOT recreated here.
//
//   GET /assessment/:workspaceId   latest PRICING_ASSESSMENT + run + escalations
//   GET /cohort/:cohortId          the cohort's public award composition
//
// BOTH ROUTES ARE READ-ONLY. There is no endpoint here that changes a rate, an
// hour count, a fee, the preferred scenario, or a PricingReview — those remain
// the existing human `/api/pricing` surface, untouched by this slice.
//
// Mounted at /api/agents/pricing. Tenant-scoped throughout.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError } from '../utils/errors'
import { prisma } from '../config/database'
import {
  MIN_BENCHMARK_COHORT_SIZE,
  STRONG_BENCHMARK_COHORT_SIZE,
  DEFAULT_LOOKBACK_MONTHS,
  VALUE_BAND_LOW_RATIO,
  VALUE_BAND_HIGH_RATIO,
  NON_COMPARABLE_AWARD_TYPES,
} from '../services/agents/pricing/awardBenchmark'
import { OUTLIER_IQR_MULTIPLIER, COMPETITIVE_RANGE_POLICY_VERSION } from '../services/agents/pricing/competitiveRange'
import { PRICING_RISK_WORKING_DAYS } from '../services/agents/pricing/pricingAgentHandler'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const AGENT_KEY = 'PRICING' as const

/** The policy the UI displays so a reader can check the numbers themselves. */
const PRICING_POLICY = {
  policyVersion: COMPETITIVE_RANGE_POLICY_VERSION,
  minimumCohortSize: MIN_BENCHMARK_COHORT_SIZE,
  strongCohortSize: STRONG_BENCHMARK_COHORT_SIZE,
  lookbackMonths: DEFAULT_LOOKBACK_MONTHS,
  valueBandLowRatio: VALUE_BAND_LOW_RATIO,
  valueBandHighRatio: VALUE_BAND_HIGH_RATIO,
  outlierIqrMultiplier: OUTLIER_IQR_MULTIPLIER,
  riskWorkingDays: PRICING_RISK_WORKING_DAYS,
  nonComparableAwardTypes: NON_COMPARABLE_AWARD_TYPES,
  notes: [
    'The benchmark is built from public federal award records only. No other firm\'s pricing is ever read.',
    `Below ${MIN_BENCHMARK_COHORT_SIZE} comparable awards no percentile and no competitive-range conclusion is calculated.`,
    'Below or above the historical range is a statement about position, not a judgement that the price is wrong.',
    'The agent recomputes derived totals and reports. It never changes a rate, hours, a fee, or the preferred scenario.',
  ],
}

// `PricingWorkspace.opportunityId` is a loose scalar, not a Prisma relation,
// so the opportunity is read separately — and under the same tenant scope.
async function loadWorkspace(consultingFirmId: string, workspaceId: string) {
  const workspace = await prisma.pricingWorkspace.findFirst({
    where: { id: workspaceId, consultingFirmId },
    select: {
      id: true, opportunityId: true, title: true, status: true,
      ownerUserId: true, preferredScenarioId: true,
    },
  })
  if (!workspace) throw new NotFoundError('Pricing workspace')

  const opportunity = await prisma.opportunity.findFirst({
    where: { id: workspace.opportunityId, consultingFirmId },
    select: { id: true, title: true, agency: true, naicsCode: true, responseDeadline: true },
  })
  return { ...workspace, opportunity }
}

// -------------------------------------------------------------
// GET /assessment/:workspaceId
// -------------------------------------------------------------

router.get('/assessment/:workspaceId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const workspace = await loadWorkspace(consultingFirmId, req.params.workspaceId)

    const [artifact, schedule, lastRun, escalations] = await Promise.all([
      prisma.agentArtifact.findFirst({
        where: {
          consultingFirmId, agentKey: AGENT_KEY, artifactType: 'PRICING_ASSESSMENT',
          sourceEntityType: 'PricingWorkspace', sourceEntityId: workspace.id,
          supersededByArtifactId: null,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.agentSchedule.findFirst({
        where: { consultingFirmId, agentKey: AGENT_KEY },
        select: {
          isEnabled: true, cronExpression: true, nextRunAt: true, lastRunAt: true,
          lastSuccessfulRunAt: true, lastFailureAt: true, lastFailureMessage: true, autonomyLevel: true,
        },
      }),
      prisma.agentRun.findFirst({
        where: { consultingFirmId, agentKey: AGENT_KEY },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, status: true, triggerType: true, createdAt: true, finishedAt: true,
          outputSummary: true, warnings: true, limitations: true,
          tokenInput: true, tokenOutput: true, estimatedCostUsd: true,
        },
      }),
      prisma.agentEscalation.findMany({
        where: {
          consultingFirmId, agentKey: AGENT_KEY, status: { in: ['OPEN', 'ACKNOWLEDGED'] },
          entityType: 'PricingWorkspace', entityId: workspace.id,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true, severity: true, status: true, title: true, reason: true,
          recommendedAction: true, createdAt: true,
        },
      }),
    ])

    res.json({
      success: true,
      data: {
        agentKey: AGENT_KEY,
        workspace,
        schedule,
        lastRun,
        // null = the agent has not assessed this workspace yet.
        assessment: artifact
          ? { artifactId: artifact.id, generatedAt: artifact.createdAt, ...(artifact.structuredData as object) }
          : null,
        escalations,
        policy: PRICING_POLICY,
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /cohort/:cohortId — the public award composition
// -------------------------------------------------------------

router.get('/cohort/:cohortId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    // Scoped find + 404: another firm's cached cohort is not merely forbidden,
    // its existence is not disclosed.
    const cohort = await prisma.awardBenchmarkCohort.findFirst({
      where: { id: req.params.cohortId, consultingFirmId },
    })
    if (!cohort) throw new NotFoundError('Award benchmark cohort')

    res.json({
      success: true,
      data: {
        cohort,
        // Stated on the wire as well as in the docs: the composition below is
        // public federal award data, which is why it can be shown in full.
        provenance: {
          sourceKind: 'PUBLIC_FEDERAL_AWARD_RECORDS',
          note: 'Every award listed is a public federal award record. No tenant-private pricing contributed to this cohort.',
        },
        policy: PRICING_POLICY,
      },
    })
  } catch (err) { next(err) }
})

export default router
