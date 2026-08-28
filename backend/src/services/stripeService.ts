// =============================================================
// Stripe Service — Checkout sessions, webhook handling, audit
// =============================================================
// Compliance: All state transitions logged to ComplianceLog.
// Idempotency: every webhook delivery atomically claims its event.id
//   in stripe_webhook_events before any handler runs (handleWebhookEvent).
// Tenancy: Always scoped by consultingFirmId from JWT (caller).
// =============================================================

import Stripe from 'stripe'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { getAddon, isPurchasableAddon, resolveAddonSlug, ALL_ACCESS_SLUG, BASE_PLAN_SLUG } from '../config/addons'
import { activateLifetime, refreshProposalTokens } from './billingService'

// -------------------------------------------------------------
// Local types — Stripe v22 dropped the Stripe.X namespace pattern,
// so we type only what we consume here. Keeps us decoupled from
// Stripe's internal TypeScript reorganization.
// -------------------------------------------------------------

interface StripeEvent {
  id: string
  type: string
  data: { object: any }
}

interface StripeCheckoutSession {
  id: string
  url: string | null
  amount_total: number | null
  metadata?: { [key: string]: string } | null
}

interface StripeCharge {
  id: string
  amount_refunded: number | null
  metadata?: { [key: string]: string } | null
}

interface StripeSubscription {
  id: string
  status: string
  customer: string
  metadata?: { [key: string]: string } | null
  current_period_end?: number
  cancel_at_period_end?: boolean
}

// -------------------------------------------------------------
// Stripe Client (lazy init — env vars required at first call)
// -------------------------------------------------------------

let stripeClient: any = null

export function getStripe(): any {
  if (stripeClient) return stripeClient

  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }

  stripeClient = new Stripe(key, {
    appInfo: { name: 'Bytescon Bytescon Engine', version: '1.0.0' },
  })

  return stripeClient
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

// -------------------------------------------------------------
// Lifetime Access Pricing (cents)
// -------------------------------------------------------------

export const LIFETIME_PRICE_CENTS = 250000 // $2,500.00
export const LIFETIME_PRODUCT_NAME = 'Bytescon Bytescon Engine — Founders Lifetime Access'
export const LIFETIME_MAX_SLOTS = 20

// -------------------------------------------------------------
// Recurring plans — the single-plan model sells exactly two recurring
// plans (base $99 / all_access $199) plus per-module add-on
// subscriptions from config/addons.ts. Prices live in code
// (billingService DEFAULT_PLANS + the add-on catalog) and are charged
// via inline Stripe price_data at checkout — no Dashboard products.
// -------------------------------------------------------------

export type SubscriptionTier = typeof BASE_PLAN_SLUG | typeof ALL_ACCESS_SLUG

export const SELF_SERVE_PLAN_SLUGS: SubscriptionTier[] = [BASE_PLAN_SLUG, ALL_ACCESS_SLUG]

// A plan is purchasable when it's one of the self-serve plans and Stripe is
// wired up (secret key present).
export function isTierConfigured(tier: string): tier is SubscriptionTier {
  return SELF_SERVE_PLAN_SLUGS.includes(tier as SubscriptionTier) && isStripeConfigured()
}

// -------------------------------------------------------------
// Customer creation (idempotent — uses stripeCustomerId on firm)
// -------------------------------------------------------------

export async function getOrCreateCustomer(consultingFirmId: string): Promise<string> {
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { id: true, name: true, contactEmail: true, stripeCustomerId: true },
  })
  if (!firm) throw new Error('Firm not found')

  if (firm.stripeCustomerId) return firm.stripeCustomerId

  const stripe = getStripe()
  const customer = await stripe.customers.create({
    email: firm.contactEmail,
    name: firm.name,
    metadata: { consultingFirmId: firm.id },
  })

  await prisma.consultingFirm.update({
    where: { id: firm.id },
    data: { stripeCustomerId: customer.id },
  })

  logger.info('Stripe customer created', { firmId: firm.id, customerId: customer.id })

  return customer.id
}

// -------------------------------------------------------------
// Lifetime checkout session
// -------------------------------------------------------------

export async function createLifetimeCheckoutSession(opts: {
  consultingFirmId: string
  successUrl: string
  cancelUrl: string
}): Promise<{ sessionId: string; url: string }> {
  const claimed = await prisma.consultingFirm.count({ where: { lifetimeAccessAt: { not: null } } })
  if (claimed >= LIFETIME_MAX_SLOTS) {
    throw new Error(`All ${LIFETIME_MAX_SLOTS} founders lifetime slots have been claimed`)
  }

  const stripe = getStripe()
  const customerId = await getOrCreateCustomer(opts.consultingFirmId)

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: LIFETIME_PRICE_CENTS,
          product_data: {
            name: LIFETIME_PRODUCT_NAME,
            description: 'One-time payment for lifetime platform access. Add-ons billed separately.',
          },
        },
        quantity: 1,
      },
    ],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    metadata: {
      consultingFirmId: opts.consultingFirmId,
      productType: 'lifetime',
    },
    payment_intent_data: {
      metadata: {
        consultingFirmId: opts.consultingFirmId,
        productType: 'lifetime',
      },
    },
  })

  if (!session.url) {
    throw new Error('Stripe checkout session has no URL')
  }

  logger.info('Stripe checkout session created', {
    firmId: opts.consultingFirmId,
    sessionId: session.id,
    productType: 'lifetime',
  })

  return { sessionId: session.id, url: session.url }
}

// -------------------------------------------------------------
// Token pack checkout session — uses inline price_data, credited
// via webhook on checkout.session.completed
// -------------------------------------------------------------

export async function createTokenPackCheckoutSession(opts: {
  consultingFirmId: string
  packSlug: string
  packName: string
  tokenAmount: number
  priceCents: number
  successUrl: string
  cancelUrl: string
}): Promise<{ sessionId: string; url: string }> {
  const stripe = getStripe()
  const customerId = await getOrCreateCustomer(opts.consultingFirmId)

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: opts.priceCents,
          product_data: {
            name: opts.packName,
            description: `${opts.tokenAmount} proposal tokens — never expire.`,
          },
        },
        quantity: 1,
      },
    ],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    metadata: {
      consultingFirmId: opts.consultingFirmId,
      productType: 'token_pack',
      packSlug: opts.packSlug,
      tokenAmount: String(opts.tokenAmount),
    },
    payment_intent_data: {
      metadata: {
        consultingFirmId: opts.consultingFirmId,
        productType: 'token_pack',
        packSlug: opts.packSlug,
        tokenAmount: String(opts.tokenAmount),
      },
    },
  })

  if (!session.url) throw new Error('Stripe checkout session has no URL')

  logger.info('Stripe token pack checkout session created', {
    firmId: opts.consultingFirmId,
    sessionId: session.id,
    packSlug: opts.packSlug,
    tokenAmount: opts.tokenAmount,
  })

  return { sessionId: session.id, url: session.url }
}

// -------------------------------------------------------------
// Add-on module subscription checkout — each module is its own
// recurring Stripe subscription so purchase, cancel, and dunning are
// independent per module. Fulfillment happens on
// customer.subscription.created (metadata productType=addon_subscription).
// -------------------------------------------------------------

export async function createAddonSubscriptionCheckoutSession(opts: {
  consultingFirmId: string
  addonSlug: string
  billingCycle?: 'MONTHLY' | 'ANNUAL'
  successUrl: string
  cancelUrl: string
}): Promise<{ sessionId: string; url: string }> {
  const slug = resolveAddonSlug(opts.addonSlug)
  const addon = getAddon(slug)
  if (!addon || !isPurchasableAddon(slug)) throw new Error(`Unknown or unavailable addon: ${opts.addonSlug}`)

  const stripe = getStripe()
  const customerId = await getOrCreateCustomer(opts.consultingFirmId)

  const annual = opts.billingCycle === 'ANNUAL'
  // priceAnnual is the discounted per-month equivalent; annual checkout bills
  // the full year up front at that rate.
  const unitAmountCents = annual
    ? Math.round(addon.priceAnnual * 12 * 100)
    : Math.round(addon.priceMonthly * 100)

  const metadata = {
    consultingFirmId: opts.consultingFirmId,
    productType: 'addon_subscription',
    addonSlug: slug,
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: unitAmountCents,
          recurring: { interval: annual ? 'year' : 'month' },
          product_data: {
            name: `${addon.name} (add-on)`,
            description: addon.tagline,
          },
        },
        quantity: 1,
      },
    ],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    metadata,
    subscription_data: { metadata },
  })

  if (!session.url) {
    throw new Error('Stripe checkout session has no URL')
  }

  logger.info('Stripe addon subscription checkout created', {
    firmId: opts.consultingFirmId,
    sessionId: session.id,
    addonSlug: slug,
    billingCycle: annual ? 'ANNUAL' : 'MONTHLY',
  })

  return { sessionId: session.id, url: session.url }
}

// Cancel a firm's add-on subscription in Stripe (immediate, with proration
// credit). Used by the add-on cancel endpoint and the all-access sweep.
export async function cancelAddonStripeSubscription(stripeSubscriptionId: string): Promise<void> {
  const stripe = getStripe()
  await stripe.subscriptions.cancel(stripeSubscriptionId, { prorate: true })
}

/**
 * Set (or clear) cancel-at-period-end on a firm's PLAN subscription in Stripe.
 *
 * The in-app cancel/reactivate controls must reach Stripe — a local-only flag
 * leaves Stripe billing the customer every month after they cancelled, and the
 * next renewal's customer.subscription.updated syncs cancelAtPeriodEnd back
 * from Stripe and erases the local flag too.
 *
 * Returns the updated Stripe subscription so callers can sync from the source
 * of truth rather than assuming the write landed.
 */
export async function setPlanSubscriptionCancelAtPeriodEnd(
  stripeSubscriptionId: string,
  cancelAtPeriodEnd: boolean
): Promise<{ cancel_at_period_end: boolean; status: string }> {
  const stripe = getStripe()
  return stripe.subscriptions.update(stripeSubscriptionId, {
    cancel_at_period_end: cancelAtPeriodEnd,
  })
}

// -------------------------------------------------------------
// Recurring subscription checkout — inline price_data (amount from code,
// DEFAULT_PLANS). No Stripe Dashboard product/price or STRIPE_PRICE_<TIER>
// env var needed. Mode 'subscription' creates a Stripe Subscription on pay.
// -------------------------------------------------------------

export async function createSubscriptionCheckoutSession(opts: {
  consultingFirmId: string
  tier: SubscriptionTier
  unitAmountCents: number
  productName: string
  billingCycle?: 'MONTHLY' | 'ANNUAL'
  successUrl: string
  cancelUrl: string
}): Promise<{ sessionId: string; url: string }> {
  const stripe = getStripe()
  const customerId = await getOrCreateCustomer(opts.consultingFirmId)

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [
      {
        // Inline recurring price — Stripe builds it on the fly from the amount
        // we define in code, so there's no Dashboard product/price to manage.
        price_data: {
          currency: 'usd',
          unit_amount: opts.unitAmountCents,
          recurring: { interval: opts.billingCycle === 'ANNUAL' ? 'year' : 'month' },
          product_data: { name: opts.productName },
        },
        quantity: 1,
      },
    ],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    metadata: {
      consultingFirmId: opts.consultingFirmId,
      productType: 'subscription',
      tier: opts.tier,
    },
    subscription_data: {
      metadata: {
        consultingFirmId: opts.consultingFirmId,
        productType: 'subscription',
        tier: opts.tier,
      },
    },
  })

  if (!session.url) {
    throw new Error('Stripe checkout session has no URL')
  }

  logger.info('Stripe subscription checkout created', {
    firmId: opts.consultingFirmId,
    sessionId: session.id,
    tier: opts.tier,
  })

  return { sessionId: session.id, url: session.url }
}

// -------------------------------------------------------------
// Customer Portal session — lets customers manage their subscription
// (update card, cancel, view invoices) without leaving Stripe.
// -------------------------------------------------------------

export async function createCustomerPortalSession(opts: {
  consultingFirmId: string
  returnUrl: string
}): Promise<{ url: string }> {
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: opts.consultingFirmId },
    select: { stripeCustomerId: true },
  })
  if (!firm?.stripeCustomerId) {
    throw new Error('Firm has no Stripe customer record yet — purchase something first')
  }

  const stripe = getStripe()
  const session = await stripe.billingPortal.sessions.create({
    customer: firm.stripeCustomerId,
    return_url: opts.returnUrl,
  })

  logger.info('Stripe customer portal session created', {
    firmId: opts.consultingFirmId,
    sessionId: session.id,
  })

  return { url: session.url }
}

// -------------------------------------------------------------
// Webhook signature verification
// -------------------------------------------------------------

export function verifyWebhookSignature(payload: Buffer, signature: string): StripeEvent {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured')
  }
  return getStripe().webhooks.constructEvent(payload, signature, secret) as StripeEvent
}

// -------------------------------------------------------------
// Webhook event handler
// Idempotent: each delivery must atomically claim its event.id in
// stripe_webhook_events (unique constraint) before any handler runs.
// The previous read-then-write check on ComplianceLog let two
// concurrent retries of the same event both pass, double-crediting
// token packs. All state changes logged to ComplianceLog.
// -------------------------------------------------------------

// A PROCESSING claim older than this is presumed dead (process crashed
// mid-handler) and may be reclaimed by a later Stripe retry.
const STALE_CLAIM_MS = 5 * 60 * 1000

type ClaimResult =
  | { claimed: true }
  | { claimed: false; reason: 'already_processed' | 'in_progress' }

async function claimWebhookEvent(event: StripeEvent): Promise<ClaimResult> {
  try {
    await prisma.stripeWebhookEvent.create({
      data: { eventId: event.id, eventType: event.type },
    })
    return { claimed: true }
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err // not a unique-violation — real failure
  }

  // Another delivery holds (or held) the claim. Reclaim only when that
  // attempt failed or died mid-flight; updateMany is atomic, so of N
  // concurrent retries exactly one wins the reclaim.
  const reclaimed = await prisma.stripeWebhookEvent.updateMany({
    where: {
      eventId: event.id,
      OR: [
        { status: 'FAILED' },
        { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
      ],
    },
    data: { status: 'PROCESSING', error: null },
  })
  if (reclaimed.count > 0) return { claimed: true }

  const row = await prisma.stripeWebhookEvent.findUnique({
    where: { eventId: event.id },
    select: { status: true },
  })
  if (row?.status === 'COMPLETED') return { claimed: false, reason: 'already_processed' }
  // Still PROCESSING (or the row vanished): a concurrent delivery is
  // mid-flight. Reported as retriable so Stripe redelivers if it dies.
  return { claimed: false, reason: 'in_progress' }
}

async function markClaim(eventId: string, status: 'COMPLETED' | 'FAILED', error?: string): Promise<void> {
  await prisma.stripeWebhookEvent
    .update({ where: { eventId }, data: { status, error: error?.slice(0, 1000) ?? null } })
    .catch((err: Error) =>
      logger.error(`Failed to mark webhook event ${status}`, { eventId, error: err.message }),
    )
}

export async function handleWebhookEvent(event: StripeEvent): Promise<{ processed: boolean; reason?: string }> {
  const claim = await claimWebhookEvent(event)
  if (!claim.claimed) {
    logger.info('Stripe webhook event not claimed', { eventId: event.id, reason: claim.reason })
    return { processed: false, reason: claim.reason }
  }

  try {
    // Deliveries processed before the claim table existed marked themselves
    // in ComplianceLog only — honor those markers so an event from before the
    // deploy can't re-apply.
    const legacyMarker = await prisma.complianceLog.findFirst({
      where: { entityType: 'OTHER', entityId: event.id },
      select: { id: true },
    })
    if (legacyMarker) {
      await markClaim(event.id, 'COMPLETED')
      logger.info('Stripe webhook already processed (legacy marker)', { eventId: event.id })
      return { processed: false, reason: 'already_processed' }
    }

    const result = await dispatchWebhookEvent(event)
    // If this mark fails the claim stays PROCESSING, but we still report
    // success: Stripe got its 2xx, so no retry arrives to re-apply anything.
    await markClaim(event.id, 'COMPLETED')
    return result
  } catch (err: any) {
    // Release the claim as FAILED so the Stripe retry (the route returns 500)
    // can reclaim and re-run. Handlers keep their non-idempotent writes in a
    // single transaction, so a FAILED event has applied nothing.
    await markClaim(event.id, 'FAILED', String(err?.message ?? err))
    throw err
  }
}

async function dispatchWebhookEvent(event: StripeEvent): Promise<{ processed: boolean; reason?: string }> {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(event)

    case 'charge.refunded':
      return handleRefund(event)

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return handleSubscriptionUpsert(event)

    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(event)

    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(event)

    // Stripe emits invoice.paid alongside invoice.payment_succeeded (and for
    // out-of-band payments only invoice.paid); both recover the same way and
    // the handler is idempotent, so accept whichever the endpoint subscribes.
    case 'invoice.payment_succeeded':
    case 'invoice.paid':
      return handleInvoicePaymentSucceeded(event)

    default:
      logger.info('Stripe webhook received (no handler)', { eventId: event.id, type: event.type })
      return { processed: false, reason: 'no_handler' }
  }
}

async function handleCheckoutCompleted(event: StripeEvent): Promise<{ processed: boolean }> {
  const session = event.data.object as StripeCheckoutSession
  const consultingFirmId = session.metadata?.consultingFirmId
  const productType = session.metadata?.productType

  if (!consultingFirmId) {
    logger.error('Stripe checkout completed without firmId metadata', { eventId: event.id })
    return { processed: false }
  }

  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { id: true, purchasedAddons: true, lifetimeAccessAt: true },
  })
  if (!firm) {
    logger.error('Stripe checkout for unknown firm', { firmId: consultingFirmId, eventId: event.id })
    return { processed: false }
  }

  // All fulfillment writes + the audit row commit atomically: a FAILED claim
  // therefore means nothing was applied, so a Stripe retry can safely re-run
  // this handler (the token-pack increment is NOT idempotent on its own).
  await prisma.$transaction(async (tx) => {
    if (productType === 'lifetime') {
      await tx.consultingFirm.update({
        where: { id: consultingFirmId },
        data: { lifetimeAccessAt: firm.lifetimeAccessAt ?? new Date() },
      })
      // Provision the lifetime entitlement: ACTIVE 99-year subscription on the
      // beta_lifetime plan + the 200-token founder grant. Idempotent (upsert),
      // and a failure here propagates so Stripe retries the whole event.
      await activateLifetime(consultingFirmId, tx)
    } else if (productType === 'addon') {
      // Legacy one-time add-on purchases (pre single-plan model). Kept so any
      // checkout session started before the deploy still fulfills.
      const addonSlug = session.metadata?.addonSlug
      if (addonSlug && !firm.purchasedAddons.includes(addonSlug)) {
        await tx.consultingFirm.update({
          where: { id: consultingFirmId },
          data: { purchasedAddons: { push: addonSlug } },
        })
      }
    } else if (productType === 'addon_subscription') {
      // Recurring add-on module — fulfillment happens on the
      // customer.subscription.created event that follows; log for audit only.
      logger.info('Add-on subscription checkout completed (subscription event will follow)', {
        firmId: consultingFirmId,
        addonSlug: session.metadata?.addonSlug,
        sessionId: session.id,
      })
    } else if (productType === 'subscription') {
      // Subscription created — Stripe will also fire customer.subscription.created
      // which is the canonical place to capture stripeSubscriptionId. We just
      // log here for the audit trail. Tier metadata is on the subscription too.
      logger.info('Subscription checkout completed (subscription event will follow)', {
        firmId: consultingFirmId,
        tier: session.metadata?.tier,
        sessionId: session.id,
      })
    } else if (productType === 'token_pack') {
      const tokenAmount = parseInt(session.metadata?.tokenAmount ?? '0', 10)
      if (tokenAmount > 0) {
        await tx.consultingFirm.update({
          where: { id: consultingFirmId },
          data: { proposalTokens: { increment: tokenAmount } },
        })
        logger.info('Token pack credited', {
          firmId: consultingFirmId,
          packSlug: session.metadata?.packSlug,
          tokenAmount,
        })
      } else {
        logger.error('Token pack checkout without tokenAmount metadata', {
          firmId: consultingFirmId,
          sessionId: session.id,
        })
      }
    }

    // Audit trail
    await tx.complianceLog.create({
      data: {
        consultingFirmId,
        entityType: 'OTHER',
        entityId: event.id,
        fromStatus: 'PENDING',
        toStatus: 'COMPLETED',
        reason: `Stripe checkout completed: ${productType}${session.metadata?.addonSlug ? ` (${session.metadata.addonSlug})` : ''} — $${(session.amount_total ?? 0) / 100}`,
        triggeredBy: `stripe-webhook:${session.id}`,
      },
    })
  })

  logger.info('Stripe checkout processed', {
    firmId: consultingFirmId,
    productType,
    sessionId: session.id,
    amount: session.amount_total,
  })

  return { processed: true }
}

async function handleRefund(event: StripeEvent): Promise<{ processed: boolean }> {
  const charge = event.data.object as StripeCharge
  const consultingFirmId = charge.metadata?.consultingFirmId
  if (!consultingFirmId) {
    logger.warn('Stripe refund without firmId metadata', { eventId: event.id })
    return { processed: false }
  }

  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { purchasedAddons: true, proposalTokens: true },
  })
  if (!firm) {
    logger.warn('Stripe refund for unknown firm', { consultingFirmId, eventId: event.id })
    return { processed: false }
  }

  // Reverse the value that was refunded. The checkout sets productType (+ slug /
  // amount) in metadata; revoke only what we can positively identify so we never
  // over-revoke. Anything ambiguous is flagged for manual review.
  // Reversal + audit row commit atomically so a FAILED claim means nothing was
  // applied and a Stripe retry can safely re-run (the token debit is a
  // read-compute-write and would double-debit on a partial re-run).
  const productType = charge.metadata?.productType
  await prisma.$transaction(async (tx) => {
    if (productType === 'lifetime') {
      await tx.consultingFirm.update({ where: { id: consultingFirmId }, data: { lifetimeAccessAt: null } })
    } else if (productType === 'addon') {
      const addonSlug = charge.metadata?.addonSlug
      if (addonSlug && firm.purchasedAddons.includes(addonSlug)) {
        await tx.consultingFirm.update({
          where: { id: consultingFirmId },
          data: { purchasedAddons: firm.purchasedAddons.filter((a) => a !== addonSlug) },
        })
      }
    } else if (productType === 'token_pack') {
      const tokenAmount = parseInt(charge.metadata?.tokenAmount ?? '0', 10)
      if (tokenAmount > 0) {
        await tx.consultingFirm.update({
          where: { id: consultingFirmId },
          data: { proposalTokens: Math.max(0, firm.proposalTokens - tokenAmount) },
        })
      }
    } else if (productType === 'subscription') {
      await tx.subscription.updateMany({
        where: { consultingFirmId },
        data: { status: 'CANCELED' },
      })
    } else {
      logger.warn('Stripe refund: productType not identifiable from charge metadata — access NOT auto-revoked, manual review required', {
        consultingFirmId,
        chargeId: charge.id,
      })
    }

    await tx.complianceLog.create({
      data: {
        consultingFirmId,
        entityType: 'OTHER',
        entityId: event.id,
        fromStatus: 'COMPLETED',
        toStatus: 'REFUNDED',
        reason: `Stripe refund processed — $${(charge.amount_refunded ?? 0) / 100}`,
        triggeredBy: `stripe-webhook:${charge.id}`,
      },
    })
  })

  logger.info('Stripe refund processed', { firmId: consultingFirmId, chargeId: charge.id, productType: productType ?? 'unknown' })
  return { processed: true }
}

// -------------------------------------------------------------
// Subscription lifecycle handlers
// customer.subscription.created — subscription just created
// customer.subscription.updated — plan change, period renewal, status change
// -------------------------------------------------------------

// Map a Stripe subscription status onto the local SubscriptionStatus enum.
// Conservative: anything not clearly active/trialing is treated as a
// non-good-standing state so tierGate downgrades to the free floor.
export function mapStripeSubscriptionStatus(
  stripeStatus: string,
): 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED' {
  switch (stripeStatus) {
    case 'active':
      return 'ACTIVE'
    case 'trialing':
      return 'TRIALING'
    case 'canceled':
    case 'incomplete_expired':
      return 'CANCELED'
    default:
      // past_due, unpaid, incomplete, paused, or anything unrecognized
      return 'PAST_DUE'
  }
}

async function handleSubscriptionUpsert(event: StripeEvent): Promise<{ processed: boolean }> {
  const sub = event.data.object as StripeSubscription
  const consultingFirmId = sub.metadata?.consultingFirmId
  if (!consultingFirmId) {
    logger.warn('Stripe subscription event without firmId metadata', { eventId: event.id, subId: sub.id })
    return { processed: false }
  }

  // Add-on module subscriptions have their own lifecycle — one Stripe
  // subscription per module, never touching the firm's plan subscription.
  if (sub.metadata?.productType === 'addon_subscription') {
    return handleAddonSubscriptionUpsert(event, sub, consultingFirmId)
  }

  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { id: true, stripeSubscriptionId: true },
  })
  if (!firm) {
    logger.error('Stripe subscription for unknown firm', { firmId: consultingFirmId, subId: sub.id })
    return { processed: false }
  }

  // Stale-event guard: after a plan switch the firm points at a NEW Stripe
  // subscription; an .updated event still arriving for the superseded one
  // must not clobber the current plan state.
  const isCreatedEvent = event.type === 'customer.subscription.created'
  if (!isCreatedEvent && firm.stripeSubscriptionId && firm.stripeSubscriptionId !== sub.id) {
    logger.info('Ignoring subscription event for superseded plan subscription', {
      firmId: consultingFirmId,
      eventSubId: sub.id,
      currentSubId: firm.stripeSubscriptionId,
    })
    await prisma.complianceLog.create({
      data: {
        consultingFirmId,
        entityType: 'OTHER',
        entityId: event.id,
        fromStatus: 'PENDING',
        toStatus: 'IGNORED',
        reason: `Stripe subscription event for superseded subscription ${sub.id} ignored`,
        triggeredBy: `stripe-webhook:${sub.id}`,
      },
    })
    return { processed: true }
  }

  // The previous plan subscription (if any) is superseded by this one and
  // must be canceled in Stripe or the customer gets double-billed.
  const supersededSubId =
    isCreatedEvent && firm.stripeSubscriptionId && firm.stripeSubscriptionId !== sub.id
      ? firm.stripeSubscriptionId
      : null

  // Persist stripeSubscriptionId (idempotent — same value on updates)
  if (firm.stripeSubscriptionId !== sub.id) {
    await prisma.consultingFirm.update({
      where: { id: consultingFirmId },
      data: { stripeSubscriptionId: sub.id },
    })
  }

  // Sync the local Subscription row that tierGate.getFirmPlan reads. Without
  // this, a paid Stripe subscription (create / plan change / renewal / status
  // change) never applied the purchased tier, and cancellations/past-due were
  // never enforced locally. Tier comes from the subscription metadata set at
  // checkout; plan.slug is unique.
  const tier = sub.metadata?.tier
  if (tier) {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { slug: tier } })
    if (plan) {
      const localStatus = mapStripeSubscriptionStatus(sub.status)
      const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000)
        : new Date(Date.now() + 31 * 24 * 60 * 60 * 1000)
      await prisma.subscription.upsert({
        where: { consultingFirmId },
        update: {
          planId: plan.id,
          status: localStatus,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
        },
        create: {
          consultingFirmId,
          planId: plan.id,
          status: localStatus,
          currentPeriodStart: new Date(),
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
        },
      })
    } else {
      logger.error('Stripe subscription tier has no matching local plan — tier NOT applied', {
        firmId: consultingFirmId,
        tier,
        subId: sub.id,
      })
    }
  } else {
    logger.error('Stripe subscription event missing tier metadata — local tier NOT synced', {
      firmId: consultingFirmId,
      subId: sub.id,
    })
  }

  // Cancel the superseded plan subscription (prorated credit). Never fail the
  // webhook over this — the new plan is already applied; a leaked old sub is
  // recoverable from the Stripe dashboard and is logged loudly.
  if (supersededSubId) {
    try {
      await getStripe().subscriptions.cancel(supersededSubId, { prorate: true })
      logger.info('Superseded plan subscription canceled in Stripe', {
        firmId: consultingFirmId,
        canceledSubId: supersededSubId,
        newSubId: sub.id,
      })
    } catch (err) {
      logger.error('Failed to cancel superseded plan subscription — MANUAL REVIEW (double-billing risk)', {
        firmId: consultingFirmId,
        supersededSubId,
        error: (err as Error).message,
      })
    }
  }

  // All Access includes every module — sweep-cancel the firm's individual
  // add-on subscriptions so they stop billing on top of the bundle.
  const isGoodStanding = sub.status === 'active' || sub.status === 'trialing'
  if (tier === ALL_ACCESS_SLUG && isGoodStanding) {
    const addonSubs = await prisma.addonSubscription.findMany({
      where: { consultingFirmId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
    })
    for (const addonSub of addonSubs) {
      try {
        await getStripe().subscriptions.cancel(addonSub.stripeSubscriptionId, { prorate: true })
      } catch (err) {
        logger.error('Failed to cancel add-on subscription during All Access sweep — MANUAL REVIEW', {
          firmId: consultingFirmId,
          addonSlug: addonSub.addonSlug,
          stripeSubscriptionId: addonSub.stripeSubscriptionId,
          error: (err as Error).message,
        })
        continue
      }
      await prisma.addonSubscription.update({
        where: { id: addonSub.id },
        data: { status: 'CANCELED', cancelAtPeriodEnd: true },
      })
      const firmNow = await prisma.consultingFirm.findUnique({
        where: { id: consultingFirmId },
        select: { purchasedAddons: true },
      })
      if (firmNow) {
        await prisma.consultingFirm.update({
          where: { id: consultingFirmId },
          data: { purchasedAddons: firmNow.purchasedAddons.filter((a) => a !== addonSub.addonSlug) },
        })
      }
      logger.info('Add-on subscription rolled into All Access bundle', {
        firmId: consultingFirmId,
        addonSlug: addonSub.addonSlug,
      })
    }
  }

  await prisma.complianceLog.create({
    data: {
      consultingFirmId,
      entityType: 'OTHER',
      entityId: event.id,
      fromStatus: 'PENDING',
      toStatus: sub.status.toUpperCase(),
      reason: `Stripe subscription ${event.type.split('.').pop()}: tier=${sub.metadata?.tier ?? 'unknown'} status=${sub.status} cancelAtPeriodEnd=${sub.cancel_at_period_end ?? false}`,
      triggeredBy: `stripe-webhook:${sub.id}`,
    },
  })

  logger.info('Subscription event processed', {
    firmId: consultingFirmId,
    subId: sub.id,
    status: sub.status,
    tier: sub.metadata?.tier,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  })
  return { processed: true }
}

// Sync a recurring add-on module subscription into AddonSubscription and the
// purchasedAddons entitlement cache. One Stripe subscription per module.
async function handleAddonSubscriptionUpsert(
  event: StripeEvent,
  sub: StripeSubscription,
  consultingFirmId: string,
): Promise<{ processed: boolean }> {
  const rawSlug = sub.metadata?.addonSlug
  if (!rawSlug) {
    logger.error('Add-on subscription event missing addonSlug metadata', { eventId: event.id, subId: sub.id })
    return { processed: false }
  }
  const addonSlug = resolveAddonSlug(rawSlug)

  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { id: true, purchasedAddons: true },
  })
  if (!firm) {
    logger.error('Add-on subscription for unknown firm', { firmId: consultingFirmId, subId: sub.id })
    return { processed: false }
  }

  const localStatus = mapStripeSubscriptionStatus(sub.status)
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null
  const isGood = localStatus === 'ACTIVE' || localStatus === 'TRIALING'

  // Upsert keyed on (firm, module): a re-subscribe arrives under a NEW Stripe
  // subscription id, and the old CANCELED row must be reused, not duplicated.
  const existing = await prisma.addonSubscription.findUnique({
    where: { consultingFirmId_addonSlug: { consultingFirmId, addonSlug } },
  })
  const wasGood = existing != null && (existing.status === 'ACTIVE' || existing.status === 'TRIALING')
  if (existing) {
    // Ignore stale events from a superseded Stripe sub for this module.
    if (existing.stripeSubscriptionId !== sub.id && event.type !== 'customer.subscription.created') {
      logger.info('Ignoring event for superseded add-on subscription', {
        firmId: consultingFirmId, addonSlug, eventSubId: sub.id, currentSubId: existing.stripeSubscriptionId,
      })
      return { processed: true }
    }
    await prisma.addonSubscription.update({
      where: { id: existing.id },
      data: {
        stripeSubscriptionId: sub.id,
        status: localStatus,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      },
    })
  } else {
    await prisma.addonSubscription.create({
      data: {
        consultingFirmId,
        addonSlug,
        stripeSubscriptionId: sub.id,
        status: localStatus,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      },
    })
  }

  // Keep the purchasedAddons entitlement cache in sync with the module's standing.
  if (isGood && !firm.purchasedAddons.includes(addonSlug)) {
    await prisma.consultingFirm.update({
      where: { id: consultingFirmId },
      data: { purchasedAddons: { push: addonSlug } },
    })
  } else if (!isGood && firm.purchasedAddons.includes(addonSlug)) {
    await prisma.consultingFirm.update({
      where: { id: consultingFirmId },
      data: { purchasedAddons: firm.purchasedAddons.filter((a) => a !== addonSlug) },
    })
  }

  // First activation (or recovery from lapse): grant the module's monthly
  // tokens immediately instead of waiting for the calendar-month refresh.
  if (isGood && !wasGood) {
    await refreshProposalTokens(consultingFirmId).catch((err: Error) =>
      logger.warn('Token refresh after add-on activation failed', { consultingFirmId, error: err.message }),
    )
  }

  await prisma.complianceLog.create({
    data: {
      consultingFirmId,
      entityType: 'OTHER',
      entityId: event.id,
      fromStatus: 'PENDING',
      toStatus: localStatus,
      reason: `Stripe add-on subscription ${event.type.split('.').pop()}: addon=${addonSlug} status=${sub.status}`,
      triggeredBy: `stripe-webhook:${sub.id}`,
    },
  })

  logger.info('Add-on subscription event processed', {
    firmId: consultingFirmId, addonSlug, subId: sub.id, status: sub.status,
  })
  return { processed: true }
}

async function handleSubscriptionDeleted(event: StripeEvent): Promise<{ processed: boolean }> {
  const sub = event.data.object as StripeSubscription
  const consultingFirmId = sub.metadata?.consultingFirmId
  if (!consultingFirmId) {
    logger.warn('Stripe subscription deleted without firmId metadata', { eventId: event.id, subId: sub.id })
    return { processed: false }
  }

  // Add-on module cancellation: close out the AddonSubscription row and drop
  // the module from the entitlement cache. The plan subscription is untouched.
  if (sub.metadata?.productType === 'addon_subscription') {
    const addonSlug = resolveAddonSlug(sub.metadata?.addonSlug ?? '')
    await prisma.addonSubscription.updateMany({
      where: { stripeSubscriptionId: sub.id },
      data: { status: 'CANCELED', cancelAtPeriodEnd: true },
    })
    const firm = await prisma.consultingFirm.findUnique({
      where: { id: consultingFirmId },
      select: { purchasedAddons: true },
    })
    if (firm && addonSlug && firm.purchasedAddons.includes(addonSlug)) {
      // Only drop the entitlement when this sub is still the module's active
      // one — a re-subscribe may already have a newer sub carrying the slug.
      const newer = await prisma.addonSubscription.findFirst({
        where: {
          consultingFirmId,
          addonSlug,
          status: { in: ['ACTIVE', 'TRIALING'] },
          stripeSubscriptionId: { not: sub.id },
        },
        select: { id: true },
      })
      if (!newer) {
        await prisma.consultingFirm.update({
          where: { id: consultingFirmId },
          data: { purchasedAddons: firm.purchasedAddons.filter((a) => a !== addonSlug) },
        })
      }
    }
    await prisma.complianceLog.create({
      data: {
        consultingFirmId,
        entityType: 'OTHER',
        entityId: event.id,
        fromStatus: 'ACTIVE',
        toStatus: 'CANCELED',
        reason: `Stripe add-on subscription deleted: addon=${addonSlug || 'unknown'}`,
        triggeredBy: `stripe-webhook:${sub.id}`,
      },
    })
    logger.info('Add-on subscription deleted', { firmId: consultingFirmId, addonSlug, subId: sub.id })
    return { processed: true }
  }

  // Clear stripeSubscriptionId so a new subscription can be created — but only
  // when it still points at THIS sub (a plan switch may already have replaced it).
  await prisma.consultingFirm.updateMany({
    where: { id: consultingFirmId, stripeSubscriptionId: sub.id },
    data: { stripeSubscriptionId: null },
  }).catch((err: Error) => {
    logger.warn('Failed to clear stripeSubscriptionId on subscription cancellation', { consultingFirmId, error: err.message })
  })

  // Downgrade the local Subscription so entitlements stop granting the paid
  // plan — but not when the deletion is a superseded sub from a plan switch.
  const firmNow = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { stripeSubscriptionId: true },
  })
  if (!firmNow?.stripeSubscriptionId) {
    await prisma.subscription.updateMany({
      where: { consultingFirmId },
      data: { status: 'CANCELED', cancelAtPeriodEnd: true },
    })
  } else {
    logger.info('Skipping local downgrade — firm already on a newer plan subscription', {
      firmId: consultingFirmId, deletedSubId: sub.id, currentSubId: firmNow.stripeSubscriptionId,
    })
  }

  await prisma.complianceLog.create({
    data: {
      consultingFirmId,
      entityType: 'OTHER',
      entityId: event.id,
      fromStatus: 'ACTIVE',
      toStatus: 'CANCELED',
      reason: `Stripe subscription deleted: tier=${sub.metadata?.tier ?? 'unknown'}`,
      triggeredBy: `stripe-webhook:${sub.id}`,
    },
  })

  logger.info('Subscription deleted', { firmId: consultingFirmId, subId: sub.id })
  return { processed: true }
}

async function handleInvoicePaymentFailed(event: StripeEvent): Promise<{ processed: boolean }> {
  const invoice = event.data.object as { id: string; customer: string; subscription?: string; amount_due?: number }
  // Look up firm via customer ID (invoice metadata not always present)
  const firm = await prisma.consultingFirm.findFirst({
    where: { stripeCustomerId: invoice.customer },
    select: { id: true },
  })
  if (!firm) {
    logger.warn('Invoice payment failed for unknown customer', { customerId: invoice.customer })
    return { processed: false }
  }

  // Mark the local Subscription PAST_DUE so tierGate downgrades to the free
  // floor until payment recovers (a later subscription.updated / successful
  // invoice restores ACTIVE). No-op when no local row exists.
  await prisma.subscription.updateMany({
    where: { consultingFirmId: firm.id },
    data: { status: 'PAST_DUE' },
  })

  await prisma.complianceLog.create({
    data: {
      consultingFirmId: firm.id,
      entityType: 'OTHER',
      entityId: event.id,
      fromStatus: 'ACTIVE',
      toStatus: 'PAST_DUE',
      reason: `Invoice payment failed — $${(invoice.amount_due ?? 0) / 100}`,
      triggeredBy: `stripe-webhook:${invoice.id}`,
    },
  })

  logger.warn('Subscription invoice payment failed', {
    firmId: firm.id,
    invoiceId: invoice.id,
    amount: invoice.amount_due,
  })
  return { processed: true }
}

async function handleInvoicePaymentSucceeded(event: StripeEvent): Promise<{ processed: boolean; reason?: string }> {
  const invoice = event.data.object as {
    id: string
    customer: string
    subscription?: string | null
    amount_paid?: number | null
  }

  // Only subscription invoices can recover a past-due plan; one-time payment
  // invoices (token packs, lifetime) have nothing to restore.
  if (!invoice.subscription) {
    return { processed: false, reason: 'not_subscription_invoice' }
  }

  const firm = await prisma.consultingFirm.findFirst({
    where: { stripeCustomerId: invoice.customer },
    select: { id: true, stripeSubscriptionId: true },
  })
  if (!firm) {
    logger.warn('Invoice payment succeeded for unknown customer', { customerId: invoice.customer, invoiceId: invoice.id })
    return { processed: false }
  }

  // Add-on module invoices recover through their own customer.subscription
  // .updated event; restoring the PLAN subscription on an add-on payment
  // would unlock a firm whose plan invoice is still unpaid.
  if (firm.stripeSubscriptionId !== invoice.subscription) {
    return { processed: true, reason: 'not_plan_subscription' }
  }

  // invoice.payment_failed marks the local row PAST_DUE eagerly — even when
  // Stripe's subscription object never leaves 'active' (smart retries). In
  // that case no customer.subscription.updated ever fires, so without this
  // handler a firm that paid stayed on the free floor indefinitely. Only
  // PAST_DUE flips back; CANCELED is never resurrected here.
  const restored = await prisma.subscription.updateMany({
    where: { consultingFirmId: firm.id, status: 'PAST_DUE' },
    data: { status: 'ACTIVE' },
  })

  if (restored.count > 0) {
    await prisma.complianceLog.create({
      data: {
        consultingFirmId: firm.id,
        entityType: 'OTHER',
        entityId: event.id,
        fromStatus: 'PAST_DUE',
        toStatus: 'ACTIVE',
        reason: `Invoice payment succeeded — $${(invoice.amount_paid ?? 0) / 100} — subscription restored from past-due`,
        triggeredBy: `stripe-webhook:${invoice.id}`,
      },
    })
    logger.info('Subscription restored from past-due on successful invoice payment', {
      firmId: firm.id,
      invoiceId: invoice.id,
    })
  }

  return { processed: true }
}

// -------------------------------------------------------------
// Read access — does firm have lifetime access?
// -------------------------------------------------------------

export async function hasLifetimeAccess(consultingFirmId: string): Promise<boolean> {
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { lifetimeAccessAt: true },
  })
  return Boolean(firm?.lifetimeAccessAt)
}
