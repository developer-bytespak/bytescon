// Fleet-wide gross margin per tenant (FIXES.md FIX-6). Platform admin only.
import { useQuery } from '@tanstack/react-query'
import { firmApi, clientDocumentsApi } from '../services/api'
import { PageHeader, ErrorBanner, StatCard, PageSkeleton } from '../components/ui'
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

  if (modLoading) return <div><span className="sr-only">Loading…</span><PageSkeleton /></div>
  if (!canView) {
    return (
      <div>
        <PageHeader title="Fleet Margin" subtitle="Per-tenant gross margin" />
        <div className="card flex gap-3">
          <span className="tile tile-gold"><AlertTriangle className="w-4 h-4" /></span>
          <p className="text-sm text-gray-300">
            Platform-administrator access is required. Ask the platform operator to add your email to{' '}
            <code>PLATFORM_ADMIN_EMAILS</code>.
          </p>
        </div>
      </div>
    )
  }
  if (error) return <ErrorBanner message="Failed to load margin report" />
  if (isLoading) return <div><span className="sr-only">Loading…</span><PageSkeleton /></div>

  const fleet = data?.data?.fleet
  const firms: MarginRow[] = data?.data?.firms || []

  return (
    <div>
      <PageHeader
        title="Fleet Margin"
        subtitle="Monthly gross margin per tenant: subscription revenue − LLM COGS (last 30 days)"
      />

      <div className="card flex items-start gap-3 mb-6">
        <span className="tile tile-accent"><DollarSign className="w-4 h-4" /></span>
        <p className="text-xs text-gray-400 leading-relaxed">{data?.data?.note}</p>
      </div>

      {fleet && (
        <div className="stagger grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard label="Monthly revenue" value={usd(fleet.monthlyRevenueUsd)} />
          <StatCard label="LLM COGS" value={usd(fleet.llmCostUsd)} />
          <StatCard label="Gross margin" value={usd(fleet.grossMarginUsd)} />
          <div className="card stat-card">
            <p className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>Margin %</p>
            <p className={`kpi-value mt-4 ${marginColor(fleet.grossMarginPct)}`}>{fleet.grossMarginPct == null ? '—' : `${fleet.grossMarginPct}%`}</p>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Firm</th>
              <th>Plan</th>
              <th className="text-right">Revenue/mo</th>
              <th className="text-right">LLM COGS</th>
              <th className="text-right">Calls</th>
              <th className="text-right">Margin</th>
              <th className="text-right">Margin %</th>
            </tr>
          </thead>
          <tbody>
            {firms.length === 0 && (
              <tr><td colSpan={7} className="py-10 text-center text-gray-500">No firms.</td></tr>
            )}
            {firms.map((r) => (
              <tr key={r.firmId}>
                <td className="text-gray-200 font-medium">{r.name}</td>
                <td className="text-gray-400">{r.plan}</td>
                <td className="text-right tabular-nums text-gray-300">{usd(r.monthlyRevenueUsd)}</td>
                <td className="text-right tabular-nums text-gray-300">{usd(r.llmCostUsd)}</td>
                <td className="text-right tabular-nums text-gray-500">{r.llmCalls}</td>
                <td className="text-right tabular-nums text-gray-300">{usd(r.grossMarginUsd)}</td>
                <td className={`text-right tabular-nums ${marginColor(r.grossMarginPct)}`}>
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
