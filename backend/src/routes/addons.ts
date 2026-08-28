import { Router, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import {
  ADDON_CATALOG,
  TOKEN_PACK_ADDONS,
  TOKEN_PACK_SLUGS,
  resolveAddonSlug,
} from '../config/addons'
import { getEntitlements, hasAddonEntitlement } from '../services/entitlementService'
import { cancelAddonStripeSubscription, isStripeConfigured } from '../services/stripeService'
import { logger } from '../utils/logger'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)

// GET /api/addons — module catalog with the firm's entitlement state
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [firm, ents, addonSubs] = await Promise.all([
      prisma.consultingFirm.findUnique({
        where: { id: consultingFirmId },
        select: { proposalTokens: true },
      }),
      getEntitlements(consultingFirmId),
      prisma.addonSubscription.findMany({ where: { consultingFirmId } }),
    ])
    const catalog = ADDON_CATALOG.map(addon => {
      const sub = addonSubs.find(s => s.addonSlug === addon.slug)
      return {
        ...addon,
        purchased: hasAddonEntitlement(ents, addon.slug),
        includedInPlan: ents.allAccess,
        subscription: sub
          ? {
              status: sub.status,
              currentPeriodEnd: sub.currentPeriodEnd,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            }
          : null,
      }
    })
    res.json({
      success: true,
      data: catalog,
      tokenPacks: TOKEN_PACK_ADDONS,
      proposalTokenBalance: firm?.proposalTokens ?? 0,
      allAccess: ents.allAccess,
      entitlementSource: ents.source,
    })
  } catch (err) { next(err) }
})

// POST /api/addons/:slug/purchase — RETIRED. Add-ons are recurring Stripe
// subscriptions now; the old direct-grant path handed out paid modules for
// free and is permanently closed.
router.post('/:slug/purchase', requireRole('ADMIN'), async (_req: AuthenticatedRequest, res: Response) => {
  return res.status(410).json({
    success: false,
    code: 'USE_STRIPE_CHECKOUT',
    error: 'Add-ons are billed through Stripe. Start a checkout via POST /api/billing/stripe/checkout/addon.',
  })
})

// DELETE /api/addons/:slug/cancel — admin only. Cancels the module's Stripe
// subscription (immediate, prorated credit) and drops the entitlement.
router.delete('/:slug/cancel', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const slug = resolveAddonSlug(req.params.slug)

    // Token packs cannot be cancelled (one-time purchase)
    if (TOKEN_PACK_SLUGS[req.params.slug] !== undefined) {
      return res.status(400).json({ success: false, error: 'Token packs are one-time purchases and cannot be cancelled.' })
    }

    const addonSub = await prisma.addonSubscription.findUnique({
      where: { consultingFirmId_addonSlug: { consultingFirmId, addonSlug: slug } },
    })

    if (addonSub && addonSub.status !== 'CANCELED') {
      // Stripe first: if the billing cancel fails we keep the entitlement so
      // the customer never loses access to something still charging them.
      if (isStripeConfigured()) {
        try {
          await cancelAddonStripeSubscription(addonSub.stripeSubscriptionId)
        } catch (err) {
          logger.error('Stripe add-on cancellation failed — entitlement left intact', {
            consultingFirmId,
            addonSlug: slug,
            stripeSubscriptionId: addonSub.stripeSubscriptionId,
            error: (err as Error).message,
          })
          return res.status(502).json({
            success: false,
            code: 'STRIPE_CANCEL_FAILED',
            error: 'Could not cancel the add-on with Stripe. Please try again or contact support.',
          })
        }
      }
      await prisma.addonSubscription.update({
        where: { id: addonSub.id },
        data: { status: 'CANCELED', cancelAtPeriodEnd: true },
      })
    }

    // Drop the entitlement cache entry (covers legacy direct grants too;
    // idempotent when the webhook already removed it).
    const firm = await prisma.consultingFirm.findUnique({
      where: { id: consultingFirmId },
      select: { purchasedAddons: true },
    })
    await prisma.consultingFirm.update({
      where: { id: consultingFirmId },
      data: {
        purchasedAddons: (firm?.purchasedAddons ?? []).filter(
          (s: string) => s !== slug && resolveAddonSlug(s) !== slug,
        ),
      },
    })
    res.json({ success: true })
  } catch (err) { next(err) }
})

export default router
