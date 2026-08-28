// =============================================================
// §8.4 — Public API v1.
//
// A deliberately small, read-only surface for customer integrations. It is not
// the browser API (which authenticates a person), not MCP (which speaks a tool
// protocol over its own transport), and not the partner portal (which serves
// an external company under an engagement grant). It shares their credential
// substrate and their domain data, and nothing else.
//
// WHAT IS NOT HERE, AND WHY
// There is no mutation of any kind in v1. Bid/no-bid, proposal approval,
// submission, budget approval, purchase-order approval, invoice approval,
// payment, legal flow-down review, portal access grants and resume approval
// are human gates; an API token is not a human. A standing test asserts this
// router registers no POST, PUT, PATCH or DELETE handler at all, so the gate
// cannot be reopened by accident.
//
// Every response body is built by a named DTO in services/publicApi/dto.ts.
// Every query is filtered by the tenant on the verified token.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import {
  authenticateApiToken, requireScope, getApiContext, type PublicApiRequest,
} from '../../services/publicApi/apiTokenAuth'
import { consumeRateLimit } from '../../services/publicApi/rateLimit'
import { recordPublicApiUsage } from '../../services/publicApi/usageLog'
import { publicApiError, publicApiErrorHandler } from '../../services/publicApi/errors'
import { PUBLIC_API_SCOPES, PUBLIC_API_SCOPE_DESCRIPTIONS } from '../../services/publicApi/scopes'
import { OPENAPI_DOCUMENT } from '../../services/publicApi/openapi'
import {
  OPPORTUNITY_SELECT, PURSUIT_SELECT, CONTRACT_SELECT, PARTNER_SELECT, PERSONNEL_SELECT,
  toOpportunityDto, toPursuitDto, toContractDto, toPartnerDto, toPersonnelDto,
  type ContactDto, page,
} from '../../services/publicApi/dto'

const router = Router()

export const DEFAULT_PAGE_LIMIT = 25
export const MAX_PAGE_LIMIT = 100

/** Unauthenticated and stable: an integrator needs the contract before a token. */
router.get('/openapi.json', (_req, res) => {
  res.json(OPENAPI_DOCUMENT)
})

router.get('/scopes', (_req, res) => {
  res.json({
    data: PUBLIC_API_SCOPES.map((scope) => ({ scope, description: PUBLIC_API_SCOPE_DESCRIPTIONS[scope] })),
  })
})

router.use(authenticateApiToken)

/** Counted after authentication so an anonymous flood cannot spend a customer's quota. */
router.use(async (req: PublicApiRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getApiContext(req)
    const decision = await consumeRateLimit(ctx.tokenId, ctx.tier)
    res.setHeader('X-RateLimit-Limit', String(decision.limit))
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining))
    res.setHeader('X-RateLimit-Reset', String(decision.resetAt))
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds))
      return publicApiError(res, req, 429, 'RATE_LIMITED', 'Rate limit exceeded for this API token.', {
        limit: decision.limit, resetAt: decision.resetAt, retryAfterSeconds: decision.retryAfterSeconds,
      })
    }
    next()
  } catch (err) { next(err) }
})

router.use((req: PublicApiRequest, res: Response, next: NextFunction) => {
  recordPublicApiUsage(req, res)
  next()
})

const PageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
})

/** Clamped rather than rejected, so a caller asking for 10,000 gets 100 and a meta block that says so. */
function pagination(req: PublicApiRequest): { limit: number; offset: number } {
  const parsed = PageSchema.safeParse(req.query ?? {})
  const raw = parsed.success ? parsed.data : {}
  const requested = Number((req.query as Record<string, unknown>).limit ?? NaN)
  const limit = Number.isFinite(requested) && requested > MAX_PAGE_LIMIT ? MAX_PAGE_LIMIT : raw.limit ?? DEFAULT_PAGE_LIMIT
  return { limit, offset: raw.offset ?? 0 }
}

/** A named route pattern for the usage log, so record ids never reach it. */
function tag(pattern: string) {
  return (req: PublicApiRequest, _res: Response, next: NextFunction) => {
    req.publicApiRoute = pattern
    next()
  }
}

const notFound = (req: PublicApiRequest, res: Response) =>
  publicApiError(res, req, 404, 'NOT_FOUND', 'No such record.')

// -------------------------------------------------------------
// Opportunities
// -------------------------------------------------------------

const OpportunityFilters = z.object({
  status: z.string().trim().max(40).optional(),
  agency: z.string().trim().max(200).optional(),
  naicsCode: z.string().trim().max(20).optional(),
  postedFrom: z.string().datetime().optional(),
  postedTo: z.string().datetime().optional(),
}).partial()

router.get('/opportunities', tag('/opportunities'), requireScope('opportunities:read'), async (req: PublicApiRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getApiContext(req)
    const filters = OpportunityFilters.safeParse(req.query ?? {})
    if (!filters.success) {
      return publicApiError(res, req, 400, 'INVALID_REQUEST', 'One or more filters are not valid.')
    }
    const { limit, offset } = pagination(req)

    // Built field by field from a fixed set. A caller-supplied filter object is
    // never translated into a Prisma where clause.
    const where: Prisma.OpportunityWhereInput = { consultingFirmId: ctx.consultingFirmId }
    if (filters.data.status) where.status = filters.data.status as Prisma.OpportunityWhereInput['status']
    if (filters.data.agency) where.agency = { contains: filters.data.agency, mode: Prisma.QueryMode.insensitive }
    if (filters.data.naicsCode) where.naicsCode = filters.data.naicsCode
    if (filters.data.postedFrom || filters.data.postedTo) {
      where.postedDate = {
        ...(filters.data.postedFrom ? { gte: new Date(filters.data.postedFrom) } : {}),
        ...(filters.data.postedTo ? { lte: new Date(filters.data.postedTo) } : {}),
      }
    }

    const [rows, total] = await Promise.all([
      prisma.opportunity.findMany({ where, select: OPPORTUNITY_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset }),
      prisma.opportunity.count({ where }),
    ])
    res.json(page(rows.map(toOpportunityDto), total, limit, offset))
  } catch (err) { next(err) }
})

router.get('/opportunities/:id', tag('/opportunities/:id'), requireScope('opportunities:read'), async (req: PublicApiRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getApiContext(req)
    const row = await prisma.opportunity.findFirst({
      where: { id: req.params.id, consultingFirmId: ctx.consultingFirmId }, select: OPPORTUNITY_SELECT,
    })
    // Another tenant's id is indistinguishable from one that does not exist.
    if (!row) return notFound(req, res)
    res.json({ data: toOpportunityDto(row) })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Pursuits
// -------------------------------------------------------------

router.get('/pursuits', tag('/pursuits'), requireScope('pursuits:read'), async (req: PublicApiRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getApiContext(req)
    const filters = z.object({
      pipelineStage: z.string().trim().max(40).optional(),
      includeClosed: z.enum(['true', 'false']).optional(),
    }).safeParse(req.query ?? {})
    if (!filters.success) return publicApiError(res, req, 400, 'INVALID_REQUEST', 'One or more filters are not valid.')
    const { limit, offset } = pagination(req)

    const where: Prisma.BidPursuitWhereInput = { consultingFirmId: ctx.consultingFirmId }
    if (filters.data.pipelineStage) where.pipelineStage = filters.data.pipelineStage as Prisma.BidPursuitWhereInput['pipelineStage']
    if (filters.data.includeClosed !== 'true') where.closedAt = null

    const [rows, total] = await Promise.all([
      prisma.bidPursuit.findMany({ where, select: PURSUIT_SELECT, orderBy: [{ lastActivityAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset }),
      prisma.bidPursuit.count({ where }),
    ])
    res.json(page(rows.map((r) => toPursuitDto(r as unknown as Record<string, unknown>)), total, limit, offset))
  } catch (err) { next(err) }
})

router.get('/pursuits/:id', tag('/pursuits/:id'), requireScope('pursuits:read'), async (req: PublicApiRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getApiContext(req)
    const row = await prisma.bidPursuit.findFirst({
      where: { id: req.params.id, consultingFirmId: ctx.consultingFirmId }, select: PURSUIT_SELECT,
    })
    if (!row) return notFound(req, res)
    res.json({ data: toPursuitDto(row as unknown as Record<string, unknown>) })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Contracts
// -------------------------------------------------------------

router.get('/contracts', tag('/contracts'), requireScope('contracts:read'), async (req: PublicApiRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getApiContext(req)
    const filters = z.object({
      status: z.string().trim().max(40).optional(),
      agency: z.string().trim().max(200).optional(),
    }).safeParse(req.query ?? {})
    if (!filters.success) return publicApiError(res, req, 400, 'INVALID_REQUEST', 'One or more filters are not valid.')
    const { limit, offset } = pagination(req)

    const where: Prisma.ContractWhereInput = { consultingFirmId: ctx.consultingFirmId, isArchived: false }
    if (filters.data.status) where.status = filters.data.status
    if (filters.data.agency) where.agency = { contains: filters.data.agency, mode: Prisma.QueryMode.insensitive }

    const [rows, total] = await Promise.all([
      prisma.contract.findMany({ where, select: CONTRACT_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset }),
      prisma.contract.count({ where }),
    ])
    res.json(page(rows.map(toContractDto), total, limit, offset))
  } catch (err) { next(err) }
})

router.get('/contracts/:id', tag('/contracts/:id'), requireScope('contracts:read'), async (req: PublicApiRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getApiContext(req)
    const row = await prisma.contract.findFirst({
      where: { id: req.params.id, consultingFirmId: ctx.consultingFirmId }, select: CONTRACT_SELECT,
    })
    if (!row) return notFound(req, res)
    res.json({ data: toContractDto(row) })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// CRM contacts — government and partner, in one normalized shape
// -------------------------------------------------------------

router.get('/crm/contacts', tag('/crm/contacts'), requireScope('crm:read'), async (req: PublicApiRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getApiContext(req)
    const filters = z.object({ kind: z.enum(['GOVERNMENT', 'PARTNER']).optional() }).safeParse(req.query ?? {})
    if (!filters.success) return publicApiError(res, req, 400, 'INVALID_REQUEST', 'One or more filters are not valid.')
    const { limit, offset } = pagination(req)
    const kind = filters.data.kind

    // `notes` is selected nowhere here: a CRM note is the firm's private
    // record of a conversation, not directory data.
    const [gov, govTotal] = kind === 'PARTNER' ? [[], 0] : await Promise.all([
      prisma.governmentContact.findMany({
        where: { consultingFirmId: ctx.consultingFirmId, isArchived: false },
        select: { id: true, fullName: true, title: true, email: true, phone: true, agencyName: true, status: true, updatedAt: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset,
      }),
      prisma.governmentContact.count({ where: { consultingFirmId: ctx.consultingFirmId, isArchived: false } }),
    ])
    const [part, partTotal] = kind === 'GOVERNMENT' ? [[], 0] : await Promise.all([
      prisma.partnerContact.findMany({
        where: { consultingFirmId: ctx.consultingFirmId },
        select: {
          id: true, fullName: true, title: true, email: true, phone: true, status: true, updatedAt: true,
          partner: { select: { name: true } },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset,
      }),
      prisma.partnerContact.count({ where: { consultingFirmId: ctx.consultingFirmId } }),
    ])

    const items: ContactDto[] = [
      ...gov.map((c) => ({
        id: c.id, kind: 'GOVERNMENT' as const, fullName: c.fullName, title: c.title,
        email: c.email, phone: c.phone, organization: c.agencyName,
        status: String(c.status), updatedAt: c.updatedAt.toISOString(),
      })),
      ...part.map((c) => ({
        id: c.id, kind: 'PARTNER' as const, fullName: c.fullName, title: c.title,
        email: c.email, phone: c.phone, organization: c.partner?.name ?? null,
        status: String(c.status), updatedAt: c.updatedAt.toISOString(),
      })),
    ].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit)

    res.json(page(items, govTotal + partTotal, limit, offset))
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Partners
// -------------------------------------------------------------

router.get('/partners', tag('/partners'), requireScope('partners:read'), async (req: PublicApiRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getApiContext(req)
    const { limit, offset } = pagination(req)
    const where: Prisma.PartnerWhereInput = { consultingFirmId: ctx.consultingFirmId, isActive: true }
    const [rows, total] = await Promise.all([
      prisma.partner.findMany({ where, select: PARTNER_SELECT, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: limit, skip: offset }),
      prisma.partner.count({ where }),
    ])
    res.json(page(rows.map(toPartnerDto), total, limit, offset))
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Personnel
// -------------------------------------------------------------

router.get('/personnel', tag('/personnel'), requireScope('personnel:read'), async (req: PublicApiRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getApiContext(req)
    const filters = z.object({ laborCategory: z.string().trim().max(160).optional() }).safeParse(req.query ?? {})
    if (!filters.success) return publicApiError(res, req, 400, 'INVALID_REQUEST', 'One or more filters are not valid.')
    const { limit, offset } = pagination(req)

    const where: Prisma.PersonnelWhereInput = { consultingFirmId: ctx.consultingFirmId, isArchived: false }
    if (filters.data.laborCategory) {
      // Verified only: an unverified qualification is not a searchable claim.
      where.qualifications = { some: { laborCategory: filters.data.laborCategory, verification: 'VERIFIED' } }
    }
    const [rows, total] = await Promise.all([
      prisma.personnel.findMany({ where, select: PERSONNEL_SELECT, orderBy: [{ lastName: 'asc' }, { id: 'asc' }], take: limit, skip: offset }),
      prisma.personnel.count({ where }),
    ])
    res.json(page(rows.map((r) => toPersonnelDto(r as unknown as Record<string, unknown>)), total, limit, offset))
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Analytics — counts and totals only
// -------------------------------------------------------------

router.get('/analytics/portfolio', tag('/analytics/portfolio'), requireScope('analytics:read'), async (req: PublicApiRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getApiContext(req)
    const firm = { consultingFirmId: ctx.consultingFirmId }
    const [opportunities, openPursuits, activeContracts, partners, personnel, ceiling] = await Promise.all([
      prisma.opportunity.count({ where: firm }),
      prisma.bidPursuit.count({ where: { ...firm, closedAt: null } }),
      prisma.contract.count({ where: { ...firm, isArchived: false, status: 'ACTIVE' } }),
      prisma.partner.count({ where: { ...firm, isActive: true } }),
      prisma.personnel.count({ where: { ...firm, isArchived: false } }),
      prisma.contract.aggregate({ where: { ...firm, isArchived: false }, _sum: { ceilingValue: true } }),
    ])
    res.json({
      data: {
        opportunities, openPursuits, activeContracts, partners, personnel,
        contractCeilingTotal: (ceiling._sum.ceilingValue ?? new Prisma.Decimal(0)).toFixed(2),
        // Said plainly, because a total that looks like a forecast will be read as one.
        note: 'Counts and recorded contract ceiling only. This is not a forecast, a win probability or a pipeline valuation.',
      },
    })
  } catch (err) { next(err) }
})

// A path that does not exist gets the same envelope as everything else.
router.use((req: PublicApiRequest, res: Response) => {
  publicApiError(res, req, 404, 'NOT_FOUND', 'No such endpoint in this API version.')
})

router.use(publicApiErrorHandler)

export default router
