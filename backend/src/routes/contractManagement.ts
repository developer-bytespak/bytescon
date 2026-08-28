// =============================================================
// Post-Award Contract Management (Section 5 Module 8)
// -------------------------------------------------------------
// Contracts + Option Periods + CLINs + Modifications + Deliverables Log — one
// connected module sharing the same records. Reads are firm-wide (any role);
// management writes are ADMIN-only; deliverable submission is allowed for any
// authenticated firm user (owner action). Every mutation is tenant-scoped and
// audited. Mounted at /api/contract-management (distinct from the existing
// /api/contracts document-analysis route). Mirrors routes/pastPerformance.ts.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ConflictError, ValidationError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { prisma } from '../config/database'
// §7.1 — contract domain events for the Contract Administration Agent. Each is
// emitted inside the same transaction as its business write.
import {
  emitContractAwarded, emitContractModificationAdded, emitDeliverableStatusChanged,
} from '../services/agents/contract/contractEvents'
import { AWARDED_CONTRACT_STATUS } from '../services/agents/contract/policy'
import {
  DELIVERABLE_STATUSES,
  DeliverableStatus,
  isValidDeliverableTransition,
  deriveStatus,
  isOverdue,
  isUpcoming,
} from '../services/deliverableStatus'
import { computeContractAfterMod, canApplyModification, ModStatus } from '../services/contractModification'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

// ---- shared validators ----
const dateField = z.string().datetime().transform((s) => new Date(s)).nullable().optional()
const money = z.number().nonnegative().max(1_000_000_000).nullable().optional()
const moneyDelta = z.number().min(-1_000_000_000).max(1_000_000_000).nullable().optional()

const CONTRACT_STATUSES = ['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'TERMINATED', 'CANCELLED', 'ARCHIVED'] as const
const CONTRACT_TYPES = ['FFP', 'T_AND_M', 'IDIQ', 'COST_REIMB', 'LABOR_HOUR', 'BPA', 'OTHER'] as const
const CLIN_TYPES = ['FFP', 'T_AND_M', 'COST_REIMBURSEMENT', 'LABOR_HOUR', 'IDIQ', 'OTHER'] as const
const CLIN_STATUSES = ['ACTIVE', 'COMPLETED', 'CANCELLED'] as const
const CLIN_LEVELS = ['TASK_ORDER', 'CLIN', 'SUB_CLIN'] as const
const OPTION_STATUSES = ['PLANNED', 'PENDING_DECISION', 'EXERCISED', 'NOT_EXERCISED', 'EXPIRED'] as const
const MOD_STATUSES = ['DRAFT', 'RECORDED', 'APPLIED', 'VOIDED'] as const

function assertDateRange(start?: Date | null, end?: Date | null) {
  if (start && end && start.getTime() > end.getTime()) {
    throw new ValidationError('End date must be on or after the start date')
  }
}

async function loadContract(consultingFirmId: string, id: string) {
  const contract = await prisma.contract.findFirst({ where: { id, consultingFirmId } })
  if (!contract) throw new NotFoundError('Contract')
  return contract
}

const audit = (req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction, entityType: string, entityId: string, rationale?: string) =>
  logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType, entityId, rationale })

// =============================================================
// GLOBAL DELIVERABLE FEEDS — declared before "/:id" so they aren't captured.
// =============================================================
function withDerived(d: { dueDate: Date | null; status: string }, now: Date) {
  return { ...d, derivedStatus: deriveStatus(d.dueDate, d.status as DeliverableStatus, now), isOverdue: isOverdue(d.dueDate, d.status as DeliverableStatus, now) }
}

router.get('/deliverables', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const q = req.query
    const page = Math.max(1, parseInt(String(q.page || '1'), 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || '25'), 10) || 25))
    const where: Prisma.ContractDeliverableWhereInput = { consultingFirmId }
    if (q.includeArchived !== 'true') where.isArchived = false
    if (q.contractId) where.contractId = String(q.contractId)
    if (q.clinId) where.clinId = String(q.clinId)
    if (q.ownerUserId) where.ownerUserId = String(q.ownerUserId)
    if (q.status) where.status = String(q.status)
    if (q.acceptanceStatus) where.acceptanceStatus = String(q.acceptanceStatus)
    if (q.dueBefore || q.dueAfter) {
      where.dueDate = {}
      if (q.dueAfter) (where.dueDate as Prisma.DateTimeFilter).gte = new Date(String(q.dueAfter))
      if (q.dueBefore) (where.dueDate as Prisma.DateTimeFilter).lte = new Date(String(q.dueBefore))
    }
    const [rows, total] = await Promise.all([
      prisma.contractDeliverable.findMany({ where, orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      prisma.contractDeliverable.count({ where }),
    ])
    const now = new Date()
    res.json({ success: true, data: rows.map((d) => withDerived(d, now)), meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } })
  } catch (err) { next(err) }
})

async function feed(req: AuthenticatedRequest, res: Response, mode: 'upcoming' | 'overdue') {
  const consultingFirmId = getTenantId(req)
  const windowDays = Math.min(365, Math.max(1, parseInt(String(req.query.windowDays || '14'), 10) || 14))
  const now = new Date()
  const rows = await prisma.contractDeliverable.findMany({
    where: { consultingFirmId, isArchived: false, dueDate: { not: null } },
    orderBy: { dueDate: 'asc' },
    include: { contract: { select: { id: true, contractNumber: true, title: true } } },
  })
  const filtered = rows.filter((d) =>
    mode === 'overdue'
      ? isOverdue(d.dueDate, d.status as DeliverableStatus, now)
      : isUpcoming(d.dueDate, d.status as DeliverableStatus, now, windowDays),
  )
  res.json({ success: true, data: filtered.map((d) => withDerived(d, now)) })
}
router.get('/deliverables/upcoming', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try { await feed(req, res, 'upcoming') } catch (err) { next(err) }
})
router.get('/deliverables/overdue', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try { await feed(req, res, 'overdue') } catch (err) { next(err) }
})

// =============================================================
// CONTRACTS
// =============================================================
const ContractCreateSchema = z.object({
  contractNumber: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
  opportunityId: z.string().uuid().nullable().optional(),
  clientCompanyId: z.string().uuid().nullable().optional(),
  agency: z.string().max(300).nullable().optional(),
  contractingOffice: z.string().max(300).nullable().optional(),
  contractType: z.enum(CONTRACT_TYPES).nullable().optional(),
  awardValue: money,
  fundedValue: money,
  ceilingValue: money,
  startDate: dateField,
  endDate: dateField,
  status: z.enum(CONTRACT_STATUSES).optional(),
  ownerUserId: z.string().nullable().optional(),
  customerContactName: z.string().max(200).nullable().optional(),
  customerContactEmail: z.string().max(200).nullable().optional(),
  customerContactPhone: z.string().max(60).nullable().optional(),
  description: z.string().max(8000).nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
})

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const q = req.query
    const page = Math.max(1, parseInt(String(q.page || '1'), 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || '25'), 10) || 25))
    const sortMap: Record<string, string> = { endDate: 'endDate', startDate: 'startDate', value: 'awardValue', updated: 'updatedAt' }
    const sortBy = sortMap[String(q.sortBy || 'updated')] || 'updatedAt'
    const sortOrder = String(q.sortOrder || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'

    const where: Prisma.ContractWhereInput = { consultingFirmId }
    if (q.includeArchived !== 'true') where.isArchived = false
    // Cascade: hide contracts belonging to an archived client (null-client rows unaffected).
    where.NOT = { clientCompany: { archivedAt: { not: null } } }
    if (q.status) where.status = String(q.status)
    if (q.agency) where.agency = { contains: String(q.agency), mode: 'insensitive' }
    if (q.clientCompanyId) where.clientCompanyId = String(q.clientCompanyId)
    if (q.ownerUserId) where.ownerUserId = String(q.ownerUserId)
    if (q.search && String(q.search).trim()) {
      const term = String(q.search).trim()
      where.OR = [
        { contractNumber: { contains: term, mode: 'insensitive' } },
        { title: { contains: term, mode: 'insensitive' } },
        { agency: { contains: term, mode: 'insensitive' } },
      ]
    }
    if (q.expiringSoon === 'true') {
      const days = Math.min(365, Math.max(1, parseInt(String(q.expiringWindowDays || '60'), 10) || 60))
      where.endDate = { gte: new Date(), lte: new Date(Date.now() + days * 86_400_000) }
    } else if (q.activePeriod === 'true') {
      const now = new Date()
      where.AND = [{ OR: [{ startDate: null }, { startDate: { lte: now } }] }, { OR: [{ endDate: null }, { endDate: { gte: now } }] }]
    }
    const [rows, total] = await Promise.all([
      prisma.contract.findMany({ where, orderBy: { [sortBy]: sortOrder }, skip: (page - 1) * limit, take: limit }),
      prisma.contract.count({ where }),
    ])
    res.json({ success: true, data: rows, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } })
  } catch (err) { next(err) }
})

router.post('/', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const body = ContractCreateSchema.parse(req.body)
    assertDateRange(body.startDate ?? null, body.endDate ?? null)
    // Duplicate contract number within the tenant is blocked.
    const numDup = await prisma.contract.findFirst({ where: { consultingFirmId, contractNumber: { equals: body.contractNumber, mode: 'insensitive' } }, select: { id: true } })
    if (numDup) throw new ConflictError('A contract with this number already exists for your firm.')
    if (body.opportunityId) {
      const opp = await prisma.opportunity.findFirst({ where: { id: body.opportunityId, consultingFirmId }, select: { id: true } })
      if (!opp) throw new NotFoundError('Opportunity')
      const dup = await prisma.contract.findFirst({ where: { consultingFirmId, opportunityId: body.opportunityId }, select: { id: true } })
      if (dup) throw new ConflictError('A contract already exists for this opportunity')
    }
    if (body.clientCompanyId) {
      const c = await prisma.clientCompany.findFirst({ where: { id: body.clientCompanyId, consultingFirmId }, select: { id: true } })
      if (!c) throw new NotFoundError('ClientCompany')
    }
    const contract = await prisma.$transaction(async (tx) => {
      const created = await tx.contract.create({ data: { consultingFirmId, ...body } })
      // A contract created straight into ACTIVE is awarded at creation.
      if (created.status === AWARDED_CONTRACT_STATUS) {
        await emitContractAwarded(tx, { consultingFirmId, contractId: created.id, contractNumber: created.contractNumber })
      }
      return created
    })
    await audit(req, consultingFirmId, 'CREATE', 'Contract', contract.id)
    res.status(201).json({ success: true, data: contract })
  } catch (err) { next(err) }
})

// Create a contract pre-filled from an AWARDED opportunity (review-then-save
// happens client-side; server validates tenant + prevents duplicates).
router.post('/from-opportunity/:opportunityId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId } })
    if (!opp) throw new NotFoundError('Opportunity')
    const dup = await prisma.contract.findFirst({ where: { consultingFirmId, opportunityId: opp.id }, select: { id: true } })
    if (dup) throw new ConflictError('A contract already exists for this opportunity')
    const overrides = ContractCreateSchema.partial().parse(req.body ?? {})
    assertDateRange(overrides.startDate ?? null, overrides.endDate ?? null)
    const contract = await prisma.contract.create({
      data: {
        consultingFirmId,
        opportunityId: opp.id,
        contractNumber: overrides.contractNumber ?? opp.solicitationNumber ?? '',
        title: overrides.title ?? opp.title,
        agency: overrides.agency ?? opp.agency,
        awardValue: overrides.awardValue ?? (opp.estimatedValue ? Number(opp.estimatedValue) : null),
        status: overrides.status ?? 'DRAFT',
        ownerUserId: overrides.ownerUserId ?? req.user?.userId ?? null,
        contractType: overrides.contractType ?? null,
        startDate: overrides.startDate ?? null,
        endDate: overrides.endDate ?? null,
        description: overrides.description ?? null,
        notes: overrides.notes ?? null,
        clientCompanyId: overrides.clientCompanyId ?? null,
      },
    })
    await audit(req, consultingFirmId, 'CREATE', 'Contract', contract.id, 'from awarded opportunity')
    res.status(201).json({ success: true, data: contract })
  } catch (err) { next(err) }
})

router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const contract = await prisma.contract.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: {
        clins: { orderBy: { clinNumber: 'asc' } },
        modifications: { orderBy: { createdAt: 'asc' } },
        optionPeriods: { orderBy: { createdAt: 'asc' } },
        deliverables: {
          where: { isArchived: false }, orderBy: [{ dueDate: 'asc' }],
          include: { partner: { select: { id: true, name: true } } },
        },
      },
    })
    if (!contract) throw new NotFoundError('Contract')
    const now = new Date()
    const deliverables = contract.deliverables.map((d) => withDerived(d, now))
    // Activity: audit events for the contract + its children.
    const childIds = [contract.id, ...contract.clins.map((c) => c.id), ...contract.modifications.map((m) => m.id), ...contract.optionPeriods.map((o) => o.id), ...contract.deliverables.map((d) => d.id)]
    const activity = await prisma.auditEvent.findMany({ where: { consultingFirmId, entityId: { in: childIds } }, orderBy: { createdAt: 'desc' }, take: 100, select: { action: true, entityType: true, entityId: true, actorUserId: true, rationale: true, createdAt: true } })
    res.json({ success: true, data: { ...contract, deliverables, activity } })
  } catch (err) { next(err) }
})

router.put('/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const contract = await loadContract(consultingFirmId, req.params.id)
    const body = ContractCreateSchema.partial().parse(req.body)
    const start = body.startDate !== undefined ? body.startDate : contract.startDate
    const end = body.endDate !== undefined ? body.endDate : contract.endDate
    assertDateRange(start, end)
    // opportunityId is not editable here to preserve the award link integrity.
    const { opportunityId: _drop, ...rest } = body
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.contract.update({ where: { id: contract.id }, data: rest })
      // ACTIVE is the canonical award/activation transition in this model — no
      // second AWARDED state is invented. Deduped on the contract id.
      if (row.status === AWARDED_CONTRACT_STATUS && contract.status !== AWARDED_CONTRACT_STATUS) {
        await emitContractAwarded(tx, { consultingFirmId, contractId: row.id, contractNumber: row.contractNumber })
      }
      return row
    })
    await audit(req, consultingFirmId, 'UPDATE', 'Contract', contract.id)
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// PATCH /:id — edit contract header fields (ADMIN). Contract Number is immutable
// (identity); Delete is never permitted — archive/restore is the lifecycle.
const ContractUpdateSchema = ContractCreateSchema.omit({ contractNumber: true, opportunityId: true }).partial()
router.patch('/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const contract = await loadContract(consultingFirmId, req.params.id)
    const body = ContractUpdateSchema.parse(req.body)
    if (body.startDate !== undefined || body.endDate !== undefined) {
      assertDateRange(body.startDate ?? contract.startDate, body.endDate ?? contract.endDate)
    }
    if (body.clientCompanyId) {
      const c = await prisma.clientCompany.findFirst({ where: { id: body.clientCompanyId, consultingFirmId }, select: { id: true } })
      if (!c) throw new NotFoundError('ClientCompany')
    }
    const updated = await prisma.contract.update({ where: { id: contract.id }, data: body })
    await audit(req, consultingFirmId, 'UPDATE', 'Contract', contract.id, `Contract updated: ${updated.title}`)
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

router.post('/:id/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const contract = await loadContract(consultingFirmId, req.params.id)
    const updated = await prisma.contract.update({ where: { id: contract.id }, data: { isArchived: true, status: 'ARCHIVED' } })
    await audit(req, consultingFirmId, 'ARCHIVED', 'Contract', contract.id, 'archived')
    res.json({ success: true, data: { id: updated.id, isArchived: true, status: updated.status } })
  } catch (err) { next(err) }
})

router.post('/:id/restore', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const contract = await loadContract(consultingFirmId, req.params.id)
    const updated = await prisma.contract.update({ where: { id: contract.id }, data: { isArchived: false, status: 'ACTIVE' } })
    await audit(req, consultingFirmId, 'RESTORED', 'Contract', contract.id, 'restored')
    res.json({ success: true, data: { id: updated.id, isArchived: false, status: updated.status } })
  } catch (err) { next(err) }
})

// =============================================================
// OPTION PERIODS
// =============================================================
const OptionSchema = z.object({
  label: z.string().min(1).max(120),
  description: z.string().max(4000).nullable().optional(),
  startDate: dateField,
  endDate: dateField,
  optionValue: money,
  exerciseStatus: z.enum(OPTION_STATUSES).optional(),
  decisionDate: dateField,
  exerciseDeadline: dateField,
  notes: z.string().max(4000).nullable().optional(),
})
router.get('/:id/options', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await loadContract(consultingFirmId, req.params.id)
    const rows = await prisma.contractOptionPeriod.findMany({ where: { consultingFirmId, contractId: req.params.id }, orderBy: { createdAt: 'asc' } })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})
router.post('/:id/options', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await loadContract(consultingFirmId, req.params.id)
    const body = OptionSchema.parse(req.body)
    assertDateRange(body.startDate ?? null, body.endDate ?? null)
    const row = await prisma.contractOptionPeriod.create({ data: { consultingFirmId, contractId: req.params.id, ...body } })
    await audit(req, consultingFirmId, 'CREATE', 'ContractOptionPeriod', row.id)
    res.status(201).json({ success: true, data: row })
  } catch (err) { next(err) }
})
router.put('/options/:optionId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.contractOptionPeriod.findFirst({ where: { id: req.params.optionId, consultingFirmId } })
    if (!existing) throw new NotFoundError('ContractOptionPeriod')
    const body = OptionSchema.partial().parse(req.body)
    assertDateRange(body.startDate ?? existing.startDate, body.endDate ?? existing.endDate)
    const row = await prisma.contractOptionPeriod.update({ where: { id: existing.id }, data: body })
    await audit(req, consultingFirmId, 'UPDATE', 'ContractOptionPeriod', row.id)
    res.json({ success: true, data: row })
  } catch (err) { next(err) }
})

// =============================================================
// CLINs
// =============================================================
const ClinSchema = z.object({
  clinNumber: z.string().min(1).max(60),
  title: z.string().max(300).nullable().optional(),
  clinType: z.enum(CLIN_TYPES).nullable().optional(),
  // §8.2 — the task-order tier. A separate TaskOrder model was deliberately
  // avoided: a task order IS a CLIN with children, so it stays one table.
  clinLevel: z.enum(CLIN_LEVELS).optional(),
  parentClinId: z.string().uuid().nullable().optional(),
  quantity: money,
  unit: z.string().max(40).nullable().optional(),
  unitPrice: money,
  fundedAmount: money,
  ceilingAmount: money,
  startDate: dateField,
  endDate: dateField,
  status: z.enum(CLIN_STATUSES).optional(),
  notes: z.string().max(4000).nullable().optional(),
})
router.get('/:id/clins', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await loadContract(consultingFirmId, req.params.id)
    const includeArchived = String(req.query.includeArchived) === 'true'
    const rows = await prisma.clin.findMany({ where: { consultingFirmId, contractId: req.params.id, ...(includeArchived ? {} : { isArchived: false }) }, orderBy: { clinNumber: 'asc' } })
    const totals = rows.reduce(
      (acc, c) => ({ funded: acc.funded.plus(c.fundedAmount ?? 0), ceiling: acc.ceiling.plus(c.ceilingAmount ?? 0) }),
      { funded: new Prisma.Decimal(0), ceiling: new Prisma.Decimal(0) },
    )
    res.json({ success: true, data: rows, meta: { totalFunded: totals.funded, totalCeiling: totals.ceiling } })
  } catch (err) { next(err) }
})
router.post('/:id/clins', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await loadContract(consultingFirmId, req.params.id)
    const body = ClinSchema.parse(req.body)
    assertDateRange(body.startDate ?? null, body.endDate ?? null)
    const dup = await prisma.clin.findFirst({ where: { contractId: req.params.id, clinNumber: body.clinNumber }, select: { id: true } })
    if (dup) throw new ConflictError(`CLIN ${body.clinNumber} already exists on this contract`)
    if (body.parentClinId) {
      const parent = await prisma.clin.findFirst({ where: { id: body.parentClinId, contractId: req.params.id }, select: { id: true } })
      if (!parent) throw new ValidationError('Parent CLIN must belong to the same contract')
    }
    const row = await prisma.clin.create({ data: { consultingFirmId, contractId: req.params.id, ...body } })
    await audit(req, consultingFirmId, 'CREATE', 'Clin', row.id)
    res.status(201).json({ success: true, data: row })
  } catch (err) { next(err) }
})
router.put('/clins/:clinId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.clin.findFirst({ where: { id: req.params.clinId, consultingFirmId } })
    if (!existing) throw new NotFoundError('Clin')
    const body = ClinSchema.partial().parse(req.body)
    assertDateRange(body.startDate ?? existing.startDate, body.endDate ?? existing.endDate)
    if (body.clinNumber && body.clinNumber !== existing.clinNumber) {
      const dup = await prisma.clin.findFirst({ where: { contractId: existing.contractId, clinNumber: body.clinNumber }, select: { id: true } })
      if (dup) throw new ConflictError(`CLIN ${body.clinNumber} already exists on this contract`)
    }
    if (body.parentClinId) {
      if (body.parentClinId === existing.id) throw new ValidationError('A CLIN cannot be its own parent')
      const parent = await prisma.clin.findFirst({ where: { id: body.parentClinId, contractId: existing.contractId }, select: { id: true } })
      if (!parent) throw new ValidationError('Parent CLIN must belong to the same contract')
    }
    const row = await prisma.clin.update({ where: { id: existing.id }, data: body })
    await audit(req, consultingFirmId, 'UPDATE', 'Clin', row.id)
    res.json({ success: true, data: row })
  } catch (err) { next(err) }
})
router.post('/clins/:clinId/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.clin.findFirst({ where: { id: req.params.clinId, consultingFirmId } })
    if (!existing) throw new NotFoundError('Clin')
    await prisma.clin.update({ where: { id: existing.id }, data: { isArchived: true } })
    await audit(req, consultingFirmId, 'DELETE', 'Clin', existing.id, 'archived')
    res.json({ success: true, data: { id: existing.id, isArchived: true } })
  } catch (err) { next(err) }
})

// =============================================================
// MODIFICATIONS
// =============================================================
const ModSchema = z.object({
  modNumber: z.string().min(1).max(60),
  modType: z.string().max(120).nullable().optional(),
  effectiveDate: dateField,
  signedDate: dateField,
  description: z.string().max(8000).nullable().optional(),
  fundingChange: moneyDelta,
  ceilingChange: moneyDelta,
  startDateChange: dateField,
  endDateChange: dateField,
  attachmentKey: z.string().max(500).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
})
router.get('/:id/modifications', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await loadContract(consultingFirmId, req.params.id)
    const rows = await prisma.contractModification.findMany({ where: { consultingFirmId, contractId: req.params.id }, orderBy: { createdAt: 'asc' } })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})
router.post('/:id/modifications', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await loadContract(consultingFirmId, req.params.id)
    const body = ModSchema.parse(req.body)
    const dup = await prisma.contractModification.findFirst({ where: { contractId: req.params.id, modNumber: body.modNumber }, select: { id: true } })
    if (dup) throw new ConflictError(`Modification ${body.modNumber} already exists on this contract`)
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.contractModification.create({ data: { consultingFirmId, contractId: req.params.id, createdByUserId: req.user?.userId ?? null, status: 'DRAFT', ...body } })
      await emitContractModificationAdded(tx, {
        consultingFirmId, contractId: created.contractId, modificationId: created.id,
        modNumber: created.modNumber, stage: 'CREATED',
      })
      return created
    })
    await audit(req, consultingFirmId, 'CREATE', 'ContractModification', row.id)
    res.status(201).json({ success: true, data: row })
  } catch (err) { next(err) }
})

// Apply a modification to the contract totals/dates — transactional + idempotent.
router.post('/modifications/:modId/apply', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const mod = await prisma.contractModification.findFirst({ where: { id: req.params.modId, consultingFirmId } })
    if (!mod) throw new NotFoundError('ContractModification')
    const guard = canApplyModification(mod.status as ModStatus, mod.appliedAt)
    if (!guard.ok) throw new ConflictError(guard.reason || 'Cannot apply modification')

    const result = await prisma.$transaction(async (tx) => {
      // Re-read inside the transaction and re-check the guard to prevent a
      // concurrent double-apply (idempotency).
      const fresh = await tx.contractModification.findUnique({ where: { id: mod.id } })
      if (!fresh || fresh.appliedAt) throw new ConflictError('Modification has already been applied')
      const contract = await tx.contract.findUnique({ where: { id: fresh.contractId } })
      if (!contract) throw new NotFoundError('Contract')
      const after = computeContractAfterMod(
        { fundedValue: contract.fundedValue, ceilingValue: contract.ceilingValue, startDate: contract.startDate, endDate: contract.endDate },
        { fundingChange: fresh.fundingChange, ceilingChange: fresh.ceilingChange, startDateChange: fresh.startDateChange, endDateChange: fresh.endDateChange },
      )
      const updatedContract = await tx.contract.update({ where: { id: contract.id }, data: { fundedValue: after.fundedValue, ceilingValue: after.ceilingValue, startDate: after.startDate, endDate: after.endDate } })
      const appliedMod = await tx.contractModification.update({ where: { id: fresh.id }, data: { status: 'APPLIED', appliedAt: new Date() } })
      // Applying materially changes funded/ceiling/dates, so contract health
      // must be recalculated. Shares this transaction and the appliedAt guard.
      await emitContractModificationAdded(tx, {
        consultingFirmId, contractId: contract.id, modificationId: appliedMod.id,
        modNumber: appliedMod.modNumber, stage: 'APPLIED',
      })
      return { contract: updatedContract, mod: appliedMod }
    })
    await audit(req, consultingFirmId, 'UPDATE', 'ContractModification', mod.id, 'applied to contract totals')
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

router.post('/modifications/:modId/void', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const mod = await prisma.contractModification.findFirst({ where: { id: req.params.modId, consultingFirmId } })
    if (!mod) throw new NotFoundError('ContractModification')
    if (mod.status === 'APPLIED') throw new ConflictError('An applied modification cannot be voided (record a reversing modification instead)')
    const row = await prisma.contractModification.update({ where: { id: mod.id }, data: { status: 'VOIDED' } })
    await audit(req, consultingFirmId, 'UPDATE', 'ContractModification', mod.id, 'voided')
    res.json({ success: true, data: row })
  } catch (err) { next(err) }
})

// =============================================================
// DELIVERABLES (per-contract + workflow)
// =============================================================
const DeliverableSchema = z.object({
  name: z.string().min(1).max(300),
  clinId: z.string().uuid().nullable().optional(),
  cdrlNumber: z.string().max(60).nullable().optional(),
  description: z.string().max(8000).nullable().optional(),
  deliverableType: z.string().max(120).nullable().optional(),
  frequency: z.enum(['ONE_TIME', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL', 'AS_REQUIRED']).nullable().optional(),
  dueDate: dateField,
  ownerUserId: z.string().nullable().optional(),
  reviewerUserId: z.string().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  // §7.5 — the one explicit deliverable→partner attribution, set by a human.
  // Partner performance counts only attributed rows, so an unset value must
  // stay unset rather than being guessed from a subcontract.
  partnerId: z.string().min(1).max(64).nullable().optional(),
})

/** Rejects a partner id from another firm before it can ever be written. */
async function assertPartnerInTenant(consultingFirmId: string, partnerId: string): Promise<void> {
  const partner = await prisma.partner.findFirst({ where: { id: partnerId, consultingFirmId }, select: { id: true } })
  if (!partner) throw new ValidationError('Partner must belong to this firm')
}
router.get('/:id/deliverables', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await loadContract(consultingFirmId, req.params.id)
    const includeArchived = String(req.query.includeArchived) === 'true'
    const rows = await prisma.contractDeliverable.findMany({
      where: { consultingFirmId, contractId: req.params.id, ...(includeArchived ? {} : { isArchived: false }) },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      include: { partner: { select: { id: true, name: true } } },
    })
    const now = new Date()
    res.json({ success: true, data: rows.map((d) => withDerived(d, now)) })
  } catch (err) { next(err) }
})
router.post('/:id/deliverables', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await loadContract(consultingFirmId, req.params.id)
    const body = DeliverableSchema.parse(req.body)
    if (body.clinId) {
      const clin = await prisma.clin.findFirst({ where: { id: body.clinId, contractId: req.params.id }, select: { id: true } })
      if (!clin) throw new ValidationError('CLIN must belong to the same contract')
    }
    if (body.partnerId) await assertPartnerInTenant(consultingFirmId, body.partnerId)
    const row = await prisma.contractDeliverable.create({ data: { consultingFirmId, contractId: req.params.id, ...body } })
    await audit(req, consultingFirmId, 'CREATE', 'ContractDeliverable', row.id)
    res.status(201).json({ success: true, data: withDerived(row, new Date()) })
  } catch (err) { next(err) }
})
async function loadDeliverable(consultingFirmId: string, id: string) {
  const d = await prisma.contractDeliverable.findFirst({ where: { id, consultingFirmId } })
  if (!d) throw new NotFoundError('ContractDeliverable')
  return d
}
router.put('/deliverables/:delId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await loadDeliverable(consultingFirmId, req.params.delId)
    const body = DeliverableSchema.partial().parse(req.body)
    if (body.clinId) {
      const clin = await prisma.clin.findFirst({ where: { id: body.clinId, contractId: existing.contractId }, select: { id: true } })
      if (!clin) throw new ValidationError('CLIN must belong to the same contract')
    }
    if (body.partnerId) await assertPartnerInTenant(consultingFirmId, body.partnerId)
    const row = await prisma.contractDeliverable.update({
      where: { id: existing.id }, data: body,
      include: { partner: { select: { id: true, name: true } } },
    })
    // Attribution drives partner performance, so name it in the audit trail
    // rather than leaving it inside a generic update.
    const attributionChanged = body.partnerId !== undefined && body.partnerId !== existing.partnerId
    await audit(req, consultingFirmId, 'UPDATE', 'ContractDeliverable', row.id,
      attributionChanged
        ? (body.partnerId ? `Attributed to partner ${row.partner?.name ?? body.partnerId}` : 'Partner attribution cleared')
        : undefined)
    res.json({ success: true, data: withDerived(row, new Date()) })
  } catch (err) { next(err) }
})

// Generic workflow transition (validated).
router.post('/deliverables/:delId/transition', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await loadDeliverable(consultingFirmId, req.params.delId)
    const to = z.enum(DELIVERABLE_STATUSES as unknown as [string, ...string[]]).parse(req.body?.status) as DeliverableStatus
    // Acceptance-related transitions are ADMIN-only.
    if ((to === 'ACCEPTED' || to === 'REJECTED') && req.user?.role !== 'ADMIN') {
      return res.status(403).json({ success: false, error: 'Only an ADMIN can accept or reject deliverables', code: 'FORBIDDEN' })
    }
    if (!isValidDeliverableTransition(existing.status as DeliverableStatus, to)) {
      return res.status(409).json({ success: false, error: `Invalid transition ${existing.status} → ${to}`, code: 'INVALID_TRANSITION' })
    }
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.contractDeliverable.update({ where: { id: existing.id }, data: { status: to } })
      // The §5 state machine treats from === to as an idempotent no-op, so only
      // a genuine status change is an event worth emitting.
      if (existing.status !== to) {
        await emitDeliverableStatusChanged(tx, {
          consultingFirmId, contractId: updated.contractId, deliverableId: updated.id,
          fromStatus: existing.status, toStatus: to,
        })
      }
      return updated
    })
    await audit(req, consultingFirmId, 'UPDATE', 'ContractDeliverable', row.id, `status ${existing.status} → ${to}`)
    res.json({ success: true, data: withDerived(row, new Date()) })
  } catch (err) { next(err) }
})

// Record a submission (owner action — any authenticated firm user).
router.post('/deliverables/:delId/submit', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await loadDeliverable(consultingFirmId, req.params.delId)
    if (!isValidDeliverableTransition(existing.status as DeliverableStatus, 'SUBMITTED')) {
      return res.status(409).json({ success: false, error: `Cannot submit from ${existing.status}`, code: 'INVALID_TRANSITION' })
    }
    const attachmentKey = typeof req.body?.attachmentKey === 'string' ? req.body.attachmentKey : existing.attachmentKey
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.contractDeliverable.update({
        where: { id: existing.id },
        data: { status: 'SUBMITTED', submissionDate: new Date(), submittedByUserId: req.user?.userId ?? null, acceptanceStatus: 'PENDING', attachmentKey },
      })
      await emitDeliverableStatusChanged(tx, {
        consultingFirmId, contractId: updated.contractId, deliverableId: updated.id,
        fromStatus: existing.status, toStatus: 'SUBMITTED',
      })
      return updated
    })
    await audit(req, consultingFirmId, 'UPDATE', 'ContractDeliverable', row.id, 'submitted')
    res.json({ success: true, data: withDerived(row, new Date()) })
  } catch (err) { next(err) }
})

router.post('/deliverables/:delId/accept', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await loadDeliverable(consultingFirmId, req.params.delId)
    if (existing.status !== 'SUBMITTED') throw new ConflictError('Only a SUBMITTED deliverable can be accepted')
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.contractDeliverable.update({ where: { id: existing.id }, data: { status: 'ACCEPTED', acceptanceStatus: 'ACCEPTED', acceptanceDate: new Date() } })
      await emitDeliverableStatusChanged(tx, {
        consultingFirmId, contractId: updated.contractId, deliverableId: updated.id,
        fromStatus: existing.status, toStatus: 'ACCEPTED',
      })
      return updated
    })
    await audit(req, consultingFirmId, 'APPROVAL', 'ContractDeliverable', row.id, 'accepted')
    res.json({ success: true, data: withDerived(row, new Date()) })
  } catch (err) { next(err) }
})

router.post('/deliverables/:delId/reject', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await loadDeliverable(consultingFirmId, req.params.delId)
    if (existing.status !== 'SUBMITTED') throw new ConflictError('Only a SUBMITTED deliverable can be rejected')
    const reason = z.string().min(1).max(2000).parse(req.body?.reason)
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.contractDeliverable.update({ where: { id: existing.id }, data: { status: 'REJECTED', acceptanceStatus: 'REJECTED', rejectionReason: reason } })
      await emitDeliverableStatusChanged(tx, {
        consultingFirmId, contractId: updated.contractId, deliverableId: updated.id,
        fromStatus: existing.status, toStatus: 'REJECTED',
      })
      return updated
    })
    await audit(req, consultingFirmId, 'UPDATE', 'ContractDeliverable', row.id, 'rejected')
    res.json({ success: true, data: withDerived(row, new Date()) })
  } catch (err) { next(err) }
})

router.post('/deliverables/:delId/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await loadDeliverable(consultingFirmId, req.params.delId)
    await prisma.contractDeliverable.update({ where: { id: existing.id }, data: { isArchived: true } })
    await audit(req, consultingFirmId, 'DELETE', 'ContractDeliverable', existing.id, 'archived')
    res.json({ success: true, data: { id: existing.id, isArchived: true } })
  } catch (err) { next(err) }
})

export default router
