// =============================================================
// Stripe webhook — idempotency claim + past-due recovery
// (integration, live test DB). Guards the money path: a token-pack
// credit must apply exactly once no matter how many concurrent
// retries Stripe sends, and a firm that pays its past-due invoice
// must get its subscription back without waiting for a
// customer.subscription.updated that may never fire.
// =============================================================
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'

import { prisma } from '../config/database'
import { handleWebhookEvent } from './stripeService'
import { createTestFirm, cleanupFirm, disconnectDb, TestFirm } from '../test-utils/testClient'

let firm: TestFirm
let seq = 0
const evtId = () => `evt_test_${Date.now()}_${process.pid}_${++seq}`
const uniq = (prefix: string) => `${prefix}_${Date.now()}_${process.pid}_${++seq}`

function tokenPackEvent(tokenAmount = 40) {
  return {
    id: evtId(),
    type: 'checkout.session.completed',
    data: {
      object: {
        id: uniq('cs_test'),
        url: null,
        amount_total: 5000,
        metadata: {
          consultingFirmId: firm.id,
          productType: 'token_pack',
          packSlug: 'proposal_tokens_40',
          tokenAmount: String(tokenAmount),
        },
      },
    },
  }
}

function invoiceEvent(opts: { customer: string; subscription?: string | null; type?: string }) {
  return {
    id: evtId(),
    type: opts.type ?? 'invoice.payment_succeeded',
    data: {
      object: {
        id: uniq('in_test'),
        customer: opts.customer,
        subscription: opts.subscription,
        amount_paid: 9900,
      },
    },
  }
}

async function firmTokens(): Promise<number> {
  const f = await prisma.consultingFirm.findUnique({
    where: { id: firm.id },
    select: { proposalTokens: true },
  })
  return f!.proposalTokens
}

const eventIds: string[] = []
function track<T extends { id: string }>(event: T): T {
  eventIds.push(event.id)
  return event
}

beforeEach(async () => {
  firm = await createTestFirm({ name: 'Webhook Idempotency Firm', plan: 'base' })
})

afterEach(async () => {
  await cleanupFirm(firm?.id).catch(() => {
    // firm may already be gone when a test cleaned up itself
  })
  // claim rows have no firm FK, so the cascade doesn't reach them
  await prisma.stripeWebhookEvent.deleteMany({ where: { eventId: { in: eventIds.splice(0) } } })
})

afterAll(async () => {
  await disconnectDb()
})

describe('webhook — idempotency claim', () => {
  it('concurrent duplicate deliveries credit a token pack exactly once', async () => {
    const event = track(tokenPackEvent(40))
    const results = await Promise.all([
      handleWebhookEvent(event as any).catch((err) => ({ processed: false, reason: `threw:${err.message}` })),
      handleWebhookEvent(event as any).catch((err) => ({ processed: false, reason: `threw:${err.message}` })),
    ])

    const winners = results.filter((r) => r.processed)
    expect(winners).toHaveLength(1)
    // the loser is turned away as in_progress (winner still running) or
    // already_processed (winner finished first) — never a second apply
    const loser = results.find((r) => !r.processed)!
    expect(['in_progress', 'already_processed']).toContain((loser as any).reason)

    expect(await firmTokens()).toBe(40)
  })

  it('sequential duplicate delivery is already_processed and does not re-credit', async () => {
    const event = track(tokenPackEvent(40))
    const first = await handleWebhookEvent(event as any)
    const second = await handleWebhookEvent(event as any)
    expect(first.processed).toBe(true)
    expect(second).toMatchObject({ processed: false, reason: 'already_processed' })
    expect(await firmTokens()).toBe(40)
  })

  it('a FAILED claim is reclaimed by the retry and the event applies', async () => {
    const event = track(tokenPackEvent(40))
    await prisma.stripeWebhookEvent.create({
      data: { eventId: event.id, eventType: event.type, status: 'FAILED', error: 'boom' },
    })

    const result = await handleWebhookEvent(event as any)
    expect(result.processed).toBe(true)
    expect(await firmTokens()).toBe(40)

    const claim = await prisma.stripeWebhookEvent.findUnique({ where: { eventId: event.id } })
    expect(claim).toMatchObject({ status: 'COMPLETED', error: null })
  })

  it('a fresh PROCESSING claim held by another delivery is reported in_progress', async () => {
    const event = track(tokenPackEvent(40))
    await prisma.stripeWebhookEvent.create({
      data: { eventId: event.id, eventType: event.type, status: 'PROCESSING' },
    })

    const result = await handleWebhookEvent(event as any)
    expect(result).toMatchObject({ processed: false, reason: 'in_progress' })
    expect(await firmTokens()).toBe(0)
  })

  it('a stale PROCESSING claim (dead handler) is reclaimed', async () => {
    const event = track(tokenPackEvent(40))
    await prisma.stripeWebhookEvent.create({
      data: { eventId: event.id, eventType: event.type, status: 'PROCESSING' },
    })
    // age the claim past the stale window (updatedAt is @updatedAt, so raw SQL)
    await prisma.$executeRaw`UPDATE "stripe_webhook_events" SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE "eventId" = ${event.id}`

    const result = await handleWebhookEvent(event as any)
    expect(result.processed).toBe(true)
    expect(await firmTokens()).toBe(40)
  })

  it('honors pre-deploy ComplianceLog markers (legacy idempotency)', async () => {
    const event = track(tokenPackEvent(40))
    await prisma.complianceLog.create({
      data: {
        consultingFirmId: firm.id,
        entityType: 'OTHER',
        entityId: event.id,
        fromStatus: 'PENDING',
        toStatus: 'COMPLETED',
        reason: 'processed before the claim table existed',
        triggeredBy: 'stripe-webhook:legacy',
      },
    })

    const result = await handleWebhookEvent(event as any)
    expect(result).toMatchObject({ processed: false, reason: 'already_processed' })
    expect(await firmTokens()).toBe(0)
  })
})

describe('webhook — invoice.payment_succeeded past-due recovery', () => {
  const customerId = () => uniq('cus_test')
  const subscriptionId = () => uniq('sub_test')

  async function wireStripeIds() {
    const cus = customerId()
    const sub = subscriptionId()
    await prisma.consultingFirm.update({
      where: { id: firm.id },
      data: { stripeCustomerId: cus, stripeSubscriptionId: sub },
    })
    return { cus, sub }
  }

  async function setLocalStatus(status: 'PAST_DUE' | 'CANCELED' | 'ACTIVE') {
    await prisma.subscription.updateMany({
      where: { consultingFirmId: firm.id },
      data: { status },
    })
  }

  async function localStatus(): Promise<string> {
    const row = await prisma.subscription.findUnique({
      where: { consultingFirmId: firm.id },
      select: { status: true },
    })
    return row!.status
  }

  it('restores a PAST_DUE plan subscription when its invoice is paid', async () => {
    const { cus, sub } = await wireStripeIds()
    await setLocalStatus('PAST_DUE')

    const result = await handleWebhookEvent(track(invoiceEvent({ customer: cus, subscription: sub })) as any)
    expect(result.processed).toBe(true)
    expect(await localStatus()).toBe('ACTIVE')
  })

  it('invoice.paid recovers the same way', async () => {
    const { cus, sub } = await wireStripeIds()
    await setLocalStatus('PAST_DUE')

    await handleWebhookEvent(track(invoiceEvent({ customer: cus, subscription: sub, type: 'invoice.paid' })) as any)
    expect(await localStatus()).toBe('ACTIVE')
  })

  it('an add-on module invoice does NOT restore the plan subscription', async () => {
    const { cus } = await wireStripeIds()
    await setLocalStatus('PAST_DUE')

    const result = await handleWebhookEvent(
      track(invoiceEvent({ customer: cus, subscription: subscriptionId() })) as any,
    )
    expect(result).toMatchObject({ processed: true, reason: 'not_plan_subscription' })
    expect(await localStatus()).toBe('PAST_DUE')
  })

  it('never resurrects a CANCELED subscription', async () => {
    const { cus, sub } = await wireStripeIds()
    await setLocalStatus('CANCELED')

    await handleWebhookEvent(track(invoiceEvent({ customer: cus, subscription: sub })) as any)
    expect(await localStatus()).toBe('CANCELED')
  })

  it('ignores one-time payment invoices (no subscription)', async () => {
    const { cus } = await wireStripeIds()
    await setLocalStatus('PAST_DUE')

    const result = await handleWebhookEvent(track(invoiceEvent({ customer: cus, subscription: null })) as any)
    expect(result).toMatchObject({ processed: false, reason: 'not_subscription_invoice' })
    expect(await localStatus()).toBe('PAST_DUE')
  })
})
