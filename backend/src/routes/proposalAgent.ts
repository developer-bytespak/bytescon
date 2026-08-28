// =============================================================
// §7.7 — Proposal Agent API and capability library.
//
// Runs, schedules and escalations are already served by the generic
// `/api/agents` surface and are NOT recreated here.
//
//   GET    /status/:proposalId          latest PROPOSAL_STATUS + run + escalations
//   GET    /library                     capability narratives + versions
//   POST   /library                     ADMIN — create a narrative
//   POST   /library/:id/versions        ADMIN — create a NEW DRAFT version
//   POST   /library/versions/:id/approve ADMIN — the human approval
//   POST   /library/:id/archive         ADMIN — archive a narrative
//
// THE APPROVAL IS A HUMAN ROUTE. `POST .../approve` is the only path in the
// codebase that writes an APPROVED capability version, it requires ADMIN, and
// it records the approving user. The Proposal Agent has no equivalent.
//
// Mounted at /api/agents/proposal. Tenant-scoped throughout.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors'
import { prisma } from '../config/database'
import { logAudit } from '../services/auditService'
import { hashNarrativeContent, nextVersionNumber, MIN_RELEVANCE_SCORE, MAX_SOURCES_PER_SECTION } from '../services/agents/proposal/capabilityLibrary'
import { emitCapabilityNarrativeApproved } from '../services/agents/proposal/proposalEvents'
import { PROPOSAL_RISK_WORKING_DAYS, MAX_SECTIONS_DRAFTED_PER_RUN } from '../services/agents/proposal/proposalAgentHandler'
import { REVIEW_OVERDUE_WORKING_DAYS, CYCLE_STALL_WORKING_DAYS, CYCLE_ORDER } from '../services/agents/proposal/reviewOrchestrator'
import {
  PROPOSAL_SECTION_DRAFT_PROMPT_VERSION,
  PAST_PERFORMANCE_ADAPTATION_PROMPT_VERSION,
  PROPOSAL_COMPLIANCE_CROSSCHECK_PROMPT_VERSION,
  AI_DRAFT_LABEL,
} from '../services/agents/proposal/proposalPrompts'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const AGENT_KEY = 'PROPOSAL' as const

/** The policy the UI displays so a reader can check the rules themselves. */
const PROPOSAL_POLICY = {
  policyVersion: 'proposal-v1',
  promptVersions: {
    sectionDraft: PROPOSAL_SECTION_DRAFT_PROMPT_VERSION,
    pastPerformanceAdaptation: PAST_PERFORMANCE_ADAPTATION_PROMPT_VERSION,
    complianceCrossCheck: PROPOSAL_COMPLIANCE_CROSSCHECK_PROMPT_VERSION,
  },
  aiDraftLabel: AI_DRAFT_LABEL,
  colourTeamOrder: CYCLE_ORDER,
  reviewOverdueWorkingDays: REVIEW_OVERDUE_WORKING_DAYS,
  cycleStallWorkingDays: CYCLE_STALL_WORKING_DAYS,
  riskWorkingDays: PROPOSAL_RISK_WORKING_DAYS,
  maxSectionsDraftedPerRun: MAX_SECTIONS_DRAFTED_PER_RUN,
  minCapabilityRelevance: MIN_RELEVANCE_SCORE,
  maxSourcesPerSection: MAX_SOURCES_PER_SECTION,
  notes: [
    'Every draft the agent produces is a DRAFT. It never approves a section, a review or a cycle.',
    'Only an APPROVED capability-library version may be quoted as a contractor fact.',
    'A skeleton section is not coverage — a heading existing is not a requirement being answered.',
    'AI compliance findings are advisory and never mark a requirement human-verified.',
    'The agent proposes past-performance candidates; a person makes the final selection.',
  ],
}

// -------------------------------------------------------------
// GET /status/:proposalId
// -------------------------------------------------------------

router.get('/status/:proposalId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const proposal = await prisma.proposal.findFirst({
      where: { id: req.params.proposalId, consultingFirmId },
      select: {
        id: true, opportunityId: true, title: true, status: true,
        opportunity: { select: { id: true, title: true, agency: true, responseDeadline: true } },
      },
    })
    if (!proposal) throw new NotFoundError('Proposal')

    const [artifact, schedule, lastRun, escalations] = await Promise.all([
      prisma.agentArtifact.findFirst({
        where: {
          consultingFirmId, agentKey: AGENT_KEY, artifactType: 'PROPOSAL_STATUS',
          sourceEntityType: 'Proposal', sourceEntityId: proposal.id, supersededByArtifactId: null,
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
        proposal,
        schedule,
        lastRun,
        // null = the agent has not assessed this proposal yet.
        status: artifact
          ? { artifactId: artifact.id, generatedAt: artifact.createdAt, ...(artifact.structuredData as object) }
          : null,
        escalations,
        policy: PROPOSAL_POLICY,
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Capability library
// -------------------------------------------------------------

const NarrativeSchema = z.object({
  title: z.string().trim().min(1).max(300),
  category: z.enum(['TECHNICAL_NARRATIVE', 'DIFFERENTIATOR', 'MANAGEMENT_APPROACH', 'QUALITY_APPROACH', 'BOILERPLATE', 'OTHER']).optional(),
  capabilityKeys: z.array(z.string().trim().max(120)).max(50).optional(),
  naicsCodes: z.array(z.string().trim().max(20)).max(50).optional(),
  agencyTags: z.array(z.string().trim().max(200)).max(50).optional(),
  tags: z.array(z.string().trim().max(120)).max(50).optional(),
})

const VersionSchema = z.object({
  content: z.string().trim().min(1).max(100_000),
  sourceReferences: z.array(z.string().trim().max(500)).max(50).optional(),
})

router.get('/library', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const narratives = await prisma.capabilityNarrative.findMany({
      where: {
        consultingFirmId,
        ...(req.query.includeArchived === 'true' ? {} : { status: 'ACTIVE' }),
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 10 } },
    })
    res.json({ success: true, data: { narratives, policy: PROPOSAL_POLICY } })
  } catch (err) { next(err) }
})

router.post('/library', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('A capability narrative must be created by a person.')

    const parsed = NarrativeSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload')

    const narrative = await prisma.capabilityNarrative.create({
      data: {
        consultingFirmId,
        title: parsed.data.title,
        category: parsed.data.category ?? 'TECHNICAL_NARRATIVE',
        capabilityKeys: parsed.data.capabilityKeys ?? [],
        naicsCodes: parsed.data.naicsCodes ?? [],
        agencyTags: parsed.data.agencyTags ?? [],
        tags: parsed.data.tags ?? [],
        createdByUserId: userId,
      },
    })

    await logAudit({
      consultingFirmId, actorUserId: userId, actorRole: req.user?.role,
      action: 'CREATE', entityType: 'CapabilityNarrative', entityId: narrative.id,
      rationale: `Capability narrative created: ${narrative.title}. It has no approved version and cannot yet be quoted.`,
    })

    res.status(201).json({ success: true, data: { narrative } })
  } catch (err) { next(err) }
})

/**
 * A NEW DRAFT version. Editing approved text never replaces it — the approved
 * wording stays exactly as an earlier proposal cited it.
 */
router.post('/library/:id/versions', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('A capability version must be created by a person.')

    const narrative = await prisma.capabilityNarrative.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, title: true },
    })
    if (!narrative) throw new NotFoundError('Capability narrative')

    const parsed = VersionSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload')

    const version = await prisma.capabilityNarrativeVersion.create({
      data: {
        consultingFirmId,
        capabilityNarrativeId: narrative.id,
        versionNumber: await nextVersionNumber(narrative.id),
        content: parsed.data.content,
        contentHash: hashNarrativeContent(parsed.data.content),
        // DRAFT, always. Approval is a separate, deliberate human act.
        status: 'DRAFT',
        sourceReferences: parsed.data.sourceReferences ?? [],
        createdByUserId: userId,
      },
    })

    await logAudit({
      consultingFirmId, actorUserId: userId, actorRole: req.user?.role,
      action: 'CREATE', entityType: 'CapabilityNarrativeVersion', entityId: version.id,
      rationale: `Draft version ${version.versionNumber} created for "${narrative.title}". A draft is never quoted as a contractor fact.`,
    })

    res.status(201).json({ success: true, data: { version } })
  } catch (err) { next(err) }
})

/**
 * THE human approval.
 *
 * The only path that writes an APPROVED capability version. It supersedes the
 * previous approved version rather than deleting it, records who approved and
 * when, and emits CAPABILITY_NARRATIVE_APPROVED inside the same transaction.
 */
router.post('/library/versions/:id/approve', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('A capability version must be approved by a person.')

    const version = await prisma.capabilityNarrativeVersion.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: { narrative: { select: { id: true, title: true } } },
    })
    if (!version) throw new NotFoundError('Capability narrative version')
    if (version.status === 'APPROVED') throw new ConflictError('This version is already approved.')
    if (version.status === 'ARCHIVED') throw new ConflictError('An archived version cannot be approved.')

    const now = new Date()
    const approved = await prisma.$transaction(async (tx) => {
      // The previous approved version is superseded, never deleted, so an
      // earlier proposal's citation still resolves to the text it quoted.
      await tx.capabilityNarrativeVersion.updateMany({
        where: { capabilityNarrativeId: version.capabilityNarrativeId, status: 'APPROVED' },
        data: { status: 'ARCHIVED', supersededAt: now },
      })

      const row = await tx.capabilityNarrativeVersion.update({
        where: { id: version.id },
        data: { status: 'APPROVED', approvedByUserId: userId, approvedAt: now },
      })

      await tx.capabilityNarrative.update({
        where: { id: version.capabilityNarrativeId },
        data: { currentApprovedVersionId: row.id },
      })

      await emitCapabilityNarrativeApproved(
        {
          consultingFirmId,
          capabilityNarrativeId: version.capabilityNarrativeId,
          versionId: row.id,
          versionNumber: row.versionNumber,
          approvedByUserId: userId,
        },
        tx,
      )
      return row
    })

    await logAudit({
      consultingFirmId, actorUserId: userId, actorRole: req.user?.role,
      action: 'APPROVAL', entityType: 'CapabilityNarrativeVersion', entityId: approved.id,
      rationale: `Version ${approved.versionNumber} of "${version.narrative.title}" approved by an administrator and is now quotable as a contractor fact.`,
      before: { status: version.status },
      after: { status: 'APPROVED', approvedByUserId: userId },
    })

    res.json({ success: true, data: { version: approved } })
  } catch (err) { next(err) }
})

router.post('/library/:id/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    const narrative = await prisma.capabilityNarrative.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, title: true },
    })
    if (!narrative) throw new NotFoundError('Capability narrative')

    const archived = await prisma.capabilityNarrative.update({
      where: { id: narrative.id },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    })

    await logAudit({
      consultingFirmId, actorUserId: userId ?? null, actorRole: req.user?.role,
      action: 'UPDATE', entityType: 'CapabilityNarrative', entityId: archived.id,
      rationale: `Capability narrative "${narrative.title}" archived. Its versions are preserved.`,
    })

    res.json({ success: true, data: { narrative: archived } })
  } catch (err) { next(err) }
})

export default router
