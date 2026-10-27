import { useState } from 'react'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTutorial } from '../hooks/useTutorial'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { analyticsApi, marketAnalyticsApi, clientsApi } from '../services/api'
import {
  PageHeader,
  Spinner,
  ErrorBanner,
  formatCurrency,
  PageSkeleton,
  Skeleton,
  SkeletonRows,
  SkeletonStats,
  TabIndicator,
} from '../components/ui'
import { RevenueForecast } from '../components/charts/RevenueForecast'
import { AddonGate } from '../components/AddonGate'
import { CashFlowPanel, RateVariancePanel } from '../components/section7/FinanceAgentPanels'
import { WinLossIntelligencePanel } from '../components/section7/IntelligenceAgentPanels'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
  ComposedChart,
  ErrorBar,
} from 'recharts'
import {
  DollarSign,
  Award,
  TrendingUp,
  TrendingDown,
  Minus,
  Building2,
  Globe,
  Info,
  Database,
  Zap,
  AlertCircle,
  Activity,
  Briefcase,
  LineChart,
  HelpCircle,
} from 'lucide-react'
import { useTabParam } from '../hooks/useTabParam'
import { motion } from 'framer-motion'

const COLORS = ['#3b82f6', '#8b5cf6', '#22c55e', '#eab308', '#ef4444', '#f97316', '#5b74ff']

type AnalyticsTab = 'pipeline' | 'market' | 'portfolio' | 'forecast' | 'cashflow' | 'intelligence'

const TAB_DEFS: Array<{ id: AnalyticsTab; label: string; icon: React.ComponentType<{ className?: string }>; subtitle: string }> = [
  { id: 'pipeline',  label: 'Pipeline',  icon: Activity,  subtitle: 'Conversion stages, agency win rates, expected yield' },
  { id: 'market',    label: 'Market',    icon: Globe,     subtitle: 'NAICS trends, agency profiles, deep market intel' },
  { id: 'portfolio', label: 'Portfolio', icon: Briefcase, subtitle: 'Concentration, set-asides, diversification' },
  { id: 'forecast',  label: 'Forecast',  icon: LineChart, subtitle: 'Revenue projection and probability-weighted pipeline' },
  // §7.8 — contracted cash movement, deliberately NOT gated behind market
  // intelligence: it is built from the firm's own invoices and costs.
  { id: 'cashflow',  label: 'Cash Flow', icon: DollarSign, subtitle: 'Projected net cash flow and indirect rate variance' },
  // §7.9 — measured win/loss from confirmed outcomes only.
  { id: 'intelligence', label: 'Win/Loss', icon: Award, subtitle: 'Confirmed outcomes, segment performance, trends and concentration' },
]

/**
 * Sticky tab bar — kept simple. Underline indicator + subtle hover. Renders
 * tab subtitle below the active tab so users always know what they're looking at.
 */
function AnalyticsTabs({ active, onChange }: { active: AnalyticsTab; onChange: (t: AnalyticsTab) => void }) {
  const activeDef = TAB_DEFS.find((t) => t.id === active)
  return (
    <div className="mb-6 sticky top-0 z-30" style={{ background: 'var(--bg)' }}>
      <div className="tabs">
        {TAB_DEFS.map((t) => {
          const Icon = t.icon
          const isActive = t.id === active
          return (
            <button
              key={t.id}
              onClick={() => onChange(t.id)}
              role="tab"
              aria-selected={isActive}
              className="tab"
              data-active={isActive}
            >
              <Icon className="w-4 h-4" />
              {t.label}
              {isActive && <TabIndicator id="analytics-tabs" />}
            </button>
          )
        })}
      </div>
      {activeDef && (
        <p className="text-xs px-1 py-2" style={{ color: 'var(--text-faint)' }}>{activeDef.subtitle}</p>
      )}
    </div>
  )
}

/**
 * Inline help tooltip — appears next to a metric label, expands on hover/focus.
 * Pure CSS hover (no JS popper) — fits in tight headers and tables.
 */
function MetricTooltip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span className="relative inline-flex items-center group">
      <HelpCircle
        className="w-3 h-3 text-gray-600 group-hover:text-blue-400 ml-1 cursor-help flex-shrink-0"
        aria-label={title ?? 'More info'}
      />
      <span
        className="invisible group-hover:visible group-focus-within:visible absolute z-40 left-full ml-2 top-1/2 -translate-y-1/2 w-64 p-2.5 rounded-md text-[11px] leading-relaxed text-gray-200 shadow-xl pointer-events-none"
        style={{ background: 'var(--surface-2)', border: '1px solid rgb(var(--ink) / 0.1)' }}
        role="tooltip"
      >
        {children}
      </span>
    </span>
  )
}

/** Reusable skeleton block — fills the height of the section while data loads. */
function LoadingSkeleton({ height = 180 }: { height?: number }) {
  return (
    <div className="card" style={{ minHeight: height }} aria-busy="true" aria-label="Loading">
      <Skeleton className="w-32 h-3 mb-4" />
      <Skeleton className="w-full h-4 mb-2.5" />
      <Skeleton className="w-4/5 h-4 mb-2.5" />
      <Skeleton className="w-3/5 h-4" />
    </div>
  )
}

/** Friendly empty state with an icon and a recommendation. */
function FriendlyEmpty({ icon: Icon, title, body }: { icon: React.ComponentType<{ className?: string }>; title: string; body: string }) {
  return (
    <div className="card py-12 text-center animate-fade-up">
      <span className="tile tile-neutral mx-auto mb-3"><Icon className="w-5 h-5" /></span>
      <p className="text-sm font-medium" style={{ color: 'var(--text-2)' }}>{title}</p>
      <p className="text-xs max-w-md mx-auto mt-1" style={{ color: 'var(--text-faint)' }}>{body}</p>
    </div>
  )
}

function transitionColor(probability: number): string {
  if (probability > 0.5) return 'text-green-400'
  if (probability >= 0.2) return 'text-yellow-400'
  return 'text-red-400'
}

function transitionBg(probability: number): string {
  if (probability > 0.5) return 'bg-green-900/30 border-green-700'
  if (probability >= 0.2) return 'bg-yellow-900/30 border-yellow-700'
  return 'bg-red-900/30 border-red-700'
}

/**
 * Export a market snapshot to CSV. Beyond the raw heatmap + agency rollup, this
 * surfaces the data that was previously trapped in the on-screen charts:
 *   • per-NAICS quarterly award trend (one column per quarter) + a direction
 *   • derived market structure (HHI → competitive / moderate / concentrated)
 *   • total $ per NAICS and each agency's share of awards
 *   • a documented metadata header (window, source, counts, disclaimer)
 * so a consultant can act on it in Excel without re-deriving anything.
 */
function exportSnapshotCsv(data: any, yearsBack: number) {
  if (!data) return

  const esc = (v: any) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const dollars = (n: number) => Math.round(n || 0).toLocaleString('en-US')

  const heatmap: any[] = data.heatmap || []
  const agencies: any[] = (data.topAgencies || []).filter((a: any) => a.agency && String(a.agency).toUpperCase() !== 'ALL')
  const maxBuckets = heatmap.reduce((m, h) => Math.max(m, (h.trendBuckets || []).length), 0)
  const quarterCols = Array.from({ length: maxBuckets }, (_, i) => `q${i + 1}_awards`)
  const totalAgencyAwards = agencies.reduce((s, a) => s + (a.awards || 0), 0) || 1

  // Direction over the trend window: compare the older half to the newer half.
  const trendDir = (b: number[]): string => {
    if (!b || b.length < 2) return 'n/a'
    const half = Math.floor(b.length / 2)
    const early = b.slice(0, half).reduce((s, n) => s + n, 0)
    const late = b.slice(half).reduce((s, n) => s + n, 0)
    if (late > early * 1.1) return 'rising'
    if (late < early * 0.9) return 'declining'
    return 'flat'
  }

  const rows: string[] = []
  // ── Metadata header ──
  rows.push('# Bytescon Deep Market Intelligence')
  rows.push(`# Window: ${yearsBack}-year snapshot (${maxBuckets} quarters)`)
  rows.push('# Data source: USAspending + FPDS-NG (federal prime awards)')
  rows.push(`# Generated: ${new Date().toISOString()}`)
  rows.push(`# NAICS rows: ${heatmap.length} | Agencies: ${agencies.length}`)
  rows.push(`# Total market volume: $${dollars(data.totalOpportunityVolume)}`)
  rows.push(`# Avg contract size: $${dollars(data.avgContractSize)}`)
  rows.push(`# Unique competitors: ${data.competitorCount ?? ''}`)
  rows.push('# Note: aggregate historical awards — a directional market signal, not a forecast or win probability.')
  rows.push('')

  // ── NAICS heatmap (enriched) ──
  rows.push('NAICS Heatmap')
  rows.push([
    'naicsCode', 'awards', 'avgAmount', 'totalAmount', 'uniqueWinners', 'avgOffers',
    'concentrationHHI', 'marketStructure', 'topSetAside', 'topSetAsidePct',
    'myActiveOpps', 'myExpectedValue', 'trendDirection',
    ...quarterCols,
  ].join(','))
  for (const h of heatmap) {
    const buckets: number[] = h.trendBuckets || []
    const hhi = h.concentration ?? 0
    const structure = hhi >= 0.25 ? 'concentrated' : hhi >= 0.15 ? 'moderate' : 'competitive'
    const sa: { type: string; count: number; pct: number }[] = h.setAsideBreakdown || []
    const top = sa[0] // backend sorts by count desc
    const base = [
      esc(h.naicsCode),
      h.awards ?? 0,
      Math.round(h.avgAmount || 0),
      Math.round((h.avgAmount || 0) * (h.awards || 0)),
      h.uniqueWinners ?? '',
      h.avgOffers != null ? h.avgOffers.toFixed(2) : '',
      hhi.toFixed(3),
      structure,
      top ? esc(top.type) : '',
      top ? (top.pct * 100).toFixed(1) : '',
      h.myActiveOpps ?? 0,
      Math.round(h.myExpectedValue ?? 0),
      trendDir(buckets),
    ]
    const padded = quarterCols.map((_, i) => buckets[i] ?? '')
    rows.push([...base, ...padded].join(','))
  }
  rows.push('')

  // ── Set-aside breakdown (one row per NAICS × set-aside type) ──
  if (heatmap.some((h) => (h.setAsideBreakdown || []).length > 0)) {
    rows.push('Set-Aside Breakdown (by NAICS)')
    rows.push('naicsCode,setAsideType,awards,pctOfNaics')
    for (const h of heatmap) {
      for (const s of (h.setAsideBreakdown || [])) {
        rows.push([esc(h.naicsCode), esc(s.type), s.count ?? 0, ((s.pct ?? 0) * 100).toFixed(1)].join(','))
      }
    }
    rows.push('')
  }

  // ── Top agencies (with award share) ──
  rows.push('Top Agencies')
  rows.push('agency,awards,totalAmount,pctOfAwards')
  for (const a of agencies) {
    const pct = (((a.awards || 0) / totalAgencyAwards) * 100).toFixed(1)
    rows.push([esc(a.agency), a.awards ?? 0, Math.round(a.amount || 0), pct].join(','))
  }

  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `market-snapshot-${yearsBack}y-${new Date().toISOString().split('T')[0]}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Tiny inline SVG sparkline. Values = quarterly award counts, oldest → newest.
 * Bars rather than line so single-point upticks are visible.
 */
function Sparkline({ values, width = 60, height = 20 }: { values: number[]; width?: number; height?: number }) {
  if (!values || values.length === 0) return null
  const max = Math.max(...values, 1)
  const barW = width / values.length
  const last = values[values.length - 1]
  const prev = values[values.length - 2] ?? 0
  const trendUp = last > prev
  return (
    <svg width={width} height={height} className="flex-shrink-0" aria-label="trend">
      {values.map((v, i) => {
        const h = max > 0 ? (v / max) * height : 0
        return (
          <rect
            key={i}
            x={i * barW + 0.5}
            y={height - h}
            width={Math.max(barW - 1, 1)}
            height={Math.max(h, 0.5)}
            fill={trendUp ? '#34d399' : '#818cf8'}
            opacity={0.7}
          />
        )
      })}
    </svg>
  )
}

export function AnalyticsPage() {
  const tutorial = useTutorial()
  const [showTutorial, setShowTutorial] = useState(() => !tutorial.hasSeen('analytics'))
  function handleTutorialClose() { tutorial.markSeen('analytics'); setShowTutorial(false) }
  const [activeTab, setActiveTab] = useTabParam(['pipeline', 'market', 'portfolio', 'forecast', 'cashflow', 'intelligence'] as const, 'pipeline')

  const { data: miData, isLoading: miLoading } = useQuery({
    queryKey: ['market-intelligence'],
    queryFn: () => analyticsApi.marketIntelligence(),
  })

  const { data: healthData, isLoading: healthLoading } = useQuery({
    queryKey: ['portfolio-health'],
    queryFn: () => analyticsApi.portfolioHealth(),
  })

  const { data: pipelineData, isLoading: pipelineLoading } = useQuery({
    queryKey: ['pipeline-analysis'],
    queryFn: () => analyticsApi.pipelineAnalysis(),
  })

  const { data: bqStatusData } = useQuery({
    queryKey: ['bq-status'],
    queryFn: () => marketAnalyticsApi.status(),
    retry: false,
  })

  const [yearsBack, setYearsBack] = useState<1 | 3 | 5 | 10>(5)
  const { data: bqSnapshotData, isLoading: bqSnapshotLoading } = useQuery({
    queryKey: ['bq-snapshot', yearsBack],
    queryFn: () => marketAnalyticsApi.snapshot({ years: yearsBack }),
    enabled: bqStatusData?.data?.hasData === true,
    retry: false,
  })

  const { data: bqInsightsData } = useQuery({
    queryKey: ['bq-insights'],
    queryFn: () => marketAnalyticsApi.insights(),
    enabled: bqStatusData?.data?.hasData === true,
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  // NAICS drill-down modal state
  const [drillNaics, setDrillNaics] = useState<string | null>(null)
  const { data: drillData, isLoading: drillLoading } = useQuery({
    queryKey: ['bq-naics-drill', drillNaics],
    queryFn: () => marketAnalyticsApi.competition(drillNaics!),
    enabled: !!drillNaics,
  })

  // Agency drill-down modal state
  const [drillAgency, setDrillAgency] = useState<string | null>(null)
  const { data: agencyData, isLoading: agencyLoading } = useQuery({
    queryKey: ['bq-agency-drill', drillAgency],
    queryFn: () => marketAnalyticsApi.agency(drillAgency!),
    enabled: !!drillAgency,
  })

  // NAICS compare state — pick up to 2 NAICS to compare side-by-side
  const [compareSelection, setCompareSelection] = useState<string[]>([])
  const compareA = compareSelection[0] ?? null
  const compareB = compareSelection[1] ?? null
  const { data: compareDataA } = useQuery({
    queryKey: ['bq-compare', compareA],
    queryFn: () => marketAnalyticsApi.competition(compareA!),
    enabled: !!compareA,
  })
  const { data: compareDataB } = useQuery({
    queryKey: ['bq-compare', compareB],
    queryFn: () => marketAnalyticsApi.competition(compareB!),
    enabled: !!compareB,
  })
  const toggleCompare = (naics: string) => {
    setCompareSelection((prev) => {
      if (prev.includes(naics)) return prev.filter((n) => n !== naics)
      if (prev.length >= 2) return [prev[1], naics]   // FIFO: drop oldest, keep newest two
      return [...prev, naics]
    })
  }

  // Watchlist
  const qcClient = useQueryClient()
  const { data: watchlistData } = useQuery({
    queryKey: ['market-watchlist'],
    queryFn: () => marketAnalyticsApi.listWatchlist(),
  })
  const watchlist: any[] = watchlistData?.data ?? []
  const watchedNaics = new Set(watchlist.filter((w) => w.naicsCode).map((w) => w.naicsCode))
  const watchedAgencies = new Set(watchlist.filter((w) => w.agency).map((w) => w.agency))

  // ── Market Overview (all tiers) — scoped to a selected client's NAICS ──
  const { data: clientsResp } = useQuery({
    queryKey: ['clients', 'analytics-selector'],
    queryFn: () => clientsApi.list(),
    staleTime: 5 * 60 * 1000,
  })
  const clientList: any[] = clientsResp?.data ?? []
  const [selectedClientId, setSelectedClientId] = useState<string>('')
  const firstClientId = clientList.length > 0 ? clientList[0].id : ''
  // '' (unset) => default to first client; '__ALL__' => firm-wide (no clientId).
  const selectValue = selectedClientId || firstClientId
  const effectiveClientId = selectValue === '__ALL__' ? '' : selectValue
  const { data: previewResp, isLoading: previewLoading } = useQuery({
    queryKey: ['market-preview', effectiveClientId],
    queryFn: () =>
      marketAnalyticsApi.preview(effectiveClientId ? { clientId: effectiveClientId } : undefined),
    retry: false,
    staleTime: 2 * 60 * 1000,
  })
  const preview: any = previewResp?.data ?? null
  const addWatch = useMutation({
    mutationFn: (body: { naicsCode?: string; agency?: string }) => marketAnalyticsApi.addWatchlist(body),
    onSuccess: () => qcClient.invalidateQueries({ queryKey: ['market-watchlist'] }),
  })
  const removeWatch = useMutation({
    mutationFn: (id: string) => marketAnalyticsApi.removeWatchlist(id),
    onSuccess: () => qcClient.invalidateQueries({ queryKey: ['market-watchlist'] }),
  })
  const toggleWatch = (kind: 'naics' | 'agency', value: string) => {
    const existing = watchlist.find((w) =>
      kind === 'naics' ? w.naicsCode === value : w.agency === value,
    )
    if (existing) removeWatch.mutate(existing.id)
    else addWatch.mutate(kind === 'naics' ? { naicsCode: value } : { agency: value })
  }

  const mi = miData?.data
  const health = healthData?.data
  const pipeline = pipelineData?.data

  if (miLoading && healthLoading) {
    return (
      <div>
        <span className="sr-only">Loading…</span>
        <PageSkeleton />
      </div>
    )
  }

  const trendIcon = (trend: string) => {
    if (trend === 'growing') return <TrendingUp className="w-3.5 h-3.5 text-green-400" />
    if (trend === 'declining') return <TrendingDown className="w-3.5 h-3.5 text-red-400" />
    if (trend === 'insufficient_data') return <Minus className="w-3.5 h-3.5 text-gray-600" />
    return <Minus className="w-3.5 h-3.5 text-gray-400" />
  }

  // Prepare agency win rate chart data
  const agencyChartData = (pipeline?.agencyWinRates ?? []).map((a: any) => ({
    agency: a.agency.length > 15 ? a.agency.slice(0, 15) + '…' : a.agency,
    winRatePct: Math.round(a.winRate * 100),
    wins: a.wins,
    n: a.n,
    ciLower: Math.round(a.ciLower * 100),
    ciUpper: Math.round(a.ciUpper * 100),
    errorBounds: [
      Math.round((a.winRate - a.ciLower) * 100),
      Math.round((a.ciUpper - a.winRate) * 100),
    ],
    ciRange: `${Math.round(a.ciLower * 100)}% – ${Math.round(a.ciUpper * 100)}%`,
  }))

  return (
    <div>
      {showTutorial && <TutorialOverlay sectionKey="analytics" onClose={handleTutorialClose} />}
      <PageHeader
        title="Deep Analytics"
        subtitle="Market intelligence, portfolio health, and competitive landscape"
      />

      <AnalyticsTabs active={activeTab} onChange={setActiveTab} />

      {activeTab === 'intelligence' && (
        <div data-testid="analytics-intelligence-tab">
          <WinLossIntelligencePanel />
        </div>
      )}

      {activeTab === 'cashflow' && (
        <div className="space-y-4" data-testid="analytics-cashflow-tab">
          <CashFlowPanel />
          <RateVariancePanel />
        </div>
      )}

      {/* ─── PIPELINE TAB — top-line KPIs ─────────────────────────────── */}
      {activeTab === 'pipeline' && (
        <AddonGate addon="market_intel">
          <>
            {healthLoading && !health ? (
              <div className="mb-8"><SkeletonStats count={4} /></div>
            ) : health ? (
              <div className="stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                <div className="card">
                  <p className="overline mb-3 flex items-center">
                    Expected Revenue
                    <MetricTooltip title="Expected Revenue">
                      Sum of each open opportunity's contract value × its predicted win probability. Realistic planning baseline (NOT a sales guarantee).
                    </MetricTooltip>
                  </p>
                  <p className="kpi-value text-green-400">
                    {formatCurrency(health.totalExpectedRevenue)}
                  </p>
                  <p className="text-xs text-gray-500 mt-2.5">Probability-weighted pipeline · 6-mo projection</p>
                </div>
                <div className="card">
                  <p className="overline mb-3 flex items-center">
                    NAICS Concentration
                    <MetricTooltip title="HHI">
                      Herfindahl-Hirschman Index of your active pipeline across NAICS codes. 0%=fully diversified, 100%=single-NAICS shop. Above 40% is concentrated.
                    </MetricTooltip>
                  </p>
                  <p className={`kpi-value ${(health.diversification?.naicsConcentration ?? 0) > 0.4 ? 'text-yellow-400' : 'text-blue-400'}`}>
                    {(health.diversification?.naicsConcentration * 100).toFixed(0)}%
                  </p>
                  <p className="text-xs text-gray-500 mt-2.5">HHI index (lower = more diverse)</p>
                </div>
                <div className="card">
                  <p className="overline mb-3 flex items-center">
                    Top Client Dependency
                    <MetricTooltip title="Single-client risk">
                      Share of your active pipeline tied to one client. Above 50% = single point of failure. Aim for diversification across ≥3 clients.
                    </MetricTooltip>
                  </p>
                  <p className={`kpi-value ${health.riskIndicators?.singleClientDependency > 50 ? 'text-red-400' : health.riskIndicators?.singleClientDependency > 30 ? 'text-yellow-400' : 'text-green-400'}`}>
                    {health.riskIndicators?.singleClientDependency}%
                  </p>
                  <p className="text-xs text-gray-500 mt-2.5">Pipeline from top client</p>
                </div>
                <div className="card">
                  <p className="overline mb-3 flex items-center">
                    Late Submission Rate
                    <MetricTooltip title="Submission timing">
                      Share of past submissions filed at or after the response deadline. Late filings often get rejected on technicality alone. Below 10% is healthy.
                    </MetricTooltip>
                  </p>
                  <p className={`kpi-value ${health.riskIndicators?.overdueSubmissionRate > 20 ? 'text-red-400' : health.riskIndicators?.overdueSubmissionRate > 10 ? 'text-yellow-400' : 'text-green-400'}`}>
                    {health.riskIndicators?.overdueSubmissionRate}%
                  </p>
                  <p className="text-xs text-gray-500 mt-2.5">
                    Avg {health.riskIndicators?.avgDaysToDeadlineAtSubmission}d before deadline
                  </p>
                </div>
              </div>
            ) : (
              <FriendlyEmpty
                icon={AlertCircle}
                title="Portfolio health metrics unavailable"
                body="Submit at least one bid through the platform to populate pipeline KPIs."
              />
            )}
          </>
        </AddonGate>
      )}

      {/* ─── FORECAST TAB — revenue projection + explainer ──────────────── */}
      {activeTab === 'forecast' && (
        <AddonGate addon="market_intel">
          <>
            <div className="mb-6 px-4 py-3.5 rounded-xl flex items-start gap-3"
              style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}>
              <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-blue-200 space-y-1">
                <p className="font-semibold text-blue-300">How Expected Revenue &amp; Forecasting Work</p>
                <p>
                  <span className="text-green-400 font-medium">Expected Revenue</span> is your probability-weighted pipeline value — each open opportunity's contract value multiplied by its calculated win probability, summed across all active bids. It represents the statistically likely revenue if you pursued every active opportunity to award.
                </p>
                <p>
                  The <span className="text-blue-300 font-medium">Revenue Forecast chart</span> projects this forward across 6 months using three scenarios: <span className="text-green-400">Optimistic</span> (your best-case pipeline closes at higher values), <span className="text-blue-400">Expected</span> (probability-weighted midpoint — your planning baseline), and <span className="text-red-400">Conservative</span> (only your highest-confidence bids close at the lower end of their value range).
                </p>
                <p className="text-yellow-400/80 text-[11px] italic">
                  These are planning projections, not guarantees. Accuracy is highest 1–3 months out and improves as your firm builds a longer award track record on this platform.
                </p>
              </div>
            </div>
            {healthLoading && !health ? (
              <LoadingSkeleton height={320} />
            ) : health?.revenueForecast ? (
              <div className="mb-8">
                <RevenueForecast data={health.revenueForecast} />
              </div>
            ) : (
              <FriendlyEmpty
                icon={LineChart}
                title="Revenue forecast needs more bid history"
                body="Forecasts populate once you've submitted at least 3 bids through the platform — the model needs a track record to calibrate scenarios."
              />
            )}
          </>
        </AddonGate>
      )}

      {/* ─── MARKET TAB — NAICS trends, Agency profiles, Deep Market Intel ── */}
      {activeTab === 'market' && (<>

      {/* Market Overview — available to ALL tiers; scoped to a selected client's NAICS.
          The full heatmap, named competitors, and drill-downs stay in the
          enterprise Deep Market Intelligence section further down. */}
      <div className="card mb-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="tile tile-sm tile-accent"><Globe className="w-3.5 h-3.5" /></span>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Market Overview</h3>
            <MetricTooltip title="Market Overview">
              Real federal award activity (USAspending) for your client's NAICS codes — a directional market signal from historical awards, not a forecast or win probability.
            </MetricTooltip>
          </div>
          {clientList.length > 0 && (
            <div className="flex items-center gap-2 min-w-0">
              <span className="label mb-0">Client</span>
              <select
                value={selectValue}
                onChange={(e) => setSelectedClientId(e.target.value)}
                className="input text-sm py-1"
                aria-label="Scope market overview to client"
              >
                <option value="__ALL__">All clients (firm-wide)</option>
                {clientList.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {previewLoading && !preview && <LoadingSkeleton height={160} />}

        {!previewLoading && preview?.status === 'warming' && (
          <div className="py-8 text-center">
            <Database className="w-8 h-8 text-blue-500/70 mx-auto mb-3 animate-pulse" />
            <p className="text-sm text-gray-300 font-medium">Loading federal market data for your sector…</p>
            <p className="text-xs text-gray-500 max-w-md mx-auto mt-1">
              We're pulling historical award data for {preview.naicsCodes?.length ?? 0} NAICS code{(preview.naicsCodes?.length ?? 0) === 1 ? '' : 's'}. This usually takes a minute — check back shortly.
            </p>
            {preview.clientMatchCount > 0 && (
              <p className="text-xs text-blue-300 mt-3">
                Meanwhile, {preview.clientMatchCount} active opportunit{preview.clientMatchCount === 1 ? 'y' : 'ies'} on your board match these NAICS codes.
              </p>
            )}
          </div>
        )}

        {!previewLoading && preview?.status === 'ready' && (
          <>
            {preview.usedDefault && (
              <p className="text-[11px] text-gray-500 mb-3">
                Showing common federal markets — add a client with NAICS codes to tailor this to your portfolio.
              </p>
            )}
            <div className="stagger grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
              <div className="panel p-3.5 min-w-0">
                <p className="overline mb-1.5">Market Volume</p>
                <p className="text-xl font-semibold tabular-nums truncate text-blue-300">{formatCurrency(preview.totalMarketVolume)}</p>
                <p className="text-[10px] text-gray-600">{preview.yearsBack}-yr federal awards</p>
              </div>
              <div className="panel p-3.5 min-w-0">
                <p className="overline mb-1.5">Avg Contract</p>
                <p className="text-xl font-semibold tabular-nums truncate text-gray-200">{formatCurrency(preview.avgContractSize)}</p>
              </div>
              <div className="panel p-3.5 min-w-0">
                <p className="overline mb-1.5">Competitors</p>
                <p className="text-xl font-semibold tabular-nums truncate text-gray-200">{Number(preview.competitorCount ?? 0).toLocaleString()}</p>
                <p className="text-[10px] text-gray-600">unique awardees</p>
              </div>
              <div className="panel p-3.5 min-w-0">
                <p className="overline mb-1.5">Your Matches</p>
                <p className="text-xl font-semibold tabular-nums truncate text-green-400">{preview.clientMatchCount}</p>
                <p className="text-[10px] text-gray-600">active opps in these NAICS</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Building2 className="w-4 h-4 text-purple-400" />
                  <h4 className="text-sm font-semibold text-gray-300">Top Buying Agencies</h4>
                </div>
                {preview.topAgencies?.length ? (
                  <ul className="space-y-1.5">
                    {preview.topAgencies.map((a: any) => (
                      <li key={a.agency} className="flex items-center justify-between text-xs">
                        <span className="text-gray-300 truncate pr-2">{a.agency}</span>
                        <span className="text-gray-500 flex-shrink-0 tabular-nums">{Number(a.awards ?? 0).toLocaleString()} · {formatCurrency(a.amount)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-gray-600">No agency data.</p>}
              </div>

              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Briefcase className="w-4 h-4 text-amber-400" />
                  <h4 className="text-sm font-semibold text-gray-300">Set-Aside Mix</h4>
                </div>
                {preview.setAsideRates?.length ? (
                  <div className="space-y-1.5">
                    {preview.setAsideRates.map((s: any) => (
                      <div key={s.type}>
                        <div className="flex items-center justify-between text-[11px] text-gray-400 mb-0.5">
                          <span className="truncate pr-2">{s.type}</span>
                          <span className="tabular-nums">{Math.round((s.pct ?? 0) * 100)}%</span>
                        </div>
                        <div className="progress-track" style={{ height: 6 }}>
                          <div className="h-full rounded-full bg-amber-500 bar-grow" style={{ width: `${Math.round((s.pct ?? 0) * 100)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-xs text-gray-600">No set-aside data.</p>}
              </div>
            </div>

            <p className="text-[10px] text-gray-600 mt-4">
              Source: USAspending federal prime awards · directional market signal, not a forecast or win probability.
            </p>
          </>
        )}

        {!previewLoading && !preview && (
          <p className="text-xs text-gray-500 py-6 text-center">
            Market data is temporarily unavailable — it populates automatically once your sector's award history loads. Check back shortly.
          </p>
        )}
      </div>

      {miLoading && !mi && <LoadingSkeleton height={240} />}
      {!miLoading && !mi?.naicsTrends?.length && !mi?.agencyProfiles?.length && (
        <FriendlyEmpty
          icon={Globe}
          title="Market intelligence unavailable"
          body="NAICS trends and agency profiles need an active SAM.gov sync — opportunities haven't been ingested yet."
        />
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="card">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="tile tile-sm tile-accent"><Globe className="w-3.5 h-3.5" /></span>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>NAICS Sector Trends</h3>
            <MetricTooltip title="NAICS trends">
              Slope of opportunity volume per NAICS sector across the last 6 months. "Growing" = ≥10% increase quarter-over-quarter; needs ≥3 months with ≥10 opps each to compute.
            </MetricTooltip>
          </div>
          {!mi?.naicsTrends?.length ? (
            <p className="text-sm text-gray-500 text-center py-8">No NAICS data available</p>
          ) : (
            <div className="stagger space-y-2">
              {mi.naicsTrends.map((s: any) => (
                <div
                  key={s.naicsCode}
                  className="panel flex items-center gap-3 px-3 py-2.5"
                >
                  {trendIcon(s.trend)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-200">{s.sector}</span>
                      <span className="text-xs text-gray-500">NAICS {s.naicsCode}xx</span>
                    </div>
                    <p className="text-xs text-gray-400">
                      {s.opportunityCount} opps · {
                        s.avgEstimatedValue !== null && s.avgEstimatedValue !== undefined
                          ? `Avg ${formatCurrency(s.avgEstimatedValue)} (${s.pricedOpportunityCount} priced)`
                          : 'No price data'
                      } · {s.avgCompetitionCount} competitors
                    </p>
                  </div>
                  <span
                    className={`chip flex-shrink-0 ${
                      s.trend === 'growing'
                        ? 'chip-success'
                        : s.trend === 'declining'
                        ? 'chip-danger'
                        : 'chip-neutral'
                    }`}
                    title={s.trend === 'insufficient_data' ? 'Need ≥3 months with ≥10 opps each to compute a trend' : undefined}
                  >
                    {s.trend === 'insufficient_data' ? 'new sync' : s.trend}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* Agency Profiles */}
      <div className="card mb-8">
        <div className="flex items-center gap-2.5 mb-4">
          <span className="tile tile-sm tile-accent"><Building2 className="w-3.5 h-3.5" /></span>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Agency Profiles</h3>
        </div>
        {!mi?.agencyProfiles?.length ? (
          <p className="text-sm text-gray-500 text-center py-8">No agency data available</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Agency</th>
                  <th className="text-right">Opps</th>
                  <th className="text-right">Small Biz %</th>
                  <th className="text-right">SDVOSB %</th>
                  <th className="text-right">Avg Award</th>
                  <th>Top Incumbents</th>
                </tr>
              </thead>
              <tbody>
                {mi.agencyProfiles.map((a: any) => (
                  <tr key={a.agency}>
                    <td className="font-medium text-xs" style={{ color: 'var(--text)' }}>{a.agency}</td>
                    <td className="text-xs text-right tabular-nums">{a.totalOpportunities}</td>
                    <td className="text-xs text-right tabular-nums">{a.smallBizRate > 0 ? `${(a.smallBizRate * 100).toFixed(0)}%` : '—'}</td>
                    <td className="text-xs text-right tabular-nums">{a.sdvosbRate > 0 ? `${(a.sdvosbRate * 100).toFixed(0)}%` : '—'}</td>
                    <td className="text-xs text-right tabular-nums">{a.avgAwardSize > 0 ? formatCurrency(a.avgAwardSize) : '—'}</td>
                    <td className="text-xs text-gray-400">
                      {a.topIncumbents.map((t: any) => t.name).join(', ') || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      </>)}{/* end market tab — first block (NAICS trends + Agency profiles) */}

      {/* ─── PORTFOLIO TAB — set-aside distribution, concentration ─────── */}
      {activeTab === 'portfolio' && (<>
      {healthLoading && !health && <LoadingSkeleton height={240} />}
      {!healthLoading && !health?.diversification?.setAsideDistribution?.length && (
        <FriendlyEmpty
          icon={Briefcase}
          title="Portfolio breakdown needs more bid data"
          body="Once you've bid on opportunities across multiple set-asides and NAICS codes, distribution charts populate here."
        />
      )}
      {/* Set-Aside Distribution */}
      {health?.diversification?.setAsideDistribution?.length > 0 && (
        <div className="card mb-8">
          <h3 className="text-sm font-semibold mb-4 flex items-center" style={{ color: 'var(--text)' }}>
            Set-Aside Distribution
            <MetricTooltip title="Set-aside mix">
              Count of your active opportunities by set-aside type. A balanced mix across SDVOSB, WOSB, HUBZone, 8(a), and small-business reduces the risk of a single program change wiping out your pipeline.
            </MetricTooltip>
          </h3>
          <div className="flex flex-col sm:flex-row items-center gap-6">
            <div className="flex-shrink-0">
              <ResponsiveContainer width={200} height={200}>
                <PieChart>
                  <Pie animationDuration={800} animationEasing="ease-out"
                    data={health.diversification.setAsideDistribution}
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    dataKey="count"
                    nameKey="type"
                  >
                    {health.diversification.setAsideDistribution.map((_: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--surface-2)',
                      border: '1px solid var(--line-strong)',
                      borderRadius: '6px',
                      color: 'var(--text)',
                    }}
                    formatter={(value: any, _name: any, props: any) => [
                      `${value} (${props.payload.percent}%)`,
                      props.payload.type,
                    ]}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {/* External legend */}
            <div className="flex flex-col gap-2 flex-1">
              {health.diversification.setAsideDistribution.map((entry: any, i: number) => (
                <div key={entry.type} className="flex items-center gap-2">
                  <span
                    className="w-3 h-3 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: COLORS[i % COLORS.length] }}
                  />
                  <span className="text-xs text-gray-300 flex-1">{entry.type}</span>
                  <span className="text-xs text-gray-400 tabular-nums">{entry.count} ({entry.percent}%)</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      </>)}{/* end portfolio tab */}

      {/* ─── PIPELINE TAB (continued) — conversion analysis ──────────────── */}
      {activeTab === 'pipeline' && (
      <div className="card mb-8">
        <h3 className="text-sm font-semibold mb-6 flex items-center" style={{ color: 'var(--text)' }}>
          Pipeline Conversion Analysis
          <MetricTooltip title="Markov-chain conversion">
            Stage-to-stage transition probabilities (ingested → scored → decided → submitted → won), computed from your own historical opportunities. Green=high conversion, yellow=normal attrition, red=stage where you're losing the most.
          </MetricTooltip>
        </h3>

        {pipelineLoading ? (
          <SkeletonRows rows={4} cols={5} />
        ) : !pipeline ? (
          <ErrorBanner message="Failed to load pipeline analysis data." />
        ) : (
          <>
            {/* Stage flow */}
            <div className="stagger flex items-stretch gap-0 overflow-x-auto pb-2 mb-6 -mx-1 px-1">
              {(pipeline.markovChain ?? []).map((stage: any, i: number) => (
                <div key={i} className="flex items-stretch flex-shrink-0">
                  {i === 0 && (
                    <div className="funnel-stage">
                      <span className="overline">{stage.from}</span>
                      <span className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--text)' }}>
                        {stage.fromCount.toLocaleString()}
                      </span>
                    </div>
                  )}
                  <div className="flex flex-col items-center justify-center px-1.5">
                    <span className={`chip tabular-nums ${transitionBg(stage.probability)} ${transitionColor(stage.probability)}`}>
                      {Math.round(stage.probability * 100)}%
                    </span>
                    <span className="funnel-arrow" aria-hidden="true">→</span>
                  </div>
                  <div className="funnel-stage">
                    <span className="overline">{stage.to}</span>
                    <span className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--text)' }}>
                      {stage.toCount.toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Expected yield callout */}
            <div className="mb-8 px-4 py-4 rounded-xl bg-blue-900/20 border border-blue-800">
              <div className="flex items-start gap-3">
                <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-gray-300">
                  <span className="font-medium text-gray-100">Expected Pipeline Yield: </span>
                  For every 100 new opportunities ingested, our analysis predicts{' '}
                  <span className="font-bold text-blue-300">
                    {(pipeline.expectedWinsPerHundred ?? 0).toFixed(1)}
                  </span>{' '}
                  will be won based on your historical conversion rates.
                </p>
              </div>
            </div>

            {/* Agency Win Rate with CI */}
            {agencyChartData.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-6">
                Need at least 2 submissions per agency to compute confidence intervals.
              </p>
            ) : (
              <>
                <h4 className="text-sm font-semibold text-gray-300 mb-3">
                  Agency Win Rate with Confidence Range
                </h4>
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={agencyChartData} margin={{ top: 10, right: 20, left: 0, bottom: 60 }}>
                    <XAxis
                      dataKey="agency"
                      tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                      angle={-35}
                      dy={10}
                      interval={0}
                    />
                    <YAxis
                      tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                      domain={[0, 100]}
                      tickFormatter={(v) => `${v}%`}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--surface-2)',
                        border: '1px solid var(--line-strong)',
                        borderRadius: '6px',
                        color: 'var(--text)',
                        fontSize: '12px',
                      }}
                      formatter={(value: any, name: string, props: any) => {
                        if (name === 'winRatePct') {
                          const d = props.payload
                          return [
                            `${value}% (CI: ${d.ciRange}) — ${d.wins}W / ${d.n} total`,
                            'Win Rate',
                          ]
                        }
                        return [value, name]
                      }}
                    />
                    <Bar animationDuration={800} animationEasing="ease-out" dataKey="winRatePct" fill="#3b82f6" radius={[4, 4, 0, 0]} name="winRatePct">
                      {agencyChartData.map((_: any, i: number) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                      <ErrorBar dataKey="errorBounds" width={4} strokeWidth={2} stroke="#60a5fa" />
                    </Bar>
                  </ComposedChart>
                </ResponsiveContainer>
                <p className="text-[10px] text-gray-500 mt-2 text-center">
                  Error bars show the statistical confidence range. Agencies with fewer than 2 submissions are excluded.
                </p>
              </>
            )}
          </>
        )}
      </div>
      )}{/* end pipeline tab */}

      {/* ─── MARKET TAB (continued) — Deep Market Intelligence ──────────── */}
      {activeTab === 'market' && (
      <AddonGate addon="market_intel">
        <div className="card mb-8">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="tile tile-sm tile-accent"><Database className="w-3.5 h-3.5" /></span>
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Deep Market Intelligence</h3>
              <span className="chip chip-accent">
                Historical Data
              </span>
              <MetricTooltip title="BigQuery awards">
                Backed by USAspending.gov award history mirrored in BigQuery. Drill into a NAICS or agency to see top contractors, winner concentration (HHI), avg award size, and historical trend buckets.
              </MetricTooltip>
            </div>
            {bqStatusData?.data && (
              <div className={`flex items-center gap-1.5 text-xs ${bqStatusData.data.connected ? 'text-green-400' : 'text-red-400'}`}>
                <span className={`w-2 h-2 rounded-full ${bqStatusData.data.connected ? 'bg-green-400' : 'bg-red-400'}`} />
                {bqStatusData.data.connected ? `${bqStatusData.data.awardRows.toLocaleString()} award records` : 'Not connected'}
              </div>
            )}
          </div>

          {/* No data state */}
          {!bqStatusData?.data?.hasData && (
            <div className="py-10 text-center space-y-3">
              <span className="tile tile-neutral mx-auto"><AlertCircle className="w-5 h-5" /></span>
              <p className="text-sm text-gray-400">No award history loaded yet.</p>
              <p className="text-xs text-gray-500 max-w-md mx-auto">
                Historical award data from USAspending powers competitive intelligence, agency profiling,
                and market trend analysis. Contact your administrator to enable this feature.
              </p>
            </div>
          )}

          {/* Insight bar — algorithmic plain-English recommendations */}
          {bqStatusData?.data?.hasData && bqInsightsData?.data && bqInsightsData.data.length > 0 && (
            <div className="stagger mb-5 space-y-2">
              {bqInsightsData.data.map((ins: any, i: number) => {
                const palette = ins.level === 'OPPORTUNITY'
                  ? { bg: 'var(--success-bg)', border: 'var(--success-border)', text: 'var(--success)', label: 'OPPORTUNITY' }
                  : ins.level === 'RISK'
                    ? { bg: 'var(--danger-bg)', border: 'var(--danger-border)', text: 'var(--danger)', label: 'RISK' }
                    : { bg: 'var(--accent-soft)', border: 'var(--accent-line)', text: 'var(--accent-3)', label: 'NOTE' }
                return (
                  <div key={i} className="rounded-xl p-3.5 flex gap-3"
                    style={{ background: palette.bg, border: `1px solid ${palette.border}` }}>
                    <span className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded h-fit flex-shrink-0"
                      style={{ background: palette.border, color: palette.text }}>
                      {palette.label}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold" style={{ color: palette.text }}>{ins.title}</p>
                      <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{ins.body}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Data available: market snapshot */}
          {bqStatusData?.data?.hasData && (
            <>
              {bqSnapshotLoading ? (
                <div className="mb-6"><SkeletonStats count={4} /></div>
              ) : bqSnapshotData?.data ? (
                <>
                  {/* Top-line metrics */}
                  <div className="stagger grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                    <div className="panel p-3.5 min-w-0">
                      <p className="overline mb-1.5">Total Market Volume</p>
                      <p className="text-lg font-semibold tabular-nums truncate text-indigo-400">
                        {formatCurrency(bqSnapshotData.data.totalOpportunityVolume)}
                      </p>
                    </div>
                    <div className="panel p-3.5 min-w-0">
                      <p className="overline mb-1.5">Avg Contract Size</p>
                      <p className="text-lg font-semibold tabular-nums truncate text-blue-400">
                        {formatCurrency(bqSnapshotData.data.avgContractSize)}
                      </p>
                    </div>
                    <div className="panel p-3.5 min-w-0">
                      <p className="overline mb-1.5">Unique Competitors</p>
                      <p className="text-lg font-semibold tabular-nums truncate text-purple-400">
                        {bqSnapshotData.data.competitorCount.toLocaleString()}
                      </p>
                    </div>
                    <div className="panel p-3.5 min-w-0">
                      <p className="overline mb-1.5">NAICS Codes Tracked</p>
                      <p className="text-lg font-semibold tabular-nums truncate text-yellow-400">
                        {bqSnapshotData.data.naicsCodes.length}
                      </p>
                    </div>
                  </div>

                  {/* Date range selector + export */}
                  <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                    <h4 className="overline">NAICS Competition Heatmap</h4>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => exportSnapshotCsv(bqSnapshotData?.data, yearsBack)}
                        className="btn-secondary btn-sm"
                        title="Download the heatmap as CSV"
                      >
                        Export CSV
                      </button>
                      <div className="segmented">
                        {[1, 3, 5, 10].map((y) => (
                          <button
                            key={y}
                            onClick={() => setYearsBack(y as 1 | 3 | 5 | 10)}
                            data-active={yearsBack === y}
                            className="tabular-nums"
                          >
                            {yearsBack === y && <motion.span layoutId="analytics-years" className="segmented-thumb" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                            {y}Y
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* NAICS heatmap — clickable rows with sparklines + portfolio overlay */}
                  {bqSnapshotData.data.heatmap?.length > 0 && (
                    <div className="mb-6">
                      <div className="space-y-1">
                        {bqSnapshotData.data.heatmap.map((h: any) => (
                          <div key={h.naicsCode}
                            className={`flex items-center gap-3 w-full px-2.5 py-2 rounded-lg transition-colors group cursor-pointer min-w-0 ${
                              compareSelection.includes(h.naicsCode) ? 'bg-emerald-900/20' : 'hover:bg-indigo-900/20'
                            }`}
                          >
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleWatch('naics', h.naicsCode) }}
                              className={`text-base leading-none flex-shrink-0 transition-colors ${
                                watchedNaics.has(h.naicsCode) ? 'text-amber-400' : 'text-gray-700 hover:text-amber-400'
                              }`}
                              title={watchedNaics.has(h.naicsCode) ? 'Remove from watchlist' : 'Add to watchlist'}
                            >
                              ★
                            </button>
                            <input
                              type="checkbox"
                              checked={compareSelection.includes(h.naicsCode)}
                              onChange={() => toggleCompare(h.naicsCode)}
                              onClick={(e) => e.stopPropagation()}
                              className="cursor-pointer flex-shrink-0"
                              title="Add to compare (max 2)"
                            />
                            <button
                              type="button"
                              onClick={() => setDrillNaics(h.naicsCode)}
                              className="flex items-center gap-3 flex-1 text-left min-w-0"
                            >
                            <span className="text-xs text-indigo-300 group-hover:text-indigo-200 font-mono w-16 flex-shrink-0">{h.naicsCode}</span>
                            <div className="flex-1 progress-track min-w-[3rem]" style={{ height: 8 }}>
                              <div
                                className="h-full rounded-full bg-indigo-500 group-hover:bg-indigo-400 transition-colors bar-grow"
                                style={{ width: `${Math.min(h.concentration * 100, 100)}%` }}
                              />
                            </div>
                            {/* Sparkline (last N quarters of award counts) */}
                            {Array.isArray(h.trendBuckets) && h.trendBuckets.length > 0 && (
                              <Sparkline values={h.trendBuckets} width={60} height={20} />
                            )}
                            <span className="text-[10px] text-gray-500 w-24 text-right flex-shrink-0 tabular-nums">
                              {h.awards} awards · {formatCurrency(h.avgAmount)}
                            </span>
                            {h.avgOffers != null && (
                              <span className="text-[10px] text-yellow-500 w-20 text-right flex-shrink-0 tabular-nums">
                                ~{h.avgOffers.toFixed(1)} offerors
                              </span>
                            )}
                            {/* Portfolio overlay */}
                            {h.myActiveOpps > 0 && (
                              <span className="text-[10px] text-emerald-400 w-24 text-right flex-shrink-0 font-mono"
                                title="Your active opps in this NAICS · probability-weighted value">
                                you: {h.myActiveOpps} · {formatCurrency(h.myExpectedValue ?? 0)}
                              </span>
                            )}
                            <span className="text-[10px] text-gray-600 group-hover:text-indigo-400 w-12 text-right flex-shrink-0">
                              View →
                            </span>
                            </button>
                          </div>
                        ))}
                      </div>
                      <p className="text-[10px] text-gray-600 mt-2">
                        Bar width = winner concentration (HHI). Sparkline = quarterly award trend. Green = your firm's active pipeline. Check up to 2 boxes to compare side-by-side. Click any row to drill in.
                      </p>

                      {/* Side-by-side compare panel */}
                      {compareSelection.length === 2 && compareDataA?.data && compareDataB?.data && (
                        <div className="mt-4 rounded-xl p-4 overflow-x-auto animate-fade-up" style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)' }}>
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="text-xs font-semibold text-emerald-300 uppercase tracking-wider">Side-by-Side Comparison</h4>
                            <button onClick={() => setCompareSelection([])} className="btn-ghost btn-sm">clear</button>
                          </div>
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-[10px] text-gray-500 border-b border-gray-700">
                                <th className="pb-2 pr-4">Metric</th>
                                <th className="pb-2 pr-4 text-right text-indigo-300 font-mono">{compareA}</th>
                                <th className="pb-2 text-right text-emerald-300 font-mono">{compareB}</th>
                              </tr>
                            </thead>
                            <tbody className="text-gray-300">
                              {([
                                ['Total Awards', compareDataA.data.totalAwards, compareDataB.data.totalAwards, (n: number) => n.toLocaleString()],
                                ['Total $', compareDataA.data.totalAmount, compareDataB.data.totalAmount, (n: number) => formatCurrency(n)],
                                ['Avg Award', compareDataA.data.avgAwardAmount, compareDataB.data.avgAwardAmount, (n: number) => formatCurrency(n)],
                                ['Median Award', compareDataA.data.medianAwardAmount, compareDataB.data.medianAwardAmount, (n: number) => formatCurrency(n)],
                                ['Unique Winners', compareDataA.data.uniqueWinners, compareDataB.data.uniqueWinners, (n: number) => n.toLocaleString()],
                                ['Avg Offerors', compareDataA.data.avgOffersReceived, compareDataB.data.avgOffersReceived, (n: number | null) => n != null ? n.toFixed(1) : '—'],
                                ['Concentration HHI', compareDataA.data.winnerConcentrationHHI, compareDataB.data.winnerConcentrationHHI, (n: number) => n.toFixed(3)],
                                ['Top Winner', compareDataA.data.topWinners?.[0]?.name, compareDataB.data.topWinners?.[0]?.name, (s: string) => s ?? '—'],
                                ['Top Winner Share', compareDataA.data.topWinners?.[0]?.shareOfWins, compareDataB.data.topWinners?.[0]?.shareOfWins, (n: number) => n != null ? `${(n * 100).toFixed(1)}%` : '—'],
                              ] as Array<[string, any, any, (v: any) => string]>).map(([label, a, b, fmt]) => (
                                <tr key={label} className="border-b border-gray-800/50">
                                  <td className="py-1.5 pr-4 text-gray-400">{label}</td>
                                  <td className="py-1.5 pr-4 text-right font-mono">{fmt(a)}</td>
                                  <td className="py-1.5 text-right font-mono">{fmt(b)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {compareSelection.length === 1 && (
                        <p className="text-[10px] text-emerald-400 mt-2">Pick one more NAICS to enable side-by-side comparison.</p>
                      )}
                    </div>
                  )}

                  {/* Top agencies from BQ */}
                  {bqSnapshotData.data.topAgencies?.length > 0 && (
                    <div>
                      <h4 className="overline mb-3 flex items-center gap-1">
                        <Zap className="w-3 h-3" /> Top Contracting Agencies (by award count)
                      </h4>
                      <div className="table-wrap">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Agency</th>
                              <th className="text-right">Awards</th>
                              <th className="text-right">Total Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {bqSnapshotData.data.topAgencies
                              .filter((a: any) => a.agency && a.agency.trim() && a.agency.trim().toUpperCase() !== 'ALL')
                              .map((a: any) => (
                                <tr
                                  key={a.agency}
                                  onClick={() => setDrillAgency(a.agency)}
                                  className="cursor-pointer"
                                >
                                  <td className="text-indigo-300 hover:text-indigo-200">
                                    <button
                                      onClick={(e) => { e.stopPropagation(); toggleWatch('agency', a.agency) }}
                                      className={`mr-2 ${watchedAgencies.has(a.agency) ? 'text-amber-400' : 'text-gray-700 hover:text-amber-400'}`}
                                      title={watchedAgencies.has(a.agency) ? 'Remove from watchlist' : 'Add to watchlist'}
                                    >
                                      ★
                                    </button>
                                    {a.agency}
                                  </td>
                                  <td className="text-right tabular-nums">{a.awards.toLocaleString()}</td>
                                  <td className="text-right tabular-nums">{formatCurrency(a.amount)}</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-gray-500 text-center py-6">No snapshot data returned.</p>
              )}
            </>
          )}

          {/* Watchlist summary */}
          {watchlist.length > 0 && (
            <div className="mt-6 pt-5 border-t border-gray-800">
              <h4 className="overline mb-3">Your Watchlist</h4>
              <p className="text-[10px] text-gray-600 mb-3">Weekly digest of activity for these NAICS codes and agencies sent every Monday.</p>
              <div className="flex flex-wrap gap-2">
                {watchlist.map((w: any) => (
                  <div key={w.id} className="chip chip-gold">
                    <span className="text-amber-300">★</span>
                    <span className="font-mono text-amber-200">
                      {w.naicsCode ? `NAICS ${w.naicsCode}` : w.agency}
                    </span>
                    <button
                      onClick={() => removeWatch.mutate(w.id)}
                      className="text-gray-500 hover:text-red-400 ml-1"
                      title="Remove from watchlist"
                      aria-label="Remove from watchlist"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </AddonGate>
      )}{/* end market tab — second block */}

      {/* ── NAICS Drill-Down Modal ── (always available regardless of tab) */}
      {drillNaics && (
        <div
          className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
          onClick={() => setDrillNaics(null)}
        >
          <div
            className="modal-panel rounded-xl w-full max-w-3xl max-h-[85vh] overflow-y-auto"
            style={{ background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-3)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 px-6 py-4 border-b border-gray-800 flex items-center justify-between"
              style={{ background: 'var(--surface)' }}>
              <div>
                <h3 className="text-base font-semibold text-gray-100">NAICS {drillNaics}</h3>
                <p className="text-xs text-gray-500 mt-0.5">Historical award profile from USAspending</p>
              </div>
              <button
                onClick={() => setDrillNaics(null)}
                className="text-gray-500 hover:text-gray-200 text-2xl leading-none px-2 rounded-md"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="px-6 py-5">
              {drillLoading && <div className="flex justify-center py-8"><Spinner /></div>}
              {!drillLoading && drillData?.data && (
                <div className="space-y-5">
                  <div className="stagger grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="panel p-3.5 min-w-0">
                      <p className="overline mb-1.5">Total Awards</p>
                      <p className="text-lg font-semibold tabular-nums truncate text-indigo-400">{drillData.data.totalAwards?.toLocaleString()}</p>
                    </div>
                    <div className="panel p-3.5 min-w-0">
                      <p className="overline mb-1.5">Total $</p>
                      <p className="text-lg font-semibold tabular-nums truncate text-blue-400">{formatCurrency(drillData.data.totalAmount ?? 0)}</p>
                    </div>
                    <div className="panel p-3.5 min-w-0">
                      <p className="overline mb-1.5">Avg Award</p>
                      <p className="text-lg font-semibold tabular-nums truncate text-purple-400">{formatCurrency(drillData.data.avgAwardAmount ?? 0)}</p>
                    </div>
                    <div className="panel p-3.5 min-w-0">
                      <p className="overline mb-1.5">Unique Winners</p>
                      <p className="text-lg font-semibold tabular-nums truncate text-yellow-400">{drillData.data.uniqueWinners?.toLocaleString()}</p>
                    </div>
                  </div>

                  {drillData.data.topWinners?.length > 0 && (
                    <div>
                      <h4 className="overline mb-3">Top Winners</h4>
                      <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Recipient</th>
                            <th className="text-right">Wins</th>
                            <th className="text-right">Total $</th>
                            <th className="text-right">Share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {drillData.data.topWinners.slice(0, 10).map((w: any) => (
                            <tr key={w.name}>
                              <td className="truncate max-w-xs text-gray-200">{w.name}</td>
                              <td className="text-right tabular-nums">{w.wins}</td>
                              <td className="text-right tabular-nums">{formatCurrency(w.totalAmount)}</td>
                              <td className="text-right tabular-nums text-amber-400">{(w.shareOfWins * 100).toFixed(1)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                    </div>
                  )}

                  {drillData.data.setAsideBreakdown?.length > 0 && (
                    <div>
                      <h4 className="overline mb-3">Set-Aside Breakdown</h4>
                      <div className="space-y-1.5">
                        {drillData.data.setAsideBreakdown.slice(0, 8).map((s: any) => (
                          <div key={s.type} className="flex items-center gap-3 text-xs">
                            <span className="w-32 text-gray-300 truncate">{s.type || '(unspecified)'}</span>
                            <div className="flex-1 progress-track" style={{ height: 8 }}>
                              <div className="h-full rounded-full bg-purple-500 bar-grow" style={{ width: `${s.pct}%` }} />
                            </div>
                            <span className="w-20 text-right text-gray-500 tabular-nums">{s.pct.toFixed(1)}% ({s.count})</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {drillData.data.yearlySummary?.length > 0 && (
                    <div>
                      <h4 className="overline mb-3">Awards by Year</h4>
                      <div className="grid grid-cols-5 sm:grid-cols-10 gap-1">
                        {drillData.data.yearlySummary.map((y: any) => (
                          <div key={y.year} className="panel p-2 text-center">
                            <p className="text-[10px] text-gray-500">{y.year}</p>
                            <p className="text-xs font-semibold text-gray-200">{y.awards}</p>
                            <p className="text-[9px] text-indigo-400 font-mono">{formatCurrency(y.totalAmount)}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {!drillLoading && !drillData?.data && (
                <p className="text-sm text-gray-500 text-center py-6">No data found for NAICS {drillNaics}.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Agency Drill-Down Modal ── */}
      {drillAgency && (
        <div
          className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
          onClick={() => setDrillAgency(null)}
        >
          <div
            className="modal-panel rounded-xl w-full max-w-3xl max-h-[85vh] overflow-y-auto"
            style={{ background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-3)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 px-6 py-4 border-b border-gray-800 flex items-center justify-between"
              style={{ background: 'var(--surface)' }}>
              <div>
                <h3 className="text-base font-semibold text-gray-100">{drillAgency}</h3>
                <p className="text-xs text-gray-500 mt-0.5">Agency buying profile · set-aside affinity · top NAICS</p>
              </div>
              <button onClick={() => setDrillAgency(null)} className="text-gray-500 hover:text-gray-200 text-2xl leading-none px-2 rounded-md" aria-label="Close">×</button>
            </div>

            <div className="px-6 py-5">
              {agencyLoading && <div className="flex justify-center py-8"><Spinner /></div>}
              {!agencyLoading && agencyData?.data && (
                <div className="space-y-5">
                  <div className="stagger grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="panel p-3.5 min-w-0">
                      <p className="overline mb-1.5">Total Awards</p>
                      <p className="text-lg font-semibold tabular-nums truncate text-indigo-400">{agencyData.data.totalAwards?.toLocaleString()}</p>
                    </div>
                    <div className="panel p-3.5 min-w-0">
                      <p className="overline mb-1.5">Total $</p>
                      <p className="text-lg font-semibold tabular-nums truncate text-blue-400">{formatCurrency(agencyData.data.totalAmount ?? 0)}</p>
                    </div>
                    <div className="panel p-3.5 min-w-0">
                      <p className="overline mb-1.5">Avg Award</p>
                      <p className="text-lg font-semibold tabular-nums truncate text-purple-400">{formatCurrency(agencyData.data.avgAwardAmount ?? 0)}</p>
                    </div>
                    <div className="panel p-3.5 min-w-0">
                      <p className="overline mb-1.5">Competitiveness</p>
                      <p className={`text-lg font-semibold ${agencyData.data.competitiveness === 'HIGH' ? 'text-green-400' : agencyData.data.competitiveness === 'LOW' ? 'text-red-400' : 'text-yellow-400'}`}>
                        {agencyData.data.competitiveness}
                      </p>
                    </div>
                  </div>

                  {/* Set-aside affinity */}
                  <div>
                    <h4 className="overline mb-3">Set-Aside Affinity (% of awards)</h4>
                    <div className="space-y-1.5">
                      {[
                        { label: 'Small Business', rate: agencyData.data.smallBizRate, color: '#3b82f6' },
                        { label: 'SDVOSB', rate: agencyData.data.sdvosbRate, color: '#10b981' },
                        { label: 'WOSB', rate: agencyData.data.wosbRate, color: '#a855f7' },
                        { label: 'HUBZone', rate: agencyData.data.hubzoneRate, color: '#5b74ff' },
                      ].map((s) => (
                        <div key={s.label} className="flex items-center gap-3 text-xs">
                          <span className="w-32 text-gray-300">{s.label}</span>
                          <div className="flex-1 progress-track" style={{ height: 8 }}>
                            <div className="h-full rounded-full bar-grow" style={{ width: `${(s.rate ?? 0) * 100}%`, background: s.color }} />
                          </div>
                          <span className="w-16 text-right text-gray-500 tabular-nums">{((s.rate ?? 0) * 100).toFixed(1)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Top NAICS at this agency */}
                  {agencyData.data.topNaicsCodes?.length > 0 && (
                    <div>
                      <h4 className="overline mb-3">Top NAICS Codes Bought</h4>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {agencyData.data.topNaicsCodes.map((n: any) => (
                          <button
                            key={n.naics}
                            onClick={() => { setDrillAgency(null); setTimeout(() => setDrillNaics(n.naics), 50) }}
                            className="panel p-2.5 text-left hover:bg-indigo-900/30 transition-colors group"
                          >
                            <p className="text-[10px] text-gray-500 group-hover:text-indigo-400">NAICS</p>
                            <p className="text-sm font-mono text-indigo-300 group-hover:text-indigo-200">{n.naics}</p>
                            <p className="text-[10px] text-gray-500">{n.count} awards</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {!agencyLoading && !agencyData?.data && (
                <p className="text-sm text-gray-500 text-center py-6">No data found for this agency.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AnalyticsPage
