// =============================================================
// Teaming Partner CRM + Graph  (FIX-2 — the ownable moat)
//
// Activates the previously-dormant Partner + TeamingArrangement
// models. Unlike scraped USAspending/SAM data (which every competitor
// can buy), this captures each firm's *real* teaming activity — which
// partners they team with, in what role, on which opportunities, at
// which agencies, and with what outcome. That relationship graph is
// proprietary, compounds per customer, and is exactly what public
// award data cannot give (see FIXES.md FIX-2).
//
// All routes tenant-scoped. Reads open to any member; writes ADMIN-only,
// mirroring clients.ts. Cross-tenant access is impossible: every query
// is filtered by consultingFirmId and every partner/opportunity
// reference is re-validated against the tenant before use.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { Prisma, PartnerType, TeamingStatus, AgreementStatus } from '@prisma/client'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { ValidationError, NotFoundError, ConflictError } from '../utils/errors'
import { assertFresh } from '../utils/optimisticLock'
import { logAudit, AuditAction } from '../services/auditService'
import { notifyUser } from '../services/notificationService'
import { upload } from '../middleware/upload'
import { matchPartnerToOpportunity, MatchPriorContext } from '../services/partnerMatch'
import { buildAgreementDraft } from '../services/teamingAgreementDraft'
import { emitPartnerAdded } from '../services/agents/teaming/teamingEvents'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('teaming_suite'))

// PRIME/SUB/BOTH are the current roles; JV_MEMBER/MENTOR_PROTEGE retained so
// existing rows validate. Same for arrangement types (SUBCONTRACT/MENTOR_PROTEGE/
// OTHER added; JV/MPA/CTA/INFORMAL kept for backward compatibility).
const ROLES = ['PRIME', 'SUB', 'BOTH', 'JV_MEMBER', 'MENTOR_PROTEGE'] as const
const ARRANGEMENT_TYPES = ['TEAMING_AGREEMENT', 'SUBCONTRACT', 'MENTOR_PROTEGE', 'OTHER', 'JV', 'MPA', 'CTA', 'INFORMAL'] as const
const PARTNER_TYPES = ['PRIME', 'SUB', 'BOTH'] as const
const TEAMING_STATUSES = ['IDENTIFIED', 'INVITED', 'INTERESTED', 'COMMITTED', 'DECLINED'] as const
const AGREEMENT_STATUSES = ['NONE', 'DRAFT', 'SENT', 'SIGNED'] as const

const audit = (req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction, entityType: string, entityId: string, rationale?: string, before?: unknown, after?: unknown) =>
  logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType, entityId, rationale, before, after })

// -------------------------------------------------------------
// Schemas
// -------------------------------------------------------------
const PartnerSchema = z.object({
  name: z.string().min(1).max(200),
  uei: z.string().max(20).optional(),
  cage: z.string().max(10).optional(),
  primarySetAsides: z.array(z.string()).default([]),
  primaryNaicsCodes: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).default([]),
  certifications: z.array(z.string()).default([]),
  cmmcLevel: z.number().int().min(1).max(3).optional(),
  pastPerformanceLink: z.string().max(2000).optional(),
  website: z.string().max(2000).optional(),
  geography: z.string().max(500).optional(),
  partnerType: z.enum(PARTNER_TYPES).optional(),
  pastRelationship: z.string().max(4000).optional(),
  ownerUserId: z.string().max(64).nullable().optional(),
  contactName: z.string().max(200).optional(),
  contactEmail: z.string().email().max(320).optional(),
  contactPhone: z.string().max(50).optional(),
  notes: z.string().max(4000).optional(),
  isActive: z.boolean().default(true),
})

const dateField = z.string().datetime().transform((s) => new Date(s)).nullable().optional()

const ArrangementSchema = z.object({
  opportunityId: z.string().min(1),
  partnerId: z.string().min(1),
  role: z.enum(ROLES),
  arrangementType: z.enum(ARRANGEMENT_TYPES),
  scopePercent: z.number().min(0).max(100).optional(),
  dollarShare: z.number().min(0).optional(),
  notes: z.string().max(4000).optional(),
  teamingStatus: z.enum(TEAMING_STATUSES).optional(),
  capabilityContribution: z.string().max(4000).optional(),
  capabilityGap: z.string().max(4000).optional(),
  workshareDescription: z.string().max(4000).optional(),
  agreementStatus: z.enum(AGREEMENT_STATUSES).optional(),
  agreementSignedDate: dateField,
  agreementDueDate: dateField,
  ndaStatus: z.enum(AGREEMENT_STATUSES).optional(),
  ownerUserId: z.string().max(64).nullable().optional(),
})

// Validate that total workshare across an opportunity's arrangements stays
// within 100% (the proposed value replaces this arrangement's prior share).
async function assertWorkshareValid(consultingFirmId: string, opportunityId: string, proposedPercent: number | null | undefined, exceptArrangementId?: string) {
  if (proposedPercent == null) return
  const others = await prisma.teamingArrangement.findMany({
    where: { consultingFirmId, opportunityId, isArchived: false, ...(exceptArrangementId ? { id: { not: exceptArrangementId } } : {}) },
    select: { scopePercent: true },
  })
  const existing = others.reduce((s, a) => s + (a.scopePercent ?? 0), 0)
  if (existing + proposedPercent > 100.0001) {
    throw new ValidationError(`Total workshare across this opportunity would be ${(existing + proposedPercent).toFixed(1)}% — it cannot exceed 100%.`)
  }
}

// =============================================================
// PARTNERS
// =============================================================

// GET /api/teaming/partners — roster with arrangement counts
router.get('/partners', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { search, activeOnly, includeArchived, naicsCode, setAside, partnerType } = req.query as Record<string, string>

    const where: Prisma.PartnerWhereInput = { consultingFirmId }
    // Archived (isActive=false) partners are hidden unless explicitly requested.
    if (activeOnly === 'true' || includeArchived !== 'true') where.isActive = true
    if (naicsCode) where.primaryNaicsCodes = { has: naicsCode }
    if (setAside) where.primarySetAsides = { has: setAside }
    if (partnerType && (PARTNER_TYPES as readonly string[]).includes(partnerType)) where.partnerType = partnerType as PartnerType
    if (search)
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { uei: { contains: search, mode: 'insensitive' } },
        { cage: { contains: search, mode: 'insensitive' } },
      ]

    const partners = await prisma.partner.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { _count: { select: { arrangements: true } } },
    })

    res.json({
      success: true,
      data: {
        partners: partners.map((p) => ({ ...p, arrangementCount: p._count.arrangements, _count: undefined })),
        total: partners.length,
      },
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/teaming/partners/:id — one partner + its arrangements
router.get('/partners/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const partner = await prisma.partner.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: {
        arrangements: {
          orderBy: { createdAt: 'desc' },
          include: { opportunity: { select: { id: true, title: true, agency: true } } },
        },
      },
    })
    if (!partner) throw new NotFoundError('Partner')
    res.json({ success: true, data: { partner } })
  } catch (err) {
    next(err)
  }
})

// POST /api/teaming/partners — create (ADMIN)
router.post('/partners', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const body = PartnerSchema.parse(req.body)
    // Duplicate by name OR uei blocked (uei also has a DB unique → P2002 below).
    const dupeName = await prisma.partner.findFirst({ where: { consultingFirmId, name: { equals: body.name, mode: 'insensitive' } }, select: { id: true } })
    if (dupeName) {
      return res.status(409).json({ success: false, error: 'A partner with this name already exists for your firm — update the existing record instead.', code: 'DUPLICATE_PARTNER' })
    }
    // §7.5 — the create and its event share one transaction. Being added
    // establishes nothing: not verified, not eligible, not recommended. It only
    // lets the Teaming Agent re-evaluate unresolved gaps against one more
    // candidate.
    const partner = await prisma.$transaction(async (tx) => {
      const created = await tx.partner.create({ data: { ...body, consultingFirmId } })
      await emitPartnerAdded({ consultingFirmId, partnerId: created.id }, tx)
      return created
    })
    await audit(req, consultingFirmId, 'CREATE', 'Partner', partner.id, `Partner created: ${partner.name}`, undefined, { partnerType: partner.partnerType })
    res.status(201).json({ success: true, data: { partner } })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return res.status(409).json({
        success: false,
        error: 'A partner with this UEI already exists for your firm — update the existing record instead.',
        code: 'DUPLICATE_PARTNER',
      })
    }
    next(err)
  }
})

// PUT /api/teaming/partners/:id — update (ADMIN)
router.put('/partners/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.partner.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Partner')
    const body = PartnerSchema.partial().parse(req.body)
    assertFresh(existing.updatedAt, req.body?.updatedAt)
    if (body.name && body.name.toLowerCase() !== existing.name.toLowerCase()) {
      const dupeName = await prisma.partner.findFirst({ where: { consultingFirmId, name: { equals: body.name, mode: 'insensitive' }, id: { not: existing.id } }, select: { id: true } })
      if (dupeName) return res.status(409).json({ success: false, error: 'A partner with this name already exists for your firm.', code: 'DUPLICATE_PARTNER' })
    }
    const partner = await prisma.partner.update({ where: { id: existing.id }, data: body })
    await audit(req, consultingFirmId, 'UPDATE', 'Partner', partner.id, body.isActive === false ? 'Partner archived' : 'Partner updated', { isActive: existing.isActive, name: existing.name }, { isActive: partner.isActive, name: partner.name })
    res.json({ success: true, data: { partner } })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/teaming/partners/:id/archive — soft-delete (ADMIN). Preserves the
// partner so past arrangement references stay intact.
router.patch('/partners/:id/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.partner.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Partner')
    const partner = await prisma.partner.update({ where: { id: existing.id }, data: { isActive: false } })
    await audit(req, consultingFirmId, 'ARCHIVED', 'Partner', partner.id, `Partner archived: ${partner.name}`)
    res.json({ success: true, data: { partner } })
  } catch (err) { next(err) }
})

// PATCH /api/teaming/partners/:id/restore — un-archive (ADMIN).
router.patch('/partners/:id/restore', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.partner.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Partner')
    const partner = await prisma.partner.update({ where: { id: existing.id }, data: { isActive: true } })
    await audit(req, consultingFirmId, 'RESTORED', 'Partner', partner.id, `Partner restored: ${partner.name}`)
    res.json({ success: true, data: { partner } })
  } catch (err) { next(err) }
})

// PATCH /api/teaming/partners/:id/notes — notes-only update, allowed for CONSULTANT.
router.patch('/partners/:id/notes', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.partner.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Partner')
    const { notes } = z.object({ notes: z.string().max(4000).nullable() }).parse(req.body)
    const partner = await prisma.partner.update({ where: { id: existing.id }, data: { notes } })
    await audit(req, consultingFirmId, 'UPDATE', 'Partner', partner.id, 'Partner notes updated')
    res.json({ success: true, data: { partner } })
  } catch (err) { next(err) }
})

// DELETE /api/teaming/partners/:id — PERMANENT delete (ADMIN). Requires a typed
// name confirmation and is allowed ONLY when the partner has zero arrangements,
// so teaming history is never silently destroyed.
router.delete('/partners/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.partner.findFirst({ where: { id: req.params.id, consultingFirmId }, include: { _count: { select: { arrangements: true } } } })
    if (!existing) throw new NotFoundError('Partner')
    const typed = (req.body?.typedNameConfirmation ?? '').trim()
    if (typed !== existing.name) throw new ValidationError('Type the exact partner name to confirm permanent deletion')
    if (existing._count.arrangements > 0) {
      throw new ConflictError('This partner has linked teaming arrangements — archive it instead of deleting.')
    }
    await prisma.partner.delete({ where: { id: existing.id } })
    await audit(req, consultingFirmId, 'DELETE', 'Partner', existing.id, `Partner permanently deleted: ${existing.name}`)
    res.json({ success: true, data: { deleted: true } })
  } catch (err) {
    next(err)
  }
})

// =============================================================
// ARRANGEMENTS (partner ⇄ opportunity, per-bid)
// =============================================================

// GET /api/teaming/arrangements?opportunityId=&partnerId=
router.get('/arrangements', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId, partnerId, includeArchived } = req.query as Record<string, string>
    const where: Record<string, unknown> = { consultingFirmId }
    if (opportunityId) where.opportunityId = opportunityId
    if (partnerId) where.partnerId = partnerId
    if (String(includeArchived) !== 'true') where.isArchived = false

    const arrangements = await prisma.teamingArrangement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        partner: { select: { id: true, name: true, uei: true } },
        opportunity: { select: { id: true, title: true, agency: true } },
      },
    })
    res.json({ success: true, data: { arrangements, total: arrangements.length } })
  } catch (err) {
    next(err)
  }
})

// POST /api/teaming/arrangements — create (ADMIN)
router.post('/arrangements', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const body = ArrangementSchema.parse(req.body)

    // Re-validate BOTH references belong to this tenant — never trust the
    // client-supplied ids to be in-tenant just because the token is.
    const [partner, opportunity] = await Promise.all([
      prisma.partner.findFirst({ where: { id: body.partnerId, consultingFirmId }, select: { id: true } }),
      prisma.opportunity.findFirst({ where: { id: body.opportunityId, consultingFirmId }, select: { id: true } }),
    ])
    if (!partner) throw new NotFoundError('Partner')
    if (!opportunity) throw new NotFoundError('Opportunity')

    // Prevent duplicate partner↔opportunity links (any role): a partner is
    // linked to a given opportunity once.
    const dupe = await prisma.teamingArrangement.findFirst({
      where: { consultingFirmId, opportunityId: body.opportunityId, partnerId: body.partnerId },
      select: { id: true },
    })
    if (dupe) throw new ConflictError('This partner is already linked to this opportunity.')

    await assertWorkshareValid(consultingFirmId, body.opportunityId, body.scopePercent)

    const arrangement = await prisma.teamingArrangement.create({
      data: {
        consultingFirmId,
        opportunityId: body.opportunityId,
        partnerId: body.partnerId,
        role: body.role,
        arrangementType: body.arrangementType,
        scopePercent: body.scopePercent ?? null,
        dollarShare: body.dollarShare ?? null,
        notes: body.notes ?? null,
        teamingStatus: (body.teamingStatus ?? 'IDENTIFIED') as TeamingStatus,
        capabilityContribution: body.capabilityContribution ?? null,
        capabilityGap: body.capabilityGap ?? null,
        workshareDescription: body.workshareDescription ?? null,
        agreementStatus: (body.agreementStatus ?? 'NONE') as AgreementStatus,
        agreementSignedDate: body.agreementSignedDate ?? null,
        agreementDueDate: body.agreementDueDate ?? null,
        ndaStatus: (body.ndaStatus ?? 'NONE') as AgreementStatus,
        ownerUserId: body.ownerUserId ?? req.user?.userId ?? null,
      },
      include: {
        partner: { select: { id: true, name: true } },
        opportunity: { select: { id: true, title: true, agency: true } },
      },
    })
    await audit(req, consultingFirmId, 'CREATE', 'TeamingArrangement', arrangement.id, `Linked partner to opportunity (${arrangement.role})`, undefined, { partnerId: arrangement.partnerId, opportunityId: arrangement.opportunityId })
    res.status(201).json({ success: true, data: { arrangement } })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return res.status(409).json({
        success: false,
        error: 'This partner already has that role on this opportunity — a duplicate arrangement would double-count the teaming metrics.',
        code: 'DUPLICATE_ARRANGEMENT',
      })
    }
    next(err)
  }
})

// DELETE /api/teaming/arrangements/:id — soft-archive only (ADMIN). Arrangements
// are never hard-deleted so teaming history and the graph metrics stay intact.
router.delete('/arrangements/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.teamingArrangement.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Arrangement')
    await prisma.teamingArrangement.update({ where: { id: existing.id }, data: { isArchived: true } })
    await audit(req, consultingFirmId, 'ARCHIVED', 'TeamingArrangement', existing.id, 'Teaming arrangement archived')
    res.json({ success: true, data: { archived: true } })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/teaming/arrangements/:id/restore — un-archive (ADMIN).
router.patch('/arrangements/:id/restore', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.teamingArrangement.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Arrangement')
    await prisma.teamingArrangement.update({ where: { id: existing.id }, data: { isArchived: false } })
    await audit(req, consultingFirmId, 'RESTORED', 'TeamingArrangement', existing.id, 'Teaming arrangement restored')
    res.json({ success: true, data: { restored: true } })
  } catch (err) {
    next(err)
  }
})

// =============================================================
// GET /api/teaming/graph — the moat aggregation
//
// Rolls the firm's arrangements into a partner-centric graph:
//   • per-partner: # arrangements, role mix, agencies teamed at,
//     total teamed dollar value, and win/loss on those teamed bids
//     (joined to SubmissionRecord.outcome, the outcome flywheel).
//   • firm summary: active partners, total teamed value, role mix,
//     agency coverage, and a teamed-bid win rate.
// This is the compounding, proprietary signal FIX-2 calls for.
// =============================================================
router.get('/graph', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    // Partner counts come from the partner table, not the arrangement nodes —
    // a partner with zero arrangements is still a partner, and the KPI must
    // match the roster rendered on the same page.
    const [arrangements, totalPartners, activePartnerCount] = await Promise.all([
      prisma.teamingArrangement.findMany({
        where: { consultingFirmId },
        include: {
          partner: { select: { id: true, name: true, uei: true, isActive: true } },
          opportunity: { select: { id: true, agency: true } },
        },
      }),
      prisma.partner.count({ where: { consultingFirmId } }),
      prisma.partner.count({ where: { consultingFirmId, isActive: true } }),
    ])

    // Outcomes for the opportunities we've teamed on (WON/LOST powers the
    // "does teaming with X actually win?" signal). One submission per
    // (opportunity) is the norm; if several, any WON counts the bid won.
    const oppIds = [...new Set(arrangements.map((a) => a.opportunityId))]
    const submissions = oppIds.length
      ? await prisma.submissionRecord.findMany({
          where: { consultingFirmId, opportunityId: { in: oppIds }, outcome: { not: null } },
          select: { opportunityId: true, outcome: true },
        })
      : []
    const outcomeByOpp = new Map<string, 'WON' | 'LOST' | 'OTHER'>()
    for (const s of submissions) {
      const prev = outcomeByOpp.get(s.opportunityId)
      const o = s.outcome === 'WON' ? 'WON' : s.outcome === 'LOST' ? 'LOST' : 'OTHER'
      // WON is sticky — a single winning submission means the bid was won.
      if (prev === 'WON') continue
      outcomeByOpp.set(s.opportunityId, o)
    }

    type Node = {
      partnerId: string
      name: string
      uei: string | null
      isActive: boolean
      arrangements: number
      roles: Record<string, number>
      agencies: string[]
      teamedValue: number
      won: number
      lost: number
    }
    const nodes = new Map<string, Node>()
    const agencySet = new Set<string>()
    let totalTeamedValue = 0
    const firmRoles: Record<string, number> = {}
    let wonBids = 0
    let lostBids = 0
    const countedOpps = new Set<string>()

    for (const a of arrangements) {
      let n = nodes.get(a.partnerId)
      if (!n) {
        n = {
          partnerId: a.partnerId,
          name: a.partner.name,
          uei: a.partner.uei,
          isActive: a.partner.isActive,
          arrangements: 0,
          roles: {},
          agencies: [],
          teamedValue: 0,
          won: 0,
          lost: 0,
        }
        nodes.set(a.partnerId, n)
      }
      n.arrangements += 1
      n.roles[a.role] = (n.roles[a.role] ?? 0) + 1
      firmRoles[a.role] = (firmRoles[a.role] ?? 0) + 1

      const agency = a.opportunity.agency
      if (agency) {
        agencySet.add(agency)
        if (!n.agencies.includes(agency)) n.agencies.push(agency)
      }

      const share = a.dollarShare ? Number(a.dollarShare) : 0
      n.teamedValue += share
      totalTeamedValue += share

      const outcome = outcomeByOpp.get(a.opportunityId)
      if (outcome === 'WON') n.won += 1
      else if (outcome === 'LOST') n.lost += 1

      // Firm-level win rate counts each teamed bid once, not once per partner.
      if (outcome && !countedOpps.has(a.opportunityId)) {
        countedOpps.add(a.opportunityId)
        if (outcome === 'WON') wonBids += 1
        else if (outcome === 'LOST') lostBids += 1
      }
    }

    const partnerNodes = [...nodes.values()]
      .map((n) => ({
        ...n,
        winRatePct: n.won + n.lost > 0 ? Math.round((n.won / (n.won + n.lost)) * 100) : null,
      }))
      .sort((a, b) => b.arrangements - a.arrangements)

    const decidedBids = wonBids + lostBids

    res.json({
      success: true,
      data: {
        summary: {
          partners: totalPartners,
          activePartners: activePartnerCount,
          arrangements: arrangements.length,
          teamedOpportunities: oppIds.length,
          totalTeamedValue,
          agencyCoverage: agencySet.size,
          roleMix: firmRoles,
          teamedBidWinRatePct: decidedBids > 0 ? Math.round((wonBids / decidedBids) * 100) : null,
          teamedBidsWon: wonBids,
          teamedBidsLost: lostBids,
        },
        partners: partnerNodes,
      },
    })
  } catch (err) {
    next(err)
  }
})

// =============================================================
// GET /api/teaming/recommend/:opportunityId — active partner ranking
//
// Turns the passive teaming graph into an ACTIONABLE recommendation:
// given a specific opportunity, rank the firm's active partners by an
// explainable fit score. Deliberately transparent (a factor breakdown,
// not a black-box number) — same honesty ethos as the tiered Fit score
// (FIXES.md FIX-1). Signals:
//   • NAICS      (0–40): exact code match, or same 2-digit sector.
//   • Set-aside  (0–25): opp's set-aside is in the partner's set-asides
//                        (neutral partial when the opp has no set-aside).
//   • Capability (0–25): partner capabilities that appear in the opp
//                        title/description.
//   • Track record (0–10): we've teamed with them before, and won.
// =============================================================
function twoDigit(code: string): string {
  return (code || '').replace(/[^0-9]/g, '').slice(0, 2)
}

router.get('/recommend/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const opp = await prisma.opportunity.findFirst({
      where: { id: req.params.opportunityId, consultingFirmId },
      select: { id: true, title: true, agency: true, naicsCode: true, setAsideType: true, description: true, placeOfPerformance: true },
    })
    if (!opp) throw new NotFoundError('Opportunity')

    const partners = await prisma.partner.findMany({ where: { consultingFirmId, isActive: true } })

    // Prior teaming track record per partner (won on past teamed bids).
    const priorArrangements = await prisma.teamingArrangement.findMany({
      where: { consultingFirmId },
      select: { partnerId: true, opportunityId: true },
    })
    const partnerPriorOpps = new Map<string, Set<string>>()
    for (const a of priorArrangements) {
      if (!partnerPriorOpps.has(a.partnerId)) partnerPriorOpps.set(a.partnerId, new Set())
      partnerPriorOpps.get(a.partnerId)!.add(a.opportunityId)
    }
    const priorOppIds = [...new Set(priorArrangements.map((a) => a.opportunityId))]
    const wonOppIds = new Set(
      priorOppIds.length
        ? (
            await prisma.submissionRecord.findMany({
              where: { consultingFirmId, opportunityId: { in: priorOppIds }, outcome: 'WON' },
              select: { opportunityId: true },
            })
          ).map((s) => s.opportunityId)
        : []
    )

    // Deterministic, explainable matching lives in services/partnerMatch.ts (the
    // single source of truth reused by tests). It adds matching + missing
    // requirements, certification fit, geography fit, why-recommended, honest
    // data limitations, and an insufficient-data flag.
    const recommendations = partners
      .map((p) => {
        const prior: MatchPriorContext = { priorOppIds: partnerPriorOpps.get(p.id) ?? new Set(), wonOppIds }
        return {
          ...matchPartnerToOpportunity(
            { id: p.id, name: p.name, uei: p.uei, cmmcLevel: p.cmmcLevel, primaryNaicsCodes: p.primaryNaicsCodes, primarySetAsides: p.primarySetAsides, capabilities: p.capabilities, certifications: p.certifications, geography: p.geography },
            { naicsCode: opp.naicsCode, setAsideType: opp.setAsideType, title: opp.title, description: opp.description, placeOfPerformance: opp.placeOfPerformance },
            prior,
          ),
          // Back-compat alias for the existing frontend recommender.
          matchedCapabilities: undefined as string[] | undefined,
        }
      })
      .map((r) => ({ ...r, matchedCapabilities: r.matchingCapabilities }))
      .sort((a, b) => b.score - a.score)

    res.json({
      success: true,
      data: {
        opportunity: { id: opp.id, title: opp.title, agency: opp.agency, naicsCode: opp.naicsCode, setAsideType: opp.setAsideType },
        recommendations,
      },
    })
  } catch (err) {
    next(err)
  }
})

// =============================================================
// ARRANGEMENT UPDATE + AGREEMENT/NDA/WORKSHARE workflow
// =============================================================
const ArrangementUpdateSchema = z.object({
  role: z.enum(ROLES).optional(),
  arrangementType: z.enum(ARRANGEMENT_TYPES).optional(),
  scopePercent: z.number().min(0).max(100).nullable().optional(),
  dollarShare: z.number().min(0).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  teamingStatus: z.enum(TEAMING_STATUSES).optional(),
  capabilityContribution: z.string().max(4000).nullable().optional(),
  capabilityGap: z.string().max(4000).nullable().optional(),
  workshareDescription: z.string().max(4000).nullable().optional(),
  agreementStatus: z.enum(AGREEMENT_STATUSES).optional(),
  agreementSignedDate: dateField,
  agreementDueDate: dateField,
  ndaStatus: z.enum(AGREEMENT_STATUSES).optional(),
  ownerUserId: z.string().max(64).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' })

async function loadArrangement(consultingFirmId: string, id: string) {
  const a = await prisma.teamingArrangement.findFirst({ where: { id, consultingFirmId } })
  if (!a) throw new NotFoundError('Arrangement')
  return a
}

// PATCH /api/teaming/arrangements/:id — update agreement/NDA/workshare/status (ADMIN)
router.patch('/arrangements/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ArrangementUpdateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid update payload')
    const existing = await loadArrangement(consultingFirmId, req.params.id)

    if (parsed.data.scopePercent != null) {
      await assertWorkshareValid(consultingFirmId, existing.opportunityId, parsed.data.scopePercent, existing.id)
    }

    const data: Prisma.TeamingArrangementUpdateInput = {}
    for (const k of ['role', 'arrangementType', 'teamingStatus', 'agreementStatus', 'ndaStatus'] as const) if (parsed.data[k] !== undefined) (data as Record<string, unknown>)[k] = parsed.data[k]
    for (const k of ['scopePercent', 'dollarShare', 'notes', 'capabilityContribution', 'capabilityGap', 'workshareDescription', 'ownerUserId', 'agreementSignedDate', 'agreementDueDate'] as const) if (k in parsed.data) (data as Record<string, unknown>)[k] = parsed.data[k] ?? null
    // Stamp a signed date automatically when marked SIGNED without one.
    if (parsed.data.agreementStatus === 'SIGNED' && !parsed.data.agreementSignedDate && !existing.agreementSignedDate) data.agreementSignedDate = new Date()

    const updated = await prisma.teamingArrangement.update({ where: { id: existing.id }, data, include: { partner: { select: { id: true, name: true } }, opportunity: { select: { id: true, title: true } } } })
    await audit(req, consultingFirmId, 'UPDATE', 'TeamingArrangement', existing.id, 'Teaming arrangement updated', { agreementStatus: existing.agreementStatus, ndaStatus: existing.ndaStatus, scopePercent: existing.scopePercent }, { agreementStatus: updated.agreementStatus, ndaStatus: updated.ndaStatus, scopePercent: updated.scopePercent })
    res.json({ success: true, data: { arrangement: updated } })
  } catch (err) { next(err) }
})

// =============================================================
// AGREEMENT DRAFTS (versioned, editable — never executed)
// =============================================================
const DraftSchema = z.object({ draftType: z.enum(['TEAMING_AGREEMENT', 'NDA']).default('TEAMING_AGREEMENT'), content: z.string().max(100_000).optional() })

// POST /api/teaming/arrangements/:id/agreement-draft — generate or save a draft
// version (ADMIN). Without `content`, a deterministic draft is built from stored
// data (no API key). Each call appends a new version; prior versions are kept.
router.post('/arrangements/:id/agreement-draft', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = DraftSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('Invalid draft payload')
    const arrangement = await prisma.teamingArrangement.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: { partner: { select: { name: true } }, opportunity: { select: { title: true, agency: true, solicitationNumber: true } }, consultingFirm: { select: { name: true } } },
    })
    if (!arrangement) throw new NotFoundError('Arrangement')

    const content = parsed.data.content ?? buildAgreementDraft({
      draftType: parsed.data.draftType, firmName: arrangement.consultingFirm.name, partnerName: arrangement.partner.name,
      partnerRole: arrangement.role, arrangementType: arrangement.arrangementType, opportunityTitle: arrangement.opportunity.title,
      agency: arrangement.opportunity.agency, solicitationNumber: arrangement.opportunity.solicitationNumber,
      scopePercent: arrangement.scopePercent, workshareDescription: arrangement.workshareDescription, capabilityContribution: arrangement.capabilityContribution,
    })

    const prior = await prisma.teamingAgreementDraft.findFirst({ where: { teamingArrangementId: arrangement.id, draftType: parsed.data.draftType }, orderBy: { version: 'desc' }, select: { version: true } })
    const draft = await prisma.teamingAgreementDraft.create({
      data: { consultingFirmId, teamingArrangementId: arrangement.id, draftType: parsed.data.draftType, version: (prior?.version ?? 0) + 1, content, generatedByUserId: req.user?.userId ?? null },
    })
    // A generated draft moves the agreement into DRAFT status if still NONE.
    if (arrangement.agreementStatus === 'NONE') await prisma.teamingArrangement.update({ where: { id: arrangement.id }, data: { agreementStatus: 'DRAFT' } })
    await audit(req, consultingFirmId, 'CREATE', 'TeamingAgreementDraft', draft.id, `${parsed.data.draftType} draft v${draft.version} generated`)
    res.status(201).json({ success: true, data: { draft } })
  } catch (err) { next(err) }
})

// GET /api/teaming/arrangements/:id/agreement-drafts — all draft versions (read)
router.get('/arrangements/:id/agreement-drafts', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await loadArrangement(consultingFirmId, req.params.id)
    const drafts = await prisma.teamingAgreementDraft.findMany({ where: { consultingFirmId, teamingArrangementId: req.params.id }, orderBy: [{ draftType: 'asc' }, { version: 'desc' }] })
    res.json({ success: true, data: { drafts } })
  } catch (err) { next(err) }
})

// =============================================================
// AGREEMENT DOCUMENT ATTACHMENT (reuses the shared /uploads storage)
// =============================================================
router.post('/arrangements/:id/attachment', requireRole('ADMIN'), upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await loadArrangement(consultingFirmId, req.params.id)
    if (!req.file) throw new ValidationError('No file uploaded')
    const key = path.basename(req.file.path)
    const updated = await prisma.teamingArrangement.update({ where: { id: existing.id }, data: { agreementDocumentKey: key, agreementDocumentName: req.file.originalname } })
    await audit(req, consultingFirmId, 'UPDATE', 'TeamingArrangement', existing.id, `Agreement document attached: ${req.file.originalname}`)
    res.status(201).json({ success: true, data: { arrangement: { id: updated.id, agreementDocumentName: updated.agreementDocumentName } } })
  } catch (err) { next(err) }
})

// GET /api/teaming/arrangements/:id/attachment — tenant-scoped download (read)
router.get('/arrangements/:id/attachment', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await loadArrangement(consultingFirmId, req.params.id)
    if (!existing.agreementDocumentKey) throw new NotFoundError('Agreement document')
    const filePath = path.join(process.cwd(), 'uploads', existing.agreementDocumentKey)
    if (!fs.existsSync(filePath)) throw new NotFoundError('File not found on disk')
    res.download(filePath, existing.agreementDocumentName ?? existing.agreementDocumentKey)
  } catch (err) { next(err) }
})

// =============================================================
// REMINDERS — unsigned / incomplete / overdue agreements
// =============================================================
function reminderState(a: { agreementStatus: string; ndaStatus: string; agreementDueDate: Date | null; teamingStatus: string }, now: Date): { needsAttention: boolean; overdue: boolean; reasons: string[] } {
  const reasons: string[] = []
  const overdue = !!a.agreementDueDate && a.agreementDueDate.getTime() < now.getTime() && a.agreementStatus !== 'SIGNED'
  if (overdue) reasons.push('agreement overdue')
  if (a.agreementStatus !== 'SIGNED' && a.teamingStatus === 'COMMITTED') reasons.push('committed partner without a signed agreement')
  if (a.agreementStatus === 'SENT') reasons.push('agreement sent, awaiting signature')
  if (a.ndaStatus === 'SENT') reasons.push('NDA sent, awaiting signature')
  return { needsAttention: reasons.length > 0, overdue, reasons }
}

// GET /api/teaming/reminders — computed feed (read)
router.get('/reminders', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const now = new Date()
    const arrangements = await prisma.teamingArrangement.findMany({
      where: { consultingFirmId, OR: [{ agreementStatus: { not: 'SIGNED' } }, { ndaStatus: { not: 'SIGNED' } }] },
      include: { partner: { select: { id: true, name: true } }, opportunity: { select: { id: true, title: true } } },
      orderBy: { agreementDueDate: 'asc' },
    })
    const items = arrangements
      .map((a) => ({ arrangement: { id: a.id, partner: a.partner, opportunity: a.opportunity, agreementStatus: a.agreementStatus, ndaStatus: a.ndaStatus, agreementDueDate: a.agreementDueDate, ownerUserId: a.ownerUserId }, ...reminderState(a, now) }))
      .filter((r) => r.needsAttention)
    res.json({ success: true, data: { reminders: items, total: items.length, overdue: items.filter((r) => r.overdue).length } })
  } catch (err) { next(err) }
})

// POST /api/teaming/reminders/dispatch — create in-app notifications for the
// owner of each arrangement needing attention (ADMIN). Deduped so re-running
// does not create duplicate reminders.
router.post('/reminders/dispatch', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const now = new Date()
    const arrangements = await prisma.teamingArrangement.findMany({
      where: { consultingFirmId, OR: [{ agreementStatus: { not: 'SIGNED' } }, { ndaStatus: { not: 'SIGNED' } }] },
      include: { partner: { select: { name: true } }, opportunity: { select: { title: true } } },
    })
    let created = 0
    for (const a of arrangements) {
      const state = reminderState(a, now)
      const recipient = a.ownerUserId ?? req.user?.userId
      if (!state.needsAttention || !recipient) continue
      const dayKey = a.agreementDueDate ? a.agreementDueDate.toISOString().slice(0, 10) : 'nodue'
      await notifyUser({
        consultingFirmId, userId: recipient, type: 'TEAMING_REMINDER',
        title: `Teaming agreement needs attention: ${a.partner.name}`,
        body: `${a.opportunity.title} — ${state.reasons.join('; ')}`,
        linkPath: `/opportunities/${a.opportunityId}`, entityType: 'TeamingArrangement', entityId: a.id,
        dedupeKey: `teaming-reminder:${a.id}:${recipient}:${dayKey}`,
      })
      created += 1
    }
    await audit(req, consultingFirmId, 'UPDATE', 'TeamingArrangement', consultingFirmId, `Dispatched ${created} teaming agreement reminder(s)`)
    res.json({ success: true, data: { dispatched: created } })
  } catch (err) { next(err) }
})

export default router
