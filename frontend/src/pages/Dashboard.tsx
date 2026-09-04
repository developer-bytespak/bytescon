import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { firmApi, analyticsApi } from '../services/api'
import { OnboardingWizard, useOnboarding } from '../components/OnboardingWizard'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTutorial } from '../hooks/useTutorial'
import {
  PageHeader,
  SectionHeader,
  StatCard,
  DeadlineBadge,
  ProbabilityBar,
  formatCurrency,
  Spinner,
  ErrorBanner,
} from '../components/ui'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import {
  TrendingUp,
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
      <div className="flex flex-col items-center justify-center mt-32 gap-4">
        <Spinner size="lg" />
        <p className="text-sm text-slate-500">Loading your dashboard…</p>
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

      {/* ---- Page Header ---- */}
      <PageHeader
        title={`${greeting()}, ${user?.firstName ?? 'Advisor'}`}
        subtitle="Your portfolio at a glance. Refreshes every minute."
        live
      >
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
      </PageHeader>

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

      {/* ---- Deadline alerts (neutral card; colour only on the counts) ---- */}
      {(d?.deadlineAlerts?.red > 0 || d?.deadlineAlerts?.yellow > 0) && (
        <div className="card flex items-center gap-4 !py-3 mb-6">
          <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-5 gap-y-1">
            <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Deadline alerts</p>
            {d.deadlineAlerts.red > 0 && (
              <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-2)' }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--danger)' }} aria-hidden="true" />
                <span className="font-semibold" style={{ color: 'var(--text)' }}>{d.deadlineAlerts.red}</span> critical, due within 7 days
              </span>
            )}
            {d.deadlineAlerts.yellow > 0 && (
              <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-2)' }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--warning)' }} aria-hidden="true" />
                <span className="font-semibold" style={{ color: 'var(--text)' }}>{d.deadlineAlerts.yellow}</span> elevated, due within 20 days
              </span>
            )}
          </div>
          <Link to="/opportunities?sortBy=deadline" className="btn-secondary text-xs flex-shrink-0 !py-1.5">
            View all
          </Link>
        </div>
      )}

      {/* ---- Pending bid decisions (pursuit tracker) ---- */}
      <PursuitWidget />

      {/* ---- KPI Row ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <StatCard
          label="Active Clients"
          value={metrics?.totalClients ?? 0}
          sub="Consulting relationships"
          color="blue"
          icon={<Users className="w-4 h-4 text-blue-400" />}
        />
        <StatCard
          label="Pipeline Value"
          value={formatCurrency(d?.pipelineValue?.totalExpected ?? 0)}
          sub={`${d?.totalOpportunities ?? 0} opportunities`}
          color="green"
          icon={<TrendingUp className="w-4 h-4 text-emerald-400" />}
        />
        <StatCard
          label="Avg Win Probability"
          value={`${winPct}%`}
          sub="Across all decisions"
          color={winPct >= 40 ? 'green' : 'yellow'}
          icon={<Target className="w-4 h-4 text-amber-400" />}
        />
        <StatCard
          label="Completion Rate"
          value={`${completionPct}%`}
          sub="On-time submissions"
          color={completionPct >= 80 ? 'green' : 'yellow'}
          icon={<Activity className="w-4 h-4 text-emerald-400" />}
        />
        <StatCard
          label="Penalties (30d)"
          value={formatCurrency(d?.recentPenalties?.total ?? 0)}
          sub={`${d?.recentPenalties?.count ?? 0} events`}
          color={(d?.recentPenalties?.total ?? 0) > 0 ? 'red' : 'green'}
          icon={<Shield className="w-4 h-4 text-red-400" />}
        />
      </div>

      {/* ---- Row 2: Pipeline + Win Distribution ---- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <PipelineFunnel stages={pipeline?.stages || []} />
        <WinProbabilityDistribution data={d?.probDistribution} />
      </div>

      {/* ---- Row 3: Trend Charts ---- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <PenaltyTrendLine data={trends?.penalties} />
        <SubmissionVelocity data={trends?.submissions} />
      </div>

      {/* ---- Row 4: Intelligence Cards ---- */}
      <div className="mb-2">
        <SectionHeader title="AI Intelligence" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
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
              <Link to="/opportunities" className="text-xs text-blue-400 hover:text-blue-300 font-medium">
                View all →
              </Link>
            }
          />

          <div className="space-y-0">
            {d?.topOpportunities?.length === 0 && (
              <p className="text-sm text-slate-600 text-center py-8">
                No scored opportunities yet
              </p>
            )}

            {d?.topOpportunities?.map((opp: any) => (
              <div key={opp.id} className="table-row py-3">
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

                <p className="text-xs mb-2.5" style={{ color: '#6e6979' }}>{opp.agency}</p>

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
