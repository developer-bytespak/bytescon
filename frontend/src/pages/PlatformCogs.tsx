// Fleet-wide gross margin per tenant (FIXES.md FIX-6). Platform admin only.
import { useQuery } from '@tanstack/react-query'
import { firmApi, clientDocumentsApi } from '../services/api'
import { PageHeader, Spinner, ErrorBanner } from '../components/ui'
import { AlertTriangle, DollarSign } from 'lucide-react'

interface MarginRow {
  firmId: string
  name: string
  plan: string
  status: string
  monthlyRevenueUsd: number
  llmCostUsd: number
  llmCalls: number
  grossMarginUsd: number
  grossMarginPct: number | null
}

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const marginColor = (pct: number | null) =>
  pct == null ? 'text-gray-500' : pct < 0 ? 'text-red-400' : pct < 50 ? 'text-yellow-400' : 'text-green-400'

export function PlatformCogsPage() {
  const { data: modData, isLoading: modLoading } = useQuery({
    queryKey: ['can-moderate-templates'],
    queryFn: () => clientDocumentsApi.canModerateTemplates(),
  })
  const canView = !!modData?.data?.canModerate

  const { data, isLoading, error } = useQuery({
    queryKey: ['platform-cogs-margin'],
    queryFn: () => firmApi.platformCogsMargin(30),
    enabled: canView,
  })

  if (modLoading) return <Spinner />
  if (!canView) {
    return (
      <div>
        <PageHeader title="Fleet Margin" subtitle="Per-tenant gross margin" />
        <div className="card flex gap-3">
          <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-gray-300">
            Platform-administrator access is required. Ask the platform operator to add your email to{' '}
            <code>PLATFORM_ADMIN_EMAILS</code>.
          </p>
        </div>
      </div>
    )
  }
  if (error) return <ErrorBanner message="Failed to load margin report" />
  if (isLoading) return <Spinner />

  const fleet = data?.data?.fleet
  const firms: MarginRow[] = data?.data?.firms || []

  return (
    <div>
      <PageHeader
        title="Fleet Margin"
        subtitle="Monthly gross margin per tenant: subscription revenue − LLM COGS (last 30 days)"
      />

      <div className="card flex gap-3 mb-6">
        <DollarSign className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-gray-400">{data?.data?.note}</p>
      </div>

      {fleet && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="card"><p className="text-xs text-gray-500">Monthly revenue</p><p className="text-lg font-mono text-gray-100">{usd(fleet.monthlyRevenueUsd)}</p></div>
          <div className="card"><p className="text-xs text-gray-500">LLM COGS</p><p className="text-lg font-mono text-gray-100">{usd(fleet.llmCostUsd)}</p></div>
          <div className="card"><p className="text-xs text-gray-500">Gross margin</p><p className="text-lg font-mono text-gray-100">{usd(fleet.grossMarginUsd)}</p></div>
          <div className="card"><p className="text-xs text-gray-500">Margin %</p><p className={`text-lg font-mono ${marginColor(fleet.grossMarginPct)}`}>{fleet.grossMarginPct == null ? '—' : `${fleet.grossMarginPct}%`}</p></div>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
              <th className="pb-2 font-medium">Firm</th>
              <th className="pb-2 font-medium">Plan</th>
              <th className="pb-2 font-medium text-right">Revenue/mo</th>
              <th className="pb-2 font-medium text-right">LLM COGS</th>
              <th className="pb-2 font-medium text-right">Calls</th>
              <th className="pb-2 font-medium text-right">Margin</th>
              <th className="pb-2 font-medium text-right">Margin %</th>
            </tr>
          </thead>
          <tbody>
            {firms.length === 0 && (
              <tr><td colSpan={7} className="py-4 text-center text-gray-500">No firms.</td></tr>
            )}
            {firms.map((r) => (
              <tr key={r.firmId} className="border-b border-gray-900">
                <td className="py-2 text-gray-200">{r.name}</td>
                <td className="py-2 text-gray-400">{r.plan}</td>
                <td className="py-2 text-right font-mono text-gray-300">{usd(r.monthlyRevenueUsd)}</td>
                <td className="py-2 text-right font-mono text-gray-300">{usd(r.llmCostUsd)}</td>
                <td className="py-2 text-right font-mono text-gray-500">{r.llmCalls}</td>
                <td className="py-2 text-right font-mono text-gray-300">{usd(r.grossMarginUsd)}</td>
                <td className={`py-2 text-right font-mono ${marginColor(r.grossMarginPct)}`}>
                  {r.grossMarginPct == null ? '—' : `${r.grossMarginPct}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default PlatformCogsPage
