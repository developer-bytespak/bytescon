// =============================================================
// Past Performance Library & Matrix (§5.1 Stage 10 / §5.2). Mounted at
// /api/past-performance-library. Extends the existing PastPerformanceRecord with
// a rich library (search/filter/paginate), create-from-completed-Contract prefill,
// manual CPARS entry, private-reference protection (role-gated), attachments, and
// the per-opportunity relevance Matrix (deterministic score kept separate from
// human selection). AI relevance/adaptation use the exact verbatim prompts with a
// deterministic no-key fallback. CPARS is never auto-fetched; nothing is fabricated.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { requireActiveBase } from '../middleware/addonGate'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors'
import { logAudit } from '../services/auditService'
import { upload } from '../middleware/upload'
import { prisma } from '../config/database'
import { scoreRelevance, generateAdaptation, OpportunityContext, PastPerformanceContext } from '../services/pastPerformanceRelevance'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const CPARS_RATINGS = ['EXCEPTIONAL', 'VERY_GOOD', 'SATISFACTORY', 'MARGINAL', 'UNSATISFACTORY']
const ROLES = ['PRIME', 'SUB']
const isAdmin = (req: AuthenticatedRequest) => req.user?.role === 'ADMIN'

const audit = (req: AuthenticatedRequest, firmId: string, action: 'CREATE' | 'UPDATE' | 'DELETE', entityType: string, entityId: string, rationale?: string, before?: unknown, after?: unknown) =>
  logAudit({ consultingFirmId: firmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType, entityId, rationale, before, after })

async function loadRecord(firmId: string, id: string) {
  const r = await prisma.pastPerformanceRecord.findFirst({ where: { id, consultingFirmId: firmId } })
  if (!r) throw new NotFoundError('Past performance record')
  return r
}

// Redact private reference contact for non-authorized (non-ADMIN) roles.
function redactReference<T extends Record<string, unknown>>(rec: T, admin: boolean): T {
  if (admin) return { ...rec, referenceRedacted: false }
  return { ...rec, referenceName: null, referenceTitle: null, referenceEmail: null, referencePhone: null, referenceRedacted: true }
}

// =============================================================
// LIBRARY — search / filter / paginate
// =============================================================
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const q = req.query
    const where: Prisma.PastPerformanceRecordWhereInput = { consultingFirmId: firmId }
    if (q.archived === 'true') where.isArchived = true
    else if (q.archived !== 'all') where.isArchived = false
    // Cascade: hide records tied to an archived client (null-client rows unaffected).
    where.NOT = { clientCompany: { archivedAt: { not: null } } }
    if (q.agency) where.customerAgency = { contains: String(q.agency), mode: 'insensitive' }
    if (q.naicsCode) where.naicsCode = String(q.naicsCode)
    if (q.pscCode) where.pscCode = String(q.pscCode)
    if (q.role && ROLES.includes(String(q.role))) where.performerRole = String(q.role)
    if (q.cparsRating) where.cparsRating = String(q.cparsRating)
    if (q.verificationStatus) where.verificationStatus = String(q.verificationStatus)
    if (q.referenceAvailability) where.referenceAvailability = String(q.referenceAvailability)
    if (q.clientCompanyId) where.clientCompanyId = String(q.clientCompanyId)
    if (q.valueMin || q.valueMax) where.totalValue = { ...(q.valueMin ? { gte: Number(q.valueMin) } : {}), ...(q.valueMax ? { lte: Number(q.valueMax) } : {}) }
    if (q.endAfter || q.endBefore) where.periodOfPerformanceEnd = { ...(q.endAfter ? { gte: new Date(String(q.endAfter)) } : {}), ...(q.endBefore ? { lte: new Date(String(q.endBefore)) } : {}) }
    if (q.tag) where.relevanceTags = { has: String(q.tag) }
    if (q.search) {
      const s = String(q.search)
      where.OR = [{ contractTitle: { contains: s, mode: 'insensitive' } }, { customerName: { contains: s, mode: 'insensitive' } }, { contractNumber: { contains: s, mode: 'insensitive' } }, { scopeSummary: { contains: s, mode: 'insensitive' } }]
    }
    const page = Math.max(1, Number(q.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20))
    const sortBy = ['createdAt', 'totalValue', 'periodOfPerformanceEnd', 'customerAgency'].includes(String(q.sortBy)) ? String(q.sortBy) : 'createdAt'
    const order = q.order === 'asc' ? 'asc' : 'desc'
    const [total, records] = await Promise.all([
      prisma.pastPerformanceRecord.count({ where }),
      prisma.pastPerformanceRecord.findMany({ where, orderBy: { [sortBy]: order }, skip: (page - 1) * pageSize, take: pageSize }),
    ])
    const admin = isAdmin(req)
    res.json({ success: true, data: { records: records.map((r) => redactReference(r as unknown as Record<string, unknown>, admin)), total, page, pageSize, totalPages: Math.ceil(total / pageSize) } })
  } catch (err) { next(err) }
})

router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const record = await prisma.pastPerformanceRecord.findFirst({ where: { id: req.params.id, consultingFirmId: firmId }, include: { attachments: true } })
    if (!record) throw new NotFoundError('Past performance record')
    res.json({ success: true, data: { record: redactReference(record as unknown as Record<string, unknown>, isAdmin(req)) } })
  } catch (err) { next(err) }
})

const RecordSchema = z.object({
  contractNumber: z.string().trim().min(1).max(120),
  customerName: z.string().trim().min(1).max(300),
  contractTitle: z.string().max(300).nullish(),
  customerAgency: z.string().max(300).nullish(),
  contractingOffice: z.string().max(300).nullish(),
  naicsCode: z.string().max(20).nullish(),
  pscCode: z.string().max(20).nullish(),
  contractType: z.string().max(40).nullish(),
  totalValue: z.number().min(0).max(1e15).nullish(),
  fundedValue: z.number().min(0).max(1e15).nullish(),
  periodOfPerformanceStart: z.string().datetime().nullish(),
  periodOfPerformanceEnd: z.string().datetime().nullish(),
  performerRole: z.enum(['PRIME', 'SUB']).nullish(),
  scopeSummary: z.string().max(20000).nullish(),
  workPerformed: z.string().max(20000).nullish(),
  technicalCapabilities: z.string().max(20000).nullish(),
  resultsOutcomes: z.string().max(20000).nullish(),
  quantitativeMetrics: z.string().max(20000).nullish(),
  setAsideRelevance: z.string().max(2000).nullish(),
  relevanceTags: z.array(z.string().max(80)).max(50).nullish(),
  cparsRating: z.enum(['EXCEPTIONAL', 'VERY_GOOD', 'SATISFACTORY', 'MARGINAL', 'UNSATISFACTORY']).nullish(),
  cparsRatingDate: z.string().datetime().nullish(),
  cparsLink: z.string().max(500).nullish(),
  referenceName: z.string().max(200).nullish(),
  referenceTitle: z.string().max(200).nullish(),
  referenceEmail: z.string().max(200).nullish(),
  referencePhone: z.string().max(60).nullish(),
  permissionToContact: z.boolean().nullish(),
  referenceAvailability: z.enum(['AVAILABLE', 'LIMITED', 'UNAVAILABLE']).nullish(),
  clientCompanyId: z.string().max(60).nullish(),
  internalNotes: z.string().max(20000).nullish(),
})

function recordData(d: z.infer<typeof RecordSchema>): Prisma.PastPerformanceRecordUncheckedCreateInput {
  return {
    consultingFirmId: '', // set by caller
    contractNumber: d.contractNumber, customerName: d.customerName,
    contractTitle: d.contractTitle ?? null, customerAgency: d.customerAgency ?? null, contractingOffice: d.contractingOffice ?? null,
    naicsCode: d.naicsCode ?? null, pscCode: d.pscCode ?? null, contractType: d.contractType ?? null,
    totalValue: d.totalValue ?? null, fundedValue: d.fundedValue ?? null,
    periodOfPerformanceStart: d.periodOfPerformanceStart ? new Date(d.periodOfPerformanceStart) : null,
    periodOfPerformanceEnd: d.periodOfPerformanceEnd ? new Date(d.periodOfPerformanceEnd) : null,
    performerRole: d.performerRole ?? null, scopeSummary: d.scopeSummary ?? '', workPerformed: d.workPerformed ?? null,
    technicalCapabilities: d.technicalCapabilities ?? null, resultsOutcomes: d.resultsOutcomes ?? null,
    quantitativeMetrics: d.quantitativeMetrics ?? null, setAsideRelevance: d.setAsideRelevance ?? null,
    relevanceTags: d.relevanceTags ?? [], cparsRating: d.cparsRating ?? null,
    cparsRatingDate: d.cparsRatingDate ? new Date(d.cparsRatingDate) : null, cparsLink: d.cparsLink ?? null,
    referenceName: d.referenceName ?? null, referenceTitle: d.referenceTitle ?? null, referenceEmail: d.referenceEmail ?? null,
    referencePhone: d.referencePhone ?? null, permissionToContact: d.permissionToContact ?? false,
    referenceAvailability: d.referenceAvailability ?? null, clientCompanyId: d.clientCompanyId ?? null, internalNotes: d.internalNotes ?? null,
  }
}

// Create — CONSULTANT may create (always as DRAFT); ADMIN too. Verify/approve/
// edit remain ADMIN-only below.
router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const p = RecordSchema.safeParse(req.body ?? {})
    if (!p.success) throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid record')
    if (p.data.clientCompanyId) { const c = await prisma.clientCompany.findFirst({ where: { id: p.data.clientCompanyId, consultingFirmId: firmId }, select: { id: true } }); if (!c) throw new ValidationError('clientCompanyId does not belong to your firm') }
    const record = await prisma.pastPerformanceRecord.create({ data: { ...recordData(p.data), consultingFirmId: firmId, ownerUserId: req.user?.userId ?? null, verificationStatus: 'DRAFT' } })
    await audit(req, firmId, 'CREATE', 'PastPerformanceRecord', record.id, `Past performance created: ${record.contractNumber}`)
    res.status(201).json({ success: true, data: { record } })
  } catch (err) { next(err) }
})

router.patch('/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await loadRecord(firmId, req.params.id)
    if (existing.verificationStatus === 'APPROVED') throw new ConflictError('Approved records are immutable — reopen the record before editing.')
    const p = RecordSchema.partial().safeParse(req.body ?? {})
    if (!p.success) throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid update')
    const data: Record<string, unknown> = {}
    const d = p.data as Record<string, unknown>
    for (const k of Object.keys(d)) {
      if (['periodOfPerformanceStart', 'periodOfPerformanceEnd', 'cparsRatingDate'].includes(k)) data[k] = d[k] ? new Date(d[k] as string) : null
      else data[k] = d[k]
    }
    const record = await prisma.pastPerformanceRecord.update({ where: { id: existing.id }, data })
    await audit(req, firmId, 'UPDATE', 'PastPerformanceRecord', existing.id, 'Past performance updated')
    res.json({ success: true, data: { record } })
  } catch (err) { next(err) }
})

// Reopen an approved record for edits (ADMIN) → back to VERIFIED.
router.post('/:id/reopen', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await loadRecord(firmId, req.params.id)
    const record = await prisma.pastPerformanceRecord.update({ where: { id: existing.id }, data: { verificationStatus: 'VERIFIED' } })
    await audit(req, firmId, 'UPDATE', 'PastPerformanceRecord', existing.id, 'Record reopened for edits', { verificationStatus: existing.verificationStatus }, { verificationStatus: 'VERIFIED' })
    res.json({ success: true, data: { record } })
  } catch (err) { next(err) }
})

router.post('/:id/verify', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await loadRecord(firmId, req.params.id)
    const status = req.body?.status === 'APPROVED' ? 'APPROVED' : 'VERIFIED'
    const record = await prisma.pastPerformanceRecord.update({ where: { id: existing.id }, data: { verificationStatus: status } })
    await audit(req, firmId, 'UPDATE', 'PastPerformanceRecord', existing.id, `Verification → ${status}`, { verificationStatus: existing.verificationStatus }, { verificationStatus: status })
    res.json({ success: true, data: { record } })
  } catch (err) { next(err) }
})

router.post('/:id/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await loadRecord(firmId, req.params.id)
    await prisma.pastPerformanceRecord.update({ where: { id: existing.id }, data: { isArchived: true } })
    await audit(req, firmId, 'UPDATE', 'PastPerformanceRecord', existing.id, 'Archived')
    res.json({ success: true, data: { archived: true } })
  } catch (err) { next(err) }
})

router.post('/:id/restore', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await loadRecord(firmId, req.params.id)
    await prisma.pastPerformanceRecord.update({ where: { id: existing.id }, data: { isArchived: false } })
    await audit(req, firmId, 'UPDATE', 'PastPerformanceRecord', existing.id, 'Restored')
    res.json({ success: true, data: { restored: true } })
  } catch (err) { next(err) }
})

// Create a DRAFT from a completed Contract — prefill only reliable stored data.
router.post('/from-contract/:contractId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const contract = await prisma.contract.findFirst({ where: { id: req.params.contractId, consultingFirmId: firmId } })
    if (!contract) throw new NotFoundError('Contract')
    const dupe = await prisma.pastPerformanceRecord.findFirst({ where: { sourceContractId: contract.id }, select: { id: true } })
    if (dupe) throw new ConflictError('A past-performance record already exists for this contract.')
    const record = await prisma.pastPerformanceRecord.create({
      data: {
        consultingFirmId: firmId, sourceContractId: contract.id, ownerUserId: req.user?.userId ?? null, verificationStatus: 'DRAFT',
        contractNumber: contract.contractNumber, contractTitle: contract.title, customerName: contract.agency ?? contract.title,
        customerAgency: contract.agency ?? null, contractingOffice: contract.contractingOffice ?? null, contractType: contract.contractType ?? null,
        totalValue: contract.awardValue ?? null, fundedValue: contract.fundedValue ?? null,
        periodOfPerformanceStart: contract.startDate ?? null, periodOfPerformanceEnd: contract.endDate ?? null,
        clientCompanyId: contract.clientCompanyId ?? null, linkedOpportunityId: contract.opportunityId ?? null,
        scopeSummary: contract.description ?? '',
        // Results, metrics, CPARS, references intentionally left blank — never fabricated.
      },
    })
    await audit(req, firmId, 'CREATE', 'PastPerformanceRecord', record.id, `Draft created from contract ${contract.contractNumber} (requires human verification)`)
    res.status(201).json({ success: true, data: { record } })
  } catch (err) { next(err) }
})

// Attachments
router.post('/:id/attachment', requireRole('ADMIN'), upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const record = await loadRecord(firmId, req.params.id)
    if (!req.file) throw new ValidationError('No file uploaded')
    const att = await prisma.pastPerformanceAttachment.create({ data: { consultingFirmId: firmId, pastPerformanceRecordId: record.id, key: path.basename(req.file.path), name: req.file.originalname, uploadedByUserId: req.user?.userId ?? null } })
    await audit(req, firmId, 'CREATE', 'PastPerformanceAttachment', att.id, `Attachment: ${req.file.originalname}`)
    res.status(201).json({ success: true, data: { attachment: { id: att.id, name: att.name } } })
  } catch (err) { next(err) }
})

router.get('/attachments/:attachmentId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const att = await prisma.pastPerformanceAttachment.findFirst({ where: { id: req.params.attachmentId, consultingFirmId: firmId } })
    if (!att) throw new NotFoundError('Attachment')
    const filePath = path.join(process.cwd(), 'uploads', att.key)
    if (!fs.existsSync(filePath)) throw new NotFoundError('File not found on disk')
    res.download(filePath, att.name)
  } catch (err) { next(err) }
})

// =============================================================
// MATRIX (per opportunity) — deterministic score separate from human selection
// =============================================================
router.get('/matrix/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId: firmId }, select: { id: true } })
    if (!opp) throw new NotFoundError('Opportunity')
    const [selections, records] = await Promise.all([
      prisma.pastPerformanceSelection.findMany({ where: { consultingFirmId: firmId, opportunityId: opp.id } }),
      prisma.pastPerformanceRecord.findMany({ where: { consultingFirmId: firmId, isArchived: false }, orderBy: { updatedAt: 'desc' } }),
    ])
    const byRecord = new Map(selections.map((s) => [s.pastPerformanceRecordId, s]))
    const admin = isAdmin(req)
    const rows = records.map((r) => ({
      record: redactReference(r as unknown as Record<string, unknown>, admin),
      selection: byRecord.get(r.id) ?? null,
    }))
    res.json({ success: true, data: { rows, selectedCount: selections.filter((s) => s.isSelected).length } })
  } catch (err) { next(err) }
})

router.post('/matrix/:opportunityId/score', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId: firmId }, select: { id: true, agency: true, naicsCode: true, description: true, setAsideType: true, estimatedValue: true } })
    if (!opp) throw new NotFoundError('Opportunity')
    const oppCtx: OpportunityContext = { agency: opp.agency, naicsCode: opp.naicsCode, pscCode: null, scope: opp.description ?? null, setAside: opp.setAsideType ?? null, estimatedValue: opp.estimatedValue ? Number(opp.estimatedValue) : null }
    const records = await prisma.pastPerformanceRecord.findMany({ where: { consultingFirmId: firmId, isArchived: false } })
    let scored = 0
    for (const r of records) {
      const ctx: PastPerformanceContext = { id: r.id, customerAgency: r.customerAgency, naicsCode: r.naicsCode, pscCode: r.pscCode, scopeSummary: r.scopeSummary, relevanceTags: r.relevanceTags, totalValue: r.totalValue ? Number(r.totalValue) : null, periodOfPerformanceEnd: r.periodOfPerformanceEnd, performerRole: r.performerRole, setAsideRelevance: r.setAsideRelevance }
      const result = scoreRelevance(oppCtx, ctx)
      await prisma.pastPerformanceSelection.upsert({
        where: { opportunityId_pastPerformanceRecordId: { opportunityId: opp.id, pastPerformanceRecordId: r.id } },
        update: { relevanceScore: result.relevanceScore, confidence: result.confidence, matchingFactors: result.matchingFactors, missingFactors: result.missingFactors, relevanceExplanation: result.explanation, scoredAt: new Date(), scoreMethod: 'DETERMINISTIC' },
        create: { consultingFirmId: firmId, opportunityId: opp.id, pastPerformanceRecordId: r.id, relevanceScore: result.relevanceScore, confidence: result.confidence, matchingFactors: result.matchingFactors, missingFactors: result.missingFactors, relevanceExplanation: result.explanation, scoredAt: new Date(), scoreMethod: 'DETERMINISTIC' },
      })
      scored++
    }
    await audit(req, firmId, 'UPDATE', 'Opportunity', opp.id, `Past-performance relevance scored (deterministic) for ${scored} record(s)`)
    res.json({ success: true, data: { scored } })
  } catch (err) { next(err) }
})

async function loadSelection(firmId: string, opportunityId: string, recordId: string) {
  const opp = await prisma.opportunity.findFirst({ where: { id: opportunityId, consultingFirmId: firmId }, select: { id: true } })
  if (!opp) throw new NotFoundError('Opportunity')
  const record = await prisma.pastPerformanceRecord.findFirst({ where: { id: recordId, consultingFirmId: firmId }, select: { id: true } })
  if (!record) throw new NotFoundError('Past performance record')
  return prisma.pastPerformanceSelection.upsert({
    where: { opportunityId_pastPerformanceRecordId: { opportunityId, pastPerformanceRecordId: recordId } },
    update: {}, create: { consultingFirmId: firmId, opportunityId, pastPerformanceRecordId: recordId },
  })
}

router.post('/matrix/:opportunityId/select/:recordId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const sel = await loadSelection(firmId, req.params.opportunityId, req.params.recordId)
    const updated = await prisma.pastPerformanceSelection.update({ where: { id: sel.id }, data: { isSelected: true, selectedByUserId: req.user?.userId ?? null, selectedAt: new Date(), displayOrder: typeof req.body?.displayOrder === 'number' ? req.body.displayOrder : sel.displayOrder, notes: typeof req.body?.notes === 'string' ? req.body.notes : sel.notes, proposalId: typeof req.body?.proposalId === 'string' ? req.body.proposalId : sel.proposalId } })
    await audit(req, firmId, 'UPDATE', 'PastPerformanceSelection', sel.id, 'Selected for proposal')
    res.json({ success: true, data: { selection: updated } })
  } catch (err) { next(err) }
})

router.post('/matrix/:opportunityId/deselect/:recordId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const sel = await loadSelection(firmId, req.params.opportunityId, req.params.recordId)
    const updated = await prisma.pastPerformanceSelection.update({ where: { id: sel.id }, data: { isSelected: false } })
    await audit(req, firmId, 'UPDATE', 'PastPerformanceSelection', sel.id, 'Deselected (master record unchanged)')
    res.json({ success: true, data: { selection: updated } })
  } catch (err) { next(err) }
})

// Proposal reuse — AI adaptation draft (exact prompt / deterministic fallback).
// Never modifies the master record.
router.post('/:id/adapt', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const record = await loadRecord(firmId, req.params.id)
    let opportunityTitle: string | null = null
    if (typeof req.body?.opportunityId === 'string') {
      const opp = await prisma.opportunity.findFirst({ where: { id: req.body.opportunityId, consultingFirmId: firmId }, select: { title: true } })
      opportunityTitle = opp?.title ?? null
    }
    const { content, source } = await generateAdaptation({
      contractTitle: record.contractTitle, customerName: record.customerName, customerAgency: record.customerAgency,
      contractNumber: record.contractNumber, totalValue: record.totalValue ? Number(record.totalValue) : null,
      scopeSummary: record.scopeSummary, workPerformed: record.workPerformed, resultsOutcomes: record.resultsOutcomes,
      quantitativeMetrics: record.quantitativeMetrics, cparsRating: record.cparsRating, performerRole: record.performerRole,
      opportunityTitle, userNotes: typeof req.body?.userNotes === 'string' ? req.body.userNotes : null,
    }, firmId)
    await audit(req, firmId, 'CREATE', 'PastPerformanceRecord', record.id, `Adaptation draft generated (${source}) — master record unchanged`)
    res.json({ success: true, data: { content, source } })
  } catch (err) { next(err) }
})

export default router
