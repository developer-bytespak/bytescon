// =============================================================
// Dashboard — the v2 design pilot (styles/ui-v2.css, components/v2).
// Answers "what needs me today, and how is my pipeline doing" in that order:
// a short greeting, what needs attention, the key figures, the next 30 days
// of deadlines (the page's one big visual), then bids awaiting a decision,
// the best opportunities, where win probabilities sit and the agents'
// insights. Rarer charts sit behind "More analytics" tabs.
// =============================================================
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { BarChart3, CheckCircle, Database, Zap } from 'lucide-react'
import { firmApi, analyticsApi, pursuitsApi } from '../services/api'
import { OnboardingWizard, useOnboarding } from '../components/OnboardingWizard'
import { isDemoSite } from '../demo/demoMode'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTutorial } from '../hooks/useTutorial'
import { ErrorBanner, Skeleton, Spinner } from '../components/ui'
import { useAuth, useIsContractor } from '../hooks/useAuth'
import { daysUntil } from '../components/v2/format'
import { PursuitWidget } from '../components/PursuitWidget'
import { useUiV2 } from '../components/v2/useUiV2'
import { DeadlineTimeline } from '../components/v2/DeadlineTimeline'
import { AttentionStrip, InsightsCard, KpiBento, MoreAnalytics, TopOpportunities, WinSpread } from '../components/v2/DashboardParts'

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export default function Dashboard() {
  useUiV2()
  const [seeding, setSeeding] = useState(false)
  const [seedResult, setSeedResult] = useState<string | null>(null)
  const { user } = useAuth()
  // Contractor accounts bid for their own company: no client figures or client mix.
  const isContractor = useIsContractor()
  const { showWizard, dismiss: dismissWizard, replay: replayOnboarding } = useOnboarding()
  const tutorial = useTutorial()
  const [showTutorial, setShowTutorial] = useState(() => !tutorial.hasSeen('dashboard'))
  function handleTutorialClose() { tutorial.markSeen('dashboard'); setShowTutorial(false) }

  const handleSeedDemo = async () => {
    setSeeding(true)
    setSeedResult(null)
    try {
      const res = await firmApi.seedDemo()
      setSeedResult(`Loaded ${res.data.created} sample opportunities (${res.data.skipped} were already there). Run scoring to update win probabilities.`)
    } catch (err: any) {
      setSeedResult('Could not load the sample opportunities: ' + (err?.response?.data?.error || err.message))
    } finally {
      setSeeding(false)
    }
  }

  const { data, isLoading, error } = useQuery({ queryKey: ['dashboard'], queryFn: () => firmApi.dashboard(), refetchInterval: 60_000 })
  const { data: trendsData } = useQuery({ queryKey: ['analytics-trends'], queryFn: () => analyticsApi.trends(), refetchInterval: 300_000 })
  const { data: pipelineData } = useQuery({ queryKey: ['analytics-pipeline'], queryFn: () => analyticsApi.pipeline(), refetchInterval: 300_000 })
  const { data: predictionsData } = useQuery({ queryKey: ['analytics-predictions'], queryFn: () => analyticsApi.predictions(), refetchInterval: 300_000 })
  const { data: healthData } = useQuery({ queryKey: ['analytics-portfolio-health'], queryFn: () => analyticsApi.portfolioHealth(), refetchInterval: 300_000 })
  // Same query as the pending-decisions card below, so it is fetched once.
  const { data: pursuitsData } = useQuery({ queryKey: ['pursuits', 'REVIEWING'], queryFn: () => pursuitsApi.list('REVIEWING'), refetchInterval: 300_000 })

  if (isLoading) {
    return (
      <div className="v2 space-y-5" aria-busy="true">
        <span className="sr-only">Loading your dashboard…</span>
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-20 w-full rounded-2xl" />
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <Skeleton className="h-64 rounded-2xl sm:col-span-2 xl:row-span-2" />
          <Skeleton className="h-28 rounded-2xl" /><Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-28 rounded-2xl" /><Skeleton className="h-28 rounded-2xl" />
        </div>
        <Skeleton className="h-72 w-full rounded-2xl" />
      </div>
    )
  }
  if (error) return <ErrorBanner message="Couldn't load the dashboard. Check your connection and refresh the page." />

  const d = data?.data
  const metrics = d?.firmMetrics
  const trends = trendsData?.data
  const stages = (pipelineData?.data?.stages ?? []) as { label: string; count: number }[]
  const predictions = predictionsData?.data
  const health = healthData?.data
  const risks = (predictions?.riskItems ?? []) as { severity: string }[]
  const clientBreakdown = (metrics?.clientBreakdown ?? []) as { totalSubmitted: number }[]
  const submitted = clientBreakdown.reduce((a, c) => a + (c.totalSubmitted || 0), 0)
  const decided = stages.find((s) => s.label === 'Decided')?.count ?? 0
  // Notices closing today through 7 days out: the same count the timeline shows.
  const closingSoon = ((d?.calendar?.closingByDay ?? []) as { day: string; count: number }[])
    .filter((r) => { const n = daysUntil(`${r.day}T12:00:00`); return n >= 0 && n <= 7 })
    .reduce((a, r) => a + r.count, 0)

  return (
    <div className="v2 space-y-5">
      {showTutorial && <TutorialOverlay sectionKey="dashboard" onClose={handleTutorialClose} />}
      {showWizard && <OnboardingWizard onDismiss={dismissWizard} />}

      {/* The blue band: greeting, actions and what needs attention today. The
          figure cards below overlap its lower edge. */}
      <section className="v2-band" aria-label="Today">
      <motion.header
        className="relative z-[1] flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="min-w-0">
          <p className="text-[13px] font-medium" style={{ color: 'rgba(255,255,255,0.78)' }}>
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          <h1 className="mt-1 text-[30px] font-semibold leading-tight tracking-[-0.025em] text-white">
            {greeting()}, {user?.firstName ?? 'there'}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!showWizard && !isDemoSite && (
            <button onClick={replayOnboarding} className="v2-btn v2-btn-glass" title="Replay the setup guide"><Zap />Setup guide</button>
          )}
          {!isDemoSite && (
            <button onClick={handleSeedDemo} disabled={seeding} className="v2-btn v2-btn-glass" title="Load 8 sample opportunities">
              {seeding ? <Spinner size="sm" /> : <Database />}{seeding ? 'Loading…' : 'Load sample data'}
            </button>
          )}
          <Link to="/analytics" className="v2-btn v2-btn-white"><BarChart3 />Open analytics</Link>
        </div>
      </motion.header>

      {seedResult && (
        <p role="status" className={`v2-card flex items-start gap-2.5 px-4 py-3 text-sm`} style={{ color: seedResult.startsWith('Could not') ? 'var(--danger-text)' : 'var(--success-text)' }}>
          <CheckCircle className="w-4 h-4 flex-none mt-0.5" aria-hidden="true" />{seedResult}
        </p>
      )}

      <div className="relative z-[1] mt-6">
      <AttentionStrip
        closingThisWeek={closingSoon}
        decisionsWaiting={((pursuitsData?.data ?? []) as unknown[]).length}
        criticalRisks={risks.filter((r) => r.severity === 'CRITICAL').length}
      />
      </div>
      </section>

      <div className="v2-overlap">
      <KpiBento
        pipeline={{ totalExpected: d?.pipelineValue?.totalExpected ?? 0, totalNet: d?.pipelineValue?.totalNet ?? 0 }}
        stages={stages}
        winProbability={d?.avgWinProbability ?? 0}
        decided={decided}
        onTimeRate={metrics?.aggregateCompletionRate ?? 0}
        submitted={submitted}
        penalties={d?.recentPenalties?.total ?? 0}
        penaltyEvents={d?.recentPenalties?.count ?? 0}
        clients={isContractor ? null : metrics?.totalClients ?? 0}
      />
      </div>

      <DeadlineTimeline calendar={d?.calendar} />

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        <div className="xl:col-span-7"><PursuitWidget variant="v2" /></div>
        <div className="xl:col-span-5"><WinSpread buckets={d?.probDistribution ?? []} /></div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        <div className="xl:col-span-7"><TopOpportunities items={d?.topOpportunities ?? []} /></div>
        <div className="xl:col-span-5">
          <InsightsCard risks={(predictions?.riskItems ?? []) as never} decisions={(d?.recentDecisions ?? []) as never} matches={(predictions?.opportunitySuggestions ?? []) as never} />
        </div>
      </div>

      <MoreAnalytics
        forecast={health?.revenueForecast}
        submissions={trends?.submissions}
        penalties={trends?.penalties}
        clients={isContractor ? null : (metrics?.clientBreakdown ?? [])}
      />
    </div>
  )
}
