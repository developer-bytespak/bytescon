// =============================================================
// §7.8 — Finance Agent API.
//
// Deliberately small. Runs, schedules and escalations are already served by the
// generic `/api/agents` surface and are NOT recreated here.
//
//   GET  /status                      latest FINANCE_STATUS + run + escalations
//   GET  /readiness                   persisted readiness checks with evidence
//   GET  /cash-flow                   persisted projections, newest first
//   GET  /actual-rates                the firm's recorded actual indirect rates
//   POST /actual-rates                record one (ADMIN) — human source data
//   POST /actual-rates/:id/verify     a person confirms it (ADMIN)
//
// THERE IS NO ENDPOINT HERE THAT TOUCHES MONEY. No approve, no submit, no
// payment, no write-off, no rate application, no WAWF or IPP submission. Those
// either live on the existing human `/api/contract-finance` surface or, in the
// case of external submission, do not exist anywhere in the platform.
//
// The two write endpoints record and verify an ACTUAL RATE, which is financial
// source data a person supplies. The agent reads it and never writes it — an
// actual rate derived from a provisional one would make every variance a
// self-fulfilling zero.
//
// Mounted at /api/agents/finance. Tenant-scoped throughout.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { prisma } from '../config/database'
import { logAudit } from '../services/auditService'
import { ESCALATION_OVERDUE_DAYS, RECEIVABLE_STATUSES, NON_RECEIVABLE_STATUSES } from '../services/agents/finance/receivablesAgeing'
import { VARIANCE_MATERIAL_PCT, VARIANCE_REVIEW_PCT, SEMANTIC_MAPPING_NOTE } from '../services/agents/finance/rateVariance'
import {
  DCAA_RULE_VERSION,
  READINESS_DISCLAIMER,
  SUBMISSION_TIMELINESS_WORKING_DAYS,
  READINESS_LOOKBACK_DAYS,
  CRITICAL_RULE_KEYS,
} from '../services/agents/finance/dcaaReadiness'
import {
  CASHFLOW_METHOD_VERSION,
  DEFAULT_HORIZON_MONTHS,
  MIN_PAYMENTS_FOR_BANDS,
  MIN_PAYMENTS_FOR_TIMING,
  NO_OPENING_BALANCE_LIMITATION,
} from '../services/agents/finance/cashFlowProjection'
import { MAX_INVOICES_PER_RUN } from '../services/agents/finance/financeAgentHandler'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const AGENT_KEY = 'FINANCE' as const

/** The policy the UI displays so a reader can check the rules themselves. */
const FINANCE_POLICY = {
  policyVersion: DCAA_RULE_VERSION,
  escalationOverdueDays: ESCALATION_OVERDUE_DAYS,
  varianceReviewPct: VARIANCE_REVIEW_PCT,
  varianceMaterialPct: VARIANCE_MATERIAL_PCT,
  submissionTimelinessWorkingDays: SUBMISSION_TIMELINESS_WORKING_DAYS,
  readinessLookbackDays: READINESS_LOOKBACK_DAYS,
  criticalRuleKeys: [...CRITICAL_RULE_KEYS],
  cashFlowHorizonMonths: DEFAULT_HORIZON_MONTHS,
  minPaymentsForTiming: MIN_PAYMENTS_FOR_TIMING,
  minPaymentsForBands: MIN_PAYMENTS_FOR_BANDS,
  maxInvoicesPerRun: MAX_INVOICES_PER_RUN,
  receivableStatuses: [...RECEIVABLE_STATUSES],
  nonReceivableStatuses: [...NON_RECEIVABLE_STATUSES],
  readinessDisclaimer: READINESS_DISCLAIMER,
  rateSemanticNote: SEMANTIC_MAPPING_NOTE,
  noOpeningBalanceNote: NO_OPENING_BALANCE_LIMITATION,
  notes: [
    'Every invoice the agent creates is a DRAFT. It never approves, submits or marks an invoice paid, and never records a payment.',
    'A DRAFT invoice is not a receivable — nobody owes money on a document that has not been sent.',
    'Timekeeping readiness is a Bytescon product checklist, not a DCAA audit, certification or approval.',
    'A readiness rule the data model cannot answer is reported UNSUPPORTED and excluded from the score, never counted as a pass.',
    'An actual indirect rate is supplied by a person or an import. The agent never derives one from a provisional rate.',
    'Cash flow is a projection of NET FLOW. The platform records no opening cash balance, so no cash position is reported.',
    'Pipeline expected value is shown separately and never counted as contracted receipts.',
  ],
}

// -------------------------------------------------------------
// GET /status
// -------------------------------------------------------------

router.get('/status', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const [artifact, schedule, lastRun, escalations] = await Promise.all([
      prisma.agentArtifact.findFirst({
        where: {
          consultingFirmId, agentKey: AGENT_KEY, artifactType: 'FINANCE_STATUS',
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
        where: { consultingFirmId, agentKey: AGENT_KEY, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true, severity: true, status: true, title: true, reason: true,
          recommendedAction: true, entityType: true, entityId: true, createdAt: true,
        },
      }),
    ])

    res.json({
      success: true,
      data: {
        agentKey: AGENT_KEY,
        schedule,
        lastRun,
        // null = the agent has not assessed this firm yet.
        status: artifact
          ? { artifactId: artifact.id, generatedAt: artifact.createdAt, ...(artifact.structuredData as object) }
          : null,
        escalations,
        policy: FINANCE_POLICY,
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /readiness
// -------------------------------------------------------------

router.get('/readiness', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const latest = await prisma.dcaaReadinessCheck.findFirst({
      where: { consultingFirmId },
      orderBy: { checkedAt: 'desc' },
      select: { checkedAt: true },
    })
    const checks = latest
      ? await prisma.dcaaReadinessCheck.findMany({
          where: { consultingFirmId, checkedAt: latest.checkedAt },
          orderBy: { ruleKey: 'asc' },
        })
      : []

    res.json({
      success: true,
      data: {
        checkedAt: latest?.checkedAt ?? null,
        ruleVersion: DCAA_RULE_VERSION,
        disclaimer: READINESS_DISCLAIMER,
        criticalRuleKeys: [...CRITICAL_RULE_KEYS],
        checks,
        policy: FINANCE_POLICY,
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /cash-flow
// -------------------------------------------------------------

router.get('/cash-flow', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const projections = await prisma.cashFlowProjection.findMany({
      where: { consultingFirmId },
      orderBy: { computedAt: 'desc' },
      take: 12,
    })
    res.json({
      success: true,
      data: {
        methodVersion: CASHFLOW_METHOD_VERSION,
        openingCashBalanceAvailable: false,
        noOpeningBalanceNote: NO_OPENING_BALANCE_LIMITATION,
        projections,
        policy: FINANCE_POLICY,
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Actual indirect rates — human source data
// -------------------------------------------------------------

const RATE_TYPES = ['FRINGE', 'OVERHEAD', 'GA', 'MATERIAL_HANDLING', 'SUBCONTRACT_HANDLING', 'OTHER'] as const

const ActualRateSchema = z.object({
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  fiscalYear: z.number().int().min(1900).max(2200),
  rateType: z.enum(RATE_TYPES),
  poolName: z.string().trim().max(200).nullable().optional(),
  /** A rate, as a percentage. Stored at Decimal(7,4) to match pricing. */
  actualRate: z.union([z.number(), z.string()]),
  allocationBaseAmount: z.union([z.number(), z.string()]).nullable().optional(),
  poolCostAmount: z.union([z.number(), z.string()]).nullable().optional(),
  source: z.enum(['MANUAL_ENTRY', 'IMPORT', 'DERIVED_FROM_LEDGER']).optional(),
  sourceReference: z.string().trim().max(500).nullable().optional(),
  status: z.enum(['DRAFT', 'FINAL']).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

router.get('/actual-rates', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const rates = await prisma.actualIndirectRate.findMany({
      where: { consultingFirmId },
      orderBy: [{ periodStart: 'desc' }, { rateType: 'asc' }],
      take: 200,
    })
    res.json({ success: true, data: { rates, policy: FINANCE_POLICY } })
  } catch (err) { next(err) }
})

router.post('/actual-rates', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('An actual rate must be recorded by a person.')

    const parsed = ActualRateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload')
    if (parsed.data.periodEnd < parsed.data.periodStart) {
      throw new ValidationError('The period end must not be before the period start.')
    }

    const rate = await prisma.actualIndirectRate.create({
      data: {
        consultingFirmId,
        periodStart: parsed.data.periodStart,
        periodEnd: parsed.data.periodEnd,
        fiscalYear: parsed.data.fiscalYear,
        rateType: parsed.data.rateType,
        poolName: parsed.data.poolName ?? null,
        actualRate: new Prisma.Decimal(parsed.data.actualRate),
        allocationBaseAmount: parsed.data.allocationBaseAmount != null ? new Prisma.Decimal(parsed.data.allocationBaseAmount) : null,
        poolCostAmount: parsed.data.poolCostAmount != null ? new Prisma.Decimal(parsed.data.poolCostAmount) : null,
        source: parsed.data.source ?? 'MANUAL_ENTRY',
        sourceReference: parsed.data.sourceReference ?? null,
        status: parsed.data.status ?? 'DRAFT',
        notes: parsed.data.notes ?? null,
        createdByUserId: userId,
      },
    })

    await logAudit({
      consultingFirmId, actorUserId: userId, actorRole: req.user?.role,
      action: 'CREATE', entityType: 'ActualIndirectRate', entityId: rate.id,
      rationale: `Actual ${rate.rateType} rate ${rate.actualRate}% recorded for ${rate.periodStart.toISOString().slice(0, 10)} to ${rate.periodEnd.toISOString().slice(0, 10)}.`,
    })

    res.status(201).json({ success: true, data: { rate } })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return next(new ValidationError('An actual rate for that pool and period already exists.'))
    }
    next(err)
  }
})

/**
 * A person confirms an actual rate is correct.
 *
 * Verification is deliberately a separate act from recording. An imported rate
 * nobody has looked at still produces a variance, but the variance says so.
 */
router.post('/actual-rates/:id/verify', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('An actual rate must be verified by a person.')

    const existing = await prisma.actualIndirectRate.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('ActualIndirectRate')

    const rate = await prisma.actualIndirectRate.update({
      where: { id: existing.id },
      data: { isHumanVerified: true, verifiedByUserId: userId, verifiedAt: new Date(), status: 'FINAL' },
    })

    await logAudit({
      consultingFirmId, actorUserId: userId, actorRole: req.user?.role,
      action: 'APPROVAL', entityType: 'ActualIndirectRate', entityId: rate.id,
      rationale: `Actual ${rate.rateType} rate verified by an administrator.`,
      before: { isHumanVerified: existing.isHumanVerified, status: existing.status },
      after: { isHumanVerified: true, status: 'FINAL' },
    })

    res.json({ success: true, data: { rate } })
  } catch (err) { next(err) }
})

export default router
