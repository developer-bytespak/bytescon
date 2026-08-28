// =============================================================
// Capture & Qualification Evidence (§5.1 Stage 3) — incumbent + competitor
// evidence for an opportunity, derived from already-ingested award history. All
// evidence is HISTORICAL (never a prediction). Reads are firm-wide; refresh,
// verify, correct, and note edits are ADMIN. Tenant-scoped + audited. Mounted at
// /api/capture-evidence.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { prisma } from '../config/database'
import { refreshOpportunityEvidence, getOpportunityEvidence } from '../services/captureEvidence'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const audit = (req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction, entityId: string, rationale?: string, before?: unknown, after?: unknown) =>
  logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType: 'CompetitorEvidence', entityId, rationale, before, after })

async function assertOpportunity(consultingFirmId: string, opportunityId: string) {
  const opp = await prisma.opportunity.findFirst({ where: { id: opportunityId, consultingFirmId }, select: { id: true } })
  if (!opp) throw new NotFoundError('Opportunity not found')
}

async function loadRow(consultingFirmId: string, id: string) {
  const row = await prisma.competitor.findFirst({ where: { id, consultingFirmId } })
  if (!row) throw new NotFoundError('Evidence record not found')
  return row
}

// GET /:opportunityId — incumbent + competitors (+ lastRefreshed). Auto-builds
// on first access from persisted award history; honest states when unavailable.
router.get('/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await assertOpportunity(consultingFirmId, req.params.opportunityId)
    let evidence = await getOpportunityEvidence(consultingFirmId, req.params.opportunityId)
    if (!evidence.incumbent && evidence.competitors.length === 0) {
      // Never built yet — derive it once from the ingested award history.
      evidence = (await refreshOpportunityEvidence(consultingFirmId, req.params.opportunityId)) ?? evidence
    }
    res.json({ success: true, data: evidence })
  } catch (err) { next(err) }
})

// POST /:opportunityId/refresh — recompute from award history (ADMIN).
router.post('/:opportunityId/refresh', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await assertOpportunity(consultingFirmId, req.params.opportunityId)
    const evidence = await refreshOpportunityEvidence(consultingFirmId, req.params.opportunityId)
    if (!evidence) throw new NotFoundError('Opportunity not found')
    await audit(req, consultingFirmId, 'UPDATE', req.params.opportunityId, 'Evidence refreshed from award history')
    res.json({ success: true, data: evidence })
  } catch (err) { next(err) }
})

// PATCH /incumbent/:id/verify — confirm the identified incumbent (ADMIN).
router.patch('/incumbent/:id/verify', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const row = await loadRow(consultingFirmId, req.params.id)
    if (row.evidenceKind !== 'INCUMBENT') throw new ValidationError('Only an incumbent record can be verified')
    if (row.confidence === 'NOT_AVAILABLE') throw new ValidationError('There is no incumbent evidence to verify')
    const updated = await prisma.competitor.update({ where: { id: row.id }, data: { verification: 'VERIFIED', verifiedByUserId: req.user?.userId, verifiedAt: new Date() } })
    await audit(req, consultingFirmId, 'APPROVAL', row.id, `Incumbent verified: ${row.name}`, { verification: row.verification }, { verification: 'VERIFIED' })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

const CorrectSchema = z.object({
  name: z.string().trim().min(1).max(300),
  uei: z.string().trim().max(20).nullable().optional(),
  reason: z.string().trim().min(1).max(2000),
})

// PATCH /incumbent/:id/correct — correct the incumbent identity (ADMIN). Reason
// is mandatory; the original source-derived name/uei is preserved.
router.patch('/incumbent/:id/correct', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = CorrectSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'A corrected name and a reason are required')
    const row = await loadRow(consultingFirmId, req.params.id)
    if (row.evidenceKind !== 'INCUMBENT') throw new ValidationError('Only an incumbent record can be corrected')

    const updated = await prisma.competitor.update({
      where: { id: row.id },
      data: {
        // Preserve the original source evidence the first time it is corrected.
        originalName: row.originalName ?? row.name,
        originalUei: row.originalUei ?? row.uei,
        name: parsed.data.name, uei: parsed.data.uei ?? null,
        verification: 'CORRECTED', confidence: 'CONFIRMED', isIncumbent: true,
        correctionReason: parsed.data.reason, verifiedByUserId: req.user?.userId, verifiedAt: new Date(),
        evidenceSource: 'Manual (corrected)',
      },
    })
    await audit(req, consultingFirmId, 'DECISION_OVERRIDE', row.id, `Incumbent corrected → ${parsed.data.name}: ${parsed.data.reason}`, { name: row.name, uei: row.uei }, { name: parsed.data.name, uei: parsed.data.uei ?? null })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

const NotesSchema = z.object({ notes: z.string().trim().max(4000).nullable() })

// PATCH /:id/notes — tenant-private note on any evidence row (ADMIN).
router.patch('/:id/notes', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = NotesSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('Invalid notes payload')
    const row = await loadRow(consultingFirmId, req.params.id)
    const updated = await prisma.competitor.update({ where: { id: row.id }, data: { notes: parsed.data.notes } })
    await audit(req, consultingFirmId, 'UPDATE', row.id, 'Evidence note updated')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

export default router
