import { useEntitlements } from './useEntitlements'

// LEGACY tier slugs — kept only so existing importers keep compiling until
// they migrate to useEntitlements/AddonGate. The multi-tier plan model is
// gone: there is one base plan + add-on modules (+ All Access bundle).
export type TierSlug = 'personal' | 'starter' | 'beta_lifetime' | 'professional' | 'enterprise' | 'elite'

// Old feature slugs → new add-on modules. Anything not listed is part of the
// base plan and only requires an active base subscription.
const FEATURE_TO_ADDON: Record<string, string> = {
  analytics: 'market_intel',
  deep_market_intel: 'market_intel',
  client_portal: 'client_portal',
  api_access: 'api_access',
  template_library: 'proposal_studio',
  bid_guidance: 'contract_analysis',
}

// COMPATIBILITY SHIM over useEntitlements. Preserves the old return shape
// ({ slug, status, usage, plan, isLoading, hasFeature, hasAddon, atOrAbove })
// so existing importers keep working. Note: the old ADMIN-role bypass in
// hasAddon was a bug and is intentionally NOT carried over.
export function useTier() {
  const { entitlements, isLoading, baseActive, allAccess, hasAddon } = useEntitlements()

  // Approximate the old tier ladder from the new entitlement state.
  const slug: TierSlug =
    entitlements?.source === 'lifetime' ? 'beta_lifetime'
    : allAccess ? 'elite'
    : baseActive ? 'professional'
    : 'starter'
  const status = entitlements?.subscriptionStatus ?? 'ACTIVE'
  // Usage counters lived on the old /billing/subscription payload; nothing in
  // the new model consumes them — kept as zeros purely for shape compatibility.
  const usage = { clients: 0, users: 0, aiCalls: 0 }
  const plan = entitlements?.planSlug ? { slug: entitlements.planSlug } : undefined

  function hasFeature(feature: string): boolean {
    const addon = FEATURE_TO_ADDON[feature]
    if (addon) return hasAddon(addon)
    return baseActive
  }

  function atOrAbove(tier: TierSlug): boolean {
    const RANK: Record<string, number> = { personal: 0, starter: 1, beta_lifetime: 2, professional: 2, enterprise: 3, elite: 4 }
    return (RANK[slug] ?? 0) >= (RANK[tier] ?? 0)
  }

  return { slug, status, usage, plan, hasFeature, hasAddon, atOrAbove, isLoading }
}
