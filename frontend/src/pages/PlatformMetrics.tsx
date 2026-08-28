// Platform operator "prove-it" metrics dashboard. Platform admin only.
import { useQuery } from '@tanstack/react-query'
import { firmApi, clientDocumentsApi } from '../services/api'
import { PageHeader, Spinner, ErrorBanner } from '../components/ui'
import { AlertTriangle, Filter, Target, TrendingUp } from 'lucide-react'

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-2xl font-mono text-gray-100 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

interface FunnelStage {
  key: string
  label: string
  firms: number
  medianDaysFromSignup: number | null
}
interface FunnelData {
  activation: { totalFirms: number; stages: FunnelStage[]; note: string }
  cohorts: { month: string; firms: number; activeLast30d: number; retainedPct: number | null }[]
  northStar: { label: string; outcomesLogged30d: number; weeklyTrend: { weekStart: string; outcomes: number }[]; note: string }
}

// FIX-5 — activation funnel, retention cohorts, and the north-star metric.
function FunnelSection({ funnel }: { funnel: FunnelData }) {
  const total = Math.max(1, funnel.activation.totalFirms)
  const trendMax = Math.max(1, ...funnel.northStar.weeklyTrend.map((w) => w.outcomes))
  return (
    <div className="mt-6 space-y-6">
      {/* Activation funnel */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="w-4 h-4 text-amber-400" />
          <h2 className="text-sm font-bold text-gray-200">Activation Funnel</h2>
          <span className="text-xs text-gray-500 ml-1">{funnel.activation.totalFirms} firms</span>
        </div>
        <div className="space-y-2">
          {funnel.activation.stages.map((s) => (
            <div key={s.key} className="flex items-center gap-3 text-xs">
              <span className="w-44 shrink-0 text-gray-400">{s.label}</span>
              <div className="flex-1 bg-gray-800 rounded h-4 overflow-hidden">
                <div
                  className="h-full bg-amber-500/70 rounded"
                  style={{ width: `${Math.min(100, Math.round((s.firms / total) * 100))}%` }}
                />
              </div>
              <span className="w-20 shrink-0 text-right font-mono text-gray-200">
                {s.firms} <span className="text-gray-500">({Math.round((s.firms / total) * 100)}%)</span>
              </span>
              <span className="w-28 shrink-0 text-right text-gray-500">
                {s.medianDaysFromSignup == null ? '—' : `median ${s.medianDaysFromSignup}d`}
              </span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-gray-600 mt-3">{funnel.activation.note}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Retention cohorts */}
        <div className="card">
          <h2 className="text-sm font-bold text-gray-200 mb-3">Retention Cohorts (signup month)</h2>
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="text-left py-1.5">Cohort</th>
                <th className="text-right py-1.5">Firms</th>
                <th className="text-right py-1.5">Active (30d)</th>
                <th className="text-right py-1.5">Retained</th>
              </tr>
            </thead>
            <tbody>
              {funnel.cohorts.map((c) => (
                <tr key={c.month} className="border-t border-gray-800">
                  <td className="py-1.5 font-mono text-gray-300">{c.month}</td>
                  <td className="py-1.5 text-right text-gray-300">{c.firms}</td>
                  <td className="py-1.5 text-right text-gray-300">{c.activeLast30d}</td>
                  <td className={`py-1.5 text-right font-mono ${
                    c.retainedPct == null ? 'text-gray-600' : c.retainedPct >= 60 ? 'text-emerald-400' : c.retainedPct >= 30 ? 'text-amber-400' : 'text-rose-400'
                  }`}>
                    {c.retainedPct == null ? '—' : `${c.retainedPct}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-gray-600 mt-2">Retained = any user login within the last 30 days.</p>
        </div>

        {/* North star */}
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-bold text-gray-200">North Star — {funnel.northStar.label}</h2>
          </div>
          <p className="text-3xl font-mono text-gray-100">{funnel.northStar.outcomesLogged30d}</p>
          <div className="flex items-end gap-1.5 h-16 mt-4">
            {funnel.northStar.weeklyTrend.map((w) => (
              <div key={w.weekStart} className="flex-1 flex flex-col items-center gap-1" title={`${w.weekStart}: ${w.outcomes}`}>
                <div
                  className="w-full bg-emerald-500/70 rounded-t"
                  style={{ height: `${Math.max(3, Math.round((w.outcomes / trendMax) * 52))}px` }}
                />
                <span className="text-[9px] text-gray-600">{w.weekStart.slice(5)}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-600 mt-3">{funnel.northStar.note}</p>
        </div>
      </div>
    </div>
  )
}

export function PlatformMetricsPage() {
  const { data: modData, isLoading: modLoading } = useQuery({
    queryKey: ['can-moderate-templates'],
    queryFn: () => clientDocumentsApi.canModerateTemplates(),
  })
  const canView = !!modData?.data?.canModerate

  const { data, isLoading, error } = useQuery({
    queryKey: ['platform-metrics'],
    queryFn: () => firmApi.platformMetrics(),
    enabled: canView,
  })
  const { data: funnelData } = useQuery({
    queryKey: ['platform-funnel'],
    queryFn: () => firmApi.platformFunnel(),
    enabled: canView,
  })

  if (modLoading) return <Spinner />
  if (!canView) {
    return (
      <div>
        <PageHeader title="Platform Metrics" subtitle="Operator dashboard" />
        <div className="card flex gap-3">
          <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-gray-300">Platform-administrator access is required.</p>
        </div>
      </div>
    )
  }
  if (error) return <ErrorBanner message="Failed to load metrics" />
  if (isLoading) return <Spinner />

  const d = data?.data
  const pct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`)
  const usd = (n: number) => `$${Number(n || 0).toLocaleString()}`

  return (
    <div>
      <PageHeader title="Platform Metrics" subtitle="Fleet-wide operating numbers — the prove-it dashboard" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Kpi label="Active firms" value={String(d?.activeFirms ?? 0)} />
        <Kpi label="Paying subscriptions" value={String(d?.subscriptions?.paying ?? 0)} />
        <Kpi label="MRR" value={usd(d?.subscriptions?.mrrUsd)} />
        <Kpi label="Win rate" value={pct(d?.outcomes?.winRatePct)} sub={`${d?.outcomes?.won ?? 0}W / ${d?.outcomes?.lost ?? 0}L`} />
        <Kpi label="Outcome capture" value={pct(d?.outcomes?.captureRatePct)} sub="calibration flywheel fuel" />
        <Kpi label="Opportunities (30d)" value={String(d?.activity30d?.opportunities ?? 0)} />
        <Kpi label="Submissions (30d)" value={String(d?.activity30d?.submissions ?? 0)} />
        <Kpi label="AI calls (30d)" value={String(d?.activity30d?.aiCalls ?? 0)} />
      </div>
      {d?.outcomes?.note && (
        <div className="card flex gap-3">
          <Target className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-gray-400">{d.outcomes.note}</p>
        </div>
      )}
      {funnelData?.data && <FunnelSection funnel={funnelData.data as FunnelData} />}
    </div>
  )
}

export default PlatformMetricsPage
