// =============================================================
// Contract Finance & Timekeeping (Section 5 Module 9)
// -------------------------------------------------------------
// Funding ledger + costs + labor rates + timekeeping + invoices + payments +
// receivables + rate monitoring + financial alerts. Built on the Module 8
// Contract/CLIN models. Reads firm-wide (any role); all writes ADMIN-only
// (platform read-only-consultant model). Sensitive cost rates are stripped for
// non-admins. Every money figure is computed on the backend with Prisma.Decimal.
// Mounted at /api/contract-finance.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requirePermission, requireAnyPermission, callerHasPermission } from '../middleware/permissions'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ConflictError, ValidationError, ForbiddenError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { prisma } from '../config/database'
import { loadContractBurn } from '../services/contractFinanceQueries'
import { emitFundingTransactionAdded } from '../services/agents/contract/contractEvents'
import { assembleInvoice, eligibleCostWhere, eligibleTimeWhere, nextInvoiceNumber } from '../services/agents/finance/invoiceBuilder'
import { emitContractCostAdded, emitInvoicePaid, emitTimeEntrySubmitted, isInvoiceNowPaid } from '../services/agents/finance/financeEvents'
import {
  D, money2, sumFunding, recognizedExpenditure, lineAmount, rateForWorkDate, periodsOverlap, computeBurn, receivablesAging, rateVariance,
} from '../services/contractFinance'
import { buildAuditPackage, auditPackageToCsv } from '../services/erp/auditPackage'
import { buildContractInvoicePdf } from '../services/erp/contractInvoicePdf'
import { csvBody } from '../utils/csv'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const dateField = z.string().datetime().transform((s) => new Date(s)).nullable().optional()
const money = z.number().finite().max(1_000_000_000).nullable().optional()
const DAILY_HOURS_MAX = 24

const audit = (req: AuthenticatedRequest, firmId: string, action: AuditAction, entityType: string, entityId: string, rationale?: string) =>
  logAudit({ consultingFirmId: firmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType, entityId, rationale })

const isAdmin = (req: AuthenticatedRequest) => req.user?.role === 'ADMIN'

async function loadContract(firmId: string, id: string) {
  const c = await prisma.contract.findFirst({ where: { id, consultingFirmId: firmId } })
  if (!c) throw new NotFoundError('Contract')
  return c
}

// Recompute the cached Contract.fundedValue from the funding ledger (source of
// truth). Always called inside the same transaction as a funding change.
async function recomputeFundedValue(tx: Prisma.TransactionClient, contractId: string): Promise<Prisma.Decimal> {
  const txns = await tx.fundingTransaction.findMany({ where: { contractId }, select: { amount: true, isVoided: true } })
  const total = sumFunding(txns)
  await tx.contract.update({ where: { id: contractId }, data: { fundedValue: total } })
  return total
}

// Strip sensitive cost fields for non-admin readers.
function stripCost<T extends Record<string, unknown>>(row: T, admin: boolean): T {
  if (admin) return row
  const { costRate, appliedCostRate, costAmount, ...rest } = row as Record<string, unknown>
  void costRate; void appliedCostRate; void costAmount
  return rest as T
}

// =============================================================
// 9A — FUNDING LEDGER
// =============================================================
const FUNDING_TYPES = ['INITIAL_OBLIGATION', 'INCREMENTAL_FUNDING', 'FUNDING_REDUCTION', 'DEOBLIGATION', 'ADJUSTMENT', 'REVERSAL'] as const
const REDUCING = new Set(['FUNDING_REDUCTION', 'DEOBLIGATION'])

const FundingSchema = z.object({
  type: z.enum(FUNDING_TYPES),
  amount: z.number().finite().max(1_000_000_000), // magnitude; sign derived from type
  clinId: z.string().uuid().nullable().optional(),
  effectiveDate: dateField,
  referenceNumber: z.string().max(120).nullable().optional(),
  modificationId: z.string().uuid().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
})

router.get('/:contractId/funding', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    await loadContract(firmId, req.params.contractId)
    const rows = await prisma.fundingTransaction.findMany({ where: { consultingFirmId: firmId, contractId: req.params.contractId }, orderBy: { createdAt: 'asc' } })
    res.json({ success: true, data: rows, meta: { fundedTotal: sumFunding(rows).toFixed(2) } })
  } catch (err) { next(err) }
})

router.post('/:contractId/funding', requirePermission('FINANCE_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const contract = await loadContract(firmId, req.params.contractId)
    const body = FundingSchema.parse(req.body)
    if (body.amount < 0) throw new ValidationError('Amount is a magnitude; use the type to indicate a reduction')
    if (body.clinId) {
      const clin = await prisma.clin.findFirst({ where: { id: body.clinId, contractId: contract.id }, select: { id: true } })
      if (!clin) throw new ValidationError('CLIN must belong to this contract')
    }
    // Signed amount: reductions/deobligations decrease the ledger.
    const signed = REDUCING.has(body.type) ? -Math.abs(body.amount) : Math.abs(body.amount)

    const result = await prisma.$transaction(async (tx) => {
      if (body.modificationId) {
        // Idempotency: a modification's funding change can only be recorded once.
        const dup = await tx.fundingTransaction.findUnique({ where: { modificationId: body.modificationId } })
        if (dup) throw new ConflictError('This modification has already been recorded in the funding ledger')
      }
      const created = await tx.fundingTransaction.create({
        data: {
          consultingFirmId: firmId, contractId: contract.id, clinId: body.clinId ?? null,
          type: body.type, amount: new Prisma.Decimal(signed), effectiveDate: body.effectiveDate ?? null,
          referenceNumber: body.referenceNumber ?? null, modificationId: body.modificationId ?? null,
          description: body.description ?? null, notes: body.notes ?? null, createdByUserId: req.user?.userId ?? null,
        },
      })
      const funded = await recomputeFundedValue(tx, contract.id)
      // §7.1 — same transaction as the ledger write, so a rolled-back funding
      // change can never leave a stray event behind.
      await emitFundingTransactionAdded(tx, {
        consultingFirmId: firmId, contractId: contract.id,
        fundingTransactionId: created.id, type: created.type,
      })
      return { txn: created, fundedTotal: funded.toFixed(2) }
    })
    await audit(req, firmId, 'CREATE', 'FundingTransaction', result.txn.id, body.type)
    res.status(201).json({ success: true, data: result })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return next(new ConflictError('This modification has already been recorded'))
    next(err)
  }
})

router.post('/funding/:txnId/void', requirePermission('FINANCE_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const txn = await prisma.fundingTransaction.findFirst({ where: { id: req.params.txnId, consultingFirmId: firmId } })
    if (!txn) throw new NotFoundError('FundingTransaction')
    if (txn.isVoided) throw new ConflictError('Transaction is already voided')
    const reason = z.string().min(1).max(2000).parse(req.body?.reason)
    const result = await prisma.$transaction(async (tx) => {
      await tx.fundingTransaction.update({ where: { id: txn.id }, data: { isVoided: true, reversalReason: reason } })
      const funded = await recomputeFundedValue(tx, txn.contractId)
      return funded.toFixed(2)
    })
    await audit(req, firmId, 'UPDATE', 'FundingTransaction', txn.id, 'voided')
    res.json({ success: true, data: { id: txn.id, isVoided: true, fundedTotal: result } })
  } catch (err) { next(err) }
})

// =============================================================
// 9C — CONTRACT COSTS
// =============================================================
const COST_CATEGORIES = ['OTHER_DIRECT_COST', 'TRAVEL', 'MATERIAL', 'SUBCONTRACTOR', 'EQUIPMENT', 'ADJUSTMENT', 'OTHER'] as const
const CostSchema = z.object({
  category: z.enum(COST_CATEGORIES),
  amount: z.number().nonnegative().max(1_000_000_000),
  description: z.string().max(2000).nullable().optional(),
  clinId: z.string().uuid().nullable().optional(),
  incurredDate: dateField,
  attachmentKey: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
})
router.get('/:contractId/costs', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    await loadContract(firmId, req.params.contractId)
    const rows = await prisma.contractCost.findMany({ where: { consultingFirmId: firmId, contractId: req.params.contractId }, orderBy: { createdAt: 'desc' } })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})
router.post('/:contractId/costs', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const contract = await loadContract(firmId, req.params.contractId)
    const body = CostSchema.parse(req.body)
    if (body.clinId) {
      const clin = await prisma.clin.findFirst({ where: { id: body.clinId, contractId: contract.id }, select: { id: true } })
      if (!clin) throw new ValidationError('CLIN must belong to this contract')
    }
    // §7.8 — the cost write and CONTRACT_COST_ADDED share one transaction, so a
    // rolled-back create emits nothing. Creation only: an edit is not a new cost.
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.contractCost.create({ data: { consultingFirmId: firmId, contractId: contract.id, ...body, createdByUserId: req.user?.userId ?? null } })
      await emitContractCostAdded(tx, { consultingFirmId: firmId, contractId: contract.id, contractCostId: created.id, category: created.category })
      return created
    })
    await audit(req, firmId, 'CREATE', 'ContractCost', row.id)
    res.status(201).json({ success: true, data: row })
  } catch (err) { next(err) }
})
async function loadCost(firmId: string, id: string) {
  const c = await prisma.contractCost.findFirst({ where: { id, consultingFirmId: firmId } })
  if (!c) throw new NotFoundError('ContractCost')
  return c
}
const COST_FLOW: Record<string, string[]> = { DRAFT: ['SUBMITTED', 'VOIDED'], SUBMITTED: ['APPROVED', 'REJECTED', 'VOIDED'], REJECTED: ['SUBMITTED', 'VOIDED'], APPROVED: ['VOIDED'], VOIDED: [] }
/**
 * §8 acceptance audit — approving a cost is a money gate, not a write.
 *
 * `submit` moves a draft into the queue and is ordinary finance work. `approve`
 * is what makes the row count toward actual cost (the canonical actual is
 * approved TimeEntry billing + approved ContractCost), and `reject`/`void`
 * take money back out of it. Those three sit behind FINANCE_APPROVE, matching
 * invoice approval, timesheet approval and payment — a general write
 * permission must never substitute for an explicit approval permission.
 */
router.post('/costs/:id/:action(submit|approve|reject|void)', requireAnyPermission('FINANCE_WRITE', 'FINANCE_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    if (req.params.action !== 'submit' && !(await callerHasPermission(req, 'FINANCE_APPROVE'))) {
      throw new ForbiddenError('This action requires the FINANCE_APPROVE permission')
    }
    const cost = await loadCost(firmId, req.params.id)
    const map: Record<string, string> = { submit: 'SUBMITTED', approve: 'APPROVED', reject: 'REJECTED', void: 'VOIDED' }
    const to = map[req.params.action]
    if (!(COST_FLOW[cost.status] || []).includes(to)) return res.status(409).json({ success: false, error: `Invalid cost transition ${cost.status} → ${to}`, code: 'INVALID_TRANSITION' })
    const data: Prisma.ContractCostUpdateInput = { status: to }
    if (to === 'APPROVED') { data.approvedByUserId = req.user?.userId ?? null; data.approvedAt = new Date() }
    if (to === 'REJECTED') data.rejectionReason = z.string().min(1).max(2000).parse(req.body?.reason)
    const row = await prisma.contractCost.update({ where: { id: cost.id }, data })
    await audit(req, firmId, to === 'APPROVED' ? 'APPROVAL' : 'UPDATE', 'ContractCost', row.id, to)
    res.json({ success: true, data: row })
  } catch (err) { next(err) }
})

// =============================================================
// 9D — LABOR RATES
// =============================================================
const RATE_TYPES = ['BILLING', 'COST', 'CEILING', 'BLENDED', 'OTHER'] as const
const RateSchema = z.object({
  categoryName: z.string().min(1).max(200),
  categoryCode: z.string().max(60).nullable().optional(),
  employeeRef: z.string().max(200).nullable().optional(),
  billingRate: money,
  costRate: money,
  rateType: z.enum(RATE_TYPES).optional(),
  effectiveStart: dateField,
  effectiveEnd: dateField,
  clinId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
})
router.get('/:contractId/rates', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    await loadContract(firmId, req.params.contractId)
    const rows = await prisma.contractLaborRate.findMany({ where: { consultingFirmId: firmId, contractId: req.params.contractId }, orderBy: [{ categoryName: 'asc' }, { effectiveStart: 'desc' }] })
    res.json({ success: true, data: rows.map((r) => stripCost(r as unknown as Record<string, unknown>, isAdmin(req))) })
  } catch (err) { next(err) }
})
router.post('/:contractId/rates', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const contract = await loadContract(firmId, req.params.contractId)
    const body = RateSchema.parse(req.body)
    const rateType = body.rateType ?? 'BILLING'
    // Prevent overlapping effective periods for same (contract, category, rateType).
    const existing = await prisma.contractLaborRate.findMany({ where: { contractId: contract.id, categoryName: body.categoryName, rateType, isActive: true } })
    if (existing.some((e) => periodsOverlap(e.effectiveStart, e.effectiveEnd, body.effectiveStart ?? null, body.effectiveEnd ?? null))) {
      throw new ConflictError(`An active ${rateType} rate for "${body.categoryName}" already covers an overlapping effective period`)
    }
    const row = await prisma.contractLaborRate.create({ data: { consultingFirmId: firmId, contractId: contract.id, ...body, rateType } })
    await audit(req, firmId, 'CREATE', 'ContractLaborRate', row.id)
    res.status(201).json({ success: true, data: row })
  } catch (err) { next(err) }
})

// =============================================================
// 9E — TIME ENTRIES
// =============================================================
const TimeSchema = z.object({
  laborCategory: z.string().min(1).max(200),
  workDate: z.string().datetime().transform((s) => new Date(s)),
  hours: z.number().positive().max(DAILY_HOURS_MAX),
  clinId: z.string().uuid().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
})
router.get('/time/mine', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const rows = await prisma.timeEntry.findMany({ where: { consultingFirmId: firmId, userId: req.user?.userId }, orderBy: { workDate: 'desc' }, take: 200 })
    res.json({ success: true, data: rows.map((r) => stripCost(r as unknown as Record<string, unknown>, isAdmin(req))) })
  } catch (err) { next(err) }
})
router.get('/time/approvals', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const rows = await prisma.timeEntry.findMany({ where: { consultingFirmId: firmId, status: 'SUBMITTED' }, orderBy: { submittedAt: 'asc' }, include: { contract: { select: { contractNumber: true, title: true } } } })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})
router.get('/:contractId/time', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    await loadContract(firmId, req.params.contractId)
    const rows = await prisma.timeEntry.findMany({ where: { consultingFirmId: firmId, contractId: req.params.contractId }, orderBy: { workDate: 'desc' } })
    res.json({ success: true, data: rows.map((r) => stripCost(r as unknown as Record<string, unknown>, isAdmin(req))) })
  } catch (err) { next(err) }
})
router.post('/:contractId/time', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const contract = await loadContract(firmId, req.params.contractId)
    if (contract.isArchived) throw new ValidationError('Cannot log time on an archived contract')
    const body = TimeSchema.parse(req.body)
    if (body.workDate.getTime() > Date.now()) throw new ValidationError('Future-dated time entries are not permitted')
    if (body.clinId) {
      const clin = await prisma.clin.findFirst({ where: { id: body.clinId, contractId: contract.id, isArchived: false }, select: { id: true } })
      if (!clin) throw new ValidationError('CLIN must belong to this contract and be active')
    }
    const row = await prisma.timeEntry.create({ data: { consultingFirmId: firmId, contractId: contract.id, userId: req.user!.userId, status: 'DRAFT', ...body } })
    await audit(req, firmId, 'CREATE', 'TimeEntry', row.id)
    res.status(201).json({ success: true, data: stripCost(row as unknown as Record<string, unknown>, isAdmin(req)) })
  } catch (err) { next(err) }
})
async function loadTime(firmId: string, id: string) {
  const t = await prisma.timeEntry.findFirst({ where: { id, consultingFirmId: firmId } })
  if (!t) throw new NotFoundError('TimeEntry')
  return t
}
router.put('/time/:id', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const t = await loadTime(firmId, req.params.id)
    if (t.status !== 'DRAFT' && t.status !== 'REJECTED') throw new ConflictError('Only DRAFT or REJECTED time entries can be edited')
    const body = TimeSchema.partial().parse(req.body)
    if (body.workDate && body.workDate.getTime() > Date.now()) throw new ValidationError('Future-dated time entries are not permitted')
    const row = await prisma.timeEntry.update({ where: { id: t.id }, data: body })
    await audit(req, firmId, 'UPDATE', 'TimeEntry', row.id)
    res.json({ success: true, data: stripCost(row as unknown as Record<string, unknown>, isAdmin(req)) })
  } catch (err) { next(err) }
})
router.post('/time/:id/submit', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const t = await loadTime(firmId, req.params.id)
    if (t.status !== 'DRAFT' && t.status !== 'REJECTED') throw new ConflictError(`Cannot submit from ${t.status}`)
    // §7.8 — submission and TIME_ENTRY_SUBMITTED share one transaction.
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.timeEntry.update({ where: { id: t.id }, data: { status: 'SUBMITTED', submittedAt: new Date(), rejectionReason: null } })
      await emitTimeEntrySubmitted(tx, { consultingFirmId: firmId, contractId: updated.contractId, timeEntryId: updated.id, workDate: updated.workDate })
      return updated
    })
    await audit(req, firmId, 'UPDATE', 'TimeEntry', row.id, 'submitted')
    res.json({ success: true, data: row })
  } catch (err) { next(err) }
})
router.post('/time/:id/approve', requirePermission('FINANCE_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const t = await loadTime(firmId, req.params.id)
    if (t.status !== 'SUBMITTED') throw new ConflictError('Only a SUBMITTED time entry can be approved')
    // Cost the entry using the rate effective on the work date.
    const rates = await prisma.contractLaborRate.findMany({ where: { consultingFirmId: firmId, contractId: t.contractId } })
    const billRate = rateForWorkDate(rates as never, t.laborCategory, t.workDate, 'BILLING')
    const costRate = rateForWorkDate(rates as never, t.laborCategory, t.workDate, 'COST') ?? billRate
    const appliedBilling = billRate?.billingRate ?? null
    const appliedCost = (costRate as { costRate?: Prisma.Decimal | null } | null)?.costRate ?? null
    const billingAmount = appliedBilling != null ? lineAmount(t.hours, appliedBilling) : null
    const costAmount = appliedCost != null ? lineAmount(t.hours, appliedCost) : null
    const row = await prisma.timeEntry.update({
      where: { id: t.id },
      data: {
        status: 'APPROVED', approverUserId: req.user?.userId ?? null, decidedAt: new Date(),
        appliedBillingRate: appliedBilling, appliedCostRate: appliedCost, billingAmount, costAmount,
      },
    })
    await audit(req, firmId, 'APPROVAL', 'TimeEntry', row.id, appliedBilling == null ? 'approved (NO RATE — billing incomplete)' : 'approved')
    res.json({ success: true, data: stripCost(row as unknown as Record<string, unknown>, isAdmin(req)), meta: { rateApplied: appliedBilling != null } })
  } catch (err) { next(err) }
})
router.post('/time/:id/reject', requirePermission('FINANCE_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const t = await loadTime(firmId, req.params.id)
    if (t.status !== 'SUBMITTED') throw new ConflictError('Only a SUBMITTED time entry can be rejected')
    const reason = z.string().min(1).max(2000).parse(req.body?.reason)
    const row = await prisma.timeEntry.update({ where: { id: t.id }, data: { status: 'REJECTED', rejectionReason: reason, decidedAt: new Date() } })
    await audit(req, firmId, 'UPDATE', 'TimeEntry', row.id, 'rejected')
    res.json({ success: true, data: row })
  } catch (err) { next(err) }
})

// =============================================================
// 9B — FINANCIAL SUMMARY / BURN
// =============================================================
router.get('/:contractId/summary', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const contract = await loadContract(firmId, req.params.contractId)
    // §7.1 — the burn inputs are loaded through the shared finance query layer so
    // this endpoint and the Contract Administration Agent can never drift apart
    // on what "funded" or "expended" means.
    const { burn } = await loadContractBurn(firmId, contract, new Date())
    res.json({ success: true, data: burn })
  } catch (err) { next(err) }
})

// =============================================================
// 9G — INVOICES (collect approved, uninvoiced time + costs)
// =============================================================
const InvoiceSchema = z.object({
  invoiceNumber: z.string().max(60).optional(),
  periodStart: dateField,
  periodEnd: dateField,
  invoiceDate: dateField,
  dueDate: dateField,
  customerName: z.string().max(300).nullable().optional(),
  feeAmount: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
})
router.get('/:contractId/invoices', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    await loadContract(firmId, req.params.contractId)
    const rows = await prisma.contractInvoice.findMany({ where: { consultingFirmId: firmId, contractId: req.params.contractId }, orderBy: { createdAt: 'desc' } })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})
/**
 * Every invoice on the contract, one row per LINE, not one row per invoice.
 *
 * The summary this replaced was true and useless: it reported that INV-00001
 * totalled $58,462.50 while the screen above it listed the fourteen lines that
 * add up to it, and the export dropped all fourteen. Whoever exports an invoice
 * ledger is going to pivot it by CLIN or by kind, and neither is possible from
 * totals.
 *
 * Invoice-level figures repeat on each line and are named "Invoice ..." so that
 * the column a reader sums is `Line amount`, not a total repeated fourteen times.
 *
 * An invoice with no lines still gets a row. Dropping it would make the file
 * disagree with the screen about how many invoices exist.
 */
router.get('/:contractId/invoices/export', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const contract = await loadContract(firmId, req.params.contractId)
    const invoices = await prisma.contractInvoice.findMany({
      where: { consultingFirmId: firmId, contractId: req.params.contractId },
      include: { lineItems: { include: { clin: { select: { clinNumber: true } } }, orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    })

    const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '')
    const rows: unknown[][] = [[
      'Invoice number', 'Invoice status', 'Invoice date', 'Period start', 'Period end', 'Due date', 'Customer',
      'CLIN', 'Line kind', 'Line description', 'Quantity', 'Rate', 'Line amount (USD)',
      'Invoice subtotal (USD)', 'Invoice total (USD)', 'Invoice paid (USD)', 'Invoice outstanding (USD)',
    ]]

    for (const inv of invoices) {
      const head = [
        inv.invoiceNumber, inv.status, date(inv.invoiceDate), date(inv.periodStart), date(inv.periodEnd),
        date(inv.dueDate), inv.customerName ?? '',
      ]
      const tail = [
        inv.subtotal.toFixed(2), inv.total.toFixed(2), inv.amountPaid.toFixed(2),
        D(inv.total).minus(inv.amountPaid).toFixed(2),
      ]
      if (inv.lineItems.length === 0) {
        rows.push([...head, '', '', '', '', '', '', ...tail])
        continue
      }
      for (const l of inv.lineItems) {
        rows.push([
          ...head,
          l.clin?.clinNumber ?? '', l.kind, l.description,
          l.quantity?.toString() ?? '', l.rate?.toString() ?? '', l.amount.toFixed(2),
          ...tail,
        ])
      }
    }

    await audit(req, firmId, 'EXPORT', 'Contract', contract.id, 'invoice ledger exported')

    const filename = `invoices-${contract.contractNumber.replace(/[^A-Za-z0-9._-]/g, '_')}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(csvBody(rows))
  } catch (err) { next(err) }
})
router.post('/:contractId/invoices', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const contract = await loadContract(firmId, req.params.contractId)
    const body = InvoiceSchema.parse(req.body)
    const invoice = await prisma.$transaction(async (tx) => {
      // Eligibility and line assembly live in services/agents/finance/invoiceBuilder
      // so the human route and the Finance Agent bill from ONE implementation.
      const period = body.periodStart || body.periodEnd
        ? { start: body.periodStart ?? new Date(0), end: body.periodEnd ?? new Date(8640000000000000) }
        : undefined
      const [times, costs] = await Promise.all([
        tx.timeEntry.findMany({ where: eligibleTimeWhere(firmId, contract.id, period) }),
        tx.contractCost.findMany({ where: eligibleCostWhere(firmId, contract.id, period) }),
      ])

      // Concurrency-safe number: unique(firm, number) constraint guards races.
      let number = body.invoiceNumber
      if (!number) {
        const count = await tx.contractInvoice.count({ where: { consultingFirmId: firmId } })
        number = nextInvoiceNumber(count)
      }

      const assembled = assembleInvoice({ consultingFirmId: firmId, times, costs, feeAmount: body.feeAmount })
      const subtotal = assembled.subtotal
      const total = assembled.total
      const lineData: Prisma.ContractInvoiceLineItemCreateManyInvoiceInput[] =
        assembled.lines as unknown as Prisma.ContractInvoiceLineItemCreateManyInvoiceInput[]

      const inv = await tx.contractInvoice.create({
        data: {
          consultingFirmId: firmId, contractId: contract.id, invoiceNumber: number, status: 'DRAFT',
          periodStart: body.periodStart ?? null, periodEnd: body.periodEnd ?? null, invoiceDate: body.invoiceDate ?? new Date(),
          dueDate: body.dueDate ?? null, customerName: body.customerName ?? contract.agency ?? null,
          subtotal, total, notes: body.notes ?? null, createdByUserId: req.user?.userId ?? null,
          lineItems: { createMany: { data: lineData } },
        },
        include: { lineItems: { include: { clin: { select: { id: true, clinNumber: true } } }, orderBy: { createdAt: 'asc' } } },
      })
      // Mark sources invoiced (prevents double-invoicing).
      if (times.length) await tx.timeEntry.updateMany({ where: { id: { in: times.map((t) => t.id) } }, data: { invoicedInvoiceId: inv.id } })
      if (costs.length) await tx.contractCost.updateMany({ where: { id: { in: costs.map((c) => c.id) } }, data: { invoicedInvoiceId: inv.id } })
      return inv
    })
    await audit(req, firmId, 'CREATE', 'ContractInvoice', invoice.id, invoice.invoiceNumber)
    res.status(201).json({ success: true, data: invoice })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return next(new ConflictError('An invoice with that number already exists'))
    next(err)
  }
})
async function loadInvoice(firmId: string, id: string) {
  const i = await prisma.contractInvoice.findFirst({ where: { id, consultingFirmId: firmId }, include: { lineItems: { include: { clin: { select: { id: true, clinNumber: true } } }, orderBy: { createdAt: 'asc' } }, payments: { where: { isVoided: false } } } })
  if (!i) throw new NotFoundError('ContractInvoice')
  return i
}
router.get('/invoices/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const inv = await loadInvoice(firmId, req.params.id)
    res.json({ success: true, data: { ...inv, outstanding: D(inv.total).minus(D(inv.amountPaid)).toFixed(2) } })
  } catch (err) { next(err) }
})
router.post('/invoices/:id/:action(approve|submit|void)', requirePermission('FINANCE_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const inv = await prisma.contractInvoice.findFirst({ where: { id: req.params.id, consultingFirmId: firmId } })
    if (!inv) throw new NotFoundError('ContractInvoice')
    const action = req.params.action
    if (action === 'approve') {
      if (inv.status !== 'DRAFT' && inv.status !== 'READY_FOR_REVIEW') throw new ConflictError(`Cannot approve from ${inv.status}`)
      const row = await prisma.contractInvoice.update({ where: { id: inv.id }, data: { status: 'APPROVED', approvedByUserId: req.user?.userId ?? null } })
      await audit(req, firmId, 'APPROVAL', 'ContractInvoice', inv.id, 'approved')
      return res.json({ success: true, data: row })
    }
    if (action === 'submit') {
      if (inv.status !== 'APPROVED') throw new ConflictError('Only an APPROVED invoice can be marked submitted')
      const row = await prisma.contractInvoice.update({ where: { id: inv.id }, data: { status: 'SUBMITTED', submittedAt: new Date(), paymentReference: typeof req.body?.reference === 'string' ? req.body.reference : inv.paymentReference } })
      await audit(req, firmId, 'UPDATE', 'ContractInvoice', inv.id, 'submitted')
      return res.json({ success: true, data: row })
    }
    // void
    if (inv.status === 'PAID') throw new ConflictError('A fully paid invoice cannot be voided')
    const reason = z.string().min(1).max(2000).parse(req.body?.reason)
    const row = await prisma.$transaction(async (tx) => {
      // Release invoiced sources so they can be re-invoiced.
      await tx.timeEntry.updateMany({ where: { invoicedInvoiceId: inv.id }, data: { invoicedInvoiceId: null } })
      await tx.contractCost.updateMany({ where: { invoicedInvoiceId: inv.id }, data: { invoicedInvoiceId: null } })
      return tx.contractInvoice.update({ where: { id: inv.id }, data: { status: 'VOIDED', notes: reason } })
    })
    await audit(req, firmId, 'UPDATE', 'ContractInvoice', inv.id, 'voided')
    res.json({ success: true, data: row })
  } catch (err) { next(err) }
})

// =============================================================
// 9H — PAYMENTS
// =============================================================
router.post('/invoices/:id/payments', requirePermission('FINANCE_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const inv = await prisma.contractInvoice.findFirst({ where: { id: req.params.id, consultingFirmId: firmId } })
    if (!inv) throw new NotFoundError('ContractInvoice')
    if (inv.status === 'VOIDED') throw new ConflictError('Cannot record a payment on a voided invoice')
    const body = z.object({ amount: z.number().positive().max(1_000_000_000), paymentDate: dateField, referenceNumber: z.string().max(120).nullable().optional(), method: z.string().max(120).nullable().optional(), notes: z.string().max(2000).nullable().optional() }).parse(req.body)

    const result = await prisma.$transaction(async (tx) => {
      const paid = await tx.invoicePayment.findMany({ where: { invoiceId: inv.id, isVoided: false }, select: { amount: true } })
      const already = paid.reduce((s, p) => s.plus(D(p.amount)), D(0))
      const newTotal = already.plus(D(body.amount))
      if (newTotal.gt(D(inv.total))) throw new ConflictError(`Payment would exceed the invoice total (outstanding ${D(inv.total).minus(already).toFixed(2)})`)
      const payment = await tx.invoicePayment.create({ data: { consultingFirmId: firmId, invoiceId: inv.id, amount: new Prisma.Decimal(body.amount), paymentDate: body.paymentDate ?? new Date(), referenceNumber: body.referenceNumber ?? null, method: body.method ?? null, notes: body.notes ?? null, recordedByUserId: req.user?.userId ?? null } })
      const status = newTotal.gte(D(inv.total)) ? 'PAID' : 'PARTIALLY_PAID'
      const updated = await tx.contractInvoice.update({ where: { id: inv.id }, data: { amountPaid: money2(newTotal), status, paidAt: status === 'PAID' ? new Date() : inv.paidAt } })
      // §7.8 — only a genuine transition INTO paid is an event. A partial
      // payment is not, and the Finance Agent can never cause either.
      if (isInvoiceNowPaid(inv.status, status)) {
        await emitInvoicePaid(tx, { consultingFirmId: firmId, contractId: inv.contractId, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, paymentId: payment.id })
      }
      return { payment, invoice: updated, outstanding: D(updated.total).minus(D(updated.amountPaid)).toFixed(2) }
    })
    await audit(req, firmId, 'CREATE', 'InvoicePayment', result.payment.id)
    res.status(201).json({ success: true, data: result })
  } catch (err) { next(err) }
})
router.post('/payments/:id/void', requirePermission('FINANCE_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const p = await prisma.invoicePayment.findFirst({ where: { id: req.params.id, consultingFirmId: firmId } })
    if (!p) throw new NotFoundError('InvoicePayment')
    if (p.isVoided) throw new ConflictError('Payment already voided')
    const reason = z.string().min(1).max(2000).parse(req.body?.reason)
    const result = await prisma.$transaction(async (tx) => {
      await tx.invoicePayment.update({ where: { id: p.id }, data: { isVoided: true, voidReason: reason } })
      const paid = await tx.invoicePayment.findMany({ where: { invoiceId: p.invoiceId, isVoided: false }, select: { amount: true } })
      const total = paid.reduce((s, x) => s.plus(D(x.amount)), D(0))
      const inv = await tx.contractInvoice.findUnique({ where: { id: p.invoiceId } })
      const status = total.lte(0) ? (inv!.status === 'PAID' || inv!.status === 'PARTIALLY_PAID' ? 'APPROVED' : inv!.status) : total.gte(D(inv!.total)) ? 'PAID' : 'PARTIALLY_PAID'
      return tx.contractInvoice.update({ where: { id: p.invoiceId }, data: { amountPaid: money2(total), status } })
    })
    await audit(req, firmId, 'UPDATE', 'InvoicePayment', p.id, 'voided')
    res.json({ success: true, data: { id: p.id, isVoided: true, invoice: result } })
  } catch (err) { next(err) }
})

// =============================================================
// INVOICE FOLLOW-UP + EXPORT
// =============================================================

const FOLLOW_UP_METHODS = ['EMAIL', 'PHONE', 'PORTAL', 'LETTER', 'OTHER'] as const

const FollowUpSchema = z.object({
  contactedAt: dateField,
  method: z.enum(FOLLOW_UP_METHODS),
  contactName: z.string().max(200).nullable().optional(),
  note: z.string().min(1).max(2000),
  nextActionAt: dateField,
})

router.get('/invoices/:id/follow-ups', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    await loadInvoice(firmId, req.params.id)
    const rows = await prisma.invoiceFollowUp.findMany({
      where: { consultingFirmId: firmId, invoiceId: req.params.id },
      orderBy: { contactedAt: 'desc' },
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

/**
 * Record that someone chased this invoice.
 *
 * Deliberately does NOT touch the invoice status. Chasing a customer is not
 * being paid, and an ageing report that quietly improved because somebody sent
 * an email would be worse than no report at all.
 */
router.post('/invoices/:id/follow-ups', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const invoice = await loadInvoice(firmId, req.params.id)
    const body = FollowUpSchema.parse(req.body)
    const row = await prisma.invoiceFollowUp.create({
      data: {
        consultingFirmId: firmId, invoiceId: invoice.id,
        contactedAt: body.contactedAt ?? new Date(),
        method: body.method,
        contactName: body.contactName ?? null,
        note: body.note,
        nextActionAt: body.nextActionAt ?? null,
        recordedByUserId: req.user?.userId ?? null,
      },
    })
    await audit(req, firmId, 'CREATE', 'InvoiceFollowUp', row.id,
      `Chased ${invoice.invoiceNumber} by ${body.method.toLowerCase()}`)
    res.status(201).json({ success: true, data: row })
  } catch (err) { next(err) }
})

router.post('/follow-ups/:id/resolve', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await prisma.invoiceFollowUp.findFirst({ where: { id: req.params.id, consultingFirmId: firmId } })
    if (!existing) throw new NotFoundError('InvoiceFollowUp')
    const row = await prisma.invoiceFollowUp.update({
      where: { id: existing.id }, data: { resolvedAt: existing.resolvedAt ?? new Date() },
    })
    await audit(req, firmId, 'UPDATE', 'InvoiceFollowUp', row.id, 'follow-up closed')
    res.json({ success: true, data: row })
  } catch (err) { next(err) }
})

/**
 * The invoice as a CSV a person can key into the customer's billing system.
 *
 * It is an EXPORT, not a submission. The platform has no WAWF or IPP
 * connection, so nothing here is transmitted anywhere — calling it a
 * submission would misrepresent what the button does.
 *
 * Every line carries its CLIN, because that is the breakdown the government
 * bills against and the one the underlying records already use.
 */
router.get('/invoices/:id/export', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const invoice = await prisma.contractInvoice.findFirst({
      where: { id: req.params.id, consultingFirmId: firmId },
      include: {
        lineItems: { include: { clin: { select: { clinNumber: true } } }, orderBy: { createdAt: 'asc' } },
        contract: { select: { contractNumber: true, title: true, agency: true } },
      },
    })
    if (!invoice) throw new NotFoundError('ContractInvoice')

    const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '')

    const rows: string[][] = [
      ['Contract number', invoice.contract.contractNumber],
      ['Contract title', invoice.contract.title],
      ['Agency', invoice.contract.agency ?? ''],
      ['Invoice number', invoice.invoiceNumber],
      ['Invoice date', date(invoice.invoiceDate)],
      ['Period start', date(invoice.periodStart)],
      ['Period end', date(invoice.periodEnd)],
      ['Due date', date(invoice.dueDate)],
      ['Customer', invoice.customerName ?? ''],
      ['Status', invoice.status],
      [],
      ['CLIN', 'Kind', 'Description', 'Quantity', 'Rate', 'Amount'],
      ...invoice.lineItems.map((l) => [
        l.clin?.clinNumber ?? '', l.kind, l.description,
        l.quantity?.toString() ?? '', l.rate?.toString() ?? '', l.amount.toFixed(2),
      ]),
      [],
      ['Subtotal', '', '', '', '', invoice.subtotal.toFixed(2)],
      ['Total', '', '', '', '', invoice.total.toFixed(2)],
      ['Amount paid', '', '', '', '', invoice.amountPaid.toFixed(2)],
      ['Outstanding', '', '', '', '', D(invoice.total).minus(D(invoice.amountPaid)).toFixed(2)],
    ]

    const csv = csvBody(rows)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.csv"`)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(csv)
  } catch (err) { next(err) }
})

/**
 * The same invoice as a formatted PDF.
 *
 * Built server-side rather than from the browser's print dialog: the customer
 * copy has to look the same whoever produced it and on whatever machine, and a
 * print stylesheet renders differently per browser. The CSV above stays — one
 * is for keying into a billing system, the other is for sending to a person.
 *
 * Like the CSV, this is an EXPORT and says so in its own footer. Nothing is
 * transmitted to any government billing system.
 */
router.get('/invoices/:id/pdf', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const invoice = await prisma.contractInvoice.findFirst({
      where: { id: req.params.id, consultingFirmId: firmId },
      include: {
        lineItems: { include: { clin: { select: { clinNumber: true } } }, orderBy: { createdAt: 'asc' } },
        contract: { select: { contractNumber: true, title: true, agency: true, contractType: true } },
      },
    })
    if (!invoice) throw new NotFoundError('ContractInvoice')

    const firm = await prisma.consultingFirm.findUnique({
      where: { id: firmId },
      select: { name: true, brandingDisplayName: true, brandingPrimaryColor: true, brandingSecondaryColor: true },
    })
    if (!firm) throw new NotFoundError('ConsultingFirm')

    // Summed here rather than in the renderer, and only over lines that carry a
    // CLIN. A fee spans the invoice and belongs to no single CLIN, so it is
    // absent from this block on purpose — which is why the block never claims
    // to equal the invoice total.
    const byClin = new Map<string, Prisma.Decimal>()
    for (const l of invoice.lineItems) {
      const key = l.clin?.clinNumber
      if (!key) continue
      byClin.set(key, (byClin.get(key) ?? D(0)).plus(l.amount))
    }

    const outstanding = D(invoice.total).minus(invoice.amountPaid)
    const pdf = await buildContractInvoicePdf({
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      customerName: invoice.customerName,
      notes: invoice.notes,
      subtotal: Number(invoice.subtotal),
      adjustments: Number(invoice.adjustments),
      taxAmount: Number(invoice.taxAmount),
      total: Number(invoice.total),
      amountPaid: Number(invoice.amountPaid),
      outstanding: Number(outstanding),
      contract: invoice.contract,
      firm: {
        name: firm.name,
        displayName: firm.brandingDisplayName,
        primaryColor: firm.brandingPrimaryColor,
        secondaryColor: firm.brandingSecondaryColor,
      },
      lines: invoice.lineItems.map((l) => ({
        clinNumber: l.clin?.clinNumber ?? null,
        kind: l.kind,
        description: l.description,
        quantity: l.quantity != null ? Number(l.quantity) : null,
        rate: l.rate != null ? Number(l.rate) : null,
        amount: Number(l.amount),
      })),
      clinTotals: [...byClin.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([clinNumber, amount]) => ({ clinNumber, amount: Number(amount) })),
    })

    await audit(req, firmId, 'EXPORT', 'ContractInvoice', invoice.id, 'invoice exported as PDF')

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`)
    res.setHeader('Content-Length', pdf.length)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(pdf)
  } catch (err) { next(err) }
})

// =============================================================
// AUDIT READINESS — incurred cost evidence
// =============================================================

const AuditPackageQuery = z.object({
  fiscalYear: z.coerce.number().int().min(1900).max(2200),
  contractId: z.string().uuid().optional(),
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
})

/**
 * The evidence an incurred-cost submission is built from, for one fiscal year.
 *
 * Reading it needs FINANCE_WRITE rather than being firm-wide: it exposes cost
 * rates and pool figures, which are the numbers the platform strips from a
 * consultant everywhere else.
 */
router.get('/audit-package', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const q = AuditPackageQuery.parse(req.query)
    if (q.contractId) await loadContract(firmId, q.contractId)
    const pkg = await buildAuditPackage({
      consultingFirmId: firmId, fiscalYear: q.fiscalYear,
      contractId: q.contractId ?? null,
      periodStart: q.periodStart ?? null, periodEnd: q.periodEnd ?? null,
    })
    res.json({ success: true, data: pkg })
  } catch (err) { next(err) }
})

router.get('/audit-package/export', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const q = AuditPackageQuery.parse(req.query)
    if (q.contractId) await loadContract(firmId, q.contractId)
    const pkg = await buildAuditPackage({
      consultingFirmId: firmId, fiscalYear: q.fiscalYear,
      contractId: q.contractId ?? null,
      periodStart: q.periodStart ?? null, periodEnd: q.periodEnd ?? null,
    })
    await audit(req, firmId, 'EXPORT', 'AuditPackage', `FY${q.fiscalYear}`,
      `Incurred cost evidence exported for FY${q.fiscalYear}`)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="incurred-cost-FY${q.fiscalYear}.csv"`)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(auditPackageToCsv(pkg))
  } catch (err) { next(err) }
})

// =============================================================
// RECEIVABLES + RATE VARIANCE + ALERTS
// =============================================================
router.get('/receivables', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const invoices = await prisma.contractInvoice.findMany({ where: { consultingFirmId: firmId, status: { notIn: ['DRAFT', 'VOIDED', 'PAID'] } }, select: { dueDate: true, total: true, amountPaid: true } })
    const aging = receivablesAging(invoices.map((i) => ({ dueDate: i.dueDate, outstanding: D(i.total).minus(D(i.amountPaid)) })), new Date())
    res.json({ success: true, data: aging })
  } catch (err) { next(err) }
})

router.get('/:contractId/rate-variance', requirePermission('FINANCE_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    await loadContract(firmId, req.params.contractId)
    const [entries, rates] = await Promise.all([
      prisma.timeEntry.findMany({ where: { consultingFirmId: firmId, contractId: req.params.contractId, status: 'APPROVED', appliedBillingRate: { not: null } } }),
      prisma.contractLaborRate.findMany({ where: { consultingFirmId: firmId, contractId: req.params.contractId, rateType: 'BILLING', isActive: true } }),
    ])
    const findings = entries.map((e) => {
      const baseline = rateForWorkDate(rates as never, e.laborCategory, e.workDate, 'BILLING')
      const expected = baseline?.billingRate ?? null
      const v = rateVariance(e.appliedBillingRate!, expected)
      return {
        timeEntryId: e.id, laborCategory: e.laborCategory, workDate: e.workDate,
        expectedRate: v.expected, appliedRate: v.applied, difference: v.difference, variancePct: v.variancePct,
        expectedSource: expected == null ? 'No baseline available' : 'Contract billing rate', severity: v.severity,
        recommendedAction: v.severity === 'HIGH' ? 'Review — applied rate differs materially from the contract baseline' : v.severity === 'NONE' && expected == null ? 'Add a contract billing rate to enable monitoring' : 'OK',
      }
    })
    res.json({ success: true, data: findings })
  } catch (err) { next(err) }
})

router.get('/alerts', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const now = new Date()
    const contracts = await prisma.contract.findMany({ where: { consultingFirmId: firmId, isArchived: false }, select: { id: true, contractNumber: true, title: true, endDate: true, ceilingValue: true } })
    const alerts: Array<{ kind: string; severity: string; message: string; contractId: string; link: string }> = []
    for (const c of contracts) {
      const [funding, aTime, aCost] = await Promise.all([
        prisma.fundingTransaction.findMany({ where: { contractId: c.id }, select: { amount: true, isVoided: true } }),
        prisma.timeEntry.findMany({ where: { contractId: c.id, status: 'APPROVED' }, select: { billingAmount: true, workDate: true } }),
        prisma.contractCost.findMany({ where: { contractId: c.id, status: 'APPROVED' }, select: { amount: true, incurredDate: true, approvedAt: true } }),
      ])
      const funded = sumFunding(funding)
      const expended = recognizedExpenditure(aTime, aCost)
      const dates = [...aTime.map((t) => t.workDate), ...aCost.map((x) => x.incurredDate ?? x.approvedAt).filter((d): d is Date => !!d)]
      const burn = computeBurn({ funded, ceiling: c.ceilingValue, expended, expenditureDates: dates, now, endDate: c.endDate })
      if (burn.warning === 'FUNDING_LOW') alerts.push({ kind: 'FUNDING_LOW', severity: 'HIGH', message: `${c.contractNumber}: funded amount ${Math.round(burn.expendedPct * 100)}% expended`, contractId: c.id, link: `/contracts/${c.id}` })
      if (burn.warning === 'CEILING_LOW') alerts.push({ kind: 'CEILING_LOW', severity: 'HIGH', message: `${c.contractNumber}: nearing contract ceiling`, contractId: c.id, link: `/contracts/${c.id}` })
      if (burn.depletionBeforeEnd) alerts.push({ kind: 'DEPLETION_BEFORE_END', severity: 'HIGH', message: `${c.contractNumber}: funding projected to deplete before period of performance ends`, contractId: c.id, link: `/contracts/${c.id}` })
    }
    // Overdue invoices + pending time.
    const overdue = await prisma.contractInvoice.findMany({ where: { consultingFirmId: firmId, status: { in: ['SUBMITTED', 'PARTIALLY_PAID', 'APPROVED'] }, dueDate: { lt: now } }, select: { id: true, contractId: true, invoiceNumber: true } })
    for (const o of overdue) alerts.push({ kind: 'INVOICE_OVERDUE', severity: 'MEDIUM', message: `Invoice ${o.invoiceNumber} is overdue`, contractId: o.contractId, link: `/contracts/${o.contractId}` })
    const pending = await prisma.timeEntry.count({ where: { consultingFirmId: firmId, status: 'SUBMITTED' } })
    if (pending > 0) alerts.push({ kind: 'TIME_PENDING_APPROVAL', severity: 'LOW', message: `${pending} time entr${pending === 1 ? 'y' : 'ies'} awaiting approval`, contractId: '', link: `/timekeeping` })
    res.json({ success: true, data: alerts })
  } catch (err) { next(err) }
})

export default router
