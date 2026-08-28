import { useQuery } from '@tanstack/react-query'
import { billingApi } from '../services/api'

// Mirrors GET /api/billing/entitlements → data
export interface Entitlements {
  baseActive: boolean
  allAccess: boolean
  addons: string[]
  source: 'owner' | 'lifetime' | 'trial' | 'bundle' | 'purchased' | 'none'
  planSlug: string | null
  subscriptionStatus: string | null
  trialEndsAt: string | null
  tokenBalance: number
  monthlyTokenGrant: number
}

export function useEntitlements(): {
  entitlements: Entitlements | undefined
  isLoading: boolean
  baseActive: boolean
  allAccess: boolean
  hasAddon: (slug: string) => boolean
} {
  const { data, isLoading } = useQuery({
    queryKey: ['entitlements'],
    queryFn: () => billingApi.getEntitlements(),
    staleTime: 60 * 1000,
  })

  const entitlements: Entitlements | undefined = data?.data

  // While loading we report access as GRANTED so gated UI doesn't flash a
  // paywall at every page load. Strict consumers (e.g. checkout flows) should
  // check isLoading before trusting these.
  const allAccess = entitlements?.allAccess ?? false
  const baseActive = isLoading ? true : (entitlements?.baseActive ?? false)

  function hasAddon(slug: string): boolean {
    if (isLoading) return true
    if (!entitlements) return false
    return entitlements.allAccess || entitlements.addons.includes(slug)
  }

  return { entitlements, isLoading, baseActive, allAccess, hasAddon }
}
