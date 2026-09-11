// =============================================================
// Grants pipeline (Phase 2) — application tracking for GRANTS_GOV
// opportunities.
//
// Bytescon prepares the application (eligibility, SF-424 document
// checklist, narratives, deadline stages); the customer performs the
// actual filing in Grants.gov Workspace. There is no System-to-System
// submission here, by design — see the READY_TO_SUBMIT stage.
//
// Grant opportunities themselves are read through the main
// /api/opportunities route with source=GRANTS_GOV; this router owns only
// the application lifecycle.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma, GrantApplicationStatus } from '@prisma/client'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { prisma } from '../config/database'

const router = Router()
router.use(authenticateJWT, enforceTenantScope, requireActiveBase)

const audit = (req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction, id: string, rationale?: string) =>
  logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType: 'GrantApplication', entityId: id, rationale })

// The SF-424 family every federal application walks through. Items are a
// starting point — NOFO-specific attachments get added per application.
export const DEFAULT_GRANT_CHECKLIST = [
  { key: 'sam_registration', label: 'Active SAM.gov entity registration (UEI)', required: true, done: false },
  { key: 'grants_gov_account', label: 'Grants.gov account with AOR authorization', required: true, done: false },
  { key: 'read_nofo', label: 'Read the full NOFO / funding opportunity announcement', required: true, done: false },
  { key: 'eligibility_check', label: 'Eligibility confirmed against the NOFO criteria', required: true, done: false },
  { key: 'sf424', label: 'SF-424 — Application for Federal Assistance', required: true, done: false },
  { key: 'sf424a', label: 'SF-424A — Budget Information (non-construction)', required: false, done: false },
  { key: 'sf424b', label: 'SF-424B — Assurances (non-construction)', required: false, done: false },
  { key: 'project_narrative', label: 'Project narrative', required: true, done: false },
  { key: 'budget_narrative', label: 'Budget narrative / justification', required: true, done: false },
  { key: 'indirect_rate', label: 'Indirect cost rate agreement (if claiming indirect costs)', required: false, done: false },
  { key: 'nofo_attachments', label: 'NOFO-specific required attachments', required: true, done: false },
  { key: 'internal_review', label: 'Internal review completed', required: true, done: false },
  { key: 'workspace_upload', label: 'Forms completed in Grants.gov Workspace', required: true, done: false },
]

const ChecklistItemSchema = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(300),
  required: z.boolean(),
  done: z.boolean(),
})

const STATUSES = Object.values(GrantApplicationStatus)

const CreateSchema = z.object({
  opportunityId: z.string().uuid(),
  clientCompanyId: z.string().uuid().optional(),
})

const UpdateSchema = z.object({
  status: z.enum(STATUSES as [string, ...string[]]).optional(),
  eligibilityNotes: z.string().max(8000).nullable().optional(),
  checklist: z.array(ChecklistItemSchema).max(60).optional(),
  awardAmount: z.number().nonnegative().nullable().optional(),
  outcomeNotes: z.string().max(8000).nullable().optional(),
  clientCompanyId: z.string().uuid().nullable().optional(),
})

const APPLICATION_INCLUDE = {
  opportunity: {
    select: {
      id: true, title: true, agency: true, responseDeadline: true,
      solicitationNumber: true, sourceUrl: true, estimatedValue: true,
      estimatedValueMin: true, estimatedValueMax: true, sourceMetadata: true,
    },
  },
  clientCompany: { select: { id: true, name: true } },
} satisfies Prisma.GrantApplicationInclude

// -------------------------------------------------------------
// GET /api/grants/applications — the firm's grant applications
// -------------------------------------------------------------
router.get('/applications', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const status = req.query.status ? String(req.query.status) : undefined
    if (status && !STATUSES.includes(status as GrantApplicationStatus)) {
      throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`)
    }
    const applications = await prisma.grantApplication.findMany({
      where: { consultingFirmId, ...(status ? { status: status as GrantApplicationStatus } : {}) },
      include: APPLICATION_INCLUDE,
      orderBy: [{ createdAt: 'desc' }],
      take: 500,
    })
    res.json({ success: true, data: { applications } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// POST /api/grants/applications — start tracking an application
// -------------------------------------------------------------
router.post('/applications', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const body = CreateSchema.parse(req.body ?? {})

    const opportunity = await prisma.opportunity.findFirst({
      where: { id: body.opportunityId, consultingFirmId, source: 'GRANTS_GOV' },
      select: { id: true, title: true },
    })
    if (!opportunity) throw new NotFoundError('Grant opportunity not found (must be a GRANTS_GOV record in your firm)')

    if (body.clientCompanyId) {
      const client = await prisma.clientCompany.findFirst({
        where: { id: body.clientCompanyId, consultingFirmId }, select: { id: true },
      })
      if (!client) throw new NotFoundError('Client company not found')
    }

    const existing = await prisma.grantApplication.findFirst({
      where: {
        consultingFirmId,
        opportunityId: body.opportunityId,
        clientCompanyId: body.clientCompanyId ?? null,
        status: { notIn: ['WITHDRAWN', 'NOT_AWARDED'] },
      },
      select: { id: true },
    })
    if (existing) throw new ValidationError('An active application for this grant (and client) already exists.')

    const created = await prisma.grantApplication.create({
      data: {
        consultingFirmId,
        opportunityId: body.opportunityId,
        clientCompanyId: body.clientCompanyId ?? null,
        checklist: DEFAULT_GRANT_CHECKLIST as unknown as Prisma.InputJsonValue,
      },
      include: APPLICATION_INCLUDE,
    })
    await audit(req, consultingFirmId, 'CREATE', created.id, `Started grant application: ${opportunity.title.slice(0, 120)}`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// PUT /api/grants/applications/:id — status / checklist / notes
// -------------------------------------------------------------
router.put('/applications/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const body = UpdateSchema.parse(req.body ?? {})

    const current = await prisma.grantApplication.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, status: true, submittedAt: true },
    })
    if (!current) throw new NotFoundError('Grant application not found')

    if (body.clientCompanyId) {
      const client = await prisma.clientCompany.findFirst({
        where: { id: body.clientCompanyId, consultingFirmId }, select: { id: true },
      })
      if (!client) throw new NotFoundError('Client company not found')
    }

    const nextStatus = body.status as GrantApplicationStatus | undefined
    const updated = await prisma.grantApplication.update({
      where: { id: current.id },
      data: {
        ...(nextStatus ? { status: nextStatus } : {}),
        // First transition into SUBMITTED stamps the filing moment.
        ...(nextStatus === 'SUBMITTED' && !current.submittedAt ? { submittedAt: new Date() } : {}),
        ...(body.eligibilityNotes !== undefined ? { eligibilityNotes: body.eligibilityNotes } : {}),
        ...(body.checklist !== undefined ? { checklist: body.checklist as unknown as Prisma.InputJsonValue } : {}),
        ...(body.awardAmount !== undefined ? { awardAmount: body.awardAmount } : {}),
        ...(body.outcomeNotes !== undefined ? { outcomeNotes: body.outcomeNotes } : {}),
        ...(body.clientCompanyId !== undefined ? { clientCompanyId: body.clientCompanyId } : {}),
      },
      include: APPLICATION_INCLUDE,
    })
    if (nextStatus && nextStatus !== current.status) {
      await audit(req, consultingFirmId, 'UPDATE', current.id, `Grant application ${current.status} -> ${nextStatus}`)
    }
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// DELETE /api/grants/applications/:id
// -------------------------------------------------------------
router.delete('/applications/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.grantApplication.findFirst({
      where: { id: req.params.id, consultingFirmId }, select: { id: true },
    })
    if (!existing) throw new NotFoundError('Grant application not found')
    await prisma.grantApplication.delete({ where: { id: existing.id } })
    await audit(req, consultingFirmId, 'DELETE', existing.id, 'Grant application removed')
    res.json({ success: true })
  } catch (err) { next(err) }
})

export default router
