// =============================================================
// Billing Routes — Subscription plans, invoices, usage, Stripe checkout
// =============================================================
import { Router, Request, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { ValidationError, NotFoundError } from '../utils/errors'
import {
  getOrSeedPlans,
  getOrCreateSubscription,
  getUsage,
  createInvoice,
} from '../services/billingService'
import {
  createLifetimeCheckoutSession,
  createAddonSubscriptionCheckoutSession,
  createSubscriptionCheckoutSession,
  createTokenPackCheckoutSession,
  createCustomerPortalSession,
  setPlanSubscriptionCancelAtPeriodEnd,
  isStripeConfigured,
  hasLifetimeAccess,
  LIFETIME_PRICE_CENTS,
  LIFETIME_PRODUCT_NAME,
  LIFETIME_MAX_SLOTS,
  isTierConfigured,
  SubscriptionTier,
  SELF_SERVE_PLAN_SLUGS,
} from '../services/stripeService'
import {
  ADDON_CATALOG,
  TOKEN_PACK_SLUGS,
  TOKEN_PACK_PRICE_CENTS,
  TOKEN_PACK_ADDONS,
  BASE_PLAN_SLUG,
  ALL_ACCESS_SLUG,
  getAddon,
  isPurchasableAddon,
  resolveAddonSlug,
} from '../config/addons'
import {
  getEntitlements,
  hasAddonEntitlement,
  computeMonthlyTokenGrant,
} from '../services/entitlementService'

const router = Router()

// -------------------------------------------------------------
// GET /api/billing/public/plans — PUBLIC (no auth). Self-serve subscription
// tiers for the marketing / landing page. Prices come from DEFAULT_PLANS so the
// public pricing never needs the Stripe Dashboard. Excludes the lifetime offer
// (its own card) and Elite (custom / contact-for-pricing). MUST stay ABOVE the
// authenticateJWT line below to remain reachable while logged out.
// -------------------------------------------------------------
router.get('/public/plans', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const SELF_SERVE = [BASE_PLAN_SLUG, ALL_ACCESS_SLUG]
    // Read-only (NOT getOrSeedPlans): this endpoint is unauthenticated, so it must
    // never write to the DB on every hit. Plans are seeded by the authenticated
    // flows (admin billing view / checkout). Only safe marketing fields are returned.
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true, slug: { in: SELF_SERVE } },
      orderBy: { sortOrder: 'asc' },
    })
    const publicPlans = plans.map((p) => ({
      slug: p.slug,
      name: p.name,
      monthlyPriceUsd: Number(p.monthlyPriceUsd),
      annualPriceUsd: Number(p.annualPriceUsd),
      maxUsers: p.maxUsers,
      maxClients: p.maxClients,
      features: p.features,
      sortOrder: p.sortOrder,
    }))
    res.json({ plans: publicPlans })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/billing/public/addons — PUBLIC (no auth). Marketing catalog of
// add-on modules for the landing page pricing section. Static from code —
// no DB or Stripe call. MUST stay above the authenticateJWT line.
// -------------------------------------------------------------
router.get('/public/addons', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: ADDON_CATALOG.map((a) => ({
        slug: a.slug,
        name: a.name,
        tagline: a.tagline,
        description: a.description,
        priceMonthly: a.priceMonthly,
        priceAnnual: a.priceAnnual,
        icon: a.icon,
        status: a.status,
        category: a.category,
      })),
    })
  } catch (err) { next(err) }
})

router.use(authenticateJWT, enforceTenantScope)

// -------------------------------------------------------------
// GET /api/billing/plans — public plan catalogue
// -------------------------------------------------------------
router.get('/plans', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const plans = await getOrSeedPlans()
    // Flag whether each tier is self-service purchasable right now (it's a
    // self-serve subscription tier and Stripe is configured). The frontend
    // shows "Coming soon" for any plan that isn't.
    const enriched = plans.map((p) => ({
      ...p,
      purchasable: isTierConfigured(p.slug as SubscriptionTier),
    }))
    // Legacy contract preserved (frontend Billing.tsx depends on top-level shape)
    res.json({ plans: enriched })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/billing/subscription — current firm subscription + usage
// -------------------------------------------------------------
router.get('/subscription', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [subscription, usage, firm] = await Promise.all([
      getOrCreateSubscription(consultingFirmId),
      getUsage(consultingFirmId),
      prisma.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { isVeteranOwned: true } }),
    ])
    const basePrice = Number(subscription.plan.monthlyPriceUsd)
    const veteranDiscount = firm?.isVeteranOwned ? Math.round(basePrice * 0.10 * 100) / 100 : 0
    const effectivePrice = Math.round((basePrice - veteranDiscount) * 100) / 100
    const lifetimeAccess = await hasLifetimeAccess(consultingFirmId)
    // Legacy top-level shape preserved + new field appended
    res.json({
      subscription,
      usage,
      veteranDiscount,
      effectivePrice,
      isVeteranOwned: firm?.isVeteranOwned ?? false,
      hasLifetimeAccess: lifetimeAccess,
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/billing/entitlements — what this firm can access (the
// frontend's single feature-gating source: base state, module list,
// all-access flag, token balance + monthly grant).
// -------------------------------------------------------------
router.get('/entitlements', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [ents, firm] = await Promise.all([
      getEntitlements(consultingFirmId),
      prisma.consultingFirm.findUnique({
        where: { id: consultingFirmId },
        select: { proposalTokens: true, purchasedAddons: true },
      }),
    ])
    res.json({
      success: true,
      data: {
        ...ents,
        tokenBalance: firm?.proposalTokens ?? 0,
        monthlyTokenGrant: computeMonthlyTokenGrant(ents),
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// POST /api/billing/subscribe — subscribe / change plan (ADMIN)
// -------------------------------------------------------------
router.post('/subscribe', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { planId, billingCycle } = req.body

    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } })
    if (!plan) throw new NotFoundError('Plan not found')

    // Paid plans MUST be purchased through Stripe checkout (which activates the
    // subscription via webhook). This endpoint may only activate a FREE plan
    // (e.g. a downgrade to the free floor). Without this guard any firm ADMIN
    // could self-grant a paid tier — enterprise/elite/lifetime — with zero
    // payment. See POST /api/billing/stripe/checkout/subscription.
    if (Number(plan.monthlyPriceUsd) > 0) {
      return res.status(402).json({
        success: false,
        error: 'Paid plans must be purchased through Stripe checkout.',
        code: 'PAYMENT_REQUIRED',
        checkoutPath: '/api/billing/stripe/checkout/subscription',
      })
    }

    const cycle: 'MONTHLY' | 'ANNUAL' = billingCycle === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY'
    const now = new Date()
    const periodEnd = cycle === 'ANNUAL'
      ? new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
      : new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())

    const existing = await prisma.subscription.findUnique({ where: { consultingFirmId } })
    const sub = existing
      ? await prisma.subscription.update({
          where: { consultingFirmId },
          data: { planId, billingCycle: cycle, status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: false, trialEndsAt: null },
          include: { plan: true },
        })
      : await prisma.subscription.create({
          data: { consultingFirmId, planId, billingCycle: cycle, status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: periodEnd },
          include: { plan: true },
        })

    res.json({ subscription: sub })
  } catch (err) { next(err) }
})

/**
 * Push a plan cancel/reactivate to Stripe when the firm has a live Stripe
 * subscription. No-op for legacy or manually-provisioned firms (no
 * stripeSubscriptionId) and when Stripe is unconfigured. Stripe errors
 * propagate — a cancellation the customer believes succeeded must not be
 * recorded locally if Stripe never received it.
 */
async function syncPlanCancellationToStripe(
  consultingFirmId: string,
  cancelAtPeriodEnd: boolean
): Promise<void> {
  if (!isStripeConfigured()) return
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { stripeSubscriptionId: true },
  })
  if (!firm?.stripeSubscriptionId) return
  await setPlanSubscriptionCancelAtPeriodEnd(firm.stripeSubscriptionId, cancelAtPeriodEnd)
}

// -------------------------------------------------------------
// PUT /api/billing/subscription/cancel — cancel at period end
//
// Mirrors the flag to Stripe first: a local-only write leaves Stripe
// charging the customer every month after they cancelled in-app, and the
// next renewal webhook syncs cancelAtPeriodEnd back from Stripe, erasing
// even the local record of the cancellation. Firms with no Stripe
// subscription (legacy/manually-provisioned) still cancel locally.
// -------------------------------------------------------------
router.put('/subscription/cancel', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    await syncPlanCancellationToStripe(consultingFirmId, true)
    const sub = await prisma.subscription.update({
      where: { consultingFirmId },
      data: { cancelAtPeriodEnd: true },
      include: { plan: true },
    })
    res.json({ subscription: sub })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// PUT /api/billing/subscription/reactivate — undo a pending cancellation
//
// Clears cancelAtPeriodEnd ONLY. It must never write `status`: doing so let
// any firm ADMIN flip an expired-trial or CANCELED subscription to ACTIVE
// with no payment, which entitlementService reads as full paid access — and
// with no live Stripe subscription behind it, no webhook would ever correct
// the state. Status transitions belong exclusively to the webhook sync.
// -------------------------------------------------------------
router.put('/subscription/reactivate', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.subscription.findUnique({
      where: { consultingFirmId },
      select: { status: true, cancelAtPeriodEnd: true },
    })
    if (!existing) throw new NotFoundError('Subscription not found')

    // Only a subscription still in good standing can be un-cancelled. A
    // CANCELED/PAST_DUE/expired one has to go back through checkout.
    if (existing.status !== 'ACTIVE' && existing.status !== 'TRIALING') {
      return res.status(402).json({
        success: false,
        error: 'This subscription can no longer be reactivated. Start a new checkout to resubscribe.',
        code: 'PLAN_REQUIRED',
      })
    }

    await syncPlanCancellationToStripe(consultingFirmId, false)
    const sub = await prisma.subscription.update({
      where: { consultingFirmId },
      data: { cancelAtPeriodEnd: false },
      include: { plan: true },
    })
    res.json({ subscription: sub })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/billing/invoices
// -------------------------------------------------------------
router.get('/invoices', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(50, Number(req.query.limit) || 20)

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where: { consultingFirmId },
        include: { lineItems: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.invoice.count({ where: { consultingFirmId } }),
    ])
    res.json({ invoices, total, page, limit })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/billing/invoices/:id
// -------------------------------------------------------------
router.get('/invoices/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, consultingFirmId: getTenantId(req) },
      include: { lineItems: true, subscription: { include: { plan: true } } },
    })
    if (!invoice) throw new NotFoundError('Invoice not found')
    res.json({ invoice })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// POST /api/billing/invoices/generate — create invoice for current period (ADMIN)
// Body: { notes?: string, force?: boolean }  // force=true bypasses duplicate guard
// -------------------------------------------------------------
router.post('/invoices/generate', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const sub = await prisma.subscription.findUnique({
      where: { consultingFirmId },
      include: { plan: true },
    })
    if (!sub) throw new ValidationError('No active subscription found')

    // Duplicate guard — refuse if a non-VOID invoice already covers this period
    // unless caller explicitly passes force: true.
    if (!req.body?.force) {
      const existing = await prisma.invoice.findFirst({
        where: {
          consultingFirmId,
          periodStart: sub.currentPeriodStart,
          periodEnd: sub.currentPeriodEnd,
          status: { not: 'VOID' },
        },
        select: { id: true, invoiceNumber: true, status: true },
      })
      if (existing) {
        return res.status(409).json({
          success: false,
          code: 'INVOICE_PERIOD_DUPLICATE',
          error: `An invoice (${existing.invoiceNumber}, ${existing.status}) already exists for this billing period. Pass force: true to create another.`,
          existing,
        })
      }
    }

    const pricePerMonth = sub.billingCycle === 'ANNUAL'
      ? Number(sub.plan.annualPriceUsd)
      : Number(sub.plan.monthlyPriceUsd)

    const dueAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const invoice = await createInvoice(consultingFirmId, sub.id, {
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
      dueAt,
      notes: req.body.notes,
      lineItems: [
        {
          description: `${sub.plan.name} Plan — ${sub.billingCycle === 'ANNUAL' ? 'Annual (billed monthly)' : 'Monthly'} subscription`,
          quantity: 1,
          unitPriceUsd: pricePerMonth,
        },
      ],
    })

    res.json({ success: true, invoice })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/billing/invoices/:id/pdf — download invoice as PDF
// -------------------------------------------------------------
router.get('/invoices/:id/pdf', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: { lineItems: true },
    })
    if (!invoice) throw new NotFoundError('Invoice not found')

    const firm = await prisma.consultingFirm.findUnique({
      where: { id: consultingFirmId },
      select: {
        name: true,
        contactEmail: true,
        brandingDisplayName: true,
        brandingPrimaryColor: true,
        brandingSecondaryColor: true,
      },
    })
    if (!firm) throw new NotFoundError('Firm not found')

    const { buildInvoicePdf } = await import('../services/invoicePdfBuilder')
    const pdfBuffer = await buildInvoicePdf({
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      dueAt: invoice.dueAt,
      createdAt: invoice.createdAt,
      paidAt: invoice.paidAt,
      subtotalUsd: Number(invoice.subtotalUsd),
      taxUsd: Number(invoice.taxUsd),
      totalUsd: Number(invoice.totalUsd),
      notes: invoice.notes,
      lineItems: invoice.lineItems.map(li => ({
        description: li.description,
        quantity: li.quantity,
        unitPriceUsd: Number(li.unitPriceUsd),
        totalUsd: Number(li.totalUsd),
      })),
      firm: {
        name: firm.name,
        displayName: firm.brandingDisplayName,
        contactEmail: firm.contactEmail,
        primaryColor: firm.brandingPrimaryColor,
        secondaryColor: firm.brandingSecondaryColor,
      },
    })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`)
    res.setHeader('Content-Length', pdfBuffer.length)
    res.send(pdfBuffer)
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// PUT /api/billing/invoices/:id/status — mark paid / void (ADMIN)
// -------------------------------------------------------------
router.put('/invoices/:id/status', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { status } = req.body
    const allowed = ['PAID', 'VOID', 'OPEN', 'UNCOLLECTIBLE']
    if (!allowed.includes(status)) throw new ValidationError(`Status must be one of: ${allowed.join(', ')}`)

    await prisma.invoice.updateMany({
      where: { id: req.params.id, consultingFirmId: getTenantId(req) },
      data: { status, paidAt: status === 'PAID' ? new Date() : null },
    })
    res.json({ success: true })
  } catch (err) { next(err) }
})

// =============================================================
// STRIPE CHECKOUT — Lifetime access + add-ons
// New endpoints follow standard contract: { success, data, error?, code? }
// =============================================================

// -------------------------------------------------------------
// GET /api/billing/stripe/catalog — public catalog (no Stripe call)
// -------------------------------------------------------------
router.get('/stripe/catalog', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: {
        configured: isStripeConfigured(),
        lifetime: {
          name: LIFETIME_PRODUCT_NAME,
          priceCents: LIFETIME_PRICE_CENTS,
          priceUsd: LIFETIME_PRICE_CENTS / 100,
        },
        // Recurring add-on modules (the single source: config/addons.ts)
        addons: ADDON_CATALOG.map(a => ({
          slug: a.slug,
          name: a.name,
          tagline: a.tagline,
          description: a.description,
          priceMonthly: a.priceMonthly,
          priceAnnual: a.priceAnnual,
          status: a.status,
          purchasable: isPurchasableAddon(a.slug) && isStripeConfigured(),
        })),
        // Self-serve recurring plans (base + all-access bundle)
        tiers: SELF_SERVE_PLAN_SLUGS.map(slug => ({
          slug,
          configured: isTierConfigured(slug),
        })),
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// POST /api/billing/stripe/checkout/lifetime — start lifetime purchase
// Body: { successUrl, cancelUrl }
// -------------------------------------------------------------
router.post('/stripe/checkout/lifetime', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!isStripeConfigured()) throw new ValidationError('Stripe is not configured on this server')

    const { successUrl, cancelUrl } = req.body
    if (!successUrl || !cancelUrl) throw new ValidationError('successUrl and cancelUrl are required')

    const consultingFirmId = getTenantId(req)

    // Idempotency: skip if firm already has lifetime access
    if (await hasLifetimeAccess(consultingFirmId)) {
      throw new ValidationError('Firm already has lifetime access')
    }

    // Cap: only 10 founders lifetime slots total
    const claimed = await prisma.consultingFirm.count({ where: { lifetimeAccessAt: { not: null } } })
    if (claimed >= LIFETIME_MAX_SLOTS) {
      throw new ValidationError(`All ${LIFETIME_MAX_SLOTS} founders lifetime slots have been claimed`)
    }

    const session = await createLifetimeCheckoutSession({
      consultingFirmId,
      successUrl,
      cancelUrl,
    })

    res.json({ success: true, data: session })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// POST /api/billing/stripe/checkout/addon — subscribe to an add-on module
// Body: { addonSlug, billingCycle?: 'MONTHLY'|'ANNUAL', successUrl?, cancelUrl? }
// Each add-on is its own recurring Stripe subscription.
// -------------------------------------------------------------
router.post('/stripe/checkout/addon', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!isStripeConfigured()) throw new ValidationError('Stripe is not configured on this server')

    const { addonSlug, billingCycle, successUrl, cancelUrl } = req.body
    if (!addonSlug) throw new ValidationError('addonSlug is required')

    const slug = resolveAddonSlug(addonSlug)
    if (!isPurchasableAddon(slug)) {
      throw new ValidationError(`'${addonSlug}' is not a purchasable add-on`)
    }

    const consultingFirmId = getTenantId(req)

    // Idempotency: no checkout when the firm is already entitled — whether by
    // direct subscription, the All Access bundle, lifetime, or comp.
    const ents = await getEntitlements(consultingFirmId)
    if (hasAddonEntitlement(ents, slug)) {
      throw new ValidationError(
        ents.allAccess
          ? 'Your plan already includes every add-on module.'
          : 'Firm already has this add-on',
      )
    }

    const appUrl = process.env.APP_URL || 'http://localhost:3000'
    const session = await createAddonSubscriptionCheckoutSession({
      consultingFirmId,
      addonSlug: slug,
      billingCycle: billingCycle === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY',
      successUrl: successUrl || `${appUrl}/billing?checkout=success&addon=${slug}`,
      cancelUrl: cancelUrl || `${appUrl}/billing?checkout=canceled`,
    })

    res.json({ success: true, data: session })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// POST /api/billing/stripe/checkout/subscription — start recurring plan
// Body: { tier: 'base'|'all_access', billingCycle?: 'MONTHLY'|'ANNUAL' }
// successUrl/cancelUrl optional — defaults to APP_URL/billing
// -------------------------------------------------------------
router.post('/stripe/checkout/subscription', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!isStripeConfigured()) throw new ValidationError('Stripe is not configured on this server')

    const { tier, billingCycle, successUrl, cancelUrl } = req.body
    if (!SELF_SERVE_PLAN_SLUGS.includes(tier)) {
      throw new ValidationError(`tier must be one of: ${SELF_SERVE_PLAN_SLUGS.join(', ')}`)
    }

    // Price comes from code (DEFAULT_PLANS) and is charged via inline price_data,
    // so there's no Stripe Dashboard price or STRIPE_PRICE_<TIER> env var to set.
    const plans = await getOrSeedPlans()
    const plan = plans.find((p) => p.slug === tier)
    if (!plan) throw new NotFoundError(`Plan '${tier}' not found`)

    const cycle: 'MONTHLY' | 'ANNUAL' = billingCycle === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY'
    // annualPriceUsd is the discounted per-month equivalent; annual billing
    // charges the full year up front.
    const unitAmountCents = cycle === 'ANNUAL'
      ? Math.round(Number(plan.annualPriceUsd) * 12 * 100)
      : Math.round(Number(plan.monthlyPriceUsd) * 100)

    const consultingFirmId = getTenantId(req)
    const appUrl = process.env.APP_URL || 'http://localhost:3000'

    const session = await createSubscriptionCheckoutSession({
      consultingFirmId,
      tier: tier as SubscriptionTier,
      unitAmountCents,
      productName: plan.name,
      billingCycle: cycle,
      successUrl: successUrl || `${appUrl}/billing?checkout=success&tier=${tier}`,
      cancelUrl: cancelUrl || `${appUrl}/billing?checkout=canceled`,
    })

    res.json({ success: true, data: session })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// POST /api/billing/stripe/checkout/token-pack — buy a token pack
// Body: { slug: 'proposal_tokens_15' | 'proposal_tokens_40' | 'proposal_tokens_120' }
// successUrl/cancelUrl optional — defaults to APP_URL/billing
// -------------------------------------------------------------
router.post('/stripe/checkout/token-pack', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!isStripeConfigured()) throw new ValidationError('Stripe is not configured on this server')

    const { slug, successUrl, cancelUrl } = req.body
    if (typeof slug !== 'string' || !TOKEN_PACK_SLUGS[slug]) {
      throw new ValidationError(`slug must be one of: ${Object.keys(TOKEN_PACK_SLUGS).join(', ')}`)
    }

    const tokenAmount = TOKEN_PACK_SLUGS[slug]
    const priceCents = TOKEN_PACK_PRICE_CENTS[slug]
    const pack = TOKEN_PACK_ADDONS.find(p => p.slug === slug)
    if (!priceCents || !pack) throw new ValidationError(`Token pack '${slug}' has no price configured`)

    const consultingFirmId = getTenantId(req)
    const appUrl = process.env.APP_URL || 'http://localhost:3000'

    const session = await createTokenPackCheckoutSession({
      consultingFirmId,
      packSlug: slug,
      packName: pack.name,
      tokenAmount,
      priceCents,
      successUrl: successUrl || `${appUrl}/billing?checkout=success&pack=${slug}`,
      cancelUrl: cancelUrl || `${appUrl}/billing?checkout=canceled`,
    })

    res.json({ success: true, data: session })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// POST /api/billing/stripe/portal — open Stripe Customer Portal
// Body: { returnUrl? }
// Customer can manage subscription, update card, view invoices.
// -------------------------------------------------------------
router.post('/stripe/portal', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!isStripeConfigured()) throw new ValidationError('Stripe is not configured on this server')

    const consultingFirmId = getTenantId(req)
    const appUrl = process.env.APP_URL || 'http://localhost:3000'

    const session = await createCustomerPortalSession({
      consultingFirmId,
      returnUrl: req.body.returnUrl || `${appUrl}/billing`,
    })

    res.json({ success: true, data: session })
  } catch (err) { next(err) }
})

export default router
