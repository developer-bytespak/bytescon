// =============================================================
// Entitlement Service — single source of truth for what a firm
// can access under the $99-base + modular add-ons model.
//
// Resolution order (first match wins):
//   1. isOwnerComp firm flag            → all-access  (owner/demo comp)
//   2. lifetimeAccessAt set             → all-access  (Founders Lifetime)
//   3. beta_lifetime plan, good standing→ all-access  (legacy lifetime rows)
//   4. valid TRIALING subscription      → all-access  (14-day trial)
//   5. ACTIVE all_access plan           → all-access  (bundle)
//   6. ACTIVE subscription              → base + purchased add-ons
//   7. anything else                    → locked floor (billing/profile only)
//
// purchasedAddons slugs are alias-resolved so firms holding legacy
// slugs (proposal_assistant, competitor_intel, …) keep access under
// the module that absorbed them.
// =============================================================

import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import {
  ADDON_CATALOG,
  ALL_ACCESS_SLUG,
  ALL_ACCESS_TOKENS_PER_MONTH,
  getAddon,
  resolveAddonSlug,
} from '../config/addons'

export type EntitlementSource = 'owner' | 'lifetime' | 'trial' | 'bundle' | 'purchased' | 'none'

export interface Entitlements {
  /** Firm may use the core product (search, scoring, profile, pursuits). */
  baseActive: boolean
  /** Every module unlocked (owner / lifetime / trial / bundle). */
  allAccess: boolean
  /** Module slugs the firm is entitled to (alias-resolved, catalog-known). */
  addons: string[]
  source: EntitlementSource
  planSlug: string | null
  subscriptionStatus: string | null
  trialEndsAt: Date | null
}

const ALL_MODULE_SLUGS = ADDON_CATALOG.map((a) => a.slug)

function allAccessEntitlements(
  source: EntitlementSource,
  ctx: { planSlug?: string | null; status?: string | null; trialEndsAt?: Date | null } = {},
): Entitlements {
  return {
    baseActive: true,
    allAccess: true,
    addons: [...ALL_MODULE_SLUGS],
    source,
    planSlug: ctx.planSlug ?? null,
    subscriptionStatus: ctx.status ?? null,
    trialEndsAt: ctx.trialEndsAt ?? null,
  }
}

export async function getEntitlements(consultingFirmId: string): Promise<Entitlements> {
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: {
      isOwnerComp: true,
      lifetimeAccessAt: true,
      purchasedAddons: true,
      subscription: { include: { plan: { select: { slug: true } } } },
    },
  })
  if (!firm) {
    return {
      baseActive: false, allAccess: false, addons: [], source: 'none',
      planSlug: null, subscriptionStatus: null, trialEndsAt: null,
    }
  }

  const sub = firm.subscription
  const planSlug = sub?.plan.slug ?? null
  const status = sub?.status ?? null
  const now = new Date()

  if (firm.isOwnerComp) {
    return allAccessEntitlements('owner', { planSlug, status, trialEndsAt: sub?.trialEndsAt })
  }
  if (firm.lifetimeAccessAt) {
    return allAccessEntitlements('lifetime', { planSlug, status })
  }
  if (planSlug === 'beta_lifetime' && (status === 'ACTIVE' || status === 'TRIALING')) {
    return allAccessEntitlements('lifetime', { planSlug, status })
  }

  const trialValid =
    status === 'TRIALING' && sub?.trialEndsAt != null && sub.trialEndsAt > now
  if (trialValid) {
    return allAccessEntitlements('trial', { planSlug, status, trialEndsAt: sub?.trialEndsAt })
  }

  const subGood = status === 'ACTIVE'
  if (subGood && planSlug === ALL_ACCESS_SLUG) {
    return allAccessEntitlements('bundle', { planSlug, status })
  }

  // Any other ACTIVE plan counts as base — covers the base plan itself and
  // legacy tier rows in the window between deploy and the cutover script.
  const baseActive = subGood
  const addons = Array.from(
    new Set(
      firm.purchasedAddons
        .map(resolveAddonSlug)
        .filter((slug) => ALL_MODULE_SLUGS.includes(slug)),
    ),
  )

  return {
    baseActive,
    allAccess: false,
    addons,
    source: baseActive ? 'purchased' : 'none',
    planSlug,
    subscriptionStatus: status,
    trialEndsAt: sub?.trialEndsAt ?? null,
  }
}

export function hasAddonEntitlement(ents: Entitlements, addonSlug: string): boolean {
  if (ents.allAccess) return true
  return ents.addons.includes(resolveAddonSlug(addonSlug))
}

/**
 * Monthly proposal-token allocation implied by a firm's entitlements:
 * all-access sources get the flat bundle grant; à-la-carte firms get the
 * sum of the grants carried by their modules (Proposal Studio 25, Contract
 * Analysis 15, Teaming 5).
 */
export function computeMonthlyTokenGrant(ents: Entitlements): number {
  if (ents.allAccess) return ALL_ACCESS_TOKENS_PER_MONTH
  if (!ents.baseActive) return 0
  return ents.addons.reduce((sum, slug) => sum + (getAddon(slug)?.tokensPerMonth ?? 0), 0)
}

// -------------------------------------------------------------
// Per-request cache — router-level requireActiveBase and route-level
// requireAddon both run on the same request; resolve the firm once.
// -------------------------------------------------------------

const ENTITLEMENTS_KEY = '__entitlements'

export async function getEntitlementsForRequest(
  req: AuthenticatedRequest,
  consultingFirmId: string,
): Promise<Entitlements> {
  const cached = (req as any)[ENTITLEMENTS_KEY] as Entitlements | undefined
  if (cached) return cached
  const ents = await getEntitlements(consultingFirmId)
  ;(req as any)[ENTITLEMENTS_KEY] = ents
  return ents
}
