import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { logger } from '../utils/logger'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('contract_analysis'))

const CreateRequirementSchema = z.object({
  clientCompanyId: z.string().min(1),
  opportunityId: z.string().optional().nullable(),
  templateId: z.string().optional().nullable(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  dueDate: z.coerce.date(),
  isPenaltyEnabled: z.boolean().optional().default(true),
  penaltyAmount: z.coerce.number().min(0).optional().nullable(),
  penaltyPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
})

const UpdateRequirementSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional().nullable(),
  dueDate: z.coerce.date().optional(),
  opportunityId: z.string().optional().nullable(),
  templateId: z.string().optional().nullable(),
  isPenaltyEnabled: z.boolean().optional(),
  penaltyAmount: z.coerce.number().min(0).optional().nullable(),
  penaltyPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED']).optional(),
  notes: z.string().max(4000).optional().nullable(),
})

function validatePenaltyChoice(input: { penaltyAmount?: number | null; penaltyPercent?: number | null }) {
  if (input.penaltyAmount != null && input.penaltyPercent != null) {
    throw new ValidationError('Specify penaltyAmount or penaltyPercent, not both')
  }
}

async function validateOptionalTemplate(templateId: string | null | undefined, consultingFirmId: string): Promise<void> {
  if (!templateId) return
  const template = await prisma.documentTemplate.findFirst({
    where: { id: templateId, consultingFirmId },
    select: { id: true, isActive: true },
  })
  if (!template) throw new ValidationError('templateId not found for this firm')
  if (!template.isActive) throw new ValidationError('templateId is inactive')
}

async function validateOptionalOpportunity(opportunityId: string | null | undefined, consultingFirmId: string): Promise<void> {
  if (!opportunityId) return
  const opp = await prisma.opportunity.findFirst({
    where: { id: opportunityId, consultingFirmId },
    select: { id: true },
  })
  if (!opp) throw new ValidationError('opportunityId not found for this firm')
}

// GET /api/doc-requirements
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { clientCompanyId, opportunityId } = req.query

    const where: any = { consultingFirmId }
    if (clientCompanyId) where.clientCompanyId = clientCompanyId as string
    if (opportunityId) where.opportunityId = opportunityId as string

    const requirements = await prisma.documentRequirement.findMany({
      where,
      include: {
        clientCompany: { select: { id: true, name: true } },
        opportunity: { select: { id: true, title: true, responseDeadline: true } },
        template: { select: { id: true, title: true, fileName: true, category: true } },
      },
      orderBy: { dueDate: 'asc' },
    })

    res.json({ success: true, data: requirements })
  } catch (err) {
    next(err)
  }
})

// POST /api/doc-requirements
router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const body = CreateRequirementSchema.parse(req.body)

    validatePenaltyChoice(body)

    const client = await prisma.clientCompany.findFirst({
      where: { id: body.clientCompanyId, consultingFirmId, isActive: true },
      select: { id: true },
    })
    if (!client) throw new NotFoundError('Client')

    await validateOptionalOpportunity(body.opportunityId, consultingFirmId)
    await validateOptionalTemplate(body.templateId, consultingFirmId)

    const requirement = await prisma.documentRequirement.create({
      data: {
        consultingFirmId,
        clientCompanyId: body.clientCompanyId,
        opportunityId: body.opportunityId || null,
        templateId: body.templateId || null,
        title: body.title,
        description: body.description || null,
        dueDate: body.dueDate,
        isPenaltyEnabled: body.isPenaltyEnabled,
        penaltyAmount:
          body.isPenaltyEnabled && body.penaltyAmount != null
            ? body.penaltyAmount
            : null,
        penaltyPercent:
          body.isPenaltyEnabled && body.penaltyPercent != null
            ? body.penaltyPercent
            : null,
        notes: body.notes || null,
        status: 'PENDING',
      },
      include: {
        clientCompany: { select: { id: true, name: true } },
        opportunity: { select: { id: true, title: true } },
        template: { select: { id: true, title: true, fileName: true, category: true } },
      },
    })

    logger.info('Document requirement created', {
      id: requirement.id,
      clientCompanyId: requirement.clientCompanyId,
      templateId: requirement.templateId,
      createdBy: req.user?.userId,
    })

    res.status(201).json({ success: true, data: requirement })
  } catch (err) {
    next(err)
  }
})

// PUT /api/doc-requirements/:id
router.put('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.documentRequirement.findFirst({
      where: { id: req.params.id, consultingFirmId },
    })
    if (!existing) throw new NotFoundError('Document requirement')

    const body = UpdateRequirementSchema.parse(req.body)
    validatePenaltyChoice(body)

    if (body.opportunityId !== undefined) {
      await validateOptionalOpportunity(body.opportunityId, consultingFirmId)
    }

    if (body.templateId !== undefined) {
      await validateOptionalTemplate(body.templateId, consultingFirmId)
    }

    const isPenaltyEnabled = body.isPenaltyEnabled ?? existing.isPenaltyEnabled
    const shouldSetSubmittedAt =
      body.status === 'SUBMITTED' &&
      !existing.submittedAt

    const updated = await prisma.documentRequirement.update({
      where: { id: req.params.id },
      data: {
        title: body.title,
        description: body.description,
        dueDate: body.dueDate,
        opportunityId: body.opportunityId,
        templateId: body.templateId,
        isPenaltyEnabled,
        penaltyAmount:
          isPenaltyEnabled && body.penaltyAmount !== undefined
            ? body.penaltyAmount
            : isPenaltyEnabled
            ? existing.penaltyAmount
            : null,
        penaltyPercent:
          isPenaltyEnabled && body.penaltyPercent !== undefined
            ? body.penaltyPercent
            : isPenaltyEnabled
            ? existing.penaltyPercent
            : null,
        status: body.status,
        notes: body.notes,
        submittedAt: shouldSetSubmittedAt ? new Date() : undefined,
      },
      include: {
        clientCompany: { select: { id: true, name: true } },
        opportunity: { select: { id: true, title: true } },
        template: { select: { id: true, title: true, fileName: true, category: true } },
      },
    })

    res.json({ success: true, data: updated })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/doc-requirements/:id
router.delete('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.documentRequirement.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('Document requirement')

    await prisma.documentRequirement.delete({ where: { id: req.params.id } })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// GET /api/doc-requirements/client/:clientId
router.get('/client/:clientId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const requirements = await prisma.documentRequirement.findMany({
      where: { clientCompanyId: req.params.clientId, consultingFirmId },
      include: {
        template: { select: { id: true, title: true, fileName: true, category: true } },
        opportunity: {
          select: {
            id: true,
            title: true,
            responseDeadline: true,
            probabilityScore: true,
            expectedValue: true,
            scoreBreakdown: true,
          },
        },
      },
      orderBy: { dueDate: 'asc' },
    })
    res.json({ success: true, data: requirements })
  } catch (err) {
    next(err)
  }
})

export default router
