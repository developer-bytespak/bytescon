// Platform operator "prove-it" metrics dashboard. Platform admin only.
import { useQuery } from '@tanstack/react-query'
import { firmApi, clientDocumentsApi } from '../services/api'
import { PageHeader, ErrorBanner, StatCard, PageSkeleton } from '../components/ui'
import { AlertTriangle, Filter, Target, TrendingUp } from 'lucide-react'

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <StatCard label={label} value={value} sub={sub} />
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
        <div className="flex flex-wrap items-center gap-2.5 mb-5">
          <span className="tile tile-sm tile-gold"><Filter className="w-3.5 h-3.5" /></span>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Activation Funnel</h2>
          <span className="chip chip-neutral tabular-nums">{funnel.activation.totalFirms} firms</span>
        </div>
        <div className="stagger space-y-2.5 overflow-x-auto">
          {funnel.activation.stages.map((s) => (
            <div key={s.key} className="flex items-center gap-3 text-xs min-w-[32rem]">
              <span className="w-44 shrink-0 text-gray-400">{s.label}</span>
              <div className="flex-1 progress-track" style={{ height: 10 }}>
                <div
                  className="h-full bg-amber-500/70 rounded-full bar-grow"
                  style={{ width: `${Math.min(100, Math.round((s.firms / total) * 100))}%` }}
                />
              </div>
              <span className="w-20 shrink-0 text-right tabular-nums text-gray-200">
                {s.firms} <span className="text-gray-500">({Math.round((s.firms / total) * 100)}%)</span>
              </span>
              <span className="w-28 shrink-0 text-right tabular-nums text-gray-500">
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
          <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text)' }}>Retention Cohorts (signup month)</h2>
          <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Cohort</th>
                <th className="text-right">Firms</th>
                <th className="text-right">Active (30d)</th>
                <th className="text-right">Retained</th>
              </tr>
            </thead>
            <tbody>
              {funnel.cohorts.map((c) => (
                <tr key={c.month}>
                  <td className="font-mono text-gray-300">{c.month}</td>
                  <td className="text-right tabular-nums text-gray-300">{c.firms}</td>
                  <td className="text-right tabular-nums text-gray-300">{c.activeLast30d}</td>
                  <td className={`text-right tabular-nums ${
                    c.retainedPct == null ? 'text-gray-600' : c.retainedPct >= 60 ? 'text-emerald-400' : c.retainedPct >= 30 ? 'text-amber-400' : 'text-rose-400'
                  }`}>
                    {c.retainedPct == null ? '—' : `${c.retainedPct}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <p className="text-[11px] text-gray-600 mt-3">Retained = any user login within the last 30 days.</p>
        </div>

        {/* North star */}
        <div className="card">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="tile tile-sm tile-success"><TrendingUp className="w-3.5 h-3.5" /></span>
            <h2 className="text-sm font-semibold min-w-0" style={{ color: 'var(--text)' }}>North Star — {funnel.northStar.label}</h2>
          </div>
          <p className="kpi-value">{funnel.northStar.outcomesLogged30d}</p>
          <div className="flex items-end gap-1.5 h-16 mt-4">
            {funnel.northStar.weeklyTrend.map((w) => (
              <div key={w.weekStart} className="flex-1 flex flex-col items-center gap-1" title={`${w.weekStart}: ${w.outcomes}`}>
                <div
                  className="w-full bg-emerald-500/70 rounded-t-md"
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

  if (modLoading) return <div><span className="sr-only">Loading…</span><PageSkeleton /></div>
  if (!canView) {
    return (
      <div>
        <PageHeader title="Platform Metrics" subtitle="Operator dashboard" />
        <div className="card flex gap-3">
          <span className="tile tile-gold"><AlertTriangle className="w-4 h-4" /></span>
          <p className="text-sm text-gray-300">Platform-administrator access is required.</p>
        </div>
      </div>
    )
  }
  if (error) return <ErrorBanner message="Failed to load metrics" />
  if (isLoading) return <div><span className="sr-only">Loading…</span><PageSkeleton /></div>

  const d = data?.data
  const pct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`)
  const usd = (n: number) => `$${Number(n || 0).toLocaleString()}`

  return (
    <div>
      <PageHeader title="Platform Metrics" subtitle="Fleet-wide operating numbers — the prove-it dashboard" />
      <div className="stagger grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
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
        <div className="card flex items-start gap-3">
          <span className="tile tile-accent"><Target className="w-4 h-4" /></span>
          <p className="text-xs text-gray-400 leading-relaxed">{d.outcomes.note}</p>
        </div>
      )}
      {funnelData?.data && <FunnelSection funnel={funnelData.data as FunnelData} />}
    </div>
  )
}

export default PlatformMetricsPage
