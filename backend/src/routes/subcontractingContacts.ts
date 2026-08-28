// =============================================================
// Subcontracting Contacts Route
// Captured prime-contractor contacts derived from subcontracting opps
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { logger } from '../utils/logger'
import { pruneContacts } from '../services/scw/subcontractContacts'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('teaming_suite'))

// =============================================================
// GET /api/subcontracting/contacts
// List / search captured contacts
// =============================================================
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { search, agency, naicsCode, prime, source, limit = '50', offset = '0' } = req.query as Record<string, string>

    const where: Record<string, unknown> = { consultingFirmId }
    if (search) where.OR = [
      { primeContractor: { contains: search, mode: 'insensitive' } },
      { contactName:     { contains: search, mode: 'insensitive' } },
      { contactEmail:    { contains: search, mode: 'insensitive' } },
    ]
    if (agency)    where.agency          = { contains: agency, mode: 'insensitive' }
    if (naicsCode) where.naicsCode       = naicsCode
    if (prime)     where.primeContractor = { contains: prime, mode: 'insensitive' }
    if (source)    where.source          = source

    const [contacts, total] = await Promise.all([
      prisma.subcontractContact.findMany({
        where,
        orderBy: { lastSeenAt: 'desc' },
        take: Math.min(200, Math.max(1, parseInt(limit, 10) || 50)),
        skip: Math.max(0, parseInt(offset, 10) || 0),
      }),
      prisma.subcontractContact.count({ where }),
    ])

    res.json({ success: true, data: { contacts, total } })
  } catch (err) { next(err) }
})

// =============================================================
// GET /api/subcontracting/contacts/stats
// =============================================================
router.get('/stats', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const [total, primeGroups, topAgencies, topNaics, bySource] = await Promise.all([
      prisma.subcontractContact.count({ where: { consultingFirmId } }),
      prisma.subcontractContact.groupBy({
        by: ['primeContractor'],
        where: { consultingFirmId },
        _count: true,
      }),
      prisma.subcontractContact.groupBy({
        by: ['agency'],
        where: { consultingFirmId, agency: { not: null } },
        _count: true,
        orderBy: { _count: { agency: 'desc' } },
        take: 10,
      }),
      prisma.subcontractContact.groupBy({
        by: ['naicsCode'],
        where: { consultingFirmId, naicsCode: { not: null } },
        _count: true,
        orderBy: { _count: { naicsCode: 'desc' } },
        take: 10,
      }),
      prisma.subcontractContact.groupBy({
        by: ['source'],
        where: { consultingFirmId },
        _count: true,
      }),
    ])

    const distinctPrimes = primeGroups.length

    res.json({ success: true, data: { total, distinctPrimes, topAgencies, topNaics, bySource } })
  } catch (err) { next(err) }
})

// =============================================================
// DELETE /api/subcontracting/contacts/:id
// =============================================================
router.delete('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.subcontractContact.findFirst({
      where: { id: req.params.id, consultingFirmId },
    })
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' })
    await prisma.subcontractContact.delete({ where: { id: req.params.id } })
    res.json({ success: true })
  } catch (err) { next(err) }
})

// =============================================================
// POST /api/subcontracting/contacts/prune
// Remove junk (no valid email) + stale contacts
// =============================================================
router.post('/prune', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const result = await pruneContacts({ consultingFirmId })
    logger.info('Subcontracting contacts pruned', { consultingFirmId, ...result })
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

export default router
