// =============================================================
// Recipient Routes — drill-down for any UEI from a subaward row.
//
// Endpoints:
//   GET  /api/recipient/:uei                — cached SAM profile (auto-fetched if stale)
//   GET  /api/recipient/:uei/subawards      — subaward history for this UEI
//   GET  /api/recipient/:uei/primes         — prime contracts won by this UEI
//   POST /api/recipient/:uei/enrich-contacts — manual contact enrichment trigger
//   GET  /api/recipient/:uei/contacts       — cached contacts (no provider call)
//
// All endpoints follow the {success, data, error?, code?} envelope.
// Authenticated via standard authenticateJWT + enforceTenantScope.
// Underlying recipient data is platform-wide (public USAspending +
// SAM.gov) — no tenant filter on the data itself, but auth is required.
// =============================================================

import { Router, Response, NextFunction } from 'express'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope } from '../middleware/tenant'
import { logger } from '../utils/logger'
import {
  getOrFetchProfile,
  getSubawardHistory,
  getPrimeAwards,
  enrichContacts,
  readCachedContacts,
} from '../services/recipientProfileService'
import { listProviders } from '../services/contactProviders'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('market_intel'))

// GET /api/recipient/:uei  — profile (cached, auto-refresh if stale)
router.get('/:uei', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true'
    const profile = await getOrFetchProfile(req.params.uei, { forceRefresh: force })
    const contactsView = readCachedContacts(profile)
    res.json({
      success: true,
      data: {
        uei: profile.uei,
        legalName: profile.legalName,
        cageCode: profile.cageCode,
        samRegStatus: profile.samRegStatus,
        samRegExpiry: profile.samRegExpiry,
        website: profile.website,
        phone: profile.phone,
        address: {
          street: profile.streetAddress,
          city: profile.city,
          state: profile.state,
          zip: profile.zipCode,
        },
        naicsCodes: profile.naicsCodes,
        certifications: {
          sdvosb: profile.sdvosb,
          wosb: profile.wosb,
          hubzone: profile.hubzone,
          smallBusiness: profile.smallBusiness,
        },
        samFetchedAt: profile.samFetchedAt,
        contacts: contactsView.contacts,
        contactsProvider: contactsView.provider,
        contactsFetchedAt: contactsView.fetchedAt,
        providers: listProviders(),
      },
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/recipient/:uei/subawards
router.get('/:uei/subawards', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200)
    const rows = await getSubawardHistory(req.params.uei, limit)
    const totalAmount = rows.reduce((sum, r) => sum + r.subAmount, 0)
    res.json({
      success: true,
      data: {
        rows,
        totals: {
          count: rows.length,
          totalAmount,
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/recipient/:uei/primes  — when this UEI was the PRIME, not the sub
router.get('/:uei/primes', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200)
    const rows = await getPrimeAwards(req.params.uei, limit)
    const totalAmount = rows.reduce((sum, r) => sum + r.totalObligation, 0)
    res.json({
      success: true,
      data: {
        rows,
        totals: {
          count: rows.length,
          totalAmount,
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/recipient/:uei/enrich-contacts
router.post(
  '/:uei/enrich-contacts',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const providerKey = typeof req.body?.provider === 'string' ? req.body.provider : undefined
      logger.info('Recipient contact enrichment requested', {
        uei: req.params.uei,
        provider: providerKey ?? '(default)',
        userId: req.user?.userId,
      })
      const result = await enrichContacts(req.params.uei, providerKey)
      res.json({ success: true, data: result })
    } catch (err) {
      next(err)
    }
  },
)

// GET /api/recipient/:uei/contacts  — cached only, no provider call
router.get('/:uei/contacts', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const profile = await getOrFetchProfile(req.params.uei)
    res.json({ success: true, data: readCachedContacts(profile) })
  } catch (err) {
    next(err)
  }
})

export default router
