// =============================================================
// Client-portal entitlement gate — the portal is a paid add-on OF
// THE FIRM ('client_portal'), but its consumers are external client
// users whose JWT carries no consultingFirmId. This gate resolves
// the OWNING firm (ClientCompany.consultingFirmId) and checks the
// firm's entitlement, so a firm that drops the add-on locks its
// clients out on their next request — not at some future login.
//
// Response shapes:
//   client callers      403 PORTAL_UNAVAILABLE — neutral message; an
//                       external client can't fix the firm's billing,
//                       so no add-on names or prices are leaked.
//   consultant callers  403 ADDON_REQUIRED — same upsell shape as
//                       requireAddon, for the dual-auth thread routes.
// =============================================================

import { Request, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { getAddon } from '../config/addons'
import { getEntitlements, hasAddonEntitlement } from '../services/entitlementService'
import { logger } from '../utils/logger'

export const CLIENT_PORTAL_ADDON = 'client_portal'

const PORTAL_UNAVAILABLE_BODY = {
  success: false,
  code: 'PORTAL_UNAVAILABLE',
  error: 'The client portal is currently unavailable. Please contact your consulting firm.',
} as const

export async function firmHasClientPortal(consultingFirmId: string): Promise<boolean> {
  const ents = await getEntitlements(consultingFirmId)
  return hasAddonEntitlement(ents, CLIENT_PORTAL_ADDON)
}

/**
 * Entitlement check keyed by client company — used by the login route,
 * where no token exists yet. Unknown companies fail closed.
 */
export async function clientCompanyHasPortal(clientCompanyId: string): Promise<boolean> {
  const company = await prisma.clientCompany.findUnique({
    where: { id: clientCompanyId },
    select: { consultingFirmId: true },
  })
  if (!company) return false
  return firmHasClientPortal(company.consultingFirmId)
}

/**
 * Gate for routes behind authenticateClientJWT (req.clientUser) or
 * authenticateAny (req.authCtx). Fails closed: an unresolvable firm or a
 * lookup error responds 403 rather than letting the request through.
 */
export async function requireClientPortalEntitlement(req: Request, res: Response, next: NextFunction) {
  try {
    const clientCompanyId: string | undefined =
      (req as any).clientUser?.clientCompanyId ?? (req as any).authCtx?.clientCompanyId
    if (clientCompanyId) {
      if (await clientCompanyHasPortal(clientCompanyId)) return next()
      return res.status(403).json(PORTAL_UNAVAILABLE_BODY)
    }

    // Dual-auth routes: firm-side callers get the standard upsell shape.
    const consultingFirmId: string | undefined = (req as any).authCtx?.consultingFirmId
    if (consultingFirmId) {
      if (await firmHasClientPortal(consultingFirmId)) return next()
      const addon = getAddon(CLIENT_PORTAL_ADDON)
      return res.status(403).json({
        success: false,
        code: 'ADDON_REQUIRED',
        error: addon
          ? `This feature is part of the ${addon.name} add-on ($${addon.priceMonthly}/mo). Add it from the Billing page.`
          : 'This feature requires an add-on your firm has not purchased.',
        addon: CLIENT_PORTAL_ADDON,
        addonName: addon?.name ?? CLIENT_PORTAL_ADDON,
        addonPriceMonthly: addon?.priceMonthly ?? null,
      })
    }

    return res.status(403).json(PORTAL_UNAVAILABLE_BODY)
  } catch (err: any) {
    logger.error('Client portal entitlement check failed', { error: err?.message, path: req.path })
    return res.status(403).json(PORTAL_UNAVAILABLE_BODY)
  }
}
