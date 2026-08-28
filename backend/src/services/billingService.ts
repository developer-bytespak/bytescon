import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import {
  ALL_ACCESS_SLUG,
  ALL_ACCESS_TOKENS_PER_MONTH,
  BASE_PLAN_SLUG,
} from '../config/addons'
import { getEntitlements, computeMonthlyTokenGrant } from './entitlementService'

// ──────────────────────────────────────────────────────────────
// Plan catalogue — the single-plan model: one $99 base plan, the
// $199 all-access bundle, and the $2,500 Founders Lifetime. All
// feature depth beyond the base lives in the add-on catalog
// (config/addons.ts), not in plan tiers.
// ──────────────────────────────────────────────────────────────
const DEFAULT_PLANS = [
  {
    slug: BASE_PLAN_SLUG,
    name: 'Bytescon Core',
    monthlyPriceUsd: 99,
    annualPriceUsd: 84, // ~15% annual discount (per-month equivalent)
    maxUsers: 3,
    maxClients: 5,
    aiCallsPerMonth: 500,
    features: [
      'SAM.gov contract search across your NAICS codes',
      'Win-probability scoring on every opportunity (Bytescon engine)',
      'Score breakdowns + bid / no-bid decision engine',
      'Company profile & onboarding — up to 5 client companies',
      'Bid pursuit tracker — declare submitted or passed, track outcomes',
      'Dashboard, pipeline & submission tracking',
      '3 seats included',
      'Email support',
      'Add feature modules anytime — from $29/mo',
    ],
    sortOrder: 1,
  },
  {
    slug: ALL_ACCESS_SLUG,
    name: 'All Access',
    monthlyPriceUsd: 199,
    annualPriceUsd: 169,
    maxUsers: 10,
    maxClients: -1,
    aiCallsPerMonth: -1,
    features: [
      'Everything in Core',
      'ALL add-on modules included — Set-Aside Intelligence, Teaming & Subcontracting, Contract Analysis, Proposal Studio, Market Intel, Daily Auto-Sync, API & MCP Access, Client Portal',
      `${ALL_ACCESS_TOKENS_PER_MONTH} proposal tokens every month`,
      '10 seats · unlimited client companies',
      'Priority support',
      'Save over 50% vs adding modules individually',
    ],
    sortOrder: 2,
  },
  {
    slug: 'beta_lifetime',
    name: 'Founders Lifetime Access',
    monthlyPriceUsd: 2500,
    annualPriceUsd: 2500,
    maxUsers: 10,
    maxClients: -1,
    aiCallsPerMonth: -1,
    features: [
      'LIFETIME ACCESS — one-time $2,500 payment, never expires (20 founder slots)',
      'The Core plan + ALL add-on modules, forever',
      '200 proposal tokens up front, then 50 every month',
      '10 seats · unlimited client companies',
      'Founding Member badge & priority support',
      'Locked-in access to every future module',
    ],
    sortOrder: 3,
  },
]

// Retired tier slugs from the pre-2026-07 six-tier model. getOrSeedPlans
// deactivates them so they vanish from every catalog endpoint, but the rows
// stay for FK integrity with historical subscriptions/invoices.
export const LEGACY_PLAN_SLUGS = ['personal', 'starter', 'professional', 'enterprise', 'elite']

export async function getOrSeedPlans() {
  // Upsert on slug so price/feature changes in code are always reflected in DB
  for (const p of DEFAULT_PLANS) {
    await prisma.subscriptionPlan.upsert({
      where: { slug: p.slug },
      update: {
        name: p.name,
        monthlyPriceUsd: new Prisma.Decimal(p.monthlyPriceUsd),
        annualPriceUsd: new Prisma.Decimal(p.annualPriceUsd),
        maxUsers: p.maxUsers,
        maxClients: p.maxClients,
        aiCallsPerMonth: p.aiCallsPerMonth,
        features: p.features,
        sortOrder: p.sortOrder,
        isActive: true,
      },
      create: {
        slug: p.slug,
        name: p.name,
        monthlyPriceUsd: new Prisma.Decimal(p.monthlyPriceUsd),
        annualPriceUsd: new Prisma.Decimal(p.annualPriceUsd),
        maxUsers: p.maxUsers,
        maxClients: p.maxClients,
        aiCallsPerMonth: p.aiCallsPerMonth,
        features: p.features,
        sortOrder: p.sortOrder,
      },
    })
  }
  // Retire the six-tier catalog wherever it still exists (idempotent).
  await prisma.subscriptionPlan.updateMany({
    where: { slug: { in: LEGACY_PLAN_SLUGS }, isActive: true },
    data: { isActive: false },
  })
  return prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  })
}

// Auto-creates the 14-day free trial if no subscription exists. The trial row
// lives on the base plan; entitlementService grants a valid TRIALING sub
// all-access so evaluators see every module before choosing add-ons.
export async function getOrCreateSubscription(consultingFirmId: string) {
  const existing = await prisma.subscription.findUnique({
    where: { consultingFirmId },
    include: { plan: true },
  })
  if (existing) return existing

  const plans = await getOrSeedPlans()
  const trialPlan = plans.find((p) => p.slug === BASE_PLAN_SLUG) ?? plans[0]

  const now = new Date()
  const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)

  return prisma.subscription.create({
    data: {
      consultingFirmId,
      planId: trialPlan.id,
      status: 'TRIALING',
      billingCycle: 'MONTHLY',
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd,
      trialEndsAt: trialEnd,
    },
    include: { plan: true },
  })
}

// One-time initial token grant for lifetime buyers
const LIFETIME_INITIAL_GRANT = 200

/**
 * Grant this month's token allocation from the firm's current entitlements
 * (sum of the token grants on its add-on modules; flat grant for all-access
 * sources). Called after add-on subscription changes so a new Proposal Studio
 * subscriber doesn't wait for the next calendar-month lazy refresh. Additive
 * on top of any purchased pack tokens (capped at 500, same as the lazy
 * refresh); stamps lastTokenRefreshAt so the lazy refresh won't double-grant
 * this month.
 */
export async function refreshProposalTokens(consultingFirmId: string): Promise<void> {
  const ents = await getEntitlements(consultingFirmId)
  const grant = computeMonthlyTokenGrant(ents)
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { proposalTokens: true },
  })
  if (!firm) return
  await prisma.consultingFirm.update({
    where: { id: consultingFirmId },
    data: {
      // Cap the GRANT at 500, never the balance — purchased pack tokens can
      // legitimately exceed 500 and must survive the monthly refresh.
      proposalTokens: firm.proposalTokens + Math.max(0, Math.min(grant, 500 - firm.proposalTokens)),
      lastTokenRefreshAt: new Date(),
    },
  })
}

/**
 * Activate a lifetime subscription — called after one-time payment confirmation.
 * Accepts a transaction client so the Stripe webhook can commit the entitlement
 * atomically with its audit row; plan seeding stays outside the transaction
 * (catalog rows are shared and idempotent).
 */
export async function activateLifetime(consultingFirmId: string, db: Prisma.TransactionClient = prisma) {
  const plans = await getOrSeedPlans()
  const betaPlan = plans.find((p) => p.slug === 'beta_lifetime')
  if (!betaPlan) throw new Error('Beta lifetime plan not found')

  const now = new Date()
  const lifetime = new Date(now.getFullYear() + 99, now.getMonth(), now.getDate())

  const sub = await db.subscription.upsert({
    where: { consultingFirmId },
    update: {
      planId: betaPlan.id,
      status: 'ACTIVE',
      billingCycle: 'ANNUAL',
      currentPeriodStart: now,
      currentPeriodEnd: lifetime,
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
    },
    create: {
      consultingFirmId,
      planId: betaPlan.id,
      status: 'ACTIVE',
      billingCycle: 'ANNUAL',
      currentPeriodStart: now,
      currentPeriodEnd: lifetime,
    },
    include: { plan: true },
  })
  // Lifetime buyers get a generous initial token grant instead of the standard monthly refresh
  await db.consultingFirm.update({
    where: { id: consultingFirmId },
    data: { proposalTokens: LIFETIME_INITIAL_GRANT, lastTokenRefreshAt: new Date() },
  })
  return sub
}

export async function getUsage(consultingFirmId: string) {
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  const [clients, users, aiCalls] = await Promise.all([
    prisma.clientCompany.count({ where: { consultingFirmId, isActive: true } }),
    prisma.user.count({ where: { consultingFirmId, isActive: true } }),
    prisma.apiUsageLog.count({
      where: { consultingFirmId, cacheHit: false, createdAt: { gte: monthStart } },
    }),
  ])
  return { clients, users, aiCalls }
}

export async function generateInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `INV-${year}-`
  const count = await prisma.invoice.count({ where: { invoiceNumber: { startsWith: prefix } } })
  return `${prefix}${String(count + 1).padStart(4, '0')}`
}

export async function createInvoice(
  consultingFirmId: string,
  subscriptionId: string,
  opts: {
    periodStart: Date
    periodEnd: Date
    dueAt: Date
    notes?: string
    lineItems: Array<{ description: string; quantity: number; unitPriceUsd: number }>
  }
) {
  const invoiceNumber = await generateInvoiceNumber()
  const subtotal = opts.lineItems.reduce((s, li) => s + li.quantity * li.unitPriceUsd, 0)

  return prisma.invoice.create({
    data: {
      consultingFirmId,
      subscriptionId,
      invoiceNumber,
      status: 'OPEN',
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      dueAt: opts.dueAt,
      subtotalUsd: new Prisma.Decimal(subtotal),
      taxUsd: new Prisma.Decimal(0),
      totalUsd: new Prisma.Decimal(subtotal),
      notes: opts.notes,
      lineItems: {
        create: opts.lineItems.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unitPriceUsd: new Prisma.Decimal(li.unitPriceUsd),
          totalUsd: new Prisma.Decimal(li.quantity * li.unitPriceUsd),
        })),
      },
    },
    include: { lineItems: true },
  })
}
