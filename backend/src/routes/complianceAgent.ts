// =============================================================
// §7.3 — Compliance Agent API.
//
// Deliberately small. Runs, schedules, artifacts and escalations are already
// served by the generic `/api/agents` surface and are NOT recreated here. These
// endpoints exist for the two things that surface cannot give the compliance UI:
//
//   GET  /latest                  one backend-authoritative COMPLIANCE_STATUS
//                                 view joining run, registration and documents
//   GET  /opportunity/:id         the same view narrowed to one opportunity
//   GET/POST/PUT/POST(archive) /bonding
//                                 human-maintained surety bonding capacity
//
// Bonding writes are ADMIN-only and are the ONLY way a bonding figure ever
// changes. No agent run, at any autonomy level, reaches these handlers.
//
// Mounted at /api/agents/compliance. Tenant-scoped throughout.
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
import { COMPLIANCE_POLICY_DOC } from '../services/agents/compliance/policy'
import { assessRegistration, assessBonding } from '../services/agents/compliance/registrationWatch'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const AGENT_KEY = 'COMPLIANCE' as const

/** Latest non-superseded COMPLIANCE_STATUS artifact for a subject. */
async function latestStatus(consultingFirmId: string, sourceEntityId?: string) {
  return prisma.agentArtifact.findFirst({
    where: {
      consultingFirmId,
      agentKey: AGENT_KEY,
      artifactType: 'COMPLIANCE_STATUS',
      supersededByArtifactId: null,
      ...(sourceEntityId ? { sourceEntityId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, runId: true, title: true, summary: true, structuredData: true,
      confidenceState: true, isHumanVerified: true, createdAt: true,
    },
  })
}

async function runContext(consultingFirmId: string) {
  const [schedule, lastRun, lastSuccessfulRun, escalations] = await Promise.all([
    prisma.agentSchedule.findUnique({
      where: { consultingFirmId_agentKey: { consultingFirmId, agentKey: AGENT_KEY } },
      select: {
        isEnabled: true, scheduleType: true, cronExpression: true, intervalMinutes: true,
        timezone: true, nextRunAt: true, lastRunAt: true, lastSuccessfulRunAt: true,
        lastFailureAt: true, lastFailureMessage: true, consecutiveFailures: true, autonomyLevel: true,
      },
    }),
    prisma.agentRun.findFirst({
      where: { consultingFirmId, agentKey: AGENT_KEY },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, status: true, triggerType: true, triggerEntityType: true, triggerEntityId: true,
        progressPercent: true, progressStage: true, createdAt: true, startedAt: true, finishedAt: true,
        outputSummary: true, confidenceState: true, dataSufficiency: true, warnings: true, limitations: true,
        errorCode: true, errorMessage: true, tokenInput: true, tokenOutput: true, estimatedCostUsd: true,
      },
    }),
    prisma.agentRun.findFirst({
      where: { consultingFirmId, agentKey: AGENT_KEY, status: 'COMPLETED' },
      orderBy: { finishedAt: 'desc' },
      select: { id: true, finishedAt: true, outputSummary: true },
    }),
    prisma.agentEscalation.findMany({
      where: { consultingFirmId, agentKey: AGENT_KEY, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, severity: true, status: true, title: true, reason: true, recommendedAction: true,
        entityType: true, entityId: true, createdAt: true,
      },
      take: 50,
    }),
  ])
  return { schedule: schedule ?? null, lastRun, lastSuccessfulRun, escalations }
}

/**
 * Everything /registration and /document-library need, in one tenant-scoped
 * read. The frontend renders this; it never recomputes a compliance state.
 */
router.get('/latest', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [context, status, registration] = await Promise.all([
      runContext(consultingFirmId),
      latestStatus(consultingFirmId),
      // Read live rather than from the artifact so /registration is current even
      // before the agent has ever run.
      assessRegistration(consultingFirmId),
    ])

    res.json({
      success: true,
      data: {
        agentKey: AGENT_KEY,
        ...context,
        // null means the agent has not produced a status yet — reported plainly
        // rather than as an empty-but-healthy state.
        status: status
          ? {
              artifactId: status.id,
              runId: status.runId,
              generatedAt: status.createdAt,
              confidenceState: status.confidenceState,
              isHumanVerified: status.isHumanVerified,
              summary: status.summary,
              ...(status.structuredData as object),
            }
          : null,
        registration: {
          sam: registration.sam,
          certifications: registration.certifications,
          insurance: registration.insurance,
          bonding: registration.bonding,
          health: registration.health.summary,
          blockers: registration.blockers,
          attention: registration.attention,
          insufficient: registration.insufficient,
        },
        policy: COMPLIANCE_POLICY_DOC,
      },
    })
  } catch (err) { next(err) }
})

/** The compliance status narrowed to one opportunity, for the proposal UI. */
router.get('/opportunity/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    // Ownership is verified on the opportunity itself, never inferred from an id.
    const opportunity = await prisma.opportunity.findFirst({
      where: { id: req.params.opportunityId, consultingFirmId },
      select: { id: true, title: true, agency: true, responseDeadline: true },
    })
    if (!opportunity) throw new NotFoundError('Opportunity')

    const [context, tenantStatus, targetedStatus] = await Promise.all([
      runContext(consultingFirmId),
      latestStatus(consultingFirmId),
      latestStatus(consultingFirmId, opportunity.id),
    ])

    // A targeted status wins; otherwise pick this opportunity's row out of the
    // tenant-wide status so the panel still has something real to show.
    const source = targetedStatus ?? tenantStatus
    const data = (source?.structuredData ?? null) as { opportunities?: Array<{ opportunityId: string }> } | null
    const row = data?.opportunities?.find((o) => o.opportunityId === opportunity.id) ?? null

    res.json({
      success: true,
      data: {
        opportunity,
        compliance: row,
        generatedAt: source?.createdAt ?? null,
        artifactId: source?.id ?? null,
        runId: source?.runId ?? null,
        lastRun: context.lastRun,
        escalations: context.escalations.filter((e) => e.entityId === opportunity.id || e.entityType === 'ConsultingFirm'),
        policy: COMPLIANCE_POLICY_DOC,
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Bonding capacity — human-maintained, ADMIN-only writes
// -------------------------------------------------------------

const MoneySchema = z.union([z.number(), z.string()])
  .nullable()
  .optional()
  .refine((v) => v === null || v === undefined || !Number.isNaN(Number(v)), 'Must be a number')

const BondingSchema = z.object({
  suretyName: z.string().trim().max(200).nullable().optional(),
  singleProjectLimit: MoneySchema,
  aggregateLimit: MoneySchema,
  committedAmount: MoneySchema,
  effectiveDate: z.string().datetime().nullable().optional(),
  expiryDate: z.string().datetime().nullable().optional(),
  status: z.enum(['ACTIVE', 'EXPIRED', 'ARCHIVED']).optional(),
  evidenceReference: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

/** Money arrives as a string or number and is stored as Decimal, never a float. */
function toDecimal(value: unknown): Prisma.Decimal | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return new Prisma.Decimal(String(value))
}

function toDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return new Date(String(value))
}

router.get('/bonding', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const rows = await prisma.bondingCapacity.findMany({
      where: { consultingFirmId },
      orderBy: [{ status: 'asc' }, { effectiveDate: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    })
    res.json({
      success: true,
      data: {
        // Each row carries its derived state so the UI never computes headroom.
        records: rows.map((row) => ({ ...row, assessment: assessBonding(row) })),
      },
    })
  } catch (err) { next(err) }
})

router.post('/bonding', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = BondingSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid bonding payload')

    const created = await prisma.bondingCapacity.create({
      data: {
        consultingFirmId,
        suretyName: parsed.data.suretyName ?? null,
        singleProjectLimit: toDecimal(parsed.data.singleProjectLimit) ?? null,
        aggregateLimit: toDecimal(parsed.data.aggregateLimit) ?? null,
        committedAmount: toDecimal(parsed.data.committedAmount) ?? null,
        effectiveDate: toDate(parsed.data.effectiveDate) ?? null,
        expiryDate: toDate(parsed.data.expiryDate) ?? null,
        status: parsed.data.status ?? 'ACTIVE',
        evidenceReference: parsed.data.evidenceReference ?? null,
        notes: parsed.data.notes ?? null,
        recordedByUserId: req.user?.userId ?? null,
      },
    })
    await logAudit({
      consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
      action: 'CREATE', entityType: 'BondingCapacity', entityId: created.id,
      rationale: 'Surety bonding capacity recorded by an administrator',
    })
    res.status(201).json({ success: true, data: { ...created, assessment: assessBonding(created) } })
  } catch (err) { next(err) }
})

router.put('/bonding/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = BondingSchema.partial().safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid bonding payload')

    const existing = await prisma.bondingCapacity.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('Bonding capacity record')

    const data: Prisma.BondingCapacityUpdateInput = {}
    if (parsed.data.suretyName !== undefined) data.suretyName = parsed.data.suretyName
    if (parsed.data.singleProjectLimit !== undefined) data.singleProjectLimit = toDecimal(parsed.data.singleProjectLimit)
    if (parsed.data.aggregateLimit !== undefined) data.aggregateLimit = toDecimal(parsed.data.aggregateLimit)
    if (parsed.data.committedAmount !== undefined) data.committedAmount = toDecimal(parsed.data.committedAmount)
    if (parsed.data.effectiveDate !== undefined) data.effectiveDate = toDate(parsed.data.effectiveDate)
    if (parsed.data.expiryDate !== undefined) data.expiryDate = toDate(parsed.data.expiryDate)
    if (parsed.data.status !== undefined) data.status = parsed.data.status
    if (parsed.data.evidenceReference !== undefined) data.evidenceReference = parsed.data.evidenceReference
    if (parsed.data.notes !== undefined) data.notes = parsed.data.notes

    const updated = await prisma.bondingCapacity.update({ where: { id: existing.id }, data })
    await logAudit({
      consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
      action: 'UPDATE', entityType: 'BondingCapacity', entityId: updated.id,
      rationale: 'Surety bonding capacity updated by an administrator',
    })
    res.json({ success: true, data: { ...updated, assessment: assessBonding(updated) } })
  } catch (err) { next(err) }
})

/** Archive rather than delete — bonding history is evidence. */
router.post('/bonding/:id/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.bondingCapacity.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('Bonding capacity record')

    const updated = await prisma.bondingCapacity.update({
      where: { id: existing.id },
      data: { status: 'ARCHIVED' },
    })
    await logAudit({
      consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
      action: 'UPDATE', entityType: 'BondingCapacity', entityId: updated.id,
      rationale: 'Surety bonding capacity archived by an administrator',
    })
    res.json({ success: true, data: { ...updated, assessment: assessBonding(updated) } })
  } catch (err) { next(err) }
})

export default router
