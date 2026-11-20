// =============================================================
// Dashboard (UI v3, components/dashboard).
// Answers "what needs me today, and how is my pipeline doing" in that order:
// a short greeting, what needs attention, the key figures, the next 30 days
// of deadlines (the page's one big visual), then bids awaiting a decision,
// the best opportunities, where win probabilities sit and the agents'
// insights. Rarer charts sit behind "More analytics" tabs.
// =============================================================
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { firmApi, analyticsApi, pursuitsApi } from '../services/api'
import { OnboardingWizard, useOnboarding } from '../components/OnboardingWizard'
import { isDemoSite } from '../demo/demoMode'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTutorial } from '../hooks/useTutorial'
import { ErrorBanner, Skeleton, Spinner } from '../components/ui'
import { useAuth, useIsContractor } from '../hooks/useAuth'
import { daysUntil } from '../components/dashboard/format'
import { PursuitWidget } from '../components/PursuitWidget'
import { DeadlineTimeline } from '../components/dashboard/DeadlineTimeline'
import { Figures, Greeting, InsightsCard, MoreAnalytics, Section, TopOpportunities, WinSpread } from '../components/dashboard/DashboardParts'


export default function Dashboard() {
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
      <div className="space-y-5 pt-6" aria-busy="true">
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

  const decisionsWaiting = ((pursuitsData?.data ?? []) as unknown[]).length
  const criticalRisks = risks.filter((r) => r.severity === 'CRITICAL').length
  const closing30 = ((d?.calendar?.closingByDay ?? []) as { day: string; count: number }[])
    .filter((r) => { const n = daysUntil(`${r.day}T12:00:00`); return n >= 0 && n <= 30 })
    .reduce((a, r) => a + r.count, 0)
  const topOpportunities = d?.topOpportunities ?? []

  return (
    <div>
      {/* One guide at a time: the tour waits until the setup wizard is closed. */}
      {showTutorial && !showWizard && <TutorialOverlay sectionKey="dashboard" onClose={handleTutorialClose} />}
      {showWizard && <OnboardingWizard onDismiss={dismissWizard} />}

      <Greeting
        name={user?.firstName ?? 'there'}
        decisionsWaiting={decisionsWaiting}
        closingThisWeek={closingSoon}
        best={topOpportunities[0]}
        actions={
          <>
            <Link to="/analytics" className="v3-pill v3-pill-dark">Open analytics</Link>
            {!showWizard && !isDemoSite && <button type="button" onClick={replayOnboarding} className="v3-pill v3-pill-light">Setup guide</button>}
            {!isDemoSite && (
              <button type="button" onClick={handleSeedDemo} disabled={seeding} className="v3-pill v3-pill-light">
                {seeding ? <Spinner size="sm" /> : null}{seeding ? 'Loading sample data…' : 'Load sample data'}
              </button>
            )}
          </>
        }
      />

      {seedResult && (
        <p role="status" className="mt-6 v3-surface !py-4 text-[14px]" style={{ color: seedResult.startsWith('Could not') ? 'var(--danger-text)' : 'var(--success-text)' }}>
          {seedResult}
        </p>
      )}

      <Figures
        pipeline={{ totalExpected: d?.pipelineValue?.totalExpected ?? 0, totalNet: d?.pipelineValue?.totalNet ?? 0 }}
        stages={stages}
        winProbability={d?.avgWinProbability ?? 0}
        decided={decided}
        onTimeRate={metrics?.aggregateCompletionRate ?? 0}
        submitted={submitted}
        penalties={d?.recentPenalties?.total ?? 0}
        decisionsWaiting={decisionsWaiting}
        criticalRisks={criticalRisks}
        clients={isContractor ? null : metrics?.totalClients ?? 0}
        closingThisWeek={closingSoon}
        closing30={closing30}
        yourBidsDue={(d?.calendar?.bidsDue ?? []).length}
      />

      <Section id="attention-title" title="Waiting for your decision"
        aside={<p className="text-[14px] max-w-[52ch]" style={{ color: 'var(--text-muted)' }}>Mark each bid submitted or passed. The result sharpens your win probabilities.</p>}>
        <PursuitWidget />
      </Section>

      <Section id="next30-title" title="The next 30 days">
        <DeadlineTimeline calendar={d?.calendar} />
      </Section>

      <Section id="best-title" title="Best opportunities" aside={<Link to="/opportunities" className="v3-pill v3-pill-light v3-pill-sm">View all</Link>}>
        <TopOpportunities items={topOpportunities} />
        <div className="mt-3.5 grid gap-3.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-stretch">
          <WinSpread buckets={d?.probDistribution ?? []} />
          <InsightsCard risks={(predictions?.riskItems ?? []) as never} decisions={(d?.recentDecisions ?? []) as never} matches={(predictions?.opportunitySuggestions ?? []) as never} />
        </div>
      </Section>

      <MoreAnalytics
        forecast={health?.revenueForecast}
        submissions={trends?.submissions}
        penalties={trends?.penalties}
        clients={isContractor ? null : (metrics?.clientBreakdown ?? [])}
      />
    </div>
  )
}
