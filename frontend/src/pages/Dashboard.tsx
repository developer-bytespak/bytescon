import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { firmApi, analyticsApi } from '../services/api'
import { OnboardingWizard, useOnboarding } from '../components/OnboardingWizard'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTutorial } from '../hooks/useTutorial'
import {
  SectionHeader,
  StatCard,
  DeadlineBadge,
  ProbabilityBar,
  formatCurrency,
  Spinner,
  ErrorBanner,
  EmptyState,
  CountUp,
  Skeleton,
  SkeletonStats,
} from '../components/ui'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import {
  TrendingUp,
  AlertTriangle,
  DollarSign,
  Users,
  Target,
  Database,
  CheckCircle,
  BarChart3,
  LogOut,
  Zap,
  Shield,
  Activity,
  ArrowRight,
  Search,
} from 'lucide-react'

// Charts
import { PursuitWidget } from '../components/PursuitWidget'
import { PipelineFunnel } from '../components/charts/PipelineFunnel'
import { WinProbabilityDistribution } from '../components/charts/WinProbabilityDistribution'
import { PenaltyTrendLine } from '../components/charts/PenaltyTrendLine'
import { SubmissionVelocity } from '../components/charts/SubmissionVelocity'
import { RevenueForecast } from '../components/charts/RevenueForecast'
import { ClientPortfolioPie } from '../components/charts/ClientPortfolioPie'

// Intelligence Cards
import { RiskRadarCard } from '../components/cards/RiskRadarCard'
import { OpportunityMatchCard } from '../components/cards/OpportunityMatchCard'
import { ScwInbox } from '../components/scw/ScwInbox'
import { DecisionRecommendationCard } from '../components/cards/DecisionRecommendationCard'

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export default function Dashboard() {
  const [seeding, setSeeding] = useState(false)
  const [seedResult, setSeedResult] = useState<string | null>(null)
  const { logout, user } = useAuth()
  const { showWizard, dismiss: dismissWizard, replay: replayOnboarding } = useOnboarding()
  const tutorial = useTutorial()
  const [showTutorial, setShowTutorial] = useState(() => !tutorial.hasSeen('dashboard'))
  function handleTutorialClose() { tutorial.markSeen('dashboard'); setShowTutorial(false) }

  const handleSeedDemo = async () => {
    setSeeding(true)
    setSeedResult(null)
    try {
      const res = await firmApi.seedDemo()
      setSeedResult(`Seeded ${res.data.created} opportunities (${res.data.skipped} already existed). Run scoring to update probabilities.`)
    } catch (err: any) {
      setSeedResult('Seed failed: ' + (err?.response?.data?.error || err.message))
    } finally {
      setSeeding(false)
    }
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => firmApi.dashboard(),
    refetchInterval: 60_000,
  })

  const { data: trendsData } = useQuery({
    queryKey: ['analytics-trends'],
    queryFn: () => analyticsApi.trends(),
    refetchInterval: 300_000,
  })

  const { data: pipelineData } = useQuery({
    queryKey: ['analytics-pipeline'],
    queryFn: () => analyticsApi.pipeline(),
    refetchInterval: 300_000,
  })

  const { data: predictionsData } = useQuery({
    queryKey: ['analytics-predictions'],
    queryFn: () => analyticsApi.predictions(),
    refetchInterval: 300_000,
  })

  const { data: healthData } = useQuery({
    queryKey: ['analytics-portfolio-health'],
    queryFn: () => analyticsApi.portfolioHealth(),
    refetchInterval: 300_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-8" aria-busy="true">
        <span className="sr-only">Loading your dashboard…</span>
        <div className="space-y-2">
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <SkeletonStats count={5} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card"><Skeleton className="h-4 w-40 mb-6" /><Skeleton className="h-52 w-full" /></div>
          <div className="card"><Skeleton className="h-4 w-40 mb-6" /><Skeleton className="h-52 w-full" /></div>
        </div>
      </div>
    )
  }

  if (error) {
    return <ErrorBanner message="Failed to load dashboard data" />
  }

  const d = data?.data
  const metrics = d?.firmMetrics
  const trends = trendsData?.data
  const pipeline = pipelineData?.data
  const predictions = predictionsData?.data
  const health = healthData?.data

  const winPct = Math.round((d?.avgWinProbability ?? 0) * 100)
  const completionPct = Math.round((metrics?.aggregateCompletionRate ?? 0) * 100)

  return (
    <div className="animate-fade-in">
      {showTutorial && <TutorialOverlay sectionKey="dashboard" onClose={handleTutorialClose} />}
      {showWizard && <OnboardingWizard onDismiss={dismissWizard} />}

      {/* ---- Hero ---- */}
      <section className="hero-banner mb-8">
        <div className="hero-orb hero-orb-a" aria-hidden="true" />
        <div className="hero-orb hero-orb-b" aria-hidden="true" />
        <div className="hero-grid" aria-hidden="true" />
        <div className="relative flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5 mb-3">
              <span className="hero-chip">
                {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              </span>
              <span className="live-pill" title="Refreshes automatically">
                <span className="live-dot" />
                Live
              </span>
            </div>
            <h1 className="hero-title">{`${greeting()}, ${user?.firstName ?? 'Advisor'}`}</h1>
            <p className="hero-sub">Your portfolio at a glance. Refreshes every minute.</p>
          </div>
          <div className="flex gap-2 items-center flex-wrap flex-shrink-0">
            {!showWizard && (
              <button
                onClick={replayOnboarding}
                className="btn-secondary text-xs"
                title="Replay the setup guide"
              >
                <Zap className="w-3.5 h-3.5" />
                Setup Guide
              </button>
            )}
            <button
              onClick={handleSeedDemo}
              disabled={seeding}
              className="btn-secondary text-xs"
              title="Load 8 realistic demo opportunities"
            >
              {seeding ? <Spinner size="sm" /> : <Database className="w-3.5 h-3.5" />}
              {seeding ? 'Seeding...' : 'Load Demo'}
            </button>
            <Link to="/analytics" className="btn-primary text-xs">
              <BarChart3 className="w-3.5 h-3.5" />
              Analytics
            </Link>
          </div>
        </div>
      </section>

      {/* ---- Seed result ---- */}
      {seedResult && (
        <div
          className={`flex items-start gap-2.5 text-sm rounded-xl px-4 py-3 mb-6 ${
            seedResult.startsWith('Seed failed')
              ? 'border text-red-300'
              : 'border text-emerald-300'
          }`}
          style={seedResult.startsWith('Seed failed')
            ? { background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.2)' }
            : { background: 'rgba(16,185,129,0.08)', borderColor: 'rgba(16,185,129,0.2)' }
          }
        >
          <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          {seedResult}
        </div>
      )}

      {/* ---- Deadline alert strip ---- */}
      {(d?.deadlineAlerts?.red > 0 || d?.deadlineAlerts?.yellow > 0) && (
        <div
          role="status"
          className="relative overflow-hidden rounded-[14px] flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5 pl-5 pr-4 py-3.5 mb-6"
          style={{ background: 'var(--surface)', border: '1px solid var(--danger-border)', boxShadow: 'var(--shadow-1)' }}
        >
          <span className="absolute left-0 inset-y-0 w-1" style={{ background: 'var(--danger)' }} aria-hidden="true" />
          <div className="flex items-center gap-3 min-w-0">
            <span className="tile tile-danger tile-sm"><AlertTriangle /></span>
            <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Deadline alerts</p>
          </div>
          <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">
            {d.deadlineAlerts.red > 0 && (
              <span className="chip chip-danger chip-lg">
                <span className="chip-dot" aria-hidden="true" />
                <span className="font-bold tabular-nums"><CountUp value={d.deadlineAlerts.red} duration={600} /></span> critical, due within 7 days
              </span>
            )}
            {d.deadlineAlerts.yellow > 0 && (
              <span className="chip chip-gold chip-lg">
                <span className="chip-dot" aria-hidden="true" />
                <span className="font-bold tabular-nums"><CountUp value={d.deadlineAlerts.yellow} duration={600} /></span> elevated, due within 20 days
              </span>
            )}
          </div>
          <Link to="/opportunities?sortBy=deadline" className="btn-secondary text-xs flex-shrink-0 !py-1.5 self-start sm:self-auto group">
            View all
            <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      )}

      {/* ---- KPI Row ---- */}
      <div className="stagger grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4 mb-8">
        <StatCard
          label="Active Clients"
          value={metrics?.totalClients ?? 0}
          sub="Consulting relationships"
          tone="accent"
          icon={<Users />}
        />
        <StatCard
          label="Pipeline Value"
          value={formatCurrency(d?.pipelineValue?.totalExpected ?? 0)}
          sub={`${d?.totalOpportunities ?? 0} opportunities`}
          tone="accent"
          featured
          series={pipeline?.stages?.map((st: { count: number }) => st.count)}
          icon={<TrendingUp />}
        />
        <StatCard
          label="Avg Win Probability"
          value={`${winPct}%`}
          sub="Across all decisions"
          color={winPct >= 40 ? 'green' : 'yellow'}
          tone={winPct >= 40 ? 'success' : 'gold'}
          icon={<Target />}
        />
        <StatCard
          label="Completion Rate"
          value={`${completionPct}%`}
          sub="On-time submissions"
          color={completionPct >= 80 ? 'green' : 'yellow'}
          tone={completionPct >= 80 ? 'success' : 'gold'}
          icon={<Activity />}
        />
        <StatCard
          label="Penalties (30d)"
          value={formatCurrency(d?.recentPenalties?.total ?? 0)}
          sub={`${d?.recentPenalties?.count ?? 0} events`}
          color={(d?.recentPenalties?.total ?? 0) > 0 ? 'red' : 'green'}
          tone={(d?.recentPenalties?.total ?? 0) > 0 ? 'danger' : 'neutral'}
          icon={<Shield />}
        />
      </div>

      {/* ---- Pending bid decisions (pursuit tracker) ---- */}
      <PursuitWidget />

      {/* ---- Row 2: Pipeline + Win Distribution ---- */}
      <div className="stagger grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <PipelineFunnel stages={pipeline?.stages || []} />
        <WinProbabilityDistribution data={d?.probDistribution} />
      </div>

      {/* ---- Row 3: Trend Charts ---- */}
      <div className="stagger grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <PenaltyTrendLine data={trends?.penalties} />
        <SubmissionVelocity data={trends?.submissions} />
      </div>

      {/* ---- Row 4: Intelligence Cards ---- */}
      <div className="mb-2">
        <SectionHeader title="AI intelligence" subtitle="Matches, risks and recent calls from the agents" icon={<Zap />} tone="gold" />
      </div>
      <div className="stagger grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <OpportunityMatchCard suggestions={predictions?.opportunitySuggestions} />
        <RiskRadarCard risks={predictions?.riskItems} />
        <DecisionRecommendationCard decisions={d?.recentDecisions} />
      </div>

      {/* ---- Subcontracting Inbox (SCW-5) ---- */}
      <div className="mb-8">
        <ScwInbox />
      </div>

      {/* ---- Row 5: Revenue Forecast ---- */}
      <div className="mb-8">
        <RevenueForecast data={health?.revenueForecast} />
      </div>

      {/* ---- Row 6: Top Opportunities + Portfolio ---- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Opportunities */}
        <div className="card">
          <SectionHeader
            title="Top Opportunities by Expected Value"
            action={
              <Link to="/opportunities" className="btn-ghost !py-1 !px-2 text-xs group" style={{ color: 'var(--accent-3)' }}>
                View all
                <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
              </Link>
            }
          />

          <div className="stagger space-y-0">
            {d?.topOpportunities?.length === 0 && (
              <EmptyState
                message="No scored opportunities yet"
                hint="Scores appear once opportunities are matched to your clients."
                icon={<Target />}
                action={<Link to="/opportunities" className="btn-primary text-xs"><Search className="w-3.5 h-3.5" />Browse opportunities</Link>}
              />
            )}

            {d?.topOpportunities?.map((opp: any) => (
              <div key={opp.id} className="table-row py-3 -mx-2 px-2 rounded-lg">
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <Link
                    to={`/opportunities/${opp.id}`}
                    className="text-sm font-medium text-sky-400 hover:text-sky-300 line-clamp-1 flex-1 transition-colors"
                  >
                    {opp.title}
                  </Link>
                  <DeadlineBadge
                    priority={
                      opp.deadline.daysUntil <= 7
                        ? 'RED'
                        : opp.deadline.daysUntil <= 20
                        ? 'YELLOW'
                        : 'GREEN'
                    }
                    label={`${opp.deadline.daysUntil}d`}
                  />
                </div>

                <p className="text-xs mb-2.5" style={{ color: 'var(--text-faint)' }}>{opp.agency}</p>

                <ProbabilityBar probability={opp.probabilityScore || 0} />

                {opp.bidDecisions?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2.5">
                    {opp.bidDecisions.map((bd: any, i: number) => (
                      <span
                        key={i}
                        className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                          bd.recommendation === 'BID_PRIME'
                            ? 'badge-green'
                            : bd.recommendation === 'BID_SUB'
                            ? 'badge-blue'
                            : 'badge-red'
                        }`}
                      >
                        {bd.recommendation} — {bd.clientCompany?.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <ClientPortfolioPie clients={metrics?.clientBreakdown} />
      </div>
    </div>
  )
}
