// =============================================================
// Add-on gate middleware — enforcement layer for the $99-base +
// modular add-ons model. Replaces the old tier feature gates.
//
//   requireActiveBase       402 PLAN_REQUIRED  when the firm has no
//                           active base subscription (trial expired,
//                           past-due, canceled, or never subscribed).
//   requireAddon(slug)      403 ADDON_REQUIRED when the firm's
//                           entitlements don't include the module.
//
// Both ride entitlementService (one DB resolve per request via the
// request cache), so owner-comp, lifetime, trial, and bundle firms
// pass every gate automatically.
// =============================================================

import { Response, NextFunction } from 'express'
import { AuthenticatedRequest } from '../types'
import { getTenantId } from './tenant'
import { getAddon } from '../config/addons'
import {
  getEntitlementsForRequest,
  hasAddonEntitlement,
} from '../services/entitlementService'

export async function requireActiveBase(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const consultingFirmId = getTenantId(req)
    const ents = await getEntitlementsForRequest(req, consultingFirmId)
    if (!ents.baseActive) {
      return res.status(402).json({
        success: false,
        code: 'PLAN_REQUIRED',
        error:
          ents.subscriptionStatus === 'TRIALING'
            ? 'Your free trial has ended. Subscribe to the Bytescon base plan ($99/mo) to keep searching and scoring contracts.'
            : 'An active Bytescon base plan ($99/mo) is required. Subscribe from the Billing page to continue.',
        subscriptionStatus: ents.subscriptionStatus,
      })
    }
    next()
  } catch (err) {
    next(err)
  }
}

// Factory — gates a route (or whole router) behind a paid add-on module.
export function requireAddon(addonSlug: string) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)
      const ents = await getEntitlementsForRequest(req, consultingFirmId)
      if (!hasAddonEntitlement(ents, addonSlug)) {
        const addon = getAddon(addonSlug)
        return res.status(403).json({
          success: false,
          code: 'ADDON_REQUIRED',
          error: addon
            ? `This feature is part of the ${addon.name} add-on ($${addon.priceMonthly}/mo). Add it from the Billing page.`
            : 'This feature requires an add-on your firm has not purchased.',
          addon: addonSlug,
          addonName: addon?.name ?? addonSlug,
          addonPriceMonthly: addon?.priceMonthly ?? null,
        })
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}
