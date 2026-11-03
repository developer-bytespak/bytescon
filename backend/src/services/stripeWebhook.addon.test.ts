// =============================================================
// Add-on modules on the plan subscription (integration, live test DB,
// Stripe faked). Base plan and add-ons bill as ONE Stripe subscription —
// one invoice, one charge. Guards:
//   - buying an add-on grants it and tracks its line;
//   - a declined add-on charge changes nothing and never locks the plan;
//   - removing an add-on drops only that module;
//   - only a failed plan renewal locks the account, and paying unlocks it
//     (old and new Stripe invoice formats);
//   - All Access upgrades and plan deletion close the add-on rows;
//   - retired per-module subscription events can't touch the plan.
// =============================================================
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  subscriptions: { retrieve: vi.fn(), update: vi.fn(), cancel: vi.fn() },
  subscriptionItems: { del: vi.fn() },
  products: { retrieve: vi.fn(), create: vi.fn() },
  invoices: { createPreview: vi.fn() },
}))
vi.mock('stripe', () => ({ default: vi.fn().mockImplementation(function () { return fake }) }))

import { prisma } from '../config/database'
import {
  addAddonToPlan,
  handleWebhookEvent,
  previewAddonOnPlan,
  removeAddonFromPlan,
  AddonBillingError,
} from './stripeService'
import { getEntitlements, hasAddonEntitlement } from './entitlementService'
import { createTestFirm, cleanupFirm, disconnectDb, TestFirm } from '../test-utils/testClient'

let firm: TestFirm
let seq = 0
const uniq = (p: string) => `${p}_${Date.now()}_${process.pid}_${++seq}`
const PERIOD_END = Math.floor(Date.now() / 1000) + 20 * 86_400

type Item = { id: string; slug?: string; amount: number; interval?: 'month' | 'year' }

function stripeSub(opts: { id: string; status?: string; items: Item[]; tier?: string; legacyPeriodField?: boolean }) {
  return {
    id: opts.id,
    status: opts.status ?? 'active',
    customer: 'cus_test',
    cancel_at_period_end: false,
    metadata: { consultingFirmId: firm.id, productType: 'subscription', tier: opts.tier ?? 'base' },
    ...(opts.legacyPeriodField ? { current_period_end: PERIOD_END } : {}),
    items: {
      data: opts.items.map((i) => ({
        id: i.id,
        quantity: 1,
        metadata: i.slug ? { addonSlug: i.slug } : {},
        // API 2025-03+ carries the period end per item.
        current_period_end: PERIOD_END,
        price: {
          unit_amount: i.amount,
          product: i.slug ? `bytescon_addon_${i.slug}` : 'prod_base',
          recurring: { interval: i.interval ?? 'month' },
        },
      })),
    },
  }
}

function event(type: string, object: unknown) {
  return { id: uniq('evt_test'), type, data: { object } }
}

async function linkPlan(subId: string) {
  await prisma.consultingFirm.update({
    where: { id: firm.id },
    data: { stripeCustomerId: uniq('cus'), stripeSubscriptionId: subId },
  })
  const f = await prisma.consultingFirm.findUnique({ where: { id: firm.id }, select: { stripeCustomerId: true } })
  return f!.stripeCustomerId!
}

async function state() {
  const f = await prisma.consultingFirm.findUnique({
    where: { id: firm.id },
    select: { purchasedAddons: true, proposalTokens: true },
  })
  const sub = await prisma.subscription.findUnique({ where: { consultingFirmId: firm.id } })
  const rows = await prisma.addonSubscription.findMany({ where: { consultingFirmId: firm.id } })
  return { ...f!, planStatus: sub?.status, rows }
}

beforeEach(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  for (const group of Object.values(fake)) for (const fn of Object.values(group)) (fn as any).mockReset()
  fake.products.retrieve.mockResolvedValue({ id: 'prod' })
  firm = await createTestFirm({ name: 'One-Subscription Billing Firm', plan: 'base' })
})

afterEach(async () => {
  await cleanupFirm(firm?.id).catch(() => {
    // firm may already be gone when a test cleaned up itself
  })
})

afterAll(async () => {
  await disconnectDb()
})

describe('adding an add-on to the plan subscription', () => {
  it('charges on the same subscription, grants the module and tracks the line', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    const before = stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }] })
    fake.subscriptions.retrieve.mockResolvedValue(before)
    fake.subscriptions.update.mockResolvedValue(
      stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }, { id: uniq('si'), slug: 'teaming_suite', amount: 4900 }] }),
    )

    await addAddonToPlan(firm.id, 'teaming_suite')

    // One subscription: the module is a new line on the plan, charged now,
    // and the whole change is refused if that charge fails.
    const [calledSubId, params] = fake.subscriptions.update.mock.calls[0]
    expect(calledSubId).toBe(subId)
    expect(params).toMatchObject({ proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' })
    expect(params.items[0]).toMatchObject({
      price_data: { product: 'bytescon_addon_teaming_suite', unit_amount: 4900, recurring: { interval: 'month' } },
      metadata: { addonSlug: 'teaming_suite' },
    })

    const s = await state()
    expect(s.purchasedAddons).toContain('teaming_suite')
    expect(s.rows).toHaveLength(1)
    expect(s.rows[0]).toMatchObject({ addonSlug: 'teaming_suite', stripeSubscriptionId: subId, status: 'ACTIVE' })
    expect(s.rows[0].stripeSubscriptionItemId).toMatch(/^si_/)
    expect(s.rows[0].currentPeriodEnd?.getTime()).toBe(PERIOD_END * 1000)
    expect(s.planStatus).toBe('ACTIVE')
    expect(hasAddonEntitlement(await getEntitlements(firm.id), 'teaming_suite')).toBe(true)
  })

  it('bills a yearly plan’s add-on yearly at the annual rate', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    fake.subscriptions.retrieve.mockResolvedValue(stripeSub({ id: subId, items: [{ id: 'si_base', amount: 99000, interval: 'year' }] }))
    fake.subscriptions.update.mockResolvedValue(
      stripeSub({ id: subId, items: [{ id: 'si_base', amount: 99000, interval: 'year' }, { id: uniq('si'), slug: 'teaming_suite', amount: 50400, interval: 'year' }] }),
    )
    await addAddonToPlan(firm.id, 'teaming_suite')
    // teaming_suite priceAnnual 42/mo × 12
    expect(fake.subscriptions.update.mock.calls[0][1].items[0].price_data).toMatchObject({
      unit_amount: 42 * 12 * 100,
      recurring: { interval: 'year' },
    })
  })

  it('a declined card changes nothing: no module, no row, plan stays open', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    fake.subscriptions.retrieve.mockResolvedValue(stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }] }))
    fake.subscriptions.update.mockRejectedValue(Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined', statusCode: 402 }))

    const err = await addAddonToPlan(firm.id, 'teaming_suite').catch((e) => e)
    expect(err).toBeInstanceOf(AddonBillingError)
    expect(err).toMatchObject({ statusCode: 402, code: 'ADDON_PAYMENT_FAILED' })

    const s = await state()
    expect(s.purchasedAddons).not.toContain('teaming_suite')
    expect(s.rows).toHaveLength(0)
    expect(s.planStatus).toBe('ACTIVE')
    expect((await getEntitlements(firm.id)).baseActive).toBe(true)
  })

  it('needs a paid base plan first', async () => {
    const err = await addAddonToPlan(firm.id, 'teaming_suite').catch((e) => e)
    expect(err).toMatchObject({ statusCode: 402, code: 'PLAN_REQUIRED' })
    expect(fake.subscriptions.update).not.toHaveBeenCalled()
  })

  it('refuses while the plan is past due', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    fake.subscriptions.retrieve.mockResolvedValue(stripeSub({ id: subId, status: 'past_due', items: [{ id: 'si_base', amount: 9900 }] }))
    const err = await addAddonToPlan(firm.id, 'teaming_suite').catch((e) => e)
    expect(err).toMatchObject({ code: 'PLAN_NOT_ACTIVE' })
    expect(fake.subscriptions.update).not.toHaveBeenCalled()
  })

  it('creates the module’s Stripe product once when it does not exist yet', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    fake.products.retrieve.mockRejectedValue(Object.assign(new Error('No such product'), { statusCode: 404, code: 'resource_missing' }))
    fake.products.create.mockResolvedValue({ id: 'bytescon_addon_teaming_suite' })
    fake.subscriptions.retrieve.mockResolvedValue(stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }] }))
    fake.subscriptions.update.mockResolvedValue(stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }, { id: uniq('si'), slug: 'teaming_suite', amount: 4900 }] }))
    await addAddonToPlan(firm.id, 'teaming_suite')
    expect(fake.products.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'bytescon_addon_teaming_suite' }))
  })

  it('preview reports today’s prorated charge and the new single total', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    fake.subscriptions.retrieve.mockResolvedValue(stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }] }))
    fake.invoices.createPreview.mockResolvedValue({ amount_due: 1450 })
    const quote = await previewAddonOnPlan(firm.id, 'proposal_studio')
    expect(quote).toMatchObject({ interval: 'month', dueTodayCents: 1450, recurringAmountCents: 7900, newPeriodTotalCents: 9900 + 7900 })
    expect(fake.subscriptions.update).not.toHaveBeenCalled()
  })
})

describe('webhook — the plan subscription carries the add-ons', () => {
  it('syncs add-on lines from customer.subscription.updated and is idempotent', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    const evt = event('customer.subscription.updated', stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }, { id: uniq('si'), slug: 'market_intel', amount: 5900 }] }))
    expect((await handleWebhookEvent(evt as any)).processed).toBe(true)
    expect(await handleWebhookEvent(evt as any)).toMatchObject({ processed: false, reason: 'already_processed' })
    const s = await state()
    expect(s.rows).toHaveLength(1)
    expect(s.purchasedAddons).toEqual(['market_intel'])
  })

  it('removing a line drops only that module; the base plan keeps working', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    const teaming = uniq('si')
    await handleWebhookEvent(event('customer.subscription.updated', stripeSub({ id: subId, items: [
      { id: 'si_base', amount: 9900 }, { id: teaming, slug: 'teaming_suite', amount: 4900 }, { id: uniq('si'), slug: 'market_intel', amount: 5900 },
    ] })) as any)

    fake.subscriptionItems.del.mockResolvedValue({ deleted: true })
    await removeAddonFromPlan(teaming)
    expect(fake.subscriptionItems.del).toHaveBeenCalledWith(teaming, { proration_behavior: 'create_prorations' })

    await handleWebhookEvent(event('customer.subscription.updated', stripeSub({ id: subId, items: [
      { id: 'si_base', amount: 9900 }, { id: uniq('si_m'), slug: 'market_intel', amount: 5900 },
    ] })) as any)
    const s = await state()
    expect(s.purchasedAddons).toEqual(['market_intel'])
    expect(s.rows.find((r) => r.addonSlug === 'teaming_suite')?.status).toBe('CANCELED')
    expect(s.planStatus).toBe('ACTIVE')
    expect((await getEntitlements(firm.id)).baseActive).toBe(true)
  })

  it('a past-due plan pulls the add-ons with it and recovery restores them', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    const items: Item[] = [{ id: 'si_base', amount: 9900 }, { id: uniq('si'), slug: 'teaming_suite', amount: 4900 }]
    await handleWebhookEvent(event('customer.subscription.updated', stripeSub({ id: subId, items })) as any)
    await handleWebhookEvent(event('customer.subscription.updated', stripeSub({ id: subId, status: 'past_due', items })) as any)
    let s = await state()
    expect(s.purchasedAddons).not.toContain('teaming_suite')
    expect(s.rows[0].status).toBe('PAST_DUE')

    await handleWebhookEvent(event('customer.subscription.updated', stripeSub({ id: subId, items })) as any)
    s = await state()
    expect(s.purchasedAddons).toContain('teaming_suite')
    expect(s.rows[0].status).toBe('ACTIVE')
  })

  it('reads the legacy current_period_end field too', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    const sub = stripeSub({ id: subId, legacyPeriodField: true, items: [{ id: 'si_base', amount: 9900 }] })
    sub.items.data.forEach((i: any) => delete i.current_period_end)
    await handleWebhookEvent(event('customer.subscription.updated', sub) as any)
    const local = await prisma.subscription.findUnique({ where: { consultingFirmId: firm.id } })
    expect(local?.currentPeriodEnd.getTime()).toBe(PERIOD_END * 1000)
  })

  it('upgrading to All Access closes the old subscription’s add-on rows', async () => {
    const oldSub = uniq('sub')
    await linkPlan(oldSub)
    await handleWebhookEvent(event('customer.subscription.updated', stripeSub({ id: oldSub, items: [
      { id: 'si_base', amount: 9900 }, { id: uniq('si'), slug: 'teaming_suite', amount: 4900 },
    ] })) as any)

    fake.subscriptions.cancel.mockResolvedValue({ id: oldSub, status: 'canceled' })
    const newSub = uniq('sub')
    await handleWebhookEvent(event('customer.subscription.created', stripeSub({ id: newSub, tier: 'all_access', items: [{ id: 'si_aa', amount: 19900 }] })) as any)

    expect(fake.subscriptions.cancel).toHaveBeenCalledWith(oldSub, { prorate: true })
    const s = await state()
    expect(s.rows[0].status).toBe('CANCELED')
    const ents = await getEntitlements(firm.id)
    expect(ents.allAccess).toBe(true)
    expect(hasAddonEntitlement(ents, 'teaming_suite')).toBe(true)
  })

  it('deleting the plan subscription ends its add-ons', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    const sub = stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }, { id: uniq('si'), slug: 'teaming_suite', amount: 4900 }] })
    await handleWebhookEvent(event('customer.subscription.updated', sub) as any)
    await handleWebhookEvent(event('customer.subscription.deleted', { ...sub, status: 'canceled' }) as any)
    const s = await state()
    expect(s.rows[0].status).toBe('CANCELED')
    expect(s.purchasedAddons).not.toContain('teaming_suite')
    expect(s.planStatus).toBe('CANCELED')
  })

  it('ignores events for retired per-module subscriptions — the plan is untouched', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    const legacy = {
      id: uniq('sub_legacy'), status: 'past_due', customer: 'cus_test',
      metadata: { consultingFirmId: firm.id, productType: 'addon_subscription', addonSlug: 'teaming_suite' },
    }
    expect((await handleWebhookEvent(event('customer.subscription.updated', legacy) as any)).processed).toBe(false)
    expect((await handleWebhookEvent(event('customer.subscription.deleted', legacy) as any)).processed).toBe(false)
    const s = await state()
    expect(s.planStatus).toBe('ACTIVE')
    const f = await prisma.consultingFirm.findUnique({ where: { id: firm.id }, select: { stripeSubscriptionId: true } })
    expect(f?.stripeSubscriptionId).toBe(subId)
  })
})

describe('webhook — invoices lock only for a failed plan payment (B3)', () => {
  it('a failed renewal of the plan subscription locks; paying it unlocks (new invoice format)', async () => {
    const subId = uniq('sub')
    const customer = await linkPlan(subId)
    const invoice = { customer, parent: { subscription_details: { subscription: subId } }, billing_reason: 'subscription_cycle', amount_due: 12800 }

    await handleWebhookEvent(event('invoice.payment_failed', { id: uniq('in'), ...invoice }) as any)
    expect((await state()).planStatus).toBe('PAST_DUE')
    expect((await getEntitlements(firm.id)).baseActive).toBe(false)

    await handleWebhookEvent(event('invoice.paid', { id: uniq('in'), ...invoice, amount_paid: 12800 }) as any)
    expect((await state()).planStatus).toBe('ACTIVE')
  })

  it('also reads the legacy invoice.subscription field', async () => {
    const subId = uniq('sub')
    const customer = await linkPlan(subId)
    await handleWebhookEvent(event('invoice.payment_failed', { id: uniq('in'), customer, subscription: subId, billing_reason: 'subscription_cycle' }) as any)
    expect((await state()).planStatus).toBe('PAST_DUE')
    await handleWebhookEvent(event('invoice.payment_succeeded', { id: uniq('in'), customer, subscription: subId }) as any)
    expect((await state()).planStatus).toBe('ACTIVE')
  })

  it('a failed add-on top-up charge does not lock the account', async () => {
    const subId = uniq('sub')
    const customer = await linkPlan(subId)
    const r = await handleWebhookEvent(event('invoice.payment_failed', {
      id: uniq('in'), customer, parent: { subscription_details: { subscription: subId } }, billing_reason: 'subscription_update', amount_due: 1450,
    }) as any)
    expect(r).toMatchObject({ processed: true, reason: 'addon_change_not_applied' })
    expect((await state()).planStatus).toBe('ACTIVE')
  })

  it('a failed one-time or other-subscription invoice does not lock the account', async () => {
    const subId = uniq('sub')
    const customer = await linkPlan(subId)
    await handleWebhookEvent(event('invoice.payment_failed', { id: uniq('in'), customer, billing_reason: 'manual' }) as any)
    await handleWebhookEvent(event('invoice.payment_failed', { id: uniq('in'), customer, subscription: uniq('sub_other'), billing_reason: 'subscription_cycle' }) as any)
    expect((await state()).planStatus).toBe('ACTIVE')
  })
})

describe('review fixes — ordering, plan switches, double clicks, legacy rows', () => {
  it('syncs from the subscription as Stripe has it now, not a late event snapshot', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    // Late "added" snapshot arrives after the add-on was already removed.
    const lateSnapshot = stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }, { id: uniq('si'), slug: 'teaming_suite', amount: 4900 }] })
    fake.subscriptions.retrieve.mockResolvedValue(stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }] }))
    await handleWebhookEvent(event('customer.subscription.updated', lateSnapshot) as any)
    const s = await state()
    expect(s.purchasedAddons).not.toContain('teaming_suite')
    expect(s.rows).toHaveLength(0)
  })

  it('a plan switch (monthly → annual) carries the add-ons onto the new subscription', async () => {
    const oldSub = uniq('sub')
    await linkPlan(oldSub)
    await handleWebhookEvent(event('customer.subscription.updated', stripeSub({ id: oldSub, items: [
      { id: 'si_base', amount: 9900 }, { id: uniq('si'), slug: 'teaming_suite', amount: 4900 },
    ] })) as any)

    const newSub = uniq('sub')
    const annualBase = stripeSub({ id: newSub, items: [{ id: 'si_base_y', amount: 100800, interval: 'year' }] })
    const annualWithAddon = stripeSub({ id: newSub, items: [
      { id: 'si_base_y', amount: 100800, interval: 'year' }, { id: uniq('si'), slug: 'teaming_suite', amount: 50400, interval: 'year' },
    ] })
    fake.subscriptions.retrieve.mockImplementation(async (id: string) => (id === newSub ? annualBase : undefined))
    fake.subscriptions.cancel.mockResolvedValue({ id: oldSub, status: 'canceled' })
    fake.subscriptions.update.mockResolvedValue(annualWithAddon)

    await handleWebhookEvent(event('customer.subscription.created', annualBase) as any)

    expect(fake.subscriptions.cancel).toHaveBeenCalledWith(oldSub, { prorate: true })
    expect(fake.subscriptions.update.mock.calls[0][0]).toBe(newSub)
    expect(fake.subscriptions.update.mock.calls[0][1].items[0].price_data).toMatchObject({ unit_amount: 42 * 12 * 100, recurring: { interval: 'year' } })
    const s = await state()
    expect(s.purchasedAddons).toContain('teaming_suite')
    expect(s.rows[0]).toMatchObject({ addonSlug: 'teaming_suite', stripeSubscriptionId: newSub, status: 'ACTIVE' })
  })

  it('double clicks share one idempotency key; an in-flight duplicate gets a clear 409', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    fake.subscriptions.retrieve.mockResolvedValue(stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }] }))
    fake.subscriptions.update
      .mockResolvedValueOnce(stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }, { id: 'si_t', slug: 'teaming_suite', amount: 4900 }] }))
      .mockRejectedValueOnce(Object.assign(new Error('Keys for idempotent requests can only be used once at a time'), { type: 'StripeIdempotencyError' }))

    await addAddonToPlan(firm.id, 'teaming_suite')
    const second = await addAddonToPlan(firm.id, 'teaming_suite').catch((e) => e)

    const [k1, k2] = fake.subscriptions.update.mock.calls.map((c: any[]) => c[2]?.idempotencyKey)
    expect(k1).toBeTruthy()
    expect(k2).toBe(k1)
    expect(second).toMatchObject({ statusCode: 409, code: 'ADDON_ADD_IN_PROGRESS' })
  })

  it('a truncated item list never cancels paid add-ons', async () => {
    const subId = uniq('sub')
    await linkPlan(subId)
    await handleWebhookEvent(event('customer.subscription.updated', stripeSub({ id: subId, items: [
      { id: 'si_base', amount: 9900 }, { id: uniq('si'), slug: 'teaming_suite', amount: 4900 },
    ] })) as any)
    const truncated: any = stripeSub({ id: subId, items: [{ id: 'si_base', amount: 9900 }] })
    truncated.items.has_more = true
    await handleWebhookEvent(event('customer.subscription.updated', truncated) as any)
    const s = await state()
    expect(s.rows[0].status).toBe('ACTIVE')
    expect(s.purchasedAddons).toContain('teaming_suite')
  })

  it('a lapsed legacy separate add-on subscription removes its module (never grants)', async () => {
    const legacySub = uniq('sub_legacy')
    await prisma.addonSubscription.create({ data: { consultingFirmId: firm.id, addonSlug: 'teaming_suite', stripeSubscriptionId: legacySub, status: 'ACTIVE' } })
    await prisma.consultingFirm.update({ where: { id: firm.id }, data: { purchasedAddons: ['teaming_suite'] } })
    const legacy = { id: legacySub, status: 'active', customer: 'cus_test', metadata: { consultingFirmId: firm.id, productType: 'addon_subscription', addonSlug: 'teaming_suite' } }

    await handleWebhookEvent(event('customer.subscription.updated', legacy) as any)
    expect((await state()).purchasedAddons).toContain('teaming_suite')

    await handleWebhookEvent(event('customer.subscription.deleted', { ...legacy, status: 'canceled' }) as any)
    const s = await state()
    expect(s.purchasedAddons).not.toContain('teaming_suite')
    expect(s.rows[0].status).toBe('CANCELED')
  })
})

