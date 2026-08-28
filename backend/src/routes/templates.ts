import fs from 'fs'
import path from 'path'
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { DocumentRequirementStatus } from '@prisma/client'
import { prisma } from '../config/database'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { upload } from '../middleware/upload'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { logger } from '../utils/logger'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('proposal_studio'))

const AssignTemplateSchema = z.object({
  clientCompanyIds: z.array(z.string().min(1)).min(1).max(200),
  dueDate: z.coerce.date(),
  opportunityId: z.string().optional().nullable(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional().nullable(),
  isPenaltyEnabled: z.boolean().optional().default(true),
  penaltyAmount: z.coerce.number().min(0).optional().nullable(),
  penaltyPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
})

const UpdateTemplateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional().nullable(),
  category: z.string().max(120).optional().nullable(),
  isActive: z.boolean().optional(),
})

function mapTemplate(template: {
  id: string
  title: string
  description: string | null
  category: string | null
  fileName: string
  fileType: string
  fileSize: number
  storageKey: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  _count?: { documentRequirements: number }
}) {
  return {
    ...template,
    downloadUrl: `/api/templates/${template.id}/download`,
    assignmentCount: template._count?.documentRequirements ?? 0,
  }
}

// -------------------------------------------------------------
// GET /api/templates
// -------------------------------------------------------------
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: any = { consultingFirmId }

    if (req.query.active !== undefined) {
      where.isActive = String(req.query.active).toLowerCase() === 'true'
    }

    if (req.query.category) {
      where.category = String(req.query.category)
    }

    const templates = await prisma.documentTemplate.findMany({
      where,
      include: {
        _count: {
          select: { documentRequirements: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    })

    res.json({ success: true, data: templates.map(mapTemplate) })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// POST /api/templates
// -------------------------------------------------------------
router.post('/', upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const title = String(req.body.title || '').trim()
    const description = req.body.description ? String(req.body.description).trim() : null
    const category = req.body.category ? String(req.body.category).trim() : null

    if (!title) throw new ValidationError('title is required')
    if (!req.file) throw new ValidationError('File is required')

    const created = await prisma.documentTemplate.create({
      data: {
        consultingFirmId,
        createdById: req.user?.userId || null,
        title,
        description,
        category,
        fileName: req.file.originalname,
        fileType: req.file.mimetype,
        fileSize: req.file.size,
        storageKey: req.file.filename,
      },
      include: {
        _count: {
          select: { documentRequirements: true },
        },
      },
    })

    logger.info('Template uploaded', {
      templateId: created.id,
      consultingFirmId,
      uploadedBy: req.user?.userId,
    })

    res.status(201).json({ success: true, data: mapTemplate(created) })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// GET /api/templates/:id/download
// -------------------------------------------------------------
router.get('/:id/download', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const template = await prisma.documentTemplate.findFirst({
      where: { id: req.params.id, consultingFirmId },
    })

    if (!template) throw new NotFoundError('Template')

    const filePath = path.join(process.cwd(), 'uploads', template.storageKey)
    if (!fs.existsSync(filePath)) throw new NotFoundError('Template file')

    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.download(filePath, template.fileName)
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// PATCH /api/templates/:id
// -------------------------------------------------------------
router.patch('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const data = UpdateTemplateSchema.parse(req.body)

    const existing = await prisma.documentTemplate.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('Template')

    const updated = await prisma.documentTemplate.update({
      where: { id: req.params.id },
      data: {
        title: data.title,
        description: data.description,
        category: data.category,
        isActive: data.isActive,
      },
      include: {
        _count: {
          select: { documentRequirements: true },
        },
      },
    })

    res.json({ success: true, data: mapTemplate(updated) })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// DELETE /api/templates/:id
// Soft-deactivate template.
// -------------------------------------------------------------
router.delete('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const existing = await prisma.documentTemplate.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('Template')

    await prisma.documentTemplate.update({
      where: { id: req.params.id },
      data: { isActive: false },
    })

    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// POST /api/templates/:id/assign
// Assign one saved template to multiple clients as document requirements.
// -------------------------------------------------------------
router.post('/:id/assign', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const templateId = req.params.id
    const input = AssignTemplateSchema.parse(req.body)

    if (input.penaltyAmount != null && input.penaltyPercent != null) {
      throw new ValidationError('Specify penaltyAmount or penaltyPercent, not both')
    }

    const template = await prisma.documentTemplate.findFirst({
      where: { id: templateId, consultingFirmId },
      select: {
        id: true,
        title: true,
        description: true,
        isActive: true,
      },
    })

    if (!template) throw new NotFoundError('Template')
    if (!template.isActive) throw new ValidationError('Template is inactive')

    const clientCompanyIds = Array.from(new Set(input.clientCompanyIds))
    const clients = await prisma.clientCompany.findMany({
      where: {
        id: { in: clientCompanyIds },
        consultingFirmId,
        isActive: true,
      },
      select: { id: true },
    })

    if (clients.length !== clientCompanyIds.length) {
      throw new ValidationError('One or more clientCompanyIds are invalid for this firm')
    }

    if (input.opportunityId) {
      const opp = await prisma.opportunity.findFirst({
        where: { id: input.opportunityId, consultingFirmId },
        select: { id: true },
      })
      if (!opp) throw new ValidationError('opportunityId does not belong to this firm')
    }

    const existing = await prisma.documentRequirement.findMany({
      where: {
        consultingFirmId,
        templateId,
        clientCompanyId: { in: clientCompanyIds },
        dueDate: input.dueDate,
        opportunityId: input.opportunityId || null,
      },
      select: { clientCompanyId: true },
    })
    const existingSet = new Set(existing.map((r) => r.clientCompanyId))

    const rows = clientCompanyIds
      .filter((clientCompanyId) => !existingSet.has(clientCompanyId))
      .map((clientCompanyId) => ({
        consultingFirmId,
        clientCompanyId,
        opportunityId: input.opportunityId || null,
        templateId,
        title: input.title || template.title,
        description:
          input.description !== undefined
            ? input.description
            : template.description,
        dueDate: input.dueDate,
        isPenaltyEnabled: input.isPenaltyEnabled,
        penaltyAmount:
          input.isPenaltyEnabled && input.penaltyAmount != null
            ? input.penaltyAmount
            : null,
        penaltyPercent:
          input.isPenaltyEnabled && input.penaltyPercent != null
            ? input.penaltyPercent
            : null,
        notes: input.notes || null,
        status: DocumentRequirementStatus.PENDING,
      }))

    if (rows.length > 0) {
      await prisma.documentRequirement.createMany({
        data: rows,
      })
    }

    logger.info('Template assigned', {
      templateId,
      consultingFirmId,
      createdCount: rows.length,
      skippedCount: existingSet.size,
      triggeredBy: req.user?.userId,
    })

    res.status(201).json({
      success: true,
      data: {
        templateId,
        createdCount: rows.length,
        skippedCount: existingSet.size,
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
