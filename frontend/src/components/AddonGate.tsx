import { Link } from 'react-router-dom'
import { Lock, Zap } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useEntitlements } from '../hooks/useEntitlements'
import { addonsApi } from '../services/api'

// Static fallback for display name/price when the ['addons'] query hasn't
// resolved yet (or fails). Keep in sync with the backend add-on catalog.
const ADDON_CATALOG: Record<string, { name: string; priceMonthly: number }> = {
  setaside_intel: { name: 'Set-Aside Intelligence', priceMonthly: 29 },
  teaming_suite: { name: 'Teaming & Subcontracting', priceMonthly: 49 },
  contract_analysis: { name: 'Contract Analysis & Compliance', priceMonthly: 59 },
  proposal_studio: { name: 'Proposal Studio', priceMonthly: 79 },
  market_intel: { name: 'Market & Competitor Intelligence', priceMonthly: 39 },
  auto_sync: { name: 'Automated Daily Sync', priceMonthly: 29 },
  api_access: { name: 'API & MCP Access', priceMonthly: 49 },
  client_portal: { name: 'Client Portal & Branded Reports', priceMonthly: 39 },
  state_municipal: { name: 'State & Municipal Access', priceMonthly: 49 },
}

interface AddonGateProps {
  addon: string
  // compact = inline lock badge instead of full overlay card
  compact?: boolean
  children: React.ReactNode
}

// Replaces TierGate: gates UI on an add-on module entitlement instead of a
// plan tier. While entitlements load, hasAddon reports true (children render)
// so users with access never see a paywall flash.
export function AddonGate({ addon, compact = false, children }: AddonGateProps) {
  const { hasAddon } = useEntitlements()
  const unlocked = hasAddon(addon)

  // Only fetch the catalog when we actually need to render the lock UI.
  const { data: addonsData } = useQuery({
    queryKey: ['addons'],
    queryFn: () => addonsApi.list(),
    staleTime: 5 * 60 * 1000,
    enabled: !unlocked,
  })

  if (unlocked) return <>{children}</>

  const fromApi = (addonsData?.data as Array<{ slug: string; name: string; priceMonthly: number }> | undefined)
    ?.find((a) => a.slug === addon)
  const name = fromApi?.name ?? ADDON_CATALOG[addon]?.name ?? addon.replace(/_/g, ' ')
  const priceMonthly = fromApi?.priceMonthly ?? ADDON_CATALOG[addon]?.priceMonthly

  if (compact) {
    return (
      <div className="relative">
        <div className="pointer-events-none opacity-30 select-none">{children}</div>
        <div className="absolute inset-0 flex items-center justify-center">
          <Link
            to="/billing#addons"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-900/80 border border-amber-600 text-amber-300 text-xs font-medium hover:bg-amber-900 transition-colors backdrop-blur-sm"
          >
            <Lock className="w-3 h-3" />
            {name} add-on
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-amber-800/40 bg-amber-950/20 px-6 py-8 text-center">
      <div className="w-10 h-10 rounded-full bg-amber-900/30 border border-amber-700 flex items-center justify-center mx-auto mb-3">
        <Lock className="w-5 h-5 text-amber-400" />
      </div>
      <h3 className="font-semibold text-gray-200 mb-1">{name} Add-on Required</h3>
      <p className="text-sm text-gray-400 mb-4 max-w-sm mx-auto">
        This section is part of the {name} module.
        {priceMonthly != null && <> Add it to your plan for ${priceMonthly}/mo.</>}
      </p>
      <Link
        to="/billing#addons"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition-colors"
      >
        <Zap className="w-4 h-4" />
        Unlock {name}
      </Link>
    </div>
  )
}
