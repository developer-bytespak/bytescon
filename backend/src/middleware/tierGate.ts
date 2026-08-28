import { prisma } from '../config/database'
import { logAudit } from '../services/auditService'
import { getEntitlements, computeMonthlyTokenGrant } from '../services/entitlementService'

// NOTE: the per-tier feature sets (TIER_FEATURES / requireFeature) that lived
// here died with the six-tier model. Feature access is now module-based —
// see middleware/addonGate.ts (requireActiveBase / requireAddon) backed by
// services/entitlementService.ts. This file keeps the plan-limit checks
// (seats / clients / AI calls) and the proposal-token economy.

// Free-floor limits for firms with no subscription in good standing. Product
// access is blocked by requireActiveBase anyway; these only bound what a
// locked-out firm can still hold (existing data, billing, profile).
const FLOOR_PLAN = { slug: 'none', maxUsers: 1, maxClients: 5, aiCallsPerMonth: 0 }

export async function getFirmPlan(consultingFirmId: string): Promise<{ slug: string; maxUsers: number; maxClients: number; aiCallsPerMonth: number }> {
  const sub = await prisma.subscription.findUnique({
    where: { consultingFirmId },
    include: { plan: true },
  })
  if (!sub) {
    return { ...FLOOR_PLAN }
  }
  // Downgrade to the free floor when the subscription is not in good standing.
  // CANCELED + PAST_DUE are unambiguously inactive; an expired TRIALING window
  // must not retain paid features (previously trials kept full access forever).
  // NOTE: ACTIVE subs whose currentPeriodEnd has lapsed are intentionally NOT
  // downgraded here yet — that requires the Stripe webhook to reliably advance
  // currentPeriodEnd on renewal (a separate fix). Enforcing period expiry before
  // that is wired would wrongly cut off paying customers at each period boundary.
  const trialExpired =
    sub.status === 'TRIALING' && sub.trialEndsAt != null && sub.trialEndsAt < new Date()
  if (sub.status === 'CANCELED' || sub.status === 'PAST_DUE' || trialExpired) {
    return { ...FLOOR_PLAN }
  }
  return {
    slug: sub.plan.slug,
    maxUsers: sub.plan.maxUsers,
    maxClients: sub.plan.maxClients,
    aiCallsPerMonth: sub.plan.aiCallsPerMonth,
  }
}

// Check if firm is within client limit
export async function checkClientLimit(consultingFirmId: string): Promise<{ allowed: boolean; current: number; max: number }> {
  const [plan, current] = await Promise.all([
    getFirmPlan(consultingFirmId),
    prisma.clientCompany.count({ where: { consultingFirmId, isActive: true } }),
  ])
  if (plan.maxClients === -1) return { allowed: true, current, max: -1 }
  return { allowed: current < plan.maxClients, current, max: plan.maxClients }
}

// Check if firm is within its user/seat limit (owner + invited team members).
// Drives the per-tier team-member invite cap: Starter (maxUsers 1) = owner only
// / 0 invites; higher tiers scale up; -1 = unlimited.
export async function checkUserLimit(consultingFirmId: string): Promise<{ allowed: boolean; current: number; max: number; slug: string }> {
  const [plan, current] = await Promise.all([
    getFirmPlan(consultingFirmId),
    prisma.user.count({ where: { consultingFirmId } }),
  ])
  if (plan.maxUsers === -1) return { allowed: true, current, max: -1, slug: plan.slug }
  return { allowed: current < plan.maxUsers, current, max: plan.maxUsers, slug: plan.slug }
}

// ---------------------------------------------------------------
// Proposal Token System
// ---------------------------------------------------------------

// Refresh tokens if it's a new calendar month (lazy refresh — no cron needed).
// The monthly allocation comes from the firm's add-on modules (Proposal
// Studio 25, Contract Analysis 15, Teaming 5; all-access sources a flat 50)
// and is added ON TOP of any remaining purchased tokens.
async function maybeRefreshTokens(consultingFirmId: string): Promise<void> {
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { lastTokenRefreshAt: true, proposalTokens: true },
  })
  if (!firm) return

  const now = new Date()
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  if (firm.lastTokenRefreshAt && firm.lastTokenRefreshAt >= thisMonth) return

  const ents = await getEntitlements(consultingFirmId)
  const monthlyGrant = computeMonthlyTokenGrant(ents)

  // Add the monthly grant on top of the existing balance. The 500 cap bounds
  // what the monthly grant can accumulate to — it must NOT clamp the balance
  // itself, or a firm holding more than 500 purchased pack tokens (sold as
  // "tokens never expire") would have the excess silently deleted on the first
  // call of a new month.
  const newBalance = firm.proposalTokens + Math.max(0, Math.min(monthlyGrant, 500 - firm.proposalTokens))

  await prisma.consultingFirm.update({
    where: { id: consultingFirmId },
    data: { proposalTokens: newBalance, lastTokenRefreshAt: now },
  })
}

export async function checkProposalTokens(
  consultingFirmId: string,
  cost = 1
): Promise<{ allowed: boolean; balance: number }> {
  await maybeRefreshTokens(consultingFirmId)
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { proposalTokens: true },
  })
  const balance = firm?.proposalTokens ?? 0
  return { allowed: balance >= cost, balance }
}

/**
 * Decrement a firm's proposalTokens balance and emit an AuditEvent for
 * billing-dispute observability. Pass `ctx` whenever the caller has the
 * relevant request context (always, in practice — both call sites are inside
 * authenticated routes). The audit row records balance before/after so a
 * post-hoc replay can reconstruct what happened.
 */
export async function deductProposalTokens(
  consultingFirmId: string,
  cost: number,
  ctx?: { userId?: string | null; opportunityId?: string | null; reason?: string },
): Promise<number> {
  const before = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { proposalTokens: true },
  })
  const updated = await prisma.consultingFirm.update({
    where: { id: consultingFirmId },
    data: { proposalTokens: { decrement: cost } },
    select: { proposalTokens: true },
  })

  // logAudit is fire-and-forget and catches its own errors; safe to not await.
  // Emitted unconditionally so even contextless deductions are still visible
  // in the audit table — observability beats noise.
  void logAudit({
    consultingFirmId,
    actorUserId: ctx?.userId ?? null,
    action: 'PROPOSAL_TOKENS_DEDUCTED',
    entityType: 'ProposalTokens',
    entityId: ctx?.opportunityId ?? null,
    rationale: ctx?.reason ?? `Deducted ${cost} proposal token(s)`,
    before: { balance: before?.proposalTokens ?? null },
    after: { balance: updated.proposalTokens, delta: -cost },
  })

  return updated.proposalTokens
}

// Check if firm is within AI call limit this month
export async function checkAiCallLimit(consultingFirmId: string): Promise<{ allowed: boolean; current: number; max: number }> {
  const [plan, current] = await Promise.all([
    getFirmPlan(consultingFirmId),
    prisma.apiUsageLog.count({
      where: {
        consultingFirmId,
        cacheHit: false,
        createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
      },
    }),
  ])
  if (plan.aiCallsPerMonth === -1) return { allowed: true, current, max: -1 }
  return { allowed: current < plan.aiCallsPerMonth, current, max: plan.aiCallsPerMonth }
}
