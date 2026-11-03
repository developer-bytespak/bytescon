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
import { getAddon, resolveAddonSlug, ALL_ACCESS_SLUG, BASE_PLAN_SLUG } from '../config/addons'
import { activateLifetime, refreshProposalTokens } from './billingService'
import { AppError } from '../utils/errors'

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

interface StripeSubscriptionItem {
  id: string
  quantity?: number
  metadata?: { [key: string]: string } | null
  current_period_end?: number
  price?: {
    unit_amount?: number | null
    product?: string | { id: string }
    recurring?: { interval?: string } | null
  }
}

interface StripeSubscription {
  id: string
  status: string
  customer: string
  metadata?: { [key: string]: string } | null
  /** Pre-2025-03 API versions only; newer versions carry it per item. */
  current_period_end?: number
  cancel_at_period_end?: boolean
  items?: { data: StripeSubscriptionItem[] }
}

// Stripe API 2025-03-31 moved invoice.subscription under parent.
interface StripeInvoice {
  id: string
  customer: string
  subscription?: string | null
  parent?: { subscription_details?: { subscription?: string | null } | null } | null
  billing_reason?: string | null
  amount_due?: number | null
  amount_paid?: number | null
}

export function invoiceSubscriptionId(invoice: StripeInvoice): string | null {
  return invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null
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
// plans (base $99 / all_access $199). Add-on modules from config/addons.ts
// are extra lines on the same subscription (see addAddonToPlan). Prices live in code
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
// Add-on modules — line items on the firm's plan subscription.
//
// The base plan and every add-on bill as ONE Stripe subscription: one
// invoice, one charge a month ($99 base + $29 add-on = $128). Adding a module
// charges the card on file for the rest of the current period immediately and
// is refused outright if that payment fails, so a declined add-on never
// changes the subscription or locks the account. Entitlements are synced from
// the subscription's items (syncAddonItemsFromPlanSubscription), both right
// after the API call and again on every customer.subscription.updated.
// -------------------------------------------------------------

const ADDON_PRODUCT_PREFIX = 'bytescon_addon_'

export function addonProductId(addonSlug: string): string {
  return `${ADDON_PRODUCT_PREFIX}${addonSlug}`
}

function isStripeMissing(err: any): boolean {
  return err?.statusCode === 404 || err?.code === 'resource_missing'
}

// Stripe needs a product for a subscription item's inline price (checkout's
// product_data shortcut isn't accepted there). Each module gets a fixed
// product id, created on first use; the amount still comes from code.
async function ensureAddonProduct(addonSlug: string): Promise<string> {
  const addon = getAddon(addonSlug)
  if (!addon) throw new Error(`Unknown addon: ${addonSlug}`)
  const id = addonProductId(addonSlug)
  const stripe = getStripe()
  try {
    await stripe.products.retrieve(id)
    return id
  } catch (err) {
    if (!isStripeMissing(err)) throw err
  }
  try {
    await stripe.products.create({
      id,
      name: `${addon.name} (add-on)`,
      description: addon.tagline,
      metadata: { addonSlug },
    })
  } catch (err: any) {
    // A concurrent request created it first.
    if (err?.code !== 'resource_already_exists') throw err
  }
  return id
}

/** The module a subscription item bills for, or null for the plan line. */
export function addonSlugOfItem(item: StripeSubscriptionItem): string | null {
  const fromMeta = item.metadata?.addonSlug
  if (fromMeta) return resolveAddonSlug(fromMeta)
  const product = typeof item.price?.product === 'string' ? item.price.product : item.price?.product?.id
  if (product && product.startsWith(ADDON_PRODUCT_PREFIX)) {
    return resolveAddonSlug(product.slice(ADDON_PRODUCT_PREFIX.length))
  }
  return null
}

function planItemOf(sub: StripeSubscription): StripeSubscriptionItem | undefined {
  return sub.items?.data.find((item) => addonSlugOfItem(item) === null)
}

/** Monthly or yearly — add-ons always follow the plan's cycle. */
function intervalOf(sub: StripeSubscription): 'month' | 'year' {
  return planItemOf(sub)?.price?.recurring?.interval === 'year' ? 'year' : 'month'
}

function addonUnitAmountCents(addonSlug: string, interval: 'month' | 'year'): number {
  const addon = getAddon(addonSlug)
  if (!addon) throw new Error(`Unknown addon: ${addonSlug}`)
  // priceAnnual is the discounted per-month equivalent; a yearly plan bills
  // the full year at that rate.
  return interval === 'year' ? Math.round(addon.priceAnnual * 12 * 100) : Math.round(addon.priceMonthly * 100)
}

/**
 * Stripe API 2025-03-31 moved current_period_end from the subscription onto
 * each item. Read both so renewal dates are right on any webhook API version.
 */
export function periodEndOf(sub: StripeSubscription): Date | null {
  if (sub.current_period_end) return new Date(sub.current_period_end * 1000)
  const ends = (sub.items?.data ?? []).map((i) => i.current_period_end ?? 0).filter((n) => n > 0)
  return ends.length > 0 ? new Date(Math.max(...ends) * 1000) : null
}

/** Why an add-on change was refused; statusCode follows AppError. */
export class AddonBillingError extends AppError {
  constructor(message: string, statusCode: number, code: string) {
    super(message, statusCode, code)
  }
}

async function loadPlanSubscriptionForAddons(consultingFirmId: string): Promise<StripeSubscription> {
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { stripeSubscriptionId: true },
  })
  if (!firm?.stripeSubscriptionId) {
    throw new AddonBillingError(
      'Subscribe to the Bytescon base plan first — add-ons are billed together with it.',
      402,
      'PLAN_REQUIRED',
    )
  }
  const sub: StripeSubscription = await getStripe().subscriptions.retrieve(firm.stripeSubscriptionId)
  if (sub.status !== 'active') {
    throw new AddonBillingError(
      'Your plan needs to be active (paid and up to date) before adding modules.',
      402,
      'PLAN_NOT_ACTIVE',
    )
  }
  return sub
}

export interface AddonQuote {
  addonSlug: string
  interval: 'month' | 'year'
  /** What the module adds to every renewal. */
  recurringAmountCents: number
  /** Charged now for the rest of the current period. */
  dueTodayCents: number
  /** The whole subscription per period after adding the module. */
  newPeriodTotalCents: number
  currentPeriodEnd: string | null
}

/** Price preview for the confirm dialog — creates nothing. */
export async function previewAddonOnPlan(consultingFirmId: string, addonSlug: string): Promise<AddonQuote> {
  const sub = await loadPlanSubscriptionForAddons(consultingFirmId)
  const interval = intervalOf(sub)
  const product = await ensureAddonProduct(addonSlug)
  const unitAmount = addonUnitAmountCents(addonSlug, interval)
  const preview = await getStripe().invoices.createPreview({
    customer: sub.customer,
    subscription: sub.id,
    subscription_details: {
      items: [{ price_data: { currency: 'usd', product, unit_amount: unitAmount, recurring: { interval } }, quantity: 1 }],
      proration_behavior: 'always_invoice',
    },
  })
  const currentTotal = (sub.items?.data ?? []).reduce(
    (sum, item) => sum + (item.price?.unit_amount ?? 0) * (item.quantity ?? 1),
    0,
  )
  return {
    addonSlug,
    interval,
    recurringAmountCents: unitAmount,
    dueTodayCents: Math.max(0, preview.amount_due ?? 0),
    newPeriodTotalCents: currentTotal + unitAmount,
    currentPeriodEnd: periodEndOf(sub)?.toISOString() ?? null,
  }
}

/**
 * Add a module to the plan subscription and charge the prorated amount now.
 * payment_behavior 'error_if_incomplete' makes Stripe reject the whole update
 * when that charge fails, so nothing is granted and nothing is locked.
 */
export async function addAddonToPlan(consultingFirmId: string, addonSlug: string): Promise<{ addonSlug: string; subscriptionId: string }> {
  const sub = await loadPlanSubscriptionForAddons(consultingFirmId)
  if ((sub.items?.data ?? []).some((item) => addonSlugOfItem(item) === addonSlug)) {
    await syncAddonItemsFromPlanSubscription(consultingFirmId, sub)
    return { addonSlug, subscriptionId: sub.id }
  }
  const interval = intervalOf(sub)
  const product = await ensureAddonProduct(addonSlug)

  let updated: StripeSubscription
  try {
    updated = await getStripe().subscriptions.update(sub.id, {
      items: [{
        price_data: { currency: 'usd', product, unit_amount: addonUnitAmountCents(addonSlug, interval), recurring: { interval } },
        quantity: 1,
        metadata: { addonSlug },
      }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
    })
  } catch (err: any) {
    if (err?.type === 'StripeCardError' || err?.code === 'card_declined' || err?.statusCode === 402) {
      throw new AddonBillingError(
        `Your card was declined, so the add-on was not added and nothing was charged.${err?.message ? ` (${err.message})` : ''}`,
        402,
        'ADDON_PAYMENT_FAILED',
      )
    }
    throw err
  }

  await syncAddonItemsFromPlanSubscription(consultingFirmId, updated)
  logger.info('Add-on added to plan subscription', { firmId: consultingFirmId, addonSlug, subId: updated.id })
  return { addonSlug, subscriptionId: updated.id }
}

/** Remove a module's line; unused time is credited on the next invoice. */
export async function removeAddonFromPlan(stripeSubscriptionItemId: string): Promise<void> {
  try {
    await getStripe().subscriptionItems.del(stripeSubscriptionItemId, { proration_behavior: 'create_prorations' })
  } catch (err) {
    // Already gone (e.g. the plan subscription ended) — nothing left to bill.
    if (!isStripeMissing(err)) throw err
  }
}

/**
 * Make AddonSubscription rows and the purchasedAddons entitlement cache match
 * the add-on items on a plan subscription. Every module on the subscription
 * takes the subscription's standing; a row whose line is gone is CANCELED.
 * Slugs not tracked by a row of this subscription (owner grants, legacy
 * one-time purchases) are never touched.
 */
export async function syncAddonItemsFromPlanSubscription(
  consultingFirmId: string,
  sub: StripeSubscription,
  opts: { ended?: boolean } = {},
): Promise<void> {
  const status = opts.ended ? 'CANCELED' : mapStripeSubscriptionStatus(sub.status)
  const good = status === 'ACTIVE' || status === 'TRIALING'
  const periodEnd = periodEndOf(sub)
  const items = opts.ended ? [] : (sub.items?.data ?? [])
  const present = new Map<string, StripeSubscriptionItem>()
  for (const item of items) {
    const slug = addonSlugOfItem(item)
    if (slug) present.set(slug, item)
  }

  const existing = await prisma.addonSubscription.findMany({ where: { consultingFirmId } })
  const newlyGood: string[] = []

  for (const [addonSlug, item] of present) {
    const row = existing.find((r) => r.addonSlug === addonSlug)
    const data = {
      stripeSubscriptionId: sub.id,
      stripeSubscriptionItemId: item.id,
      status,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    }
    if (row) {
      await prisma.addonSubscription.update({ where: { id: row.id }, data })
      if (good && row.status !== 'ACTIVE' && row.status !== 'TRIALING') newlyGood.push(addonSlug)
    } else {
      await prisma.addonSubscription.create({ data: { consultingFirmId, addonSlug, ...data } })
      if (good) newlyGood.push(addonSlug)
    }
  }

  // Rows of this subscription whose line is no longer on it.
  const removed = existing.filter(
    (r) => r.stripeSubscriptionId === sub.id && !present.has(r.addonSlug) && r.status !== 'CANCELED',
  )
  for (const row of removed) {
    await prisma.addonSubscription.update({
      where: { id: row.id },
      data: { status: 'CANCELED', cancelAtPeriodEnd: true },
    })
  }

  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { purchasedAddons: true },
  })
  if (firm) {
    const drop = new Set<string>(removed.map((r) => r.addonSlug))
    if (!good) for (const slug of present.keys()) drop.add(slug)
    const next = firm.purchasedAddons.filter((s) => !drop.has(resolveAddonSlug(s)))
    if (good) for (const slug of present.keys()) if (!next.map(resolveAddonSlug).includes(slug)) next.push(slug)
    const changed = next.length !== firm.purchasedAddons.length || next.some((s, i) => s !== firm.purchasedAddons[i])
    if (changed) {
      await prisma.consultingFirm.update({ where: { id: consultingFirmId }, data: { purchasedAddons: next } })
    }
  }

  // First activation (or recovery from a lapse): grant the module's monthly
  // tokens now instead of waiting for the calendar-month refresh.
  if (newlyGood.length > 0) {
    await refreshProposalTokens(consultingFirmId).catch((err: Error) =>
      logger.warn('Token refresh after add-on activation failed', { consultingFirmId, error: err.message }),
    )
  }
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

  // Separate per-module subscriptions were retired before launch (add-ons are
  // now items on the plan subscription). An event for one must never be read
  // as a plan change, so it is acknowledged and ignored.
  if (sub.metadata?.productType === 'addon_subscription') {
    logger.warn('Ignoring event for a retired separate add-on subscription', { eventId: event.id, subId: sub.id })
    return { processed: false }
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
      const periodEnd = periodEndOf(sub) ?? new Date(Date.now() + 31 * 24 * 60 * 60 * 1000)
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

  // Add-on modules are items on this subscription; their rows and the
  // entitlement cache follow its items and standing.
  await syncAddonItemsFromPlanSubscription(consultingFirmId, sub)
  if (supersededSubId) await endAddonRowsOfSubscription(consultingFirmId, supersededSubId)

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

/** The plan subscription ended: its add-on lines ended with it. */
async function endAddonRowsOfSubscription(consultingFirmId: string, stripeSubscriptionId: string): Promise<void> {
  await syncAddonItemsFromPlanSubscription(
    consultingFirmId,
    { id: stripeSubscriptionId, status: 'canceled', customer: '' },
    { ended: true },
  )
}

async function handleSubscriptionDeleted(event: StripeEvent): Promise<{ processed: boolean }> {
  const sub = event.data.object as StripeSubscription
  const consultingFirmId = sub.metadata?.consultingFirmId
  if (!consultingFirmId) {
    logger.warn('Stripe subscription deleted without firmId metadata', { eventId: event.id, subId: sub.id })
    return { processed: false }
  }

  if (sub.metadata?.productType === 'addon_subscription') {
    logger.warn('Ignoring deletion of a retired separate add-on subscription', { eventId: event.id, subId: sub.id })
    return { processed: false }
  }

  // Add-on lines end with the plan subscription that carried them.
  await endAddonRowsOfSubscription(consultingFirmId, sub.id)

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

async function handleInvoicePaymentFailed(event: StripeEvent): Promise<{ processed: boolean; reason?: string }> {
  const invoice = event.data.object as StripeInvoice
  // Look up firm via customer ID (invoice metadata not always present)
  const firm = await prisma.consultingFirm.findFirst({
    where: { stripeCustomerId: invoice.customer },
    select: { id: true, stripeSubscriptionId: true },
  })
  if (!firm) {
    logger.warn('Invoice payment failed for unknown customer', { customerId: invoice.customer })
    return { processed: false }
  }

  // Lock only for the firm's CURRENT plan subscription — base and add-ons bill
  // together on it, so a failed renewal means nothing was paid. Not for:
  //   - one-time invoices (token packs, lifetime): no subscription at all;
  //   - a superseded subscription from a plan switch;
  //   - an add-on top-up (billing_reason subscription_update): addAddonToPlan
  //     uses error_if_incomplete, so the add-on was never added and the plan
  //     the customer already paid for must stay open.
  const subscriptionId = invoiceSubscriptionId(invoice)
  if (!subscriptionId || subscriptionId !== firm.stripeSubscriptionId) {
    return { processed: true, reason: 'not_plan_subscription' }
  }
  if (invoice.billing_reason === 'subscription_update') {
    logger.info('Add-on top-up payment failed — change was not applied, plan left active', {
      firmId: firm.id, invoiceId: invoice.id,
    })
    return { processed: true, reason: 'addon_change_not_applied' }
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
  const invoice = event.data.object as StripeInvoice
  const subscriptionId = invoiceSubscriptionId(invoice)

  // Only subscription invoices can recover a past-due plan; one-time payment
  // invoices (token packs, lifetime) have nothing to restore.
  if (!subscriptionId) {
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

  // Only the firm's current plan subscription restores the plan; a payment on
  // a superseded subscription says nothing about the one in force.
  if (firm.stripeSubscriptionId !== subscriptionId) {
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
