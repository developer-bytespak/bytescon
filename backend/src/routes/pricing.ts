// =============================================================
// Pricing & Rate Build-Up (§5.1 Stage 6 / §5.2). Mounted at /api/pricing.
// Relational, versioned, decimal-safe, role-protected. Workspace → Scenario →
// {labour lines, indirect rates, other/subcontractor costs}. Scenario totals are
// backend-computed snapshots (pricingCalc). Sensitive rates/margins are redacted
// from non-ADMIN roles. APPROVED workspaces are immutable (edit blocked). Every
// financial/workflow change is audited.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { requireActiveBase } from '../middleware/addonGate'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { prisma } from '../config/database'
import { computePricing, validateRateBase, RATE_TYPES, COST_BASES, OTHER_COST_CATEGORIES } from '../services/pricingCalc'
import { createHash } from 'crypto'
import { emitPricingScenarioChanged, emitIndirectRateChanged, pricingFingerprint, templateRateFingerprint } from '../services/agents/pricing/pricingEvents'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const ACTIVE_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED']
const EDITABLE_STATUSES = ['DRAFT']
const isAdmin = (req: AuthenticatedRequest) => req.user?.role === 'ADMIN'

const audit = (req: AuthenticatedRequest, firmId: string, action: AuditAction, entityType: string, entityId: string, rationale?: string, before?: unknown, after?: unknown) =>
  logAudit({ consultingFirmId: firmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType, entityId, rationale, before, after })

async function loadWorkspace(firmId: string, id: string) {
  const w = await prisma.pricingWorkspace.findFirst({ where: { id, consultingFirmId: firmId } })
  if (!w) throw new NotFoundError('Pricing workspace')
  return w
}
async function loadScenario(firmId: string, id: string) {
  const s = await prisma.pricingScenario.findFirst({ where: { id, consultingFirmId: firmId }, include: { workspace: true } })
  if (!s || s.workspace.consultingFirmId !== firmId) throw new NotFoundError('Pricing scenario')
  return s
}
function assertEditable(status: string) {
  if (!EDITABLE_STATUSES.includes(status)) throw new ConflictError(`Pricing is ${status} and cannot be edited. Create a new version to make changes.`)
}

// Recompute + persist a scenario's snapshot totals from its current lines.
//
// §7.6 — this is the ONE chokepoint every pricing mutation already funnels
// through, so PRICING_SCENARIO_CHANGED is emitted from here and nowhere else.
// The event fires only when the normalized pricing fingerprint actually moved,
// so a rename or a reorder emits nothing, and it shares the transaction with
// the totals write, so a rolled-back mutation emits nothing either.
async function recomputeScenario(scenarioId: string) {
  const [scenario, labor, indirects, others] = await Promise.all([
    prisma.pricingScenario.findUnique({
      where: { id: scenarioId },
      select: { id: true, consultingFirmId: true, workspaceId: true, workspace: { select: { opportunityId: true } } },
    }),
    prisma.pricingLaborLine.findMany({ where: { scenarioId } }),
    prisma.pricingIndirectRate.findMany({ where: { scenarioId } }),
    prisma.pricingOtherCost.findMany({ where: { scenarioId } }),
  ])
  const t = computePricing(
    labor.map((l) => ({ hours: l.hours, baseRate: l.baseRate, escalationPct: l.escalationPct, personnelCount: l.personnelCount, isActive: l.isActive })),
    indirects.map((r) => ({ rateType: r.rateType, percent: r.percent, costBase: r.costBase, isActive: r.isActive })),
    others.map((o) => ({ costCategory: o.costCategory, quantity: o.quantity, unitCost: o.unitCost })),
  )

  const fingerprintHash = createHash('sha256')
    .update(pricingFingerprint({ laborLines: labor, indirectRates: indirects, otherCosts: others }))
    .digest('hex')

  await prisma.$transaction(async (tx) => {
    await tx.pricingScenario.update({
      where: { id: scenarioId },
      data: {
        totalDirectLabor: t.totalDirectLabor, totalFringe: t.totalFringe, totalOverhead: t.totalOverhead,
        totalOdc: t.totalOdc, totalSubcontractor: t.totalSubcontractor, totalGA: t.totalGA,
        subtotalBeforeFee: t.subtotalBeforeFee, totalFee: t.totalFee, totalPrice: t.totalPrice, calculatedAt: new Date(),
      },
    })
    if (scenario) {
      await emitPricingScenarioChanged(
        {
          consultingFirmId: scenario.consultingFirmId,
          scenarioId,
          workspaceId: scenario.workspaceId,
          opportunityId: scenario.workspace?.opportunityId ?? null,
          fingerprintHash,
        },
        tx,
      )
    }
  })
  return t
}

// Strip sensitive cost rates/margins for non-ADMIN readers. Total price stays
// visible; per-line rates, percentages, and the cost breakdown are redacted.
function redactScenario(scenario: Record<string, unknown>, admin: boolean) {
  if (admin) return { ...scenario, sensitiveRedacted: false }
  const redactedLines = (arr: Record<string, unknown>[] | undefined, fields: string[]) =>
    (arr ?? []).map((x) => { const c = { ...x }; for (const f of fields) c[f] = null; return c })
  return {
    ...scenario,
    totalFringe: null, totalOverhead: null, totalGA: null, totalFee: null, subtotalBeforeFee: null,
    laborLines: redactedLines(scenario.laborLines as Record<string, unknown>[], ['baseRate', 'escalationPct', 'directLaborAmount']),
    indirectRates: redactedLines(scenario.indirectRates as Record<string, unknown>[], ['percent']),
    otherCosts: redactedLines(scenario.otherCosts as Record<string, unknown>[], ['unitCost', 'totalAmount']),
    sensitiveRedacted: true,
  }
}

function scenarioInclude() {
  return { laborLines: { orderBy: { sortOrder: 'asc' as const } }, indirectRates: { orderBy: { sortOrder: 'asc' as const } }, otherCosts: { orderBy: { sortOrder: 'asc' as const } } }
}

// =============================================================
// WORKSPACE
// =============================================================
router.post('/opportunity/:opportunityId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim().slice(0, 300) : null
    if (!title) throw new ValidationError('A pricing title is required')
    const opp = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId: firmId }, select: { id: true } })
    if (!opp) throw new NotFoundError('Opportunity')
    const dupe = await prisma.pricingWorkspace.findFirst({ where: { consultingFirmId: firmId, opportunityId: opp.id, isArchived: false, status: { in: ACTIVE_STATUSES } }, select: { id: true } })
    if (dupe) throw new ConflictError('An active pricing workspace already exists for this opportunity. Create a new version instead.')
    const workspace = await prisma.pricingWorkspace.create({
      data: {
        consultingFirmId: firmId, opportunityId: opp.id, title,
        proposalId: typeof req.body?.proposalId === 'string' ? req.body.proposalId : null,
        contractType: typeof req.body?.contractType === 'string' ? req.body.contractType : null,
        ownerUserId: req.user?.userId ?? null, createdByUserId: req.user?.userId ?? null,
        scenarios: { create: { consultingFirmId: firmId, name: 'Base', isPreferred: true, sortOrder: 0 } },
      },
      include: { scenarios: true },
    })
    await prisma.pricingWorkspace.update({ where: { id: workspace.id }, data: { preferredScenarioId: workspace.scenarios[0].id } })
    await audit(req, firmId, 'CREATE', 'PricingWorkspace', workspace.id, `Pricing created: ${title}`)
    res.status(201).json({ success: true, data: { workspace } })
  } catch (err) { next(err) }
})

router.get('/opportunity/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId: firmId }, select: { id: true } })
    if (!opp) throw new NotFoundError('Opportunity')
    const workspace = await prisma.pricingWorkspace.findFirst({
      where: { consultingFirmId: firmId, opportunityId: opp.id, isArchived: false, status: { in: ACTIVE_STATUSES } },
      include: { scenarios: { where: { isArchived: false }, orderBy: { sortOrder: 'asc' }, include: scenarioInclude() } },
    })
    const versions = await prisma.pricingWorkspace.findMany({ where: { consultingFirmId: firmId, opportunityId: opp.id }, orderBy: { version: 'desc' }, select: { id: true, version: true, status: true, title: true, isArchived: true, approvedAt: true, createdAt: true } })
    if (!workspace) return res.json({ success: true, data: { exists: false, versions } })
    const admin = isAdmin(req)
    const scenarios = workspace.scenarios.map((s) => redactScenario(s as unknown as Record<string, unknown>, admin))
    res.json({ success: true, data: { exists: true, workspace: { ...workspace, scenarios }, versions } })
  } catch (err) { next(err) }
})

router.get('/:workspaceId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const workspace = await prisma.pricingWorkspace.findFirst({ where: { id: req.params.workspaceId, consultingFirmId: firmId }, include: { scenarios: { where: { isArchived: false }, orderBy: { sortOrder: 'asc' }, include: scenarioInclude() } } })
    if (!workspace) throw new NotFoundError('Pricing workspace')
    const admin = isAdmin(req)
    const scenarios = workspace.scenarios.map((s) => redactScenario(s as unknown as Record<string, unknown>, admin))
    res.json({ success: true, data: { workspace: { ...workspace, scenarios } } })
  } catch (err) { next(err) }
})

// New version: copy an APPROVED (or any) workspace into a fresh DRAFT, mark the
// source SUPERSEDED. Prior versions are preserved.
router.post('/:workspaceId/version', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const src = await prisma.pricingWorkspace.findFirst({ where: { id: req.params.workspaceId, consultingFirmId: firmId }, include: { scenarios: { include: scenarioInclude() } } })
    if (!src) throw new NotFoundError('Pricing workspace')
    const activeDupe = await prisma.pricingWorkspace.findFirst({ where: { consultingFirmId: firmId, opportunityId: src.opportunityId, isArchived: false, status: { in: ['DRAFT', 'IN_REVIEW'] } }, select: { id: true } })
    if (activeDupe) throw new ConflictError('An editable pricing version already exists for this opportunity.')
    const maxV = await prisma.pricingWorkspace.aggregate({ where: { consultingFirmId: firmId, opportunityId: src.opportunityId }, _max: { version: true } })
    const created = await prisma.$transaction(async (tx) => {
      const w = await tx.pricingWorkspace.create({ data: { consultingFirmId: firmId, opportunityId: src.opportunityId, proposalId: src.proposalId, clientCompanyId: src.clientCompanyId, title: src.title, contractType: src.contractType, ownerUserId: req.user?.userId ?? null, createdByUserId: req.user?.userId ?? null, version: (maxV._max.version ?? 0) + 1, supersedesWorkspaceId: src.id, status: 'DRAFT' } })
      for (const sc of src.scenarios) {
        const ns = await tx.pricingScenario.create({ data: { consultingFirmId: firmId, workspaceId: w.id, name: sc.name, description: sc.description, isPreferred: sc.isPreferred, sortOrder: sc.sortOrder } })
        if (sc.isPreferred) await tx.pricingWorkspace.update({ where: { id: w.id }, data: { preferredScenarioId: ns.id } })
        for (const l of sc.laborLines) await tx.pricingLaborLine.create({ data: { consultingFirmId: firmId, scenarioId: ns.id, categoryName: l.categoryName, categoryCode: l.categoryCode, description: l.description, personnelCount: l.personnelCount, hours: l.hours, baseRate: l.baseRate, periodLabel: l.periodLabel, escalationPct: l.escalationPct, directLaborAmount: l.directLaborAmount, notes: l.notes, sortOrder: l.sortOrder, isActive: l.isActive } })
        for (const r of sc.indirectRates) await tx.pricingIndirectRate.create({ data: { consultingFirmId: firmId, scenarioId: ns.id, name: r.name, rateType: r.rateType, percent: r.percent, costBase: r.costBase, description: r.description, effectiveDate: r.effectiveDate, endDate: r.endDate, source: r.source, isActive: r.isActive, sortOrder: r.sortOrder } })
        for (const o of sc.otherCosts) await tx.pricingOtherCost.create({ data: { consultingFirmId: firmId, scenarioId: ns.id, costCategory: o.costCategory, description: o.description, quantity: o.quantity, unit: o.unit, unitCost: o.unitCost, totalAmount: o.totalAmount, vendorName: o.vendorName, partnerId: o.partnerId, teamingArrangementId: o.teamingArrangementId, notes: o.notes, sortOrder: o.sortOrder } })
      }
      await tx.pricingWorkspace.update({ where: { id: src.id }, data: { status: 'SUPERSEDED' } })
      await tx.pricingReview.create({ data: { consultingFirmId: firmId, workspaceId: w.id, action: 'VERSIONED', toStatus: 'DRAFT', actorUserId: req.user?.userId ?? null, comment: `Versioned from v${src.version}` } })
      return w
    })
    await recomputeScenariosForWorkspace(created.id)
    await audit(req, firmId, 'CREATE', 'PricingWorkspace', created.id, `New pricing version v${created.version} from v${src.version}`)
    res.status(201).json({ success: true, data: { workspace: created } })
  } catch (err) { next(err) }
})

async function recomputeScenariosForWorkspace(workspaceId: string) {
  const scs = await prisma.pricingScenario.findMany({ where: { workspaceId }, select: { id: true } })
  for (const s of scs) await recomputeScenario(s.id)
}

// PATCH /:workspaceId — rename (ADMIN). Delete is never permitted for pricing.
router.patch('/:workspaceId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const w = await loadWorkspace(firmId, req.params.workspaceId)
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 300) : ''
    if (!title) throw new ValidationError('A pricing title is required')
    const updated = await prisma.pricingWorkspace.update({ where: { id: w.id }, data: { title } })
    await audit(req, firmId, 'UPDATE', 'PricingWorkspace', w.id, 'Pricing renamed', { title: w.title }, { title })
    res.json({ success: true, data: { workspace: updated } })
  } catch (err) { next(err) }
})

router.post('/:workspaceId/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const w = await loadWorkspace(firmId, req.params.workspaceId)
    const updated = await prisma.pricingWorkspace.update({ where: { id: w.id }, data: { isArchived: true, status: 'ARCHIVED' } })
    await audit(req, firmId, 'ARCHIVED', 'PricingWorkspace', w.id, 'Pricing archived', { status: w.status }, { status: 'ARCHIVED' })
    res.json({ success: true, data: { workspace: updated } })
  } catch (err) { next(err) }
})

// POST /:workspaceId/restore — reactivate an archived workspace to DRAFT (ADMIN).
// Blocked if another active workspace already exists for the opportunity.
router.post('/:workspaceId/restore', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const w = await loadWorkspace(firmId, req.params.workspaceId)
    const active = await prisma.pricingWorkspace.findFirst({ where: { consultingFirmId: firmId, opportunityId: w.opportunityId, isArchived: false, status: { in: ACTIVE_STATUSES }, id: { not: w.id } }, select: { id: true } })
    if (active) throw new ConflictError('An active pricing workspace already exists for this opportunity — archive it before restoring this one.')
    const updated = await prisma.pricingWorkspace.update({ where: { id: w.id }, data: { isArchived: false, status: 'DRAFT' } })
    await audit(req, firmId, 'RESTORED', 'PricingWorkspace', w.id, 'Pricing restored', { status: w.status }, { status: 'DRAFT' })
    res.json({ success: true, data: { workspace: updated } })
  } catch (err) { next(err) }
})

// Review workflow
async function transitionWorkspace(req: AuthenticatedRequest, res: Response, id: string, opts: { action: string; from: string[]; to: string; audit: 'APPROVAL' | 'REJECTION' | 'UPDATE'; commentRequired?: boolean }) {
  const firmId = getTenantId(req)
  const w = await loadWorkspace(firmId, id)
  if (!opts.from.includes(w.status)) throw new ConflictError(`Cannot ${opts.action} pricing in status ${w.status}`)
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : ''
  if (opts.commentRequired && !comment) throw new ValidationError('A reason is required')
  if (opts.to === 'IN_REVIEW' && !w.preferredScenarioId) throw new ValidationError('Select a preferred scenario before submitting for review')
  const data: Prisma.PricingWorkspaceUpdateInput = { status: opts.to }
  if (opts.to === 'APPROVED') { data.approvedAt = new Date(); data.approvedByUserId = req.user?.userId ?? null }
  const updated = await prisma.pricingWorkspace.update({ where: { id: w.id }, data })
  await prisma.pricingReview.create({ data: { consultingFirmId: firmId, workspaceId: w.id, action: opts.action, fromStatus: w.status, toStatus: opts.to, scenarioId: w.preferredScenarioId, actorUserId: req.user?.userId ?? null, comment: comment || null } })
  await audit(req, firmId, opts.audit, 'PricingWorkspace', w.id, `Pricing ${opts.action} → ${opts.to}${comment ? `: ${comment}` : ''}`, { status: w.status }, { status: opts.to })
  res.json({ success: true, data: { workspace: updated } })
}
router.post('/:workspaceId/submit', requireRole('ADMIN'), (req, res, next) => transitionWorkspace(req, res, req.params.workspaceId, { action: 'submitted', from: ['DRAFT'], to: 'IN_REVIEW', audit: 'UPDATE' }).catch(next))
router.post('/:workspaceId/approve', requireRole('ADMIN'), (req, res, next) => transitionWorkspace(req, res, req.params.workspaceId, { action: 'approved', from: ['IN_REVIEW'], to: 'APPROVED', audit: 'APPROVAL' }).catch(next))
router.post('/:workspaceId/reject', requireRole('ADMIN'), (req, res, next) => transitionWorkspace(req, res, req.params.workspaceId, { action: 'rejected', from: ['IN_REVIEW'], to: 'REJECTED', audit: 'REJECTION', commentRequired: true }).catch(next))
router.post('/:workspaceId/request-changes', requireRole('ADMIN'), (req, res, next) => transitionWorkspace(req, res, req.params.workspaceId, { action: 'changes requested', from: ['IN_REVIEW'], to: 'DRAFT', audit: 'UPDATE', commentRequired: true }).catch(next))

router.get('/:workspaceId/reviews', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    await loadWorkspace(firmId, req.params.workspaceId)
    const reviews = await prisma.pricingReview.findMany({ where: { consultingFirmId: firmId, workspaceId: req.params.workspaceId }, orderBy: { createdAt: 'desc' } })
    res.json({ success: true, data: { reviews } })
  } catch (err) { next(err) }
})

router.get('/:workspaceId/compare', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const w = await loadWorkspace(firmId, req.params.workspaceId)
    const scenarios = await prisma.pricingScenario.findMany({ where: { workspaceId: w.id, isArchived: false }, orderBy: { sortOrder: 'asc' } })
    const admin = isAdmin(req)
    const rows = scenarios.map((s) => admin
      ? { id: s.id, name: s.name, isPreferred: s.isPreferred, totalDirectLabor: s.totalDirectLabor, totalFringe: s.totalFringe, totalOverhead: s.totalOverhead, totalOdc: s.totalOdc, totalSubcontractor: s.totalSubcontractor, totalGA: s.totalGA, subtotalBeforeFee: s.subtotalBeforeFee, totalFee: s.totalFee, totalPrice: s.totalPrice }
      : { id: s.id, name: s.name, isPreferred: s.isPreferred, totalPrice: s.totalPrice, sensitiveRedacted: true })
    res.json({ success: true, data: { scenarios: rows, preferredScenarioId: w.preferredScenarioId } })
  } catch (err) { next(err) }
})

// =============================================================
// SCENARIOS
// =============================================================
router.post('/:workspaceId/scenarios', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const w = await loadWorkspace(firmId, req.params.workspaceId)
    assertEditable(w.status)
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 120) : null
    if (!name) throw new ValidationError('A scenario name is required')
    const max = await prisma.pricingScenario.aggregate({ where: { workspaceId: w.id }, _max: { sortOrder: true } })
    const scenario = await prisma.pricingScenario.create({ data: { consultingFirmId: firmId, workspaceId: w.id, name, description: typeof req.body?.description === 'string' ? req.body.description : null, sortOrder: (max._max.sortOrder ?? -1) + 1 } })
    await audit(req, firmId, 'CREATE', 'PricingScenario', scenario.id, `Scenario added: ${name}`)
    res.status(201).json({ success: true, data: { scenario } })
  } catch (err) { next(err) }
})

router.post('/scenarios/:scenarioId/duplicate', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const src = await loadScenario(firmId, req.params.scenarioId)
    assertEditable(src.workspace.status)
    const [labor, indirects, others] = await Promise.all([
      prisma.pricingLaborLine.findMany({ where: { scenarioId: src.id } }),
      prisma.pricingIndirectRate.findMany({ where: { scenarioId: src.id } }),
      prisma.pricingOtherCost.findMany({ where: { scenarioId: src.id } }),
    ])
    const max = await prisma.pricingScenario.aggregate({ where: { workspaceId: src.workspaceId }, _max: { sortOrder: true } })
    const ns = await prisma.pricingScenario.create({ data: { consultingFirmId: firmId, workspaceId: src.workspaceId, name: `${src.name} (copy)`, description: src.description, sortOrder: (max._max.sortOrder ?? -1) + 1 } })
    await prisma.$transaction([
      ...labor.map((l) => prisma.pricingLaborLine.create({ data: { consultingFirmId: firmId, scenarioId: ns.id, categoryName: l.categoryName, categoryCode: l.categoryCode, description: l.description, personnelCount: l.personnelCount, hours: l.hours, baseRate: l.baseRate, periodLabel: l.periodLabel, escalationPct: l.escalationPct, directLaborAmount: l.directLaborAmount, notes: l.notes, sortOrder: l.sortOrder, isActive: l.isActive } })),
      ...indirects.map((r) => prisma.pricingIndirectRate.create({ data: { consultingFirmId: firmId, scenarioId: ns.id, name: r.name, rateType: r.rateType, percent: r.percent, costBase: r.costBase, description: r.description, effectiveDate: r.effectiveDate, endDate: r.endDate, source: r.source, isActive: r.isActive, sortOrder: r.sortOrder } })),
      ...others.map((o) => prisma.pricingOtherCost.create({ data: { consultingFirmId: firmId, scenarioId: ns.id, costCategory: o.costCategory, description: o.description, quantity: o.quantity, unit: o.unit, unitCost: o.unitCost, totalAmount: o.totalAmount, vendorName: o.vendorName, partnerId: o.partnerId, teamingArrangementId: o.teamingArrangementId, notes: o.notes, sortOrder: o.sortOrder } })),
    ])
    await recomputeScenario(ns.id)
    await audit(req, firmId, 'CREATE', 'PricingScenario', ns.id, `Scenario duplicated from ${src.name}`)
    res.status(201).json({ success: true, data: { scenario: await prisma.pricingScenario.findUnique({ where: { id: ns.id } }) } })
  } catch (err) { next(err) }
})

router.patch('/scenarios/:scenarioId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadScenario(firmId, req.params.scenarioId)
    assertEditable(s.workspace.status)
    const data: Prisma.PricingScenarioUpdateInput = {}
    if (typeof req.body?.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim().slice(0, 120)
    if ('description' in (req.body ?? {})) data.description = req.body.description ?? null
    const updated = await prisma.pricingScenario.update({ where: { id: s.id }, data })
    await audit(req, firmId, 'UPDATE', 'PricingScenario', s.id, 'Scenario updated')
    res.json({ success: true, data: { scenario: updated } })
  } catch (err) { next(err) }
})

router.post('/:workspaceId/scenarios/:scenarioId/select', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const w = await loadWorkspace(firmId, req.params.workspaceId)
    const s = await loadScenario(firmId, req.params.scenarioId)
    if (s.workspaceId !== w.id) throw new ValidationError('Scenario does not belong to this workspace')
    await prisma.$transaction([
      prisma.pricingScenario.updateMany({ where: { workspaceId: w.id }, data: { isPreferred: false } }),
      prisma.pricingScenario.update({ where: { id: s.id }, data: { isPreferred: true } }),
      prisma.pricingWorkspace.update({ where: { id: w.id }, data: { preferredScenarioId: s.id } }),
      prisma.pricingReview.create({ data: { consultingFirmId: firmId, workspaceId: w.id, action: 'SCENARIO_SELECTED', scenarioId: s.id, actorUserId: req.user?.userId ?? null, comment: `Preferred: ${s.name}` } }),
    ])
    await audit(req, firmId, 'UPDATE', 'PricingWorkspace', w.id, `Preferred scenario set: ${s.name}`)
    res.json({ success: true, data: { preferredScenarioId: s.id } })
  } catch (err) { next(err) }
})

router.delete('/scenarios/:scenarioId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadScenario(firmId, req.params.scenarioId)
    assertEditable(s.workspace.status)
    if (s.sortOrder === 0 || s.name === 'Base') throw new ConflictError('The Base scenario cannot be deleted.')
    if (s.isPreferred) throw new ConflictError('Cannot archive the preferred scenario. Select another first.')
    await prisma.pricingScenario.update({ where: { id: s.id }, data: { isArchived: true } })
    await audit(req, firmId, 'ARCHIVED', 'PricingScenario', s.id, 'Scenario archived')
    res.json({ success: true, data: { archived: true } })
  } catch (err) { next(err) }
})

// POST /scenarios/:scenarioId/restore — un-archive a scenario (ADMIN).
router.post('/scenarios/:scenarioId/restore', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadScenario(firmId, req.params.scenarioId)
    assertEditable(s.workspace.status)
    await prisma.pricingScenario.update({ where: { id: s.id }, data: { isArchived: false } })
    await audit(req, firmId, 'RESTORED', 'PricingScenario', s.id, 'Scenario restored')
    res.json({ success: true, data: { restored: true } })
  } catch (err) { next(err) }
})

// =============================================================
// LINES (labour / indirect / other) — recompute snapshot after every mutation
// =============================================================
const LaborSchema = z.object({
  categoryName: z.string().trim().min(1).max(200),
  categoryCode: z.string().trim().max(60).nullish(),
  description: z.string().max(2000).nullish(),
  personnelCount: z.number().int().min(0).max(100000).nullish(),
  hours: z.number().min(0).max(100_000_000),
  baseRate: z.number().min(0).max(100_000),
  periodLabel: z.string().max(60).nullish(),
  escalationPct: z.number().min(0).max(1000).nullish(),
  notes: z.string().max(2000).nullish(),
})

async function afterLineChange(scenarioId: string) { return recomputeScenario(scenarioId) }

router.post('/scenarios/:scenarioId/labor', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadScenario(firmId, req.params.scenarioId)
    assertEditable(s.workspace.status)
    const p = LaborSchema.safeParse(req.body ?? {})
    if (!p.success) throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid labour line')
    const d = p.data
    const max = await prisma.pricingLaborLine.aggregate({ where: { scenarioId: s.id }, _max: { sortOrder: true } })
    const directLaborAmount = new Prisma.Decimal(d.hours).times(d.baseRate).times(new Prisma.Decimal(d.escalationPct ?? 0).div(100).plus(1)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    const line = await prisma.pricingLaborLine.create({ data: { consultingFirmId: firmId, scenarioId: s.id, categoryName: d.categoryName, categoryCode: d.categoryCode ?? null, description: d.description ?? null, personnelCount: d.personnelCount ?? null, hours: d.hours, baseRate: d.baseRate, periodLabel: d.periodLabel ?? null, escalationPct: d.escalationPct ?? 0, directLaborAmount, notes: d.notes ?? null, sortOrder: (max._max.sortOrder ?? -1) + 1 } })
    const totals = await afterLineChange(s.id)
    await audit(req, firmId, 'CREATE', 'PricingLaborLine', line.id, `Labour line: ${d.categoryName}`)
    res.status(201).json({ success: true, data: { line, totals } })
  } catch (err) { next(err) }
})

router.patch('/labor/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await prisma.pricingLaborLine.findFirst({ where: { id: req.params.id, consultingFirmId: firmId }, include: { scenario: { include: { workspace: true } } } })
    if (!existing) throw new NotFoundError('Labour line')
    assertEditable(existing.scenario.workspace.status)
    const p = LaborSchema.partial().safeParse(req.body ?? {})
    if (!p.success) throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid update')
    const merged = { hours: Number(existing.hours), baseRate: Number(existing.baseRate), escalationPct: Number(existing.escalationPct), ...p.data }
    const directLaborAmount = new Prisma.Decimal(merged.hours).times(merged.baseRate).times(new Prisma.Decimal(merged.escalationPct ?? 0).div(100).plus(1)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    const data: Record<string, unknown> = { directLaborAmount }
    for (const k of ['categoryName', 'categoryCode', 'description', 'personnelCount', 'hours', 'baseRate', 'periodLabel', 'escalationPct', 'notes', 'isActive'] as const) if (k in (req.body ?? {})) data[k] = (req.body as Record<string, unknown>)[k]
    const line = await prisma.pricingLaborLine.update({ where: { id: existing.id }, data })
    const totals = await afterLineChange(existing.scenarioId)
    await audit(req, firmId, 'UPDATE', 'PricingLaborLine', line.id, 'Labour line updated')
    res.json({ success: true, data: { line, totals } })
  } catch (err) { next(err) }
})

router.delete('/labor/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await prisma.pricingLaborLine.findFirst({ where: { id: req.params.id, consultingFirmId: firmId }, include: { scenario: { include: { workspace: true } } } })
    if (!existing) throw new NotFoundError('Labour line')
    assertEditable(existing.scenario.workspace.status)
    await prisma.pricingLaborLine.delete({ where: { id: existing.id } })
    const totals = await afterLineChange(existing.scenarioId)
    await audit(req, firmId, 'DELETE', 'PricingLaborLine', existing.id, 'Labour line deleted')
    res.json({ success: true, data: { deleted: true, totals } })
  } catch (err) { next(err) }
})

const IndirectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  rateType: z.enum(RATE_TYPES),
  percent: z.number().min(0).max(1000),
  costBase: z.enum(COST_BASES),
  description: z.string().max(2000).nullish(),
  effectiveDate: z.string().datetime().nullish(),
  endDate: z.string().datetime().nullish(),
})

router.post('/scenarios/:scenarioId/indirect', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadScenario(firmId, req.params.scenarioId)
    assertEditable(s.workspace.status)
    const p = IndirectSchema.safeParse(req.body ?? {})
    if (!p.success) throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid indirect rate')
    const d = p.data
    if (d.rateType !== 'FEE' && !validateRateBase(d.rateType, d.costBase)) throw new ValidationError(`Cost base ${d.costBase} is not valid for a ${d.rateType} rate (would be circular).`)
    const max = await prisma.pricingIndirectRate.aggregate({ where: { scenarioId: s.id }, _max: { sortOrder: true } })
    const rate = await prisma.pricingIndirectRate.create({ data: { consultingFirmId: firmId, scenarioId: s.id, name: d.name, rateType: d.rateType, percent: d.percent, costBase: d.costBase, description: d.description ?? null, effectiveDate: d.effectiveDate ? new Date(d.effectiveDate) : null, endDate: d.endDate ? new Date(d.endDate) : null, sortOrder: (max._max.sortOrder ?? -1) + 1 } })
    const totals = await afterLineChange(s.id)
    await audit(req, firmId, 'CREATE', 'PricingIndirectRate', rate.id, `Indirect rate: ${d.name} ${d.percent}%`)
    res.status(201).json({ success: true, data: { rate, totals } })
  } catch (err) { next(err) }
})

router.patch('/indirect/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await prisma.pricingIndirectRate.findFirst({ where: { id: req.params.id, consultingFirmId: firmId }, include: { scenario: { include: { workspace: true } } } })
    if (!existing) throw new NotFoundError('Indirect rate')
    assertEditable(existing.scenario.workspace.status)
    const nextType = typeof req.body?.rateType === 'string' ? req.body.rateType : existing.rateType
    const nextBase = typeof req.body?.costBase === 'string' ? req.body.costBase : existing.costBase
    if (nextType !== 'FEE' && !validateRateBase(nextType, nextBase)) throw new ValidationError(`Cost base ${nextBase} is not valid for a ${nextType} rate (would be circular).`)
    const data: Record<string, unknown> = {}
    for (const k of ['name', 'rateType', 'percent', 'costBase', 'description', 'isActive'] as const) if (k in (req.body ?? {})) data[k] = (req.body as Record<string, unknown>)[k]
    const rate = await prisma.pricingIndirectRate.update({ where: { id: existing.id }, data })
    const totals = await afterLineChange(existing.scenarioId)
    await audit(req, firmId, 'UPDATE', 'PricingIndirectRate', rate.id, 'Indirect rate updated')
    res.json({ success: true, data: { rate, totals } })
  } catch (err) { next(err) }
})

router.delete('/indirect/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await prisma.pricingIndirectRate.findFirst({ where: { id: req.params.id, consultingFirmId: firmId }, include: { scenario: { include: { workspace: true } } } })
    if (!existing) throw new NotFoundError('Indirect rate')
    assertEditable(existing.scenario.workspace.status)
    await prisma.pricingIndirectRate.delete({ where: { id: existing.id } })
    const totals = await afterLineChange(existing.scenarioId)
    await audit(req, firmId, 'DELETE', 'PricingIndirectRate', existing.id, 'Indirect rate deleted')
    res.json({ success: true, data: { deleted: true, totals } })
  } catch (err) { next(err) }
})

const OtherCostSchema = z.object({
  costCategory: z.enum(OTHER_COST_CATEGORIES),
  description: z.string().trim().min(1).max(500),
  quantity: z.number().min(0).max(100_000_000),
  unit: z.string().max(40).nullish(),
  unitCost: z.number().min(0).max(100_000_000),
  vendorName: z.string().max(200).nullish(),
  partnerId: z.string().max(60).nullish(),
  teamingArrangementId: z.string().max(60).nullish(),
  notes: z.string().max(2000).nullish(),
})

router.post('/scenarios/:scenarioId/other', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadScenario(firmId, req.params.scenarioId)
    assertEditable(s.workspace.status)
    const p = OtherCostSchema.safeParse(req.body ?? {})
    if (!p.success) throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid cost line')
    const d = p.data
    if (d.partnerId) { const partner = await prisma.partner.findFirst({ where: { id: d.partnerId, consultingFirmId: firmId }, select: { id: true } }); if (!partner) throw new ValidationError('partnerId does not belong to your firm') }
    const totalAmount = new Prisma.Decimal(d.quantity).times(d.unitCost).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    const max = await prisma.pricingOtherCost.aggregate({ where: { scenarioId: s.id }, _max: { sortOrder: true } })
    const line = await prisma.pricingOtherCost.create({ data: { consultingFirmId: firmId, scenarioId: s.id, costCategory: d.costCategory, description: d.description, quantity: d.quantity, unit: d.unit ?? null, unitCost: d.unitCost, totalAmount, vendorName: d.vendorName ?? null, partnerId: d.partnerId ?? null, teamingArrangementId: d.teamingArrangementId ?? null, notes: d.notes ?? null, sortOrder: (max._max.sortOrder ?? -1) + 1 } })
    const totals = await afterLineChange(s.id)
    await audit(req, firmId, 'CREATE', 'PricingOtherCost', line.id, `Cost line: ${d.costCategory} ${d.description}`)
    res.status(201).json({ success: true, data: { line, totals } })
  } catch (err) { next(err) }
})

router.patch('/other/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await prisma.pricingOtherCost.findFirst({ where: { id: req.params.id, consultingFirmId: firmId }, include: { scenario: { include: { workspace: true } } } })
    if (!existing) throw new NotFoundError('Cost line')
    assertEditable(existing.scenario.workspace.status)
    const qty = typeof req.body?.quantity === 'number' ? req.body.quantity : Number(existing.quantity)
    const unitCost = typeof req.body?.unitCost === 'number' ? req.body.unitCost : Number(existing.unitCost)
    if (qty < 0 || unitCost < 0) throw new ValidationError('quantity and unitCost must be non-negative')
    const totalAmount = new Prisma.Decimal(qty).times(unitCost).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    const data: Record<string, unknown> = { totalAmount }
    for (const k of ['costCategory', 'description', 'quantity', 'unit', 'unitCost', 'vendorName', 'notes'] as const) if (k in (req.body ?? {})) data[k] = (req.body as Record<string, unknown>)[k]
    const line = await prisma.pricingOtherCost.update({ where: { id: existing.id }, data })
    const totals = await afterLineChange(existing.scenarioId)
    await audit(req, firmId, 'UPDATE', 'PricingOtherCost', line.id, 'Cost line updated')
    res.json({ success: true, data: { line, totals } })
  } catch (err) { next(err) }
})

router.delete('/other/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await prisma.pricingOtherCost.findFirst({ where: { id: req.params.id, consultingFirmId: firmId }, include: { scenario: { include: { workspace: true } } } })
    if (!existing) throw new NotFoundError('Cost line')
    assertEditable(existing.scenario.workspace.status)
    await prisma.pricingOtherCost.delete({ where: { id: existing.id } })
    const totals = await afterLineChange(existing.scenarioId)
    await audit(req, firmId, 'DELETE', 'PricingOtherCost', existing.id, 'Cost line deleted')
    res.json({ success: true, data: { deleted: true, totals } })
  } catch (err) { next(err) }
})

// =============================================================
// TEMPLATES (firm-level, sensitive → ADMIN only)
// =============================================================
router.get('/templates', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const templates = await prisma.pricingTemplate.findMany({ where: { consultingFirmId: firmId, isArchived: req.query.includeArchived === 'true' ? undefined : false }, orderBy: { updatedAt: 'desc' } })
    res.json({ success: true, data: { templates } })
  } catch (err) { next(err) }
})

router.post('/templates', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 200) : null
    if (!name) throw new ValidationError('A template name is required')
    const template = await prisma.pricingTemplate.create({ data: { consultingFirmId: firmId, name, description: typeof req.body?.description === 'string' ? req.body.description : null, laborLinesJson: req.body?.laborLinesJson ?? Prisma.JsonNull, indirectRatesJson: req.body?.indirectRatesJson ?? Prisma.JsonNull, feeDefaultPct: typeof req.body?.feeDefaultPct === 'number' ? req.body.feeDefaultPct : null, escalationDefaultPct: typeof req.body?.escalationDefaultPct === 'number' ? req.body.escalationDefaultPct : null, createdByUserId: req.user?.userId ?? null } })
    await audit(req, firmId, 'CREATE', 'PricingTemplate', template.id, `Template created: ${name}`)
    res.status(201).json({ success: true, data: { template } })
  } catch (err) { next(err) }
})

router.patch('/templates/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await prisma.pricingTemplate.findFirst({ where: { id: req.params.id, consultingFirmId: firmId } })
    if (!existing) throw new NotFoundError('Pricing template')
    const data: Record<string, unknown> = {}
    for (const k of ['name', 'description', 'laborLinesJson', 'indirectRatesJson', 'feeDefaultPct', 'escalationDefaultPct', 'isActive'] as const) if (k in (req.body ?? {})) data[k] = (req.body as Record<string, unknown>)[k]

    // §7.6 — the template is the canonical reusable rate source, so
    // INDIRECT_RATE_CHANGED is emitted from here, once per logical rate update,
    // inside the same transaction as the write. Editing a template NEVER
    // rewrites a scenario's human-entered rates; the agent reports drift and a
    // person decides whether to adopt the new rate.
    const beforeHash = templateRateFingerprint(existing.indirectRatesJson, existing.feeDefaultPct)
    const template = await prisma.$transaction(async (tx) => {
      const updated = await tx.pricingTemplate.update({ where: { id: existing.id }, data })
      const afterHash = templateRateFingerprint(updated.indirectRatesJson, updated.feeDefaultPct)
      if (afterHash !== beforeHash) {
        await emitIndirectRateChanged(
          { consultingFirmId: firmId, templateId: updated.id, rateSetHash: createHash('sha256').update(afterHash).digest('hex') },
          tx,
        )
      }
      return updated
    })
    await audit(req, firmId, 'UPDATE', 'PricingTemplate', template.id, 'Template updated')
    res.json({ success: true, data: { template } })
  } catch (err) { next(err) }
})

router.post('/templates/:id/duplicate', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const src = await prisma.pricingTemplate.findFirst({ where: { id: req.params.id, consultingFirmId: firmId } })
    if (!src) throw new NotFoundError('Pricing template')
    const template = await prisma.pricingTemplate.create({ data: { consultingFirmId: firmId, name: `${src.name} (copy)`, description: src.description, laborLinesJson: src.laborLinesJson ?? Prisma.JsonNull, indirectRatesJson: src.indirectRatesJson ?? Prisma.JsonNull, feeDefaultPct: src.feeDefaultPct, escalationDefaultPct: src.escalationDefaultPct, version: src.version + 1, createdByUserId: req.user?.userId ?? null } })
    await audit(req, firmId, 'CREATE', 'PricingTemplate', template.id, `Template duplicated from ${src.name}`)
    res.status(201).json({ success: true, data: { template } })
  } catch (err) { next(err) }
})

router.post('/templates/:id/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const existing = await prisma.pricingTemplate.findFirst({ where: { id: req.params.id, consultingFirmId: firmId } })
    if (!existing) throw new NotFoundError('Pricing template')
    await prisma.pricingTemplate.update({ where: { id: existing.id }, data: { isArchived: true, isActive: false } })
    await audit(req, firmId, 'UPDATE', 'PricingTemplate', existing.id, 'Template archived')
    res.json({ success: true, data: { archived: true } })
  } catch (err) { next(err) }
})

// Apply a template into a scenario — SNAPSHOT copy (later template edits never
// change this scenario's numbers).
router.post('/scenarios/:scenarioId/apply-template/:templateId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadScenario(firmId, req.params.scenarioId)
    assertEditable(s.workspace.status)
    const tpl = await prisma.pricingTemplate.findFirst({ where: { id: req.params.templateId, consultingFirmId: firmId } })
    if (!tpl) throw new NotFoundError('Pricing template')
    const laborRows = Array.isArray(tpl.laborLinesJson) ? (tpl.laborLinesJson as unknown[]) : []
    const rateRows = Array.isArray(tpl.indirectRatesJson) ? (tpl.indirectRatesJson as unknown[]) : []
    let order = (await prisma.pricingLaborLine.aggregate({ where: { scenarioId: s.id }, _max: { sortOrder: true } }))._max.sortOrder ?? -1
    let rorder = (await prisma.pricingIndirectRate.aggregate({ where: { scenarioId: s.id }, _max: { sortOrder: true } }))._max.sortOrder ?? -1
    for (const raw of laborRows) {
      const r = raw as Record<string, unknown>
      const hours = Number(r.hours ?? 0), baseRate = Number(r.baseRate ?? 0), esc = Number(r.escalationPct ?? tpl.escalationDefaultPct ?? 0)
      if (typeof r.categoryName !== 'string' || !r.categoryName.trim()) continue
      const directLaborAmount = new Prisma.Decimal(hours).times(baseRate).times(new Prisma.Decimal(esc).div(100).plus(1)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      await prisma.pricingLaborLine.create({ data: { consultingFirmId: firmId, scenarioId: s.id, categoryName: r.categoryName.slice(0, 200), categoryCode: typeof r.categoryCode === 'string' ? r.categoryCode : null, hours, baseRate, escalationPct: esc, directLaborAmount, sortOrder: ++order } })
    }
    for (const raw of rateRows) {
      const r = raw as Record<string, unknown>
      if (typeof r.name !== 'string' || typeof r.rateType !== 'string' || typeof r.costBase !== 'string') continue
      if (r.rateType !== 'FEE' && !validateRateBase(r.rateType, r.costBase)) continue
      await prisma.pricingIndirectRate.create({ data: { consultingFirmId: firmId, scenarioId: s.id, name: r.name.slice(0, 120), rateType: r.rateType, percent: Number(r.percent ?? 0), costBase: r.costBase, source: tpl.name, sortOrder: ++rorder } })
    }
    const totals = await afterLineChange(s.id)
    await audit(req, firmId, 'UPDATE', 'PricingScenario', s.id, `Applied template ${tpl.name} (snapshot)`)
    res.status(201).json({ success: true, data: { totals, appliedLabor: laborRows.length, appliedRates: rateRows.length } })
  } catch (err) { next(err) }
})

// =============================================================
// COMPETITIVE BENCHMARK (honest — from existing award enrichment only)
// =============================================================
router.get('/opportunity/:opportunityId/benchmark', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId: firmId }, select: { id: true, agency: true, naicsCode: true, historicalAwardCount: true, historicalAvgAward: true, competitionCount: true, estimatedValue: true } })
    if (!opp) throw new NotFoundError('Opportunity')
    const count = opp.historicalAwardCount ?? 0
    if (!count || count < 1 || opp.historicalAvgAward == null) {
      return res.json({ success: true, data: { available: false, message: 'No reliable benchmark available for this opportunity. Award-history enrichment is insufficient.', basis: 'AWARD_VALUE', source: 'USAspending enrichment (Opportunity)' } })
    }
    res.json({
      success: true,
      data: {
        available: true,
        basis: 'AWARD_VALUE', // award-value comparison — NOT labour-rate comparison
        comparableAwardCount: count,
        averageAwardValue: opp.historicalAvgAward,
        agency: opp.agency, naicsCode: opp.naicsCode,
        competitionCount: opp.competitionCount ?? null,
        estimatedValue: opp.estimatedValue ?? null,
        source: 'USAspending award-history enrichment (Opportunity)',
        limitations: 'Award-value totals only — does not reflect labour rates, wrap, or cost build-up. Not a guarantee of award.',
      },
    })
  } catch (err) { next(err) }
})

export default router
