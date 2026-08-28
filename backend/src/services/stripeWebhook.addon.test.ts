// =============================================================
// Stripe webhook — add-on subscription lifecycle (integration,
// live test DB). Guards the new revenue path: an add-on module is
// its own Stripe subscription; the webhook must sync the
// AddonSubscription row, the purchasedAddons entitlement cache,
// and the module's monthly token grant.
// =============================================================
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'

import { prisma } from '../config/database'
import { handleWebhookEvent } from './stripeService'
import { createTestFirm, cleanupFirm, disconnectDb, TestFirm } from '../test-utils/testClient'

let firm: TestFirm
let seq = 0
const evtId = () => `evt_test_${Date.now()}_${process.pid}_${++seq}`
const subId = () => `sub_test_${Date.now()}_${process.pid}_${++seq}`

function addonSubEvent(opts: {
  type: 'customer.subscription.created' | 'customer.subscription.updated' | 'customer.subscription.deleted'
  stripeSubId: string
  addonSlug: string
  status?: string
}) {
  return {
    id: evtId(),
    type: opts.type,
    data: {
      object: {
        id: opts.stripeSubId,
        status: opts.status ?? 'active',
        customer: 'cus_test',
        metadata: {
          consultingFirmId: firm.id,
          productType: 'addon_subscription',
          addonSlug: opts.addonSlug,
        },
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
        cancel_at_period_end: false,
      },
    },
  }
}

async function firmState() {
  const f = await prisma.consultingFirm.findUnique({
    where: { id: firm.id },
    select: { purchasedAddons: true, proposalTokens: true },
  })
  const rows = await prisma.addonSubscription.findMany({ where: { consultingFirmId: firm.id } })
  return { ...f!, rows }
}

beforeEach(async () => {
  // base plan (not all_access): token grants must reflect à-la-carte modules.
  firm = await createTestFirm({ name: 'Webhook Addon Firm', plan: 'base' })
})

afterEach(async () => {
  await cleanupFirm(firm?.id).catch(() => {
    // firm may already be gone when a test cleaned up itself
  })
})

afterAll(async () => {
  await disconnectDb()
})

describe('webhook — addon_subscription lifecycle', () => {
  it('activation: creates the AddonSubscription row, grants the entitlement, and refreshes tokens', async () => {
    const sid = subId()
    const res = await handleWebhookEvent(
      addonSubEvent({ type: 'customer.subscription.created', stripeSubId: sid, addonSlug: 'teaming_suite' }) as any,
    )
    expect(res.processed).toBe(true)

    const state = await firmState()
    expect(state.purchasedAddons).toContain('teaming_suite')
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ addonSlug: 'teaming_suite', stripeSubscriptionId: sid, status: 'ACTIVE' })
    // teaming_suite carries a 5-token monthly grant, applied immediately on activation
    expect(state.proposalTokens).toBe(5)
  })

  it('lapse: past_due pulls the entitlement but keeps the row for recovery', async () => {
    const sid = subId()
    await handleWebhookEvent(
      addonSubEvent({ type: 'customer.subscription.created', stripeSubId: sid, addonSlug: 'contract_analysis' }) as any,
    )
    await handleWebhookEvent(
      addonSubEvent({ type: 'customer.subscription.updated', stripeSubId: sid, addonSlug: 'contract_analysis', status: 'past_due' }) as any,
    )
    const state = await firmState()
    expect(state.purchasedAddons).not.toContain('contract_analysis')
    expect(state.rows[0].status).toBe('PAST_DUE')
  })

  it('deletion: cancels the row and removes the entitlement', async () => {
    const sid = subId()
    await handleWebhookEvent(
      addonSubEvent({ type: 'customer.subscription.created', stripeSubId: sid, addonSlug: 'setaside_intel' }) as any,
    )
    await handleWebhookEvent(
      addonSubEvent({ type: 'customer.subscription.deleted', stripeSubId: sid, addonSlug: 'setaside_intel', status: 'canceled' }) as any,
    )
    const state = await firmState()
    expect(state.purchasedAddons).not.toContain('setaside_intel')
    expect(state.rows[0].status).toBe('CANCELED')
  })

  it('re-subscribe after cancel reuses the (firm, module) row under the new Stripe sub id', async () => {
    const first = subId()
    const second = subId()
    await handleWebhookEvent(
      addonSubEvent({ type: 'customer.subscription.created', stripeSubId: first, addonSlug: 'market_intel' }) as any,
    )
    await handleWebhookEvent(
      addonSubEvent({ type: 'customer.subscription.deleted', stripeSubId: first, addonSlug: 'market_intel', status: 'canceled' }) as any,
    )
    await handleWebhookEvent(
      addonSubEvent({ type: 'customer.subscription.created', stripeSubId: second, addonSlug: 'market_intel' }) as any,
    )
    const state = await firmState()
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ stripeSubscriptionId: second, status: 'ACTIVE' })
    expect(state.purchasedAddons).toContain('market_intel')
  })

  it('legacy slug metadata resolves through the alias map (proposal_assistant → proposal_studio)', async () => {
    await handleWebhookEvent(
      addonSubEvent({ type: 'customer.subscription.created', stripeSubId: subId(), addonSlug: 'proposal_assistant' }) as any,
    )
    const state = await firmState()
    expect(state.purchasedAddons).toContain('proposal_studio')
    expect(state.rows[0].addonSlug).toBe('proposal_studio')
    // proposal_studio grants 25 tokens/month
    expect(state.proposalTokens).toBe(25)
  })

  it('duplicate event delivery is idempotent (same event id applies once)', async () => {
    const event = addonSubEvent({ type: 'customer.subscription.created', stripeSubId: subId(), addonSlug: 'teaming_suite' })
    const first = await handleWebhookEvent(event as any)
    const second = await handleWebhookEvent(event as any)
    expect(first.processed).toBe(true)
    expect(second).toMatchObject({ processed: false, reason: 'already_processed' })
    const state = await firmState()
    expect(state.rows).toHaveLength(1)
  })
})
