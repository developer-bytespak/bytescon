// =============================================================
// Subcontracting Opportunities Route
// Aggregates SUBNet + USAspending + SAM.gov set-aside data
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { decryptSecret } from '../utils/fieldCrypto'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { logAudit } from '../services/auditService'
import { logger } from '../utils/logger'
import { fetchSubnetOpportunities, fetchSamSetAsideBroad, enrichValueFromUsaSpending } from '../services/subnetScraper'
import { computeExpiryState, graceCutoff } from '../services/scw/subcontractExpiry'
import { captureContact } from '../services/scw/subcontractContacts'
import { seedPrimeDirectoryContacts } from '../services/scw/primeDirectorySeed'
import { config } from '../config/config'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('teaming_suite'))

// =============================================================
// GET /api/subcontracting/opportunities
// =============================================================
router.get('/opportunities', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { search, naicsCode, setAside, agency, status, limit = '50', offset = '0' } = req.query as Record<string, string>

    const where: Record<string, unknown> = { consultingFirmId }
    if (naicsCode) where.naicsCode = naicsCode
    if (setAside)  where.setAside  = setAside
    if (agency)    where.agency    = { contains: agency, mode: 'insensitive' }
    if (status)    where.status    = status
    // Dismissed opportunities stop appearing unless explicitly requested.
    else if (req.query.includeDismissed !== 'true') where.status = { not: 'DISMISSED' }
    if (search)    where.OR = [
      { title:            { contains: search, mode: 'insensitive' } },
      { primeContractor:  { contains: search, mode: 'insensitive' } },
    ]

    // Hide opportunities past the 7-day grace window unless includeExpired=true
    if (req.query.includeExpired !== 'true') {
      where.AND = [{ OR: [{ responseDeadline: null }, { responseDeadline: { gte: graceCutoff(new Date()) } }] }]
    }

    const [opportunities, total] = await Promise.all([
      prisma.subcontractOpportunity.findMany({
        where,
        orderBy: { scrapedAt: 'desc' },
        take: Math.min(200, Math.max(1, parseInt(limit, 10) || 50)),
        skip: Math.max(0, parseInt(offset, 10) || 0),
      }),
      prisma.subcontractOpportunity.count({ where }),
    ])

    const withState = opportunities.map(o => ({ ...o, expiryState: computeExpiryState(o.responseDeadline as any) }))
    res.json({ success: true, data: { opportunities: withState, total } })
  } catch (err) { next(err) }
})

// =============================================================
// GET /api/subcontracting/stats
// =============================================================
router.get('/stats', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [total, bySetAside, open] = await Promise.all([
      prisma.subcontractOpportunity.count({ where: { consultingFirmId } }),
      prisma.subcontractOpportunity.groupBy({
        by: ['setAside'],
        where: { consultingFirmId },
        _count: { _all: true },
        orderBy: { _count: { setAside: 'desc' } },
      }),
      prisma.subcontractOpportunity.count({ where: { consultingFirmId, status: 'OPEN' } }),
    ])
    res.json({ success: true, data: { total, bySetAside, open } })
  } catch (err) { next(err) }
})

// =============================================================
// POST /api/subcontracting/sync
// Trigger scrape from USAspending + SAM.gov
// =============================================================
router.post('/sync', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    res.json({ success: true, message: 'Subcontracting sync started. Pulling set-aside solicitations from SAM.gov.' })

    setImmediate(async () => {
      try {
        // Get client NAICS codes + firm SAM key
        const [clients, firm] = await Promise.all([
          prisma.clientCompany.findMany({
            where: { consultingFirmId, isActive: true },
            select: { naicsCodes: true },
          }),
          prisma.consultingFirm.findUnique({
            where: { id: consultingFirmId },
            select: { samApiKey: true },
          }),
        ])

        const naicsCodes = [...new Set(clients.flatMap((c) => c.naicsCodes))]

        // Pull from SBA SUBNet (www.sba.gov HTML scrape) + SAM.gov set-asides in parallel
        // + USAspending value enrichment per NAICS.
        // SAM key: prefer the per-firm key, else fall back to the platform
        // SAM_API_KEY (same key that already serves enrichment + ingestion), so
        // onboarding never requires a per-firm key. If neither is set, resolve [].
        const samKey = decryptSecret(firm?.samApiKey ?? null) || process.env.SAM_API_KEY
        let [subnetResults, samResults, valueMap] = await Promise.all([
          fetchSubnetOpportunities(naicsCodes.length > 0 ? naicsCodes : undefined),
          samKey ? fetchSamSetAsideBroad(samKey, naicsCodes.length > 0 ? naicsCodes : undefined) : Promise.resolve([]),
          naicsCodes.length > 0 ? enrichValueFromUsaSpending(naicsCodes) : Promise.resolve(new Map<string, number>()),
        ])

        // Fallback: if NAICS filter yielded nothing, fetch unfiltered so the page always has content
        if (subnetResults.length === 0 && naicsCodes.length > 0) {
          logger.info('Subcontracting: no NAICS-filtered SUBNet results, falling back to unfiltered', { naicsCodes })
          subnetResults = await fetchSubnetOpportunities()
        }

        // Apply USAspending-derived value estimates to opportunities that have no value
        const allOpps = [...subnetResults, ...samResults].map((opp) => ({
          ...opp,
          estimatedValue: opp.estimatedValue ?? (opp.naicsCode ? (valueMap.get(opp.naicsCode) ?? null) : null),
        }))
        let created = 0
        let skipped = 0

        for (const opp of allOpps) {
          try {
            const saved = await prisma.subcontractOpportunity.upsert({
              where: { externalId: opp.externalId },
              update: {
                title:             opp.title,
                estimatedValue:    opp.estimatedValue ?? undefined,
                responseDeadline:  opp.responseDeadline ?? undefined,
                description:       opp.description ?? undefined,
                scrapedAt:         new Date(),
              },
              create: {
                consultingFirmId,
                externalId:         opp.externalId,
                title:              opp.title,
                primeContractor:    opp.primeContractor,
                primeContractorUei: opp.primeContractorUei ?? undefined,
                naicsCode:          opp.naicsCode ?? undefined,
                agency:             opp.agency ?? undefined,
                estimatedValue:     opp.estimatedValue ?? undefined,
                responseDeadline:   opp.responseDeadline ?? undefined,
                description:        opp.description ?? undefined,
                contactEmail:       opp.contactEmail ?? undefined,
                contactName:        opp.contactName ?? undefined,
                sourceUrl:          opp.sourceUrl ?? undefined,
                setAside:           opp.setAside ?? undefined,
                status:             'OPEN',
              },
            })
            created++
            await captureContact({ consultingFirmId, primeContractor: opp.primeContractor, primeContractorUei: opp.primeContractorUei, contactName: opp.contactName, contactEmail: opp.contactEmail, agency: opp.agency, naicsCode: opp.naicsCode, setAside: opp.setAside, sourceUrl: opp.sourceUrl, source: opp.source, opportunityId: saved.id, opportunityTitle: saved.title })
          } catch {
            skipped++
          }
        }

        // Federal published prime-SBLO directory (baked corpus, no network).
        // Idempotent upserts, so re-running each sync just refreshes lastSeenAt.
        if (config.scw.primeDirectorySeedEnabled) {
          await seedPrimeDirectoryContacts(consultingFirmId)
        }

        logger.info('Subcontracting sync complete', { consultingFirmId, total: allOpps.length, created, skipped })
        void logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'UPDATE', entityType: 'SubcontractOpportunity', rationale: `Subcontracting sync — ${created} created, ${skipped} skipped`, after: { total: allOpps.length, created, skipped } })
      } catch (err) {
        logger.error('Subcontracting sync failed', { error: (err as Error).message })
      }
    })
  } catch (err) { next(err) }
})

// =============================================================
// POST /api/subcontracting/opportunities  (manual add)
// =============================================================
router.post('/opportunities', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { title, primeContractor, naicsCode, agency, estimatedValue,
            responseDeadline, description, contactEmail, contactName, sourceUrl, setAside } = req.body

    if (!title || !primeContractor) {
      return res.status(400).json({ success: false, error: 'title and primeContractor are required' })
    }

    const opp = await prisma.subcontractOpportunity.create({
      data: {
        consultingFirmId,
        title,
        primeContractor,
        naicsCode:        naicsCode        ?? undefined,
        agency:           agency           ?? undefined,
        estimatedValue:   estimatedValue   ? parseFloat(estimatedValue) : undefined,
        responseDeadline: responseDeadline ? new Date(responseDeadline) : undefined,
        description:      description      ?? undefined,
        contactEmail:     contactEmail     ?? undefined,
        contactName:      contactName      ?? undefined,
        sourceUrl:        sourceUrl        ?? undefined,
        setAside:         setAside         ?? undefined,
        status:           'OPEN',
      },
    })
    await captureContact({ consultingFirmId, primeContractor: opp.primeContractor, primeContractorUei: opp.primeContractorUei ?? undefined, contactName: opp.contactName ?? undefined, contactEmail: opp.contactEmail ?? undefined, agency: opp.agency ?? undefined, naicsCode: opp.naicsCode ?? undefined, setAside: opp.setAside ?? undefined, sourceUrl: opp.sourceUrl ?? undefined, source: 'manual', opportunityId: opp.id, opportunityTitle: opp.title })
    res.status(201).json({ success: true, data: opp })
  } catch (err) { next(err) }
})

// =============================================================
// DELETE /api/subcontracting/opportunities/:id
// =============================================================
router.delete('/opportunities/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.subcontractOpportunity.findFirst({
      where: { id: req.params.id, consultingFirmId },
    })
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' })
    await prisma.subcontractOpportunity.delete({ where: { id: req.params.id } })
    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /api/subcontracting/opportunities/:id/save-to-pipeline — spawn a manual
// Opportunity from this external subcontract lead + a BidPursuit to track it.
router.post('/opportunities/:id/save-to-pipeline', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const sub = await prisma.subcontractOpportunity.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!sub) return res.status(404).json({ success: false, error: 'Not found' })
    if (sub.savedOpportunityId) return res.status(409).json({ success: false, error: 'Already saved to pipeline', code: 'ALREADY_SAVED' })

    const deadline = sub.responseDeadline ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const result = await prisma.$transaction(async (tx) => {
      const opp = await tx.opportunity.create({
        data: {
          consultingFirmId,
          title: `${sub.title} (sub to ${sub.primeContractor})`,
          agency: sub.agency ?? sub.primeContractor,
          responseDeadline: deadline,
          source: 'MANUAL',
          naicsCode: sub.naicsCode ?? undefined,
          sourceUrl: sub.sourceUrl ?? undefined,
          description: sub.description ?? undefined,
        },
      })
      const pursuit = await tx.bidPursuit.create({
        data: { consultingFirmId, opportunityId: opp.id, source: 'USER', pipelineStage: 'IDENTIFIED', notes: `Saved from subcontracting lead — prime ${sub.primeContractor}` },
      })
      await tx.subcontractOpportunity.update({ where: { id: sub.id }, data: { status: 'SAVED', savedOpportunityId: opp.id } })
      return { opp, pursuit }
    })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'CREATE', entityType: 'BidPursuit', entityId: result.pursuit.id, rationale: `Saved subcontracting lead to pipeline: ${sub.title}`, after: { opportunityId: result.opp.id } })
    res.status(201).json({ success: true, data: { opportunityId: result.opp.id, pursuitId: result.pursuit.id } })
  } catch (err) { next(err) }
})

// POST /api/subcontracting/opportunities/:id/dismiss — dismiss with a reason so
// it stops appearing in the default list.
router.post('/opportunities/:id/dismiss', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const sub = await prisma.subcontractOpportunity.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!sub) return res.status(404).json({ success: false, error: 'Not found' })
    const reason = String((req.body?.reason ?? '')).trim()
    if (!reason) return res.status(422).json({ success: false, error: 'A dismissal reason is required', code: 'VALIDATION_ERROR' })
    const updated = await prisma.subcontractOpportunity.update({ where: { id: sub.id }, data: { status: 'DISMISSED', dismissedReason: reason, dismissedAt: new Date() } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'UPDATE', entityType: 'SubcontractOpportunity', entityId: sub.id, rationale: `Dismissed: ${reason}` })
    res.json({ success: true, data: { opportunity: updated } })
  } catch (err) { next(err) }
})

export default router
