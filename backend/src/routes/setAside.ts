// =============================================================
// Set-Aside Intelligence — the setaside_intel add-on module.
//
//   GET /api/setaside/overview               firm-wide set-aside landscape
//   GET /api/setaside/scanner                set-aside opportunities, scored
//   GET /api/setaside/eligibility/:oppId     per-client cert match
//   GET /api/setaside/agency-rates           SB/SDVOSB award rates by agency
//
// Eligibility is derived from ClientCompany certification flags; agency
// rates come from usaSpendingService.getAgencySetAsideRates (3 USAspending
// count queries per agency) behind a 24h in-process cache.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { NotFoundError, ValidationError } from '../utils/errors'
import { usaSpendingService } from '../services/usaSpending'
import { logger } from '../utils/logger'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('setaside_intel'))

// Set-aside categories as normalized by samApi.mapSetAside.
const SET_ASIDE_TYPES = [
  'SDVOSB', 'VOSB', 'WOSB', 'EDWOSB', 'SBA_8A', 'HUBZONE',
  'TOTAL_SMALL_BUSINESS', 'SMALL_BUSINESS',
] as const

interface ClientCerts {
  id: string
  name: string
  sdvosb: boolean
  wosb: boolean
  hubzone: boolean
  smallBusiness: boolean
  sdvosbCertExpiry: Date | null
  wosbCertExpiry: Date | null
}

export type EligibilityVerdict = 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'OPEN' | 'UNKNOWN'

// Cert match per normalized set-aside type. SDVOSB certification also
// satisfies VOSB set-asides; 8(a) status is not tracked on the profile yet,
// so SBA_8A resolves UNKNOWN rather than a false no.
export function setAsideEligibility(setAsideType: string | null | undefined, client: ClientCerts): EligibilityVerdict {
  switch (setAsideType) {
    case null:
    case undefined:
    case '':
    case 'NONE':
      return 'OPEN'
    case 'SDVOSB':
      return client.sdvosb ? 'ELIGIBLE' : 'NOT_ELIGIBLE'
    case 'VOSB':
      return client.sdvosb ? 'ELIGIBLE' : 'UNKNOWN'
    case 'WOSB':
    case 'EDWOSB':
      return client.wosb ? 'ELIGIBLE' : 'NOT_ELIGIBLE'
    case 'HUBZONE':
      return client.hubzone ? 'ELIGIBLE' : 'NOT_ELIGIBLE'
    case 'SBA_8A':
      return 'UNKNOWN'
    case 'TOTAL_SMALL_BUSINESS':
    case 'SMALL_BUSINESS':
      return client.smallBusiness ? 'ELIGIBLE' : 'NOT_ELIGIBLE'
    default:
      return 'UNKNOWN'
  }
}

async function activeClients(consultingFirmId: string): Promise<ClientCerts[]> {
  return prisma.clientCompany.findMany({
    where: { consultingFirmId, isActive: true },
    select: {
      id: true, name: true, sdvosb: true, wosb: true, hubzone: true,
      smallBusiness: true, sdvosbCertExpiry: true, wosbCertExpiry: true,
    },
  })
}

// -------------------------------------------------------------
// GET /api/setaside/overview
// -------------------------------------------------------------
router.get('/overview', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [byType, clients] = await Promise.all([
      prisma.opportunity.groupBy({
        by: ['setAsideType'],
        where: { consultingFirmId, status: 'ACTIVE' },
        _count: { _all: true },
        _avg: { probabilityScore: true },
      }),
      activeClients(consultingFirmId),
    ])

    const landscape = byType
      .map((row) => ({
        setAsideType: row.setAsideType,
        count: row._count._all,
        avgProbability: row._avg.probabilityScore ?? 0,
        eligibleClients: clients
          .filter((c) => setAsideEligibility(row.setAsideType, c) === 'ELIGIBLE')
          .map((c) => c.name),
      }))
      .sort((a, b) => b.count - a.count)

    const now = new Date()
    const certProfile = clients.map((c) => ({
      clientCompanyId: c.id,
      name: c.name,
      certifications: {
        sdvosb: c.sdvosb,
        wosb: c.wosb,
        hubzone: c.hubzone,
        smallBusiness: c.smallBusiness,
      },
      expiringSoon: [
        ...(c.sdvosbCertExpiry && c.sdvosbCertExpiry < new Date(now.getTime() + 90 * 24 * 3600 * 1000)
          ? [{ cert: 'SDVOSB', expiresAt: c.sdvosbCertExpiry }] : []),
        ...(c.wosbCertExpiry && c.wosbCertExpiry < new Date(now.getTime() + 90 * 24 * 3600 * 1000)
          ? [{ cert: 'WOSB', expiresAt: c.wosbCertExpiry }] : []),
      ],
    }))

    res.json({ success: true, data: { landscape, certProfile, knownTypes: SET_ASIDE_TYPES } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/setaside/scanner?type=SDVOSB&limit=25
// Set-aside opportunities ranked by win probability, each annotated with
// the firm's best eligible client.
// -------------------------------------------------------------
router.get('/scanner', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const type = typeof req.query.type === 'string' ? req.query.type : undefined
    if (type && !SET_ASIDE_TYPES.includes(type as (typeof SET_ASIDE_TYPES)[number])) {
      throw new ValidationError(`type must be one of: ${SET_ASIDE_TYPES.join(', ')}`)
    }
    const limit = Math.min(100, Number(req.query.limit) || 25)

    const [opps, clients] = await Promise.all([
      prisma.opportunity.findMany({
        where: {
          consultingFirmId,
          status: 'ACTIVE',
          responseDeadline: { gt: new Date() },
          setAsideType: type ? type : { notIn: ['NONE', ''] },
        },
        select: {
          id: true, title: true, agency: true, naicsCode: true, setAsideType: true,
          responseDeadline: true, probabilityScore: true, estimatedValue: true, sourceUrl: true,
        },
        orderBy: { probabilityScore: 'desc' },
        take: limit,
      }),
      activeClients(consultingFirmId),
    ])

    const data = opps.map((opp) => {
      const verdicts = clients.map((c) => ({
        clientCompanyId: c.id,
        clientName: c.name,
        verdict: setAsideEligibility(opp.setAsideType, c),
      }))
      return {
        ...opp,
        eligibility: verdicts,
        anyEligible: verdicts.some((v) => v.verdict === 'ELIGIBLE'),
      }
    })

    res.json({ success: true, data })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/setaside/eligibility/:opportunityId
// -------------------------------------------------------------
router.get('/eligibility/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opportunity = await prisma.opportunity.findFirst({
      where: { id: req.params.opportunityId, consultingFirmId },
      select: { id: true, title: true, setAsideType: true },
    })
    if (!opportunity) throw new NotFoundError('Opportunity not found')

    const clients = await activeClients(consultingFirmId)
    res.json({
      success: true,
      data: {
        opportunity,
        eligibility: clients.map((c) => ({
          clientCompanyId: c.id,
          clientName: c.name,
          verdict: setAsideEligibility(opportunity.setAsideType, c),
          certifications: {
            sdvosb: c.sdvosb, wosb: c.wosb, hubzone: c.hubzone, smallBusiness: c.smallBusiness,
          },
        })),
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/setaside/agency-rates?agency=<name>
// Without ?agency: rates for the firm's top agencies by ACTIVE opportunity
// count (capped — each agency costs 3 USAspending count queries on a cold
// cache). With ?agency: that single agency.
// -------------------------------------------------------------
interface RateCacheEntry { value: { smallBizRate: number; sdvosbRate: number }; expiresAt: number }
const agencyRateCache = new Map<string, RateCacheEntry>()
const AGENCY_RATE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_AGENCIES_PER_REQUEST = 6

async function ratesForAgency(agency: string) {
  const key = agency.toLowerCase()
  const cached = agencyRateCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return { agency, ...cached.value, cached: true }
  const value = await usaSpendingService.getAgencySetAsideRates(agency)
  agencyRateCache.set(key, { value, expiresAt: Date.now() + AGENCY_RATE_TTL_MS })
  return { agency, ...value, cached: false }
}

router.get('/agency-rates', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const single = typeof req.query.agency === 'string' && req.query.agency.trim()
      ? req.query.agency.trim()
      : null

    const agencies = single
      ? [single]
      : (
          await prisma.opportunity.groupBy({
            by: ['agency'],
            where: { consultingFirmId, status: 'ACTIVE' },
            _count: { _all: true },
            orderBy: { _count: { agency: 'desc' } },
            take: MAX_AGENCIES_PER_REQUEST,
          })
        ).map((r) => r.agency)

    // Sequential on purpose — each agency is 3 upstream calls and USAspending
    // rate-limits aggressively. Per-agency failures degrade to null rates
    // rather than failing the whole board.
    const results = []
    for (const agency of agencies) {
      try {
        results.push(await ratesForAgency(agency))
      } catch (err) {
        logger.warn('Agency set-aside rate lookup failed', { agency, error: (err as Error).message })
        results.push({ agency, smallBizRate: null, sdvosbRate: null, cached: false, error: 'unavailable' })
      }
    }

    res.json({ success: true, data: results })
  } catch (err) { next(err) }
})

export default router
