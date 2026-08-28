// =============================================================
// Shared opportunity filter definitions — the SINGLE source of truth for how
// opportunity search query params become a Prisma `where`. Used by the
// opportunity list route (GET /api/opportunities) and by saved monitoring
// profiles (§5.1 Stage 1), so a saved profile filters exactly the same way the
// live search does. Adding a filter here adds it to both.
// =============================================================
import { z } from 'zod'
import { Prisma } from '@prisma/client'

// Values may arrive as query strings (from the URL) or as JSON (a stored
// profile). Treat both `true` and `'true'` as truthy.
function truthy(v: unknown): boolean {
  return v === true || v === 'true'
}
function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}
function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
function date(v: unknown): Date | undefined {
  const s = str(v)
  if (!s) return undefined
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export interface FilterContext {
  consultingFirmId: string
  // Whether the firm may use the set-aside filter (Set-Aside Intelligence
  // add-on). When false, a setAsideType filter is ignored rather than applied.
  allowSetAside: boolean
  // NAICS prefixes derived from a client (clientId lookup happens in the route).
  clientNaicsPrefixes?: string[]
  now?: Date
}

/**
 * Build the Prisma `where` for an opportunity search from raw query/profile
 * params. Behaviour matches the historical GET /api/opportunities logic, plus
 * postedAfter/postedBefore (posted-date range) and dueBefore (deadline upper
 * bound) which saved profiles need.
 */
export function buildOpportunityWhere(q: Record<string, unknown>, ctx: FilterContext): Prisma.OpportunityWhereInput {
  const now = ctx.now ?? new Date()
  const where: Prisma.OpportunityWhereInput = { consultingFirmId: ctx.consultingFirmId }

  // Demo rows hidden unless explicitly included.
  if (!truthy(q.includeDemo)) where.isDemo = false

  if (str(q.naicsCode)) where.naicsCode = { startsWith: str(q.naicsCode) }
  if (str(q.agency)) where.agency = { contains: str(q.agency)!, mode: 'insensitive' }
  if (str(q.setAsideType) && ctx.allowSetAside) where.setAsideType = str(q.setAsideType)
  if (str(q.status)) where.status = str(q.status) as Prisma.OpportunityWhereInput['status']
  if (str(q.placeOfPerformance)) where.placeOfPerformance = { contains: str(q.placeOfPerformance)!, mode: 'insensitive' }
  if (truthy(q.recompeteOnly)) where.recompeteFlag = true
  if (truthy(q.enrichedOnly)) where.isEnriched = true
  if (str(q.contractVehicle)) where.contractVehicle = str(q.contractVehicle)
  if (str(q.vehicleType)) where.vehicleType = str(q.vehicleType)
  if (truthy(q.hasVehicle)) where.contractVehicle = { not: null }

  const search = str(q.search) ?? str(q.keywords)
  const andClauses: Prisma.OpportunityWhereInput[] = []
  if (search) {
    andClauses.push({
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { samNoticeId: { contains: search, mode: 'insensitive' } },
        { agency: { contains: search, mode: 'insensitive' } },
      ],
    })
  }
  if (andClauses.length) where.AND = andClauses

  const evMin = num(q.estimatedValueMin)
  const evMax = num(q.estimatedValueMax)
  if (evMin !== undefined || evMax !== undefined) {
    where.estimatedValue = {}
    if (evMin !== undefined) where.estimatedValue.gte = evMin
    if (evMax !== undefined) where.estimatedValue.lte = evMax
  }

  const pMin = num(q.probabilityMin)
  const pMax = num(q.probabilityMax)
  if (pMin !== undefined || pMax !== undefined) {
    where.probabilityScore = {}
    if (pMin !== undefined) where.probabilityScore.gte = pMin
    if (pMax !== undefined) where.probabilityScore.lte = pMax
  }

  // Posted-date range (new — powers saved profiles).
  const postedAfter = date(q.postedAfter)
  const postedBefore = date(q.postedBefore)
  if (postedAfter || postedBefore) {
    where.postedDate = {}
    if (postedAfter) where.postedDate.gte = postedAfter
    if (postedBefore) where.postedDate.lte = postedBefore
  }

  // Response-deadline window. daysUntilDeadline (a rolling window) takes
  // precedence, matching the historical behaviour; otherwise default to
  // "not expired" (unless showExpired) and honour an explicit dueBefore bound.
  const daysUntilDeadline = num(q.daysUntilDeadline)
  const dueBefore = date(q.dueBefore)
  if (daysUntilDeadline !== undefined) {
    where.responseDeadline = { gt: now, lte: new Date(now.getTime() + daysUntilDeadline * 24 * 60 * 60 * 1000) }
  } else {
    const rd: Prisma.DateTimeFilter = {}
    if (!truthy(q.showExpired)) rd.gte = now
    if (dueBefore) rd.lte = dueBefore
    if (rd.gte !== undefined || rd.lte !== undefined) where.responseDeadline = rd
  }

  // Record provenance. §6.1A added GRANTS_GOV / STATE_LOCAL /
  // SUBCONTRACTING_BOARD / AGENCY_FORECAST / CONTRACT_AWARDS to the enum;
  // `sources` accepts a comma-separated multi-select, `source` the single value.
  if (str(q.source)) where.source = str(q.source) as Prisma.OpportunityWhereInput['source']
  const sources = str(q.sources)?.split(',').map((s) => s.trim()).filter(Boolean)
  if (sources && sources.length > 0) {
    where.source = { in: sources as NonNullable<Prisma.OpportunityWhereInput['source']> extends { in?: infer T } ? T : never }
  }

  // §6.1D — pre-solicitation notice kinds (SOURCES_SOUGHT, RFI, DRAFT_RFP, …).
  const noticeKinds = str(q.presolicitationKinds)?.split(',').map((s) => s.trim()).filter(Boolean)
  if (noticeKinds && noticeKinds.length > 0) where.presolicitationKind = { in: noticeKinds }
  else if (str(q.presolicitationKind)) where.presolicitationKind = str(q.presolicitationKind)
  // Pre-solicitation notices only, or active solicitations only.
  if (truthy(q.preSolicitationOnly)) where.presolicitationKind = { not: null }
  if (truthy(q.solicitationsOnly)) where.presolicitationKind = null

  // §6.1E/§6.1F — capability match + eligibility, read from the persisted
  // OpportunityMatch snapshot so filtering stays server-side and deterministic.
  const matchMin = num(q.matchScoreMin)
  const eligibilityStates = str(q.eligibility)?.split(',').map((s) => s.trim()).filter(Boolean)
  const matchWhere: Prisma.OpportunityMatchWhereInput = {}
  if (matchMin !== undefined) matchWhere.overallScore = { gte: matchMin }
  if (eligibilityStates && eligibilityStates.length > 0) {
    matchWhere.eligibility = { in: eligibilityStates as NonNullable<Prisma.OpportunityMatchWhereInput['eligibility']> extends { in?: infer T } ? T : never }
  }
  // "Eligible only" and "include possible" are explicit opt-ins. An opportunity
  // is NEVER dropped merely because its eligibility could not be determined —
  // INSUFFICIENT_DATA is always carried along with the requested states.
  if (truthy(q.eligibleOnly)) matchWhere.eligibility = { in: ['ELIGIBLE', 'EXPIRING_BEFORE_DEADLINE', 'INSUFFICIENT_DATA'] }
  else if (truthy(q.includePossibleEligibility)) {
    matchWhere.eligibility = { in: ['ELIGIBLE', 'POSSIBLY_ELIGIBLE', 'EXPIRING_BEFORE_DEADLINE', 'INSUFFICIENT_DATA'] }
  }
  if (Object.keys(matchWhere).length > 0) where.match = matchWhere

  // Pursuit-level filters (owner + pipeline stage) via the 1:1 BidPursuit.
  const pursuitSome: Prisma.BidPursuitWhereInput = {}
  if (str(q.ownerUserId)) pursuitSome.ownerUserId = str(q.ownerUserId)
  if (str(q.pipelineStage)) pursuitSome.pipelineStage = str(q.pipelineStage) as Prisma.BidPursuitWhereInput['pipelineStage']
  if (Object.keys(pursuitSome).length > 0) where.bidPursuits = { some: pursuitSome }

  // Bid/no-bid decision (algorithmic BidDecision: GO / NO_GO / PENDING).
  if (str(q.bidDecision)) where.bidDecisions = { some: { decision: str(q.bidDecision) as Prisma.BidDecisionWhereInput['decision'] } }

  if (ctx.clientNaicsPrefixes && ctx.clientNaicsPrefixes.length > 0) {
    where.OR = ctx.clientNaicsPrefixes.map((prefix) => ({ naicsCode: { startsWith: prefix } }))
  }

  return where
}

// Validation schema for a saved profile's stored filters. `.strict()` rejects
// unknown keys so malformed filters are caught on save. All fields optional —
// an empty profile is a valid "everything" monitor.
export const MonitoringFiltersSchema = z
  .object({
    naicsCode: z.string().trim().max(10).regex(/^[0-9]*$/, 'NAICS must be digits').optional(),
    agency: z.string().trim().max(160).optional(),
    setAsideType: z.string().trim().max(40).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED', 'EXPIRED', 'AWARDED', 'CANCELLED']).optional(),
    source: z
      .enum(['SAM_GOV', 'USA_SPENDING', 'MANUAL', 'DEMO', 'OTHER', 'GRANTS_GOV', 'STATE_LOCAL', 'SUBCONTRACTING_BOARD', 'AGENCY_FORECAST', 'CONTRACT_AWARDS'])
      .optional(),
    keywords: z.string().trim().max(200).optional(),
    placeOfPerformance: z.string().trim().max(160).optional(),
    contractVehicle: z.string().trim().max(80).optional(),
    vehicleType: z.string().trim().max(80).optional(),
    estimatedValueMin: z.number().nonnegative().max(1_000_000_000).optional(),
    estimatedValueMax: z.number().nonnegative().max(1_000_000_000).optional(),
    postedAfter: z.string().datetime().optional(),
    postedBefore: z.string().datetime().optional(),
    dueBefore: z.string().datetime().optional(),
    daysUntilDeadline: z.number().int().min(0).max(3650).optional(),
    recompeteOnly: z.boolean().optional(),
    enrichedOnly: z.boolean().optional(),
    hasVehicle: z.boolean().optional(),
    showExpired: z.boolean().optional(),
    // §6.1G additions. Stored as the same shape the live search accepts, so a
    // profile and the search it replays can never diverge.
    sources: z.string().trim().max(200).optional(),
    presolicitationKind: z.enum(['SOURCES_SOUGHT', 'RFI', 'SPECIAL_NOTICE', 'DRAFT_RFP', 'PRESOLICITATION', 'INDUSTRY_DAY']).optional(),
    presolicitationKinds: z.string().trim().max(200).optional(),
    preSolicitationOnly: z.boolean().optional(),
    solicitationsOnly: z.boolean().optional(),
    matchScoreMin: z.number().int().min(0).max(100).optional(),
    eligibility: z.string().trim().max(200).optional(),
    eligibleOnly: z.boolean().optional(),
    includePossibleEligibility: z.boolean().optional(),
  })
  .strict()
  .refine(
    (f) => f.estimatedValueMin === undefined || f.estimatedValueMax === undefined || f.estimatedValueMin <= f.estimatedValueMax,
    { message: 'estimatedValueMin must be <= estimatedValueMax' },
  )

export type MonitoringFilters = z.infer<typeof MonitoringFiltersSchema>
