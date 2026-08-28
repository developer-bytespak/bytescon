import { Router, Request, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import type { AuthenticatedRequest } from '../types'
import { ValidationError, NotFoundError } from '../utils/errors'
import { logger } from '../utils/logger'
import {
  resolveHostToFirmId,
  isValidSubdomain,
  isValidHost,
  clearHostCache,
  clearCustomDomainsCache,
  buildPortalUrl,
  PLATFORM_ROOT_DOMAIN,
} from '../services/hostResolver'

const router = Router()

// =============================================================
// GET /api/branding/:firmId
// Fetch branding configuration for a firm (public endpoint)
// =============================================================
router.get('/:firmId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firmId } = req.params

    const firm = await prisma.consultingFirm.findUnique({
      where: { id: firmId },
      select: {
        id: true,
        name: true,
        isVeteranOwned: true,
        brandingLogoUrl: true,
        brandingPrimaryColor: true,
        brandingSecondaryColor: true,
        brandingDisplayName: true,
        brandingTagline: true,
        brandingFaviconUrl: true,
      },
    })

    if (!firm) {
      throw new NotFoundError('Firm not found')
    }

    // Return branding config with fallbacks
    const branding = {
      firmId: firm.id,
      firmName: firm.name,
      displayName: firm.brandingDisplayName || firm.name,
      tagline: firm.brandingTagline || 'Federal contracting intelligence.',
      logoUrl: firm.brandingLogoUrl || null,
      primaryColor: firm.brandingPrimaryColor || '#fbbf24',
      secondaryColor: firm.brandingSecondaryColor || '#f59e0b',
      faviconUrl: firm.brandingFaviconUrl || null,
      isVeteranOwned: firm.isVeteranOwned,
      platform: 'Bytescon',
      engine: 'Bytescon Engine',
    }

    res.json({
      success: true,
      data: branding,
    })
  } catch (err) {
    next(err)
  }
})

// =============================================================
// PUT /api/branding/admin/update
// Update branding configuration (admin only)
// =============================================================
router.put(
  '/admin/update',
  authenticateJWT,
  requireRole('ADMIN'),
  enforceTenantScope,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const firmId = getTenantId(req as AuthenticatedRequest)
      const {
        displayName,
        tagline,
        logoUrl,
        primaryColor,
        secondaryColor,
        faviconUrl,
      } = req.body

      // Validate colors are hex format
      if (primaryColor && !/^#[0-9A-Fa-f]{6}$/.test(primaryColor)) {
        throw new ValidationError('Invalid primary color format (must be #RRGGBB)')
      }
      if (secondaryColor && !/^#[0-9A-Fa-f]{6}$/.test(secondaryColor)) {
        throw new ValidationError('Invalid secondary color format (must be #RRGGBB)')
      }

      const updated = await prisma.consultingFirm.update({
        where: { id: firmId },
        data: {
          brandingDisplayName: displayName || undefined,
          brandingTagline: tagline || undefined,
          brandingLogoUrl: logoUrl || undefined,
          brandingPrimaryColor: primaryColor || undefined,
          brandingSecondaryColor: secondaryColor || undefined,
          brandingFaviconUrl: faviconUrl || undefined,
        },
        select: {
          id: true,
          name: true,
          brandingLogoUrl: true,
          brandingPrimaryColor: true,
          brandingSecondaryColor: true,
          brandingDisplayName: true,
          brandingTagline: true,
          brandingFaviconUrl: true,
        },
      })

      logger.info('Firm branding updated', {
        firmId,
        displayName: updated.brandingDisplayName,
      })

      res.json({
        success: true,
        message: 'Branding configuration updated',
        data: updated,
      })
    } catch (err) {
      next(err)
    }
  }
)

// =============================================================
// GET /api/branding/by-host/:host
// Resolve branding by Host header — used by client portal on load
// when no firmId is yet known (e.g., subdomain-only access)
// =============================================================
router.get('/by-host/:host', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const host = req.params.host

    if (!isValidHost(host)) {
      throw new ValidationError('Invalid host format')
    }

    const firmId = await resolveHostToFirmId(host)
    if (!firmId) {
      // Not an error — return platform defaults (caller renders fallback)
      return res.json({
        success: true,
        data: {
          firmId: null,
          firmName: 'Bytescon',
          displayName: 'Bytescon',
          tagline: 'Federal contracting intelligence.',
          logoUrl: null,
          primaryColor: '#fbbf24',
          secondaryColor: '#f59e0b',
          faviconUrl: null,
          isVeteranOwned: false,
          platform: 'Bytescon',
          engine: 'Bytescon Engine',
          resolvedFromHost: host,
        },
      })
    }

    const firm = await prisma.consultingFirm.findUnique({
      where: { id: firmId },
      select: {
        id: true,
        name: true,
        isVeteranOwned: true,
        brandingLogoUrl: true,
        brandingPrimaryColor: true,
        brandingSecondaryColor: true,
        brandingDisplayName: true,
        brandingTagline: true,
        brandingFaviconUrl: true,
        subdomain: true,
        customDomain: true,
        customDomainVerifiedAt: true,
      },
    })
    if (!firm) throw new NotFoundError('Firm not found')

    res.json({
      success: true,
      data: {
        firmId: firm.id,
        firmName: firm.name,
        displayName: firm.brandingDisplayName || firm.name,
        tagline: firm.brandingTagline || 'Federal contracting intelligence.',
        logoUrl: firm.brandingLogoUrl || null,
        primaryColor: firm.brandingPrimaryColor || '#fbbf24',
        secondaryColor: firm.brandingSecondaryColor || '#f59e0b',
        faviconUrl: firm.brandingFaviconUrl || null,
        isVeteranOwned: firm.isVeteranOwned,
        platform: 'Bytescon',
        engine: 'Bytescon Engine',
        subdomain: firm.subdomain,
        customDomain: firm.customDomain,
        customDomainVerified: Boolean(firm.customDomainVerifiedAt),
        resolvedFromHost: host,
      },
    })
  } catch (err) {
    next(err)
  }
})

// =============================================================
// GET /api/branding/admin/domain-config
// Returns current firm's subdomain + custom domain status (ADMIN)
// =============================================================
router.get(
  '/admin/domain-config',
  authenticateJWT,
  requireRole('ADMIN'),
  enforceTenantScope,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const firmId = getTenantId(req as AuthenticatedRequest)
      const firm = await prisma.consultingFirm.findUnique({
        where: { id: firmId },
        select: {
          subdomain: true,
          customDomain: true,
          customDomainVerifiedAt: true,
        },
      })
      if (!firm) throw new NotFoundError('Firm not found')

      const portalUrl = buildPortalUrl({
        customDomain: firm.customDomain,
        customDomainVerifiedAt: firm.customDomainVerifiedAt,
        subdomain: firm.subdomain,
      })

      res.json({
        success: true,
        data: {
          subdomain: firm.subdomain,
          customDomain: firm.customDomain,
          customDomainVerified: Boolean(firm.customDomainVerifiedAt),
          customDomainVerifiedAt: firm.customDomainVerifiedAt,
          platformRootDomain: PLATFORM_ROOT_DOMAIN,
          currentPortalUrl: portalUrl,
          dnsInstructions: firm.customDomain
            ? {
                type: 'CNAME',
                host: firm.customDomain,
                target: `app.${PLATFORM_ROOT_DOMAIN}`,
                ttl: 300,
              }
            : null,
        },
      })
    } catch (err) {
      next(err)
    }
  }
)

// =============================================================
// PUT /api/branding/admin/subdomain
// Claim or change the firm subdomain (ADMIN)
// Body: { subdomain: string | null }
// =============================================================
router.put(
  '/admin/subdomain',
  authenticateJWT,
  requireRole('ADMIN'),
  enforceTenantScope,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const firmId = getTenantId(req as AuthenticatedRequest)
      const { subdomain } = req.body

      if (subdomain !== null && (typeof subdomain !== 'string' || !isValidSubdomain(subdomain))) {
        throw new ValidationError(
          'Invalid subdomain. Must be 2-63 chars, lowercase alphanumeric or hyphen, ' +
          'not start/end with hyphen, not a reserved name (www, app, api, etc.)'
        )
      }

      const normalized = subdomain ? subdomain.toLowerCase() : null

      // Check uniqueness (Prisma will also enforce, but we want a clean error)
      if (normalized) {
        const existing = await prisma.consultingFirm.findUnique({
          where: { subdomain: normalized },
          select: { id: true },
        })
        if (existing && existing.id !== firmId) {
          throw new ValidationError('This subdomain is already in use')
        }
      }

      // Get old value for cache invalidation
      const before = await prisma.consultingFirm.findUnique({
        where: { id: firmId },
        select: { subdomain: true },
      })

      await prisma.consultingFirm.update({
        where: { id: firmId },
        data: { subdomain: normalized },
      })

      // Invalidate host cache for both old and new subdomain
      if (before?.subdomain) clearHostCache(`${before.subdomain}.${PLATFORM_ROOT_DOMAIN}`)
      if (normalized) clearHostCache(`${normalized}.${PLATFORM_ROOT_DOMAIN}`)

      logger.info('Firm subdomain updated', {
        firmId,
        oldSubdomain: before?.subdomain,
        newSubdomain: normalized,
      })

      res.json({
        success: true,
        message: normalized ? 'Subdomain claimed' : 'Subdomain released',
        data: {
          subdomain: normalized,
          portalUrl: normalized ? `https://${normalized}.${PLATFORM_ROOT_DOMAIN}/client-portal` : null,
        },
      })
    } catch (err) {
      next(err)
    }
  }
)

// =============================================================
// PUT /api/branding/admin/custom-domain
// Claim a custom domain (requires DNS verification before active)
// Body: { customDomain: string | null }
//
// Note: customDomainVerifiedAt is null on initial set — verification
// happens out-of-band (admin verifies CNAME points to app.bytescon.com
// then calls /admin/custom-domain/verify)
// =============================================================
router.put(
  '/admin/custom-domain',
  authenticateJWT,
  requireRole('ADMIN'),
  enforceTenantScope,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const firmId = getTenantId(req as AuthenticatedRequest)
      const { customDomain } = req.body

      if (customDomain !== null && (typeof customDomain !== 'string' || !isValidHost(customDomain))) {
        throw new ValidationError('Invalid custom domain. Must be a valid hostname (e.g., portal.acmefederal.com)')
      }

      const normalized = customDomain ? customDomain.toLowerCase().trim() : null

      // Reject claiming the platform root or its subdomains
      if (normalized && (
        normalized === PLATFORM_ROOT_DOMAIN ||
        normalized.endsWith(`.${PLATFORM_ROOT_DOMAIN}`)
      )) {
        throw new ValidationError(
          `Cannot claim ${PLATFORM_ROOT_DOMAIN} or its subdomains as custom domain. ` +
          `Use the subdomain endpoint instead.`
        )
      }

      // Uniqueness check
      if (normalized) {
        const existing = await prisma.consultingFirm.findUnique({
          where: { customDomain: normalized },
          select: { id: true },
        })
        if (existing && existing.id !== firmId) {
          throw new ValidationError('This domain is already claimed by another firm')
        }
      }

      const before = await prisma.consultingFirm.findUnique({
        where: { id: firmId },
        select: { customDomain: true },
      })

      await prisma.consultingFirm.update({
        where: { id: firmId },
        data: {
          customDomain: normalized,
          // Reset verification when domain changes
          customDomainVerifiedAt: normalized === before?.customDomain ? undefined : null,
        },
      })

      if (before?.customDomain) clearHostCache(before.customDomain)
      if (normalized) clearHostCache(normalized)
      clearCustomDomainsCache()

      logger.info('Firm custom domain updated', {
        firmId,
        oldDomain: before?.customDomain,
        newDomain: normalized,
      })

      res.json({
        success: true,
        message: normalized
          ? 'Custom domain saved. Configure DNS CNAME to verify.'
          : 'Custom domain removed',
        data: {
          customDomain: normalized,
          dnsInstructions: normalized
            ? {
                type: 'CNAME',
                host: normalized,
                target: `app.${PLATFORM_ROOT_DOMAIN}`,
                ttl: 300,
              }
            : null,
        },
      })
    } catch (err) {
      next(err)
    }
  }
)

// =============================================================
// POST /api/branding/admin/custom-domain/verify
// Verify CNAME resolves correctly (DNS lookup)
// =============================================================
router.post(
  '/admin/custom-domain/verify',
  authenticateJWT,
  requireRole('ADMIN'),
  enforceTenantScope,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const firmId = getTenantId(req as AuthenticatedRequest)
      const firm = await prisma.consultingFirm.findUnique({
        where: { id: firmId },
        select: { customDomain: true },
      })
      if (!firm?.customDomain) {
        throw new ValidationError('No custom domain set for this firm')
      }

      const expectedTarget = `app.${PLATFORM_ROOT_DOMAIN}`

      // Perform DNS resolution (CNAME or A record check)
      const dns = await import('dns/promises')
      let verified = false
      let resolvedTo: string[] = []

      try {
        const cnames = await dns.resolveCname(firm.customDomain).catch(() => [])
        resolvedTo = cnames
        verified = cnames.some(c => c.toLowerCase() === expectedTarget.toLowerCase())
      } catch {
        // CNAME lookup failed — try A record fallback (some setups use ALIAS)
        try {
          const aRecords = await dns.resolve4(firm.customDomain)
          const expectedIps: string[] = await dns.resolve4(expectedTarget).catch(() => [] as string[])
          resolvedTo = aRecords
          verified = aRecords.length > 0 && expectedIps.length > 0 &&
            aRecords.some(ip => expectedIps.includes(ip))
        } catch (err: any) {
          logger.info('Custom domain DNS lookup failed', {
            firmId,
            domain: firm.customDomain,
            error: err.message,
          })
        }
      }

      if (verified) {
        await prisma.consultingFirm.update({
          where: { id: firmId },
          data: { customDomainVerifiedAt: new Date() },
        })
        clearHostCache(firm.customDomain)
        clearCustomDomainsCache()
        logger.info('Custom domain verified', { firmId, domain: firm.customDomain })
      }

      res.json({
        success: true,
        data: {
          verified,
          customDomain: firm.customDomain,
          expectedTarget,
          resolvedTo,
          message: verified
            ? 'Domain verified — your portal is now live at this URL.'
            : `DNS does not yet point to ${expectedTarget}. Check your CNAME record and retry in a few minutes (DNS propagation takes time).`,
        },
      })
    } catch (err) {
      next(err)
    }
  }
)

export default router
