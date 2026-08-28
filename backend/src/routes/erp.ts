// =============================================================
// §8.2 — ERP routes: budgets, resource allocations, purchasing,
// subcontractor invoices, flow-down tracking and the financial summary.
//
// Human authority is the organising principle here. Establishing a budget,
// activating it, approving a purchase order, approving or rejecting a vendor
// invoice, recording a payment and clearing a flow-down review are all ADMIN
// operations on this router. No agent reaches any of them: agents have no route
// access at all, and the write matrix in the agent suites forbids these models.
//
// Reads follow the platform's existing posture — any authenticated member of
// the firm may read; CONSULTANT accounts stay read-only because
// `enforceTenantScope` already makes them so across every tenant-scoped route.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import {
  AllocationStatus, BudgetCategory, BudgetStatus, FlowDownState,
  Prisma, PurchaseOrderStatus, SubcontractInvoiceStatus,
} from '@prisma/client'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requirePermission } from '../middleware/permissions'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { ValidationError, NotFoundError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { computeBudgetVsActual, budgetThresholdFor } from '../services/erp/budgetVsActual'
import { computeCapacity, readCapacityForPursuitWindow } from '../services/erp/capacityPlanning'
import { postSubcontractInvoiceCost, computePurchaseOrderBalance } from '../services/erp/subcontractPosting'
import { computeContractFinancialSummary } from '../services/erp/financialSummary'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const audit = (
  req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction,
  entityType: string, entityId: string, rationale?: string, before?: unknown, after?: unknown,
) => logAudit({
  consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
  action, entityType, entityId, rationale, before, after,
})

const money = z.union([z.number(), z.string()]).transform((v) => new Prisma.Decimal(v))

/** Tenant-revalidate every foreign reference before it is stored. */
async function assertRefs(
  consultingFirmId: string,
  refs: { contractId?: string | null; clinId?: string | null; partnerId?: string | null; purchaseOrderId?: string | null; userId?: string | null; teamingArrangementId?: string | null },
): Promise<void> {
  const checks: Array<[string, Promise<unknown>]> = []
  if (refs.contractId) checks.push(['Contract', prisma.contract.findFirst({ where: { id: refs.contractId, consultingFirmId }, select: { id: true } })])
  if (refs.clinId) checks.push(['CLIN', prisma.clin.findFirst({ where: { id: refs.clinId, consultingFirmId }, select: { id: true } })])
  if (refs.partnerId) checks.push(['Partner', prisma.partner.findFirst({ where: { id: refs.partnerId, consultingFirmId }, select: { id: true } })])
  if (refs.purchaseOrderId) checks.push(['Purchase order', prisma.purchaseOrder.findFirst({ where: { id: refs.purchaseOrderId, consultingFirmId }, select: { id: true } })])
  if (refs.userId) checks.push(['User', prisma.user.findFirst({ where: { id: refs.userId, consultingFirmId }, select: { id: true } })])
  if (refs.teamingArrangementId) checks.push(['Teaming arrangement', prisma.teamingArrangement.findFirst({ where: { id: refs.teamingArrangementId, consultingFirmId }, select: { id: true } })])
  const rows = await Promise.all(checks.map(([, p]) => p))
  rows.forEach((r, i) => { if (!r) throw new NotFoundError(`${checks[i][0]} not found`) })
}

// -------------------------------------------------------------
// Budgets
// -------------------------------------------------------------

const BudgetLineSchema = z.object({
  clinId: z.string().uuid().nullable().optional(),
  category: z.nativeEnum(BudgetCategory),
  description: z.string().trim().max(500).nullable().optional(),
  plannedAmount: money,
})

const BudgetSchema = z.object({
  contractId: z.string().uuid(),
  title: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  effectiveDate: z.string().datetime().nullable().optional(),
  lines: z.array(BudgetLineSchema).min(1).max(500),
})

router.get('/contracts/:contractId/budgets', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await assertRefs(consultingFirmId, { contractId: req.params.contractId })
    const budgets = await prisma.contractBudget.findMany({
      where: { consultingFirmId, contractId: req.params.contractId },
      include: { lines: { include: { clin: { select: { id: true, clinNumber: true } } } } },
      orderBy: { versionNumber: 'desc' },
    })
    res.json({ success: true, data: budgets })
  } catch (err) { next(err) }
})

/** Create a DRAFT budget. A new version never activates itself. */
router.post('/budgets', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = BudgetSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid budget payload')
    const d = parsed.data
    await assertRefs(consultingFirmId, { contractId: d.contractId })
    for (const line of d.lines) {
      if (line.plannedAmount.isNegative()) throw new ValidationError('A planned amount cannot be negative')
      if (line.clinId) await assertRefs(consultingFirmId, { clinId: line.clinId })
    }

    const created = await prisma.$transaction(async (tx) => {
      const last = await tx.contractBudget.findFirst({
        where: { contractId: d.contractId }, orderBy: { versionNumber: 'desc' }, select: { versionNumber: true },
      })
      return tx.contractBudget.create({
        data: {
          consultingFirmId,
          contractId: d.contractId,
          versionNumber: (last?.versionNumber ?? 0) + 1,
          status: BudgetStatus.DRAFT,
          title: d.title ?? null,
          notes: d.notes ?? null,
          effectiveDate: d.effectiveDate ? new Date(d.effectiveDate) : null,
          createdByUserId: req.user?.userId ?? null,
          lines: {
            create: d.lines.map((l) => ({
              consultingFirmId,
              clinId: l.clinId ?? null,
              category: l.category,
              description: l.description ?? null,
              plannedAmount: l.plannedAmount,
            })),
          },
        },
        include: { lines: true },
      })
    })

    await audit(req, consultingFirmId, 'CREATE', 'ContractBudget', created.id, `Budget v${created.versionNumber} drafted`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

/** Edit a DRAFT. An approved version is immutable — revise it instead. */
router.put('/budgets/:id', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.contractBudget.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Budget not found')
    if (existing.status !== BudgetStatus.DRAFT) {
      res.status(422).json({
        success: false,
        code: 'BUDGET_IMMUTABLE',
        error: `A ${existing.status} budget cannot be edited. Create a revision instead — approved budgets are decision evidence and are kept intact.`,
      })
      return
    }
    const parsed = BudgetSchema.partial().omit({ contractId: true }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid budget payload')

    const updated = await prisma.$transaction(async (tx) => {
      if (parsed.data.lines) {
        await tx.contractBudgetLine.deleteMany({ where: { budgetId: existing.id } })
        await tx.contractBudgetLine.createMany({
          data: parsed.data.lines.map((l) => ({
            consultingFirmId, budgetId: existing.id, clinId: l.clinId ?? null,
            category: l.category, description: l.description ?? null, plannedAmount: l.plannedAmount,
          })),
        })
      }
      return tx.contractBudget.update({
        where: { id: existing.id },
        data: {
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
          ...(parsed.data.effectiveDate !== undefined
            ? { effectiveDate: parsed.data.effectiveDate ? new Date(parsed.data.effectiveDate) : null } : {}),
        },
        include: { lines: true },
      })
    })
    await audit(req, consultingFirmId, 'UPDATE', 'ContractBudget', existing.id, 'Draft budget updated')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

/**
 * Activate a draft. The previously active version is superseded in the same
 * transaction, so a contract can never have two active budgets.
 */
router.post('/budgets/:id/activate', requirePermission('FINANCE_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const budget = await prisma.contractBudget.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!budget) throw new NotFoundError('Budget not found')
    if (budget.status !== BudgetStatus.DRAFT) {
      res.status(422).json({
        success: false, code: 'INVALID_TRANSITION',
        error: `Only a DRAFT budget can be activated; this one is ${budget.status}.`,
        allowedNextStates: budget.status === BudgetStatus.ACTIVE ? ['SUPERSEDED'] : [],
      })
      return
    }

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.contractBudget.findFirst({
        where: { consultingFirmId, contractId: budget.contractId, status: BudgetStatus.ACTIVE },
        select: { id: true },
      })
      if (current) {
        await tx.contractBudget.update({
          where: { id: current.id },
          data: { status: BudgetStatus.SUPERSEDED, supersededAt: new Date() },
        })
      }
      return tx.contractBudget.update({
        where: { id: budget.id },
        data: {
          status: BudgetStatus.ACTIVE,
          approvedByUserId: req.user?.userId ?? null,
          approvedAt: new Date(),
          supersedesBudgetId: current?.id ?? null,
        },
        include: { lines: true },
      })
    })

    await audit(req, consultingFirmId, 'UPDATE', 'ContractBudget', budget.id,
      `Budget v${budget.versionNumber} activated`, { status: budget.status }, { status: result.status })
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

router.get('/contracts/:contractId/budget-vs-actual', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await assertRefs(consultingFirmId, { contractId: req.params.contractId })
    const result = await computeBudgetVsActual(consultingFirmId, req.params.contractId)
    res.json({ success: true, data: { ...result, threshold: budgetThresholdFor(result) } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Resource allocations
// -------------------------------------------------------------

const AllocationSchema = z.object({
  userId: z.string().min(1),
  contractId: z.string().uuid(),
  clinId: z.string().uuid().nullable().optional(),
  laborCategory: z.string().trim().max(120).nullable().optional(),
  allocationPercent: z.number().min(0.01).max(100),
  plannedHoursPerWeek: z.number().min(0).max(168).nullable().optional(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().nullable().optional(),
  status: z.nativeEnum(AllocationStatus).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

router.get('/resource-allocations', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.ResourceAllocationWhereInput = { consultingFirmId }
    if (typeof req.query.contractId === 'string' && req.query.contractId) where.contractId = req.query.contractId
    if (typeof req.query.userId === 'string' && req.query.userId) where.userId = req.query.userId
    const rows = await prisma.resourceAllocation.findMany({
      where,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        contract: { select: { id: true, contractNumber: true, title: true } },
      },
      orderBy: [{ startDate: 'desc' }],
      take: 500,
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

router.post('/resource-allocations', requirePermission('CONTRACT_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = AllocationSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid allocation payload')
    const d = parsed.data
    await assertRefs(consultingFirmId, { contractId: d.contractId, clinId: d.clinId, userId: d.userId })

    const start = new Date(d.startDate)
    const end = d.endDate ? new Date(d.endDate) : null
    if (end && end <= start) throw new ValidationError('An allocation must end after it starts')

    const created = await prisma.resourceAllocation.create({
      data: {
        consultingFirmId,
        userId: d.userId,
        contractId: d.contractId,
        clinId: d.clinId ?? null,
        laborCategory: d.laborCategory ?? null,
        allocationPercent: new Prisma.Decimal(d.allocationPercent),
        plannedHoursPerWeek: d.plannedHoursPerWeek != null ? new Prisma.Decimal(d.plannedHoursPerWeek) : null,
        startDate: start,
        endDate: end,
        status: d.status ?? AllocationStatus.PLANNED,
        notes: d.notes ?? null,
        createdByUserId: req.user?.userId ?? null,
      },
    })

    // Over-allocation is surfaced, not refused — overlapping work is often
    // deliberate, and refusing it would push planning back into a spreadsheet.
    const snapshot = await computeCapacity(consultingFirmId, start, end)
    const person = snapshot.people.find((p) => p.userId === d.userId)
    const conflict = person?.conflict
      ? { state: 'CAPACITY_CONFLICT', allocatedPercent: person.allocatedPercent,
          message: `This person is now allocated ${person.allocatedPercent}% across overlapping work. Recorded for review rather than refused.` }
      : null

    await audit(req, consultingFirmId, 'CREATE', 'ResourceAllocation', created.id, 'Resource allocation created')
    res.status(201).json({ success: true, data: { ...created, conflict } })
  } catch (err) { next(err) }
})

router.put('/resource-allocations/:id', requirePermission('CONTRACT_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.resourceAllocation.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Allocation not found')
    const parsed = AllocationSchema.partial().omit({ userId: true, contractId: true }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid allocation payload')
    const d = parsed.data
    const updated = await prisma.resourceAllocation.update({
      where: { id: existing.id },
      data: {
        ...(d.allocationPercent !== undefined ? { allocationPercent: new Prisma.Decimal(d.allocationPercent) } : {}),
        ...(d.laborCategory !== undefined ? { laborCategory: d.laborCategory } : {}),
        ...(d.startDate !== undefined ? { startDate: new Date(d.startDate) } : {}),
        ...(d.endDate !== undefined ? { endDate: d.endDate ? new Date(d.endDate) : null } : {}),
        ...(d.status !== undefined ? { status: d.status } : {}),
        ...(d.notes !== undefined ? { notes: d.notes } : {}),
      },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'ResourceAllocation', existing.id, 'Resource allocation updated')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

router.get('/capacity', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const start = typeof req.query.start === 'string' && req.query.start ? new Date(req.query.start) : new Date()
    const end = typeof req.query.end === 'string' && req.query.end ? new Date(req.query.end) : null
    res.json({ success: true, data: await computeCapacity(consultingFirmId, start, end) })
  } catch (err) { next(err) }
})

/** Advisory read for a pursuit window. Writes nothing, decides nothing. */
router.get('/capacity/pursuit-window', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const start = typeof req.query.start === 'string' && req.query.start ? new Date(req.query.start) : new Date()
    const end = typeof req.query.end === 'string' && req.query.end ? new Date(req.query.end) : null
    res.json({ success: true, data: await readCapacityForPursuitWindow(consultingFirmId, start, end) })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Purchase orders
// -------------------------------------------------------------

const PoLineSchema = z.object({
  clinId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1).max(500),
  category: z.nativeEnum(BudgetCategory).optional(),
  quantity: z.union([z.number(), z.string()]).nullable().optional(),
  unit: z.string().trim().max(40).nullable().optional(),
  unitPrice: z.union([z.number(), z.string()]).nullable().optional(),
  amount: money,
})

const PoSchema = z.object({
  contractId: z.string().uuid(),
  clinId: z.string().uuid().nullable().optional(),
  partnerId: z.string().min(1).nullable().optional(),
  teamingArrangementId: z.string().min(1).nullable().optional(),
  vendorName: z.string().trim().min(1).max(200),
  poNumber: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).nullable().optional(),
  ceilingAmount: money,
  startDate: z.string().datetime().nullable().optional(),
  endDate: z.string().datetime().nullable().optional(),
  isSubcontract: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(PoLineSchema).max(200).optional(),
})

const PO_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['PARTIALLY_RECEIVED', 'COMPLETE', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['COMPLETE', 'CANCELLED'],
  COMPLETE: [],
  CANCELLED: [],
}

router.get('/purchase-orders', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.PurchaseOrderWhereInput = { consultingFirmId }
    if (typeof req.query.contractId === 'string' && req.query.contractId) where.contractId = req.query.contractId
    if (typeof req.query.status === 'string' && req.query.status in PurchaseOrderStatus) where.status = req.query.status as PurchaseOrderStatus
    const orders = await prisma.purchaseOrder.findMany({
      where,
      include: {
        lines: true,
        partner: { select: { id: true, name: true } },
        contract: { select: { id: true, contractNumber: true } },
        _count: { select: { invoices: true, flowDowns: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    })
    res.json({ success: true, data: orders })
  } catch (err) { next(err) }
})

router.post('/purchase-orders', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = PoSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid purchase order payload')
    const d = parsed.data
    await assertRefs(consultingFirmId, {
      contractId: d.contractId, clinId: d.clinId, partnerId: d.partnerId, teamingArrangementId: d.teamingArrangementId,
    })
    if (d.ceilingAmount.isNegative()) throw new ValidationError('A purchase order ceiling cannot be negative')

    const dup = await prisma.purchaseOrder.findFirst({ where: { consultingFirmId, poNumber: d.poNumber }, select: { id: true } })
    if (dup) throw new ValidationError('That purchase order number already exists for this firm')

    const created = await prisma.purchaseOrder.create({
      data: {
        consultingFirmId,
        contractId: d.contractId,
        clinId: d.clinId ?? null,
        partnerId: d.partnerId ?? null,
        teamingArrangementId: d.teamingArrangementId ?? null,
        vendorName: d.vendorName,
        poNumber: d.poNumber,
        description: d.description ?? null,
        ceilingAmount: d.ceilingAmount,
        startDate: d.startDate ? new Date(d.startDate) : null,
        endDate: d.endDate ? new Date(d.endDate) : null,
        isSubcontract: d.isSubcontract ?? false,
        notes: d.notes ?? null,
        status: PurchaseOrderStatus.DRAFT,
        createdByUserId: req.user?.userId ?? null,
        lines: d.lines?.length
          ? {
              create: d.lines.map((l) => ({
                consultingFirmId,
                clinId: l.clinId ?? null,
                description: l.description,
                category: l.category ?? BudgetCategory.SUBCONTRACT,
                quantity: l.quantity != null ? new Prisma.Decimal(l.quantity) : null,
                unit: l.unit ?? null,
                unitPrice: l.unitPrice != null ? new Prisma.Decimal(l.unitPrice) : null,
                amount: l.amount,
              })),
            }
          : undefined,
      },
      include: { lines: true },
    })
    await audit(req, consultingFirmId, 'CREATE', 'PurchaseOrder', created.id, `PO ${created.poNumber} drafted`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

router.post('/purchase-orders/:id/transition', requirePermission('FINANCE_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = z.object({ status: z.nativeEnum(PurchaseOrderStatus), reason: z.string().trim().max(500).optional() }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A valid status is required')
    const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!po) throw new NotFoundError('Purchase order not found')

    const allowed = PO_TRANSITIONS[po.status]
    if (!allowed.includes(parsed.data.status)) {
      res.status(422).json({
        success: false, code: 'INVALID_TRANSITION',
        error: `Cannot move a ${po.status} purchase order to ${parsed.data.status}.`,
        allowedNextStates: allowed,
      })
      return
    }

    const approving = parsed.data.status === PurchaseOrderStatus.APPROVED
    const cancelling = parsed.data.status === PurchaseOrderStatus.CANCELLED
    const updated = await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status: parsed.data.status,
        ...(approving ? { approvedByUserId: req.user?.userId ?? null, approvedAt: new Date() } : {}),
        ...(cancelling ? { cancelledAt: new Date(), cancelReason: parsed.data.reason ?? null } : {}),
      },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'PurchaseOrder', po.id,
      `PO ${po.poNumber} ${parsed.data.status}`, { status: po.status }, { status: updated.status })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

router.get('/purchase-orders/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const po = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: {
        // The CLIN travels with the line so the order can be read against the
        // same breakdown the budget and the invoice use.
        lines: { include: { clin: { select: { id: true, clinNumber: true } } } },
        partner: { select: { id: true, name: true } },
        invoices: { orderBy: { invoiceDate: 'desc' } },
        flowDowns: { orderBy: { clauseNumber: 'asc' } },
        contract: { select: { id: true, contractNumber: true, title: true } },
      },
    })
    if (!po) throw new NotFoundError('Purchase order not found')
    const balance = await computePurchaseOrderBalance(consultingFirmId, po.id)
    res.json({ success: true, data: { ...po, balance } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Subcontractor invoices — accounts PAYABLE, kept apart from ContractInvoice
// -------------------------------------------------------------

const SubInvoiceSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  invoiceNumber: z.string().trim().min(1).max(80),
  invoiceDate: z.string().datetime(),
  servicePeriodStart: z.string().datetime().nullable().optional(),
  servicePeriodEnd: z.string().datetime().nullable().optional(),
  amount: money,
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(z.object({
    clinId: z.string().uuid().nullable().optional(),
    description: z.string().trim().min(1).max(500),
    category: z.nativeEnum(BudgetCategory).optional(),
    amount: money,
  })).max(200).optional(),
})

const INVOICE_TRANSITIONS: Record<SubcontractInvoiceStatus, SubcontractInvoiceStatus[]> = {
  RECEIVED: ['UNDER_REVIEW', 'APPROVED', 'REJECTED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['PAID'],
  REJECTED: ['UNDER_REVIEW'],
  PAID: [],
}

router.get('/subcontract-invoices', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.SubcontractInvoiceWhereInput = { consultingFirmId }
    if (typeof req.query.purchaseOrderId === 'string' && req.query.purchaseOrderId) where.purchaseOrderId = req.query.purchaseOrderId
    if (typeof req.query.status === 'string' && req.query.status in SubcontractInvoiceStatus) where.status = req.query.status as SubcontractInvoiceStatus
    const rows = await prisma.subcontractInvoice.findMany({
      where,
      include: { lines: true, purchaseOrder: { select: { id: true, poNumber: true, contractId: true } } },
      orderBy: { invoiceDate: 'desc' },
      take: 300,
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

router.post('/subcontract-invoices', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = SubInvoiceSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid invoice payload')
    const d = parsed.data
    await assertRefs(consultingFirmId, { purchaseOrderId: d.purchaseOrderId })
    if (d.amount.isNegative()) throw new ValidationError('An invoice amount cannot be negative')

    const po = await prisma.purchaseOrder.findFirst({
      where: { id: d.purchaseOrderId, consultingFirmId },
      select: { id: true, partnerId: true, vendorName: true, status: true },
    })
    if (!po) throw new NotFoundError('Purchase order not found')
    if (po.status === PurchaseOrderStatus.DRAFT || po.status === PurchaseOrderStatus.CANCELLED) {
      throw new ValidationError(`An invoice cannot be recorded against a ${po.status} purchase order`)
    }

    const dup = await prisma.subcontractInvoice.findFirst({
      where: { consultingFirmId, purchaseOrderId: d.purchaseOrderId, invoiceNumber: d.invoiceNumber }, select: { id: true },
    })
    if (dup) throw new ValidationError('That invoice number already exists against this purchase order')

    const created = await prisma.subcontractInvoice.create({
      data: {
        consultingFirmId,
        purchaseOrderId: d.purchaseOrderId,
        partnerId: po.partnerId,
        vendorName: po.vendorName,
        invoiceNumber: d.invoiceNumber,
        invoiceDate: new Date(d.invoiceDate),
        servicePeriodStart: d.servicePeriodStart ? new Date(d.servicePeriodStart) : null,
        servicePeriodEnd: d.servicePeriodEnd ? new Date(d.servicePeriodEnd) : null,
        amount: d.amount,
        notes: d.notes ?? null,
        status: SubcontractInvoiceStatus.RECEIVED,
        createdByUserId: req.user?.userId ?? null,
        lines: d.lines?.length
          ? { create: d.lines.map((l) => ({
              consultingFirmId, clinId: l.clinId ?? null, description: l.description,
              category: l.category ?? BudgetCategory.SUBCONTRACT, amount: l.amount,
            })) }
          : undefined,
      },
      include: { lines: true },
    })

    const balance = await computePurchaseOrderBalance(consultingFirmId, d.purchaseOrderId)
    await audit(req, consultingFirmId, 'CREATE', 'SubcontractInvoice', created.id, `Vendor invoice ${created.invoiceNumber} received`)
    res.status(201).json({
      success: true,
      data: {
        ...created,
        balance,
        // Reported, never blocked — an over-ceiling invoice is a real dispute
        // the operator needs to see rather than an input error to reject.
        overCeilingWarning: balance.overInvoiced
          ? 'Invoices against this order now exceed its ceiling. Recorded for review.' : null,
      },
    })
  } catch (err) { next(err) }
})

/**
 * Human-only invoice transition. Approving posts the cost exactly once through
 * the canonical posting service; re-approving is a no-op on the cost side.
 */
router.post('/subcontract-invoices/:id/transition', requirePermission('FINANCE_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = z.object({
      status: z.nativeEnum(SubcontractInvoiceStatus),
      reason: z.string().trim().max(500).optional(),
      paymentReference: z.string().trim().max(120).optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A valid status is required')

    const invoice = await prisma.subcontractInvoice.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!invoice) throw new NotFoundError('Invoice not found')

    const allowed = INVOICE_TRANSITIONS[invoice.status]
    if (!allowed.includes(parsed.data.status)) {
      res.status(422).json({
        success: false, code: 'INVALID_TRANSITION',
        error: `Cannot move a ${invoice.status} invoice to ${parsed.data.status}.`,
        allowedNextStates: allowed,
      })
      return
    }

    const target = parsed.data.status
    const updated = await prisma.subcontractInvoice.update({
      where: { id: invoice.id },
      data: {
        status: target,
        ...(target === SubcontractInvoiceStatus.APPROVED
          ? { approvedByUserId: req.user?.userId ?? null, approvedAt: new Date(), rejectionReason: null } : {}),
        ...(target === SubcontractInvoiceStatus.REJECTED ? { rejectionReason: parsed.data.reason ?? null } : {}),
        ...(target === SubcontractInvoiceStatus.PAID
          ? {
              // Human-recorded only. The platform never moves money.
              paymentRecordedAt: new Date(),
              paymentReference: parsed.data.paymentReference ?? null,
              paymentRecordedByUserId: req.user?.userId ?? null,
            } : {}),
      },
    })

    let posting: Awaited<ReturnType<typeof postSubcontractInvoiceCost>> | null = null
    if (target === SubcontractInvoiceStatus.APPROVED || target === SubcontractInvoiceStatus.PAID) {
      posting = await postSubcontractInvoiceCost(consultingFirmId, invoice.id, req.user?.userId ?? null)
    }

    await audit(req, consultingFirmId, 'UPDATE', 'SubcontractInvoice', invoice.id,
      `Vendor invoice ${invoice.invoiceNumber} ${target}`, { status: invoice.status }, { status: updated.status })

    res.json({
      success: true,
      data: {
        ...updated,
        posting,
        balance: await computePurchaseOrderBalance(consultingFirmId, invoice.purchaseOrderId),
        paymentNote: 'Payment status is a human-recorded reference. This platform does not move money.',
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Flow-down compliance — surfaced and tracked, never concluded
// -------------------------------------------------------------

const FlowDownSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  clauseObligationId: z.string().uuid().nullable().optional(),
  clauseNumber: z.string().trim().min(1).max(80),
  clauseTitle: z.string().trim().max(300).nullable().optional(),
  state: z.nativeEnum(FlowDownState).optional(),
  evidence: z.string().trim().max(2000).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

router.get('/purchase-orders/:id/flow-downs', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await assertRefs(consultingFirmId, { purchaseOrderId: req.params.id })
    const rows = await prisma.subcontractFlowDown.findMany({
      where: { consultingFirmId, purchaseOrderId: req.params.id },
      include: { clauseObligation: { select: { id: true, clauseNumber: true, flowDownStatus: true } } },
      orderBy: { clauseNumber: 'asc' },
    })
    res.json({
      success: true,
      data: {
        items: rows,
        disclaimer:
          'Flow-down states are tracking records, not legal determinations. Nothing here concludes that a clause legally flows down — a qualified human decides that, and legal review is never cleared automatically.',
      },
    })
  } catch (err) { next(err) }
})

/**
 * Seed flow-down rows from clauses already extracted for the contract's
 * opportunity. Deliberately conservative: every seeded row lands as
 * REVIEW_REQUIRED, because an extracted clause is evidence that something needs
 * looking at, not a conclusion that it applies to this subcontract.
 */
router.post('/purchase-orders/:id/flow-downs/seed', requirePermission('CONTRACT_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const po = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, contract: { select: { opportunityId: true } } },
    })
    if (!po) throw new NotFoundError('Purchase order not found')
    if (!po.contract.opportunityId) {
      res.json({ success: true, data: { created: 0, note: 'This contract is not linked to an opportunity, so there are no extracted clauses to seed from.' } })
      return
    }

    const clauses = await prisma.clauseObligation.findMany({
      where: { consultingFirmId, opportunityId: po.contract.opportunityId },
      select: { id: true, clauseNumber: true, clauseTitle: true, flowDownStatus: true },
      take: 500,
    })

    let created = 0
    for (const c of clauses) {
      const existing = await prisma.subcontractFlowDown.findFirst({
        where: { purchaseOrderId: po.id, clauseNumber: c.clauseNumber }, select: { id: true },
      })
      if (existing) continue
      await prisma.subcontractFlowDown.create({
        data: {
          consultingFirmId,
          purchaseOrderId: po.id,
          clauseObligationId: c.id,
          clauseNumber: c.clauseNumber,
          clauseTitle: c.clauseTitle ?? null,
          state: FlowDownState.REVIEW_REQUIRED,
          evidence: `Seeded from the extracted clause record (flow-down status recorded there: ${c.flowDownStatus}). This is not a determination that the clause flows down to this subcontract.`,
          createdByUserId: req.user?.userId ?? null,
        },
      })
      created++
    }
    await audit(req, consultingFirmId, 'CREATE', 'SubcontractFlowDown', po.id, `${created} flow-down rows seeded for review`)
    res.json({ success: true, data: { created, examined: clauses.length } })
  } catch (err) { next(err) }
})

router.post('/flow-downs', requirePermission('CONTRACT_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = FlowDownSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid flow-down payload')
    const d = parsed.data
    await assertRefs(consultingFirmId, { purchaseOrderId: d.purchaseOrderId })

    const created = await prisma.subcontractFlowDown.create({
      data: {
        consultingFirmId,
        purchaseOrderId: d.purchaseOrderId,
        clauseObligationId: d.clauseObligationId ?? null,
        clauseNumber: d.clauseNumber,
        clauseTitle: d.clauseTitle ?? null,
        state: d.state ?? FlowDownState.INSUFFICIENT_DATA,
        evidence: d.evidence ?? null,
        notes: d.notes ?? null,
        createdByUserId: req.user?.userId ?? null,
      },
    })
    await audit(req, consultingFirmId, 'CREATE', 'SubcontractFlowDown', created.id, `Flow-down ${created.clauseNumber} tracked`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

/** Only a human sets a flow-down state; the reviewer is always recorded. */
router.post('/flow-downs/:id/review', requirePermission('CONTRACT_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = z.object({
      state: z.nativeEnum(FlowDownState),
      evidence: z.string().trim().max(2000).optional(),
      notes: z.string().trim().max(2000).optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A valid flow-down state is required')

    const existing = await prisma.subcontractFlowDown.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Flow-down record not found')

    const updated = await prisma.subcontractFlowDown.update({
      where: { id: existing.id },
      data: {
        state: parsed.data.state,
        evidence: parsed.data.evidence ?? existing.evidence,
        notes: parsed.data.notes ?? existing.notes,
        reviewedByUserId: req.user?.userId ?? null,
        reviewedAt: new Date(),
      },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'SubcontractFlowDown', existing.id,
      `Flow-down ${existing.clauseNumber} reviewed as ${parsed.data.state}`, { state: existing.state }, { state: updated.state })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Financial summary
// -------------------------------------------------------------

router.get('/contracts/:contractId/financial-summary', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await assertRefs(consultingFirmId, { contractId: req.params.contractId })
    res.json({ success: true, data: await computeContractFinancialSummary(consultingFirmId, req.params.contractId) })
  } catch (err) { next(err) }
})

export default router
