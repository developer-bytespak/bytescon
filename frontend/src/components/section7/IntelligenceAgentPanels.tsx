// =============================================================
// §7.9 — Intelligence Agent panels.
//
// Two panels, hosted on the pages that already own their subject:
//   · WinLossIntelligencePanel → /analytics  (measurement)
//   · CaptureIntelligencePanel → /portfolio  (decisions)
//
// THE RULES THIS UI ENFORCES
//   · A null win rate is rendered as INSUFFICIENT DATA with the real counts,
//     never as 0%, never as a 50% placeholder, never as an empty gauge.
//   · A rate is never shown without its sample and its interval beside it.
//   · An insufficient segment is never given a colour ranking against a
//     measured one.
//   · The public benchmark is always labelled PUBLIC AWARD DATA and never
//     described as a competitor win rate.
//   · There is no control that applies a recommendation to the pipeline.
//     Dismiss and acknowledge act on the advice, not on the data.
//
// Every statistic is rendered from the backend payload. This file computes no
// rate, no interval, no score and no ranking.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, BarChart3, HelpCircle, Info, Layers, RefreshCw, Target, TrendingDown, TrendingUp } from 'lucide-react'
import {
  intelligenceAgentApi,
  formatRate,
  insufficientSampleMessage,
  type IntelligenceAgentView,
  type PortfolioIntelligence,
  type StoredRecommendation,
  type WinLossSegmentView,
} from '../../services/intelligenceAgentApi'

const SUFFICIENCY_TONE: Record<string, string> = {
  SUFFICIENT: 'bg-green-950/30 border-green-800 text-green-300',
  PARTIAL: 'bg-yellow-950/40 border-yellow-800 text-yellow-300',
  INSUFFICIENT_DATA: 'bg-gray-800 border-gray-700 text-gray-400',
}

const TREND_ICON = { IMPROVING: TrendingUp, DECLINING: TrendingDown, STABLE: BarChart3, INSUFFICIENT_DATA: HelpCircle }

const CONCENTRATION_TONE: Record<string, string> = {
  CONCENTRATED: 'bg-red-950/40 border-red-800 text-red-300',
  MODERATE: 'bg-yellow-950/40 border-yellow-800 text-yellow-300',
  DIVERSIFIED: 'bg-green-950/30 border-green-800 text-green-300',
  INSUFFICIENT_DATA: 'bg-gray-800 border-gray-700 text-gray-400',
}

const money = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

function Panel({ title, icon: Icon, testId, onRefresh, children }: {
  title: string
  icon: typeof Target
  testId: string
  onRefresh?: () => void
  children: React.ReactNode
}) {
  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid={testId}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-gray-400" />
          <h2 className="text-sm font-medium text-gray-200">{title}</h2>
        </div>
        {onRefresh && (
          <button onClick={onRefresh} className="text-gray-500 hover:text-gray-300 transition-colors" aria-label={`Refresh ${title}`}>
            <RefreshCw className="w-4 h-4" />
          </button>
        )}
      </div>
      {children}
    </section>
  )
}

function Note({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] text-gray-500 mb-3" data-testid={testId}>
      <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{children}</span>
    </p>
  )
}

/**
 * The one place a rate is rendered.
 *
 * When the backend supplied no rate this shows the counts and how many more
 * outcomes are needed — never a number the data does not support.
 */
function RateWithSample({ segment, testId }: { segment: WinLossSegmentView; testId?: string }) {
  if (segment.winRate === null) {
    return (
      <div data-testid={testId}>
        <span className="text-[10px] px-1.5 py-0.5 rounded border bg-gray-800 border-gray-700 text-gray-400 font-mono">
          INSUFFICIENT DATA
        </span>
        <p className="text-[11px] text-gray-500 mt-1">
          {insufficientSampleMessage(segment.sampleSize, segment.minimumSampleSize)}
        </p>
        <p className="text-[11px] text-gray-600">
          {segment.wins} win(s), {segment.losses} loss(es), {segment.pending} pending.
        </p>
      </div>
    )
  }
  return (
    <div data-testid={testId}>
      <span className="text-base font-bold text-gray-100">{formatRate(segment.winRate)}</span>
      <p className="text-[11px] text-gray-500">
        {segment.wins}W / {segment.losses}L across {segment.sampleSize} confirmed outcome(s)
        {segment.pending > 0 && ` · ${segment.pending} pending, excluded from the denominator`}
      </p>
      {segment.intervalLower !== null && segment.intervalUpper !== null && (
        <p className="text-[11px] text-gray-500">
          95% interval {formatRate(segment.intervalLower)} to {formatRate(segment.intervalUpper)}
        </p>
      )}
    </div>
  )
}

function SegmentList({ segments, label, testId }: { segments: WinLossSegmentView[]; label: string; testId: string }) {
  if (segments.length === 0) {
    return <p className="text-xs text-gray-500" data-testid={testId}>No {label.toLowerCase()} outcomes recorded.</p>
  }
  return (
    <ul className="space-y-2" data-testid={testId}>
      {segments.slice(0, 8).map((s) => (
        <li key={`${s.segmentType}-${s.segmentKey}`} className="border border-gray-800 rounded-lg p-2" data-testid={`segment-${s.segmentType}-${s.segmentKey}`}>
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs text-gray-300">{s.segmentLabel}</span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${SUFFICIENCY_TONE[s.dataSufficiency]}`}>
              {s.dataSufficiency.replace(/_/g, ' ')}
            </span>
          </div>
          <div className="mt-1"><RateWithSample segment={s} /></div>
        </li>
      ))}
    </ul>
  )
}

// =============================================================
// /analytics — measurement
// =============================================================

export function WinLossIntelligencePanel() {
  const [data, setData] = useState<IntelligenceAgentView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await intelligenceAgentApi.portfolio())
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load the Intelligence Agent analysis.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <Panel title="Win/loss intelligence" icon={BarChart3} testId="winloss-panel"><p className="text-xs text-gray-500">Loading…</p></Panel>
  if (error) return <Panel title="Win/loss intelligence" icon={BarChart3} testId="winloss-panel" onRefresh={() => void load()}><p className="text-xs text-red-400">{error}</p></Panel>

  const intel: PortfolioIntelligence | null = data?.intelligence ?? null

  return (
    <Panel title="Win/loss intelligence" icon={BarChart3} testId="winloss-panel" onRefresh={() => void load()}>
      {!intel ? (
        <p className="text-xs text-gray-500">
          The Intelligence Agent has not analysed this firm yet. Enable it on the Agent Operations page.
        </p>
      ) : (
        <>
          <p className="text-[11px] text-gray-600 mb-3" data-testid="analysis-period">
            {intel.analysisPeriod.lookbackMonths}-month analysis to {new Date(intel.analysisPeriod.end).toLocaleDateString()}
            {data?.lastRun && ` · run ${data.lastRun.id.slice(0, 8)} (${data.lastRun.status})`}
          </p>

          {/* --- headline ------------------------------------------------- */}
          <div className="bg-gray-950/40 border border-gray-800 rounded-lg p-3 mb-3" data-testid="outcome-summary">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Confirmed win rate</p>
            <RateWithSample
              testId="overall-rate"
              segment={{
                segmentType: 'OVERALL', segmentKey: 'OVERALL', segmentLabel: 'All',
                wins: intel.outcomeSummary.confirmedWins,
                losses: intel.outcomeSummary.confirmedLosses,
                pending: intel.outcomeSummary.pending,
                sampleSize: intel.outcomeSummary.confirmedSampleSize,
                minimumSampleSize: intel.outcomeSummary.minimumSampleSize,
                winRate: intel.outcomeSummary.winRate,
                intervalLower: intel.outcomeSummary.intervalLower,
                intervalUpper: intel.outcomeSummary.intervalUpper,
                dataSufficiency: intel.outcomeSummary.dataSufficiency,
                sourceOutcomeIds: [], limitations: [], algorithmVersion: '', inputHash: '',
              }}
            />
            {intel.outcomeSummary.duplicatesCollapsed > 0 && (
              <p className="text-[11px] text-gray-600 mt-1">
                {intel.outcomeSummary.duplicatesCollapsed} duplicate record(s) collapsed so no procurement is counted twice.
              </p>
            )}
            {intel.outcomeSummary.nonContestExcluded > 0 && (
              <p className="text-[11px] text-gray-600">
                {intel.outcomeSummary.nonContestExcluded} cancelled or withdrawn solicitation(s) excluded — no contest was decided.
              </p>
            )}
          </div>

          {/* --- segments -------------------------------------------------- */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div>
              <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">By agency</p>
              <SegmentList segments={intel.segments.agencies} label="Agency" testId="segments-agencies" />
            </div>
            <div>
              <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">By NAICS</p>
              <SegmentList segments={intel.segments.naics} label="NAICS" testId="segments-naics" />
            </div>
            <div>
              <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">By contract vehicle</p>
              <SegmentList segments={intel.segments.vehicles} label="Vehicle" testId="segments-vehicles" />
            </div>
            <div>
              <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">By set-aside</p>
              <SegmentList segments={intel.segments.setAsides} label="Set-aside" testId="segments-setasides" />
            </div>
          </div>

          {/* --- trend ------------------------------------------------------ */}
          <div className="border-t border-gray-800 pt-2 mb-3" data-testid="trend-block">
            <div className="flex items-center gap-2 mb-1">
              {(() => {
                const Icon = TREND_ICON[intel.trends.overall?.state ?? 'INSUFFICIENT_DATA']
                return <Icon className="w-3.5 h-3.5 text-gray-400" />
              })()}
              <p className="text-xs text-gray-300">
                Trend: {(intel.trends.overall?.state ?? 'INSUFFICIENT_DATA').replace(/_/g, ' ').toLowerCase()}
              </p>
            </div>
            <p className="text-[11px] text-gray-500">
              {intel.trends.overall
                ? `${intel.trends.overall.periodsWithSufficientSample} qualifying quarter(s), smoothed with ${intel.trends.overall.method}.`
                : 'Not computed for this run.'}
            </p>
            {intel.trends.limitations.map((l) => <p key={l} className="text-[11px] text-yellow-400">{l}</p>)}
          </div>

          {/* --- concentration ---------------------------------------------- */}
          <div className="border-t border-gray-800 pt-2 mb-3" data-testid="concentration-block">
            <div className="flex items-center gap-2 mb-1">
              <Layers className="w-3.5 h-3.5 text-gray-400" />
              <p className="text-xs text-gray-300">Concentration</p>
              <span className={`text-[9px] px-1.5 py-0.5 rounded border ${CONCENTRATION_TONE[intel.concentration.state]}`}>
                {intel.concentration.state}
              </span>
              {intel.concentration.hhi !== null && (
                <span className="text-[11px] font-mono text-gray-400">HHI {intel.concentration.hhi}</span>
              )}
            </div>
            <p className="text-[11px] text-gray-500">
              Basis: {intel.concentration.basis}. Monitoring threshold {intel.concentration.threshold}.
            </p>
            {intel.concentration.dominantSegments.length > 0 && (
              <p className="text-[11px] text-gray-500">
                Dominant: {intel.concentration.dominantSegments.map((d) => `${d.key} ${(d.share * 100).toFixed(1)}%`).join(', ')}
              </p>
            )}
          </div>

          {/* --- public benchmark -------------------------------------------- */}
          <div className="border-t border-gray-800 pt-2 mb-3" data-testid="public-benchmark">
            <p className="text-xs text-gray-300 mb-1">
              Comparable benchmark — <span className="font-mono text-[10px] text-gray-400">PUBLIC AWARD DATA</span>
            </p>
            <Note testId="benchmark-source">{intel.comparablePublicBenchmark.sourceDescription}</Note>
            <p className="text-[11px] text-gray-500">
              Cohort {intel.comparablePublicBenchmark.cohortSize} of a minimum {intel.comparablePublicBenchmark.minimumCohortSize}
              {intel.comparablePublicBenchmark.cohortRules.length > 0 && ` · ${intel.comparablePublicBenchmark.cohortRules.join(' · ')}`}
            </p>
            {intel.comparablePublicBenchmark.relaxedFilters.length > 0 && (
              <p className="text-[11px] text-gray-500">Relaxed: {intel.comparablePublicBenchmark.relaxedFilters.join(', ')}</p>
            )}
            {intel.comparablePublicBenchmark.sourceIds.length > 0 && (
              <p className="text-[11px] text-gray-600 font-mono">
                {intel.comparablePublicBenchmark.sourceIds.length} source award(s)
              </p>
            )}
            {intel.comparablePublicBenchmark.limitations.map((l) => (
              <p key={l} className="text-[11px] text-yellow-400 mt-1">{l}</p>
            ))}
          </div>

          {/* --- data limitations ---------------------------------------------- */}
          <div className="border-t border-gray-800 pt-2" data-testid="data-limitations">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Data limitations</p>
            {intel.dataLimitations.length === 0 ? (
              <p className="text-[11px] text-gray-500">None recorded for this analysis.</p>
            ) : (
              <ul className="space-y-0.5">
                {intel.dataLimitations.map((l) => <li key={l} className="text-[11px] text-yellow-400">{l}</li>)}
              </ul>
            )}
          </div>
        </>
      )}
    </Panel>
  )
}

// =============================================================
// /portfolio — decisions
// =============================================================

export function CaptureIntelligencePanel() {
  const [view, setView] = useState<IntelligenceAgentView | null>(null)
  const [recommendations, setRecommendations] = useState<StoredRecommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [portfolio, recs] = await Promise.all([
        intelligenceAgentApi.portfolio(),
        intelligenceAgentApi.recommendations('ACTIVE'),
      ])
      setView(portfolio)
      setRecommendations(recs.recommendations)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load capture intelligence.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const dismiss = async (id: string) => {
    const reason = window.prompt('Why are you dismissing this recommendation?')
    if (!reason?.trim()) return
    setBusyId(id)
    try {
      await intelligenceAgentApi.dismiss(id, reason.trim())
      await load()
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not dismiss the recommendation.')
    } finally {
      setBusyId(null)
    }
  }

  if (loading) return <Panel title="Capture intelligence" icon={Target} testId="capture-panel"><p className="text-xs text-gray-500">Loading…</p></Panel>
  if (error) return <Panel title="Capture intelligence" icon={Target} testId="capture-panel" onRefresh={() => void load()}><p className="text-xs text-red-400">{error}</p></Panel>

  const intel = view?.intelligence ?? null

  return (
    <Panel title="Capture intelligence" icon={Target} testId="capture-panel" onRefresh={() => void load()}>
      <Note testId="advisory-note">
        Everything here is advice built from your confirmed outcomes. Nothing in your pipeline, scoring or pursuits has been
        changed, and acting on a recommendation is your decision.
      </Note>

      {!intel ? (
        <p className="text-xs text-gray-500">
          The Intelligence Agent has not analysed this firm yet. Enable it on the Agent Operations page.
        </p>
      ) : (
        <>
          {/* --- recommendations ---------------------------------------- */}
          <div className="mb-4" data-testid="capture-recommendations">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Capture focus</p>
            {recommendations.length === 0 ? (
              <p className="text-xs text-gray-500">
                No capture recommendation is active. This usually means there are not yet enough confirmed outcomes to rank a segment.
              </p>
            ) : (
              <ul className="space-y-2">
                {recommendations.map((r) => (
                  <li key={r.id} className="border border-gray-800 rounded-lg p-3 text-xs" data-testid={`recommendation-${r.id}`}>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div>
                        {r.rank !== null && <span className="text-gray-500 font-mono mr-1">#{r.rank}</span>}
                        <span className="text-gray-200 font-medium">{r.segmentLabel}</span>
                        <span className="text-gray-600"> · {r.segmentType.replace(/_/g, ' ').toLowerCase()}</span>
                      </div>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${SUFFICIENCY_TONE[r.dataSufficiency]}`}>
                        {r.scoreState === 'SCORED' ? 'SCORED' : r.scoreState.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-gray-400">{r.rationale}</p>
                    {r.scoreState !== 'SCORED' && (
                      <p className="text-[11px] text-gray-500 mt-1" data-testid={`no-score-${r.id}`}>
                        No comparable score — this segment is surfaced for exploration only.
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={() => void dismiss(r.id)}
                        disabled={busyId === r.id}
                        className="text-[11px] px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
                      >
                        {busyId === r.id ? 'Dismissing…' : 'Dismiss'}
                      </button>
                      <span className="text-[10px] text-gray-600">
                        Dismissing records your decision. It changes no pursuit, weight or measurement.
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* --- capability roadmap -------------------------------------- */}
          <div className="border-t border-gray-800 pt-2 mb-3" data-testid="capability-roadmap">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Capability roadmap</p>
            {intel.capabilityRoadmap.items.length === 0 ? (
              <p className="text-xs text-gray-500">
                No capability gap recurs often enough to report.
                {intel.capabilityRoadmap.nonRecurringGaps > 0 && ` ${intel.capabilityRoadmap.nonRecurringGaps} gap(s) were seen once.`}
              </p>
            ) : (
              <ul className="space-y-2">
                {intel.capabilityRoadmap.items.map((item) => (
                  <li key={item.gapKey} className="border border-gray-800 rounded-lg p-2 text-xs" data-testid={`roadmap-${item.gapKey}`}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-gray-300">{item.gapLabel}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${item.severity === 'CRITICAL' ? 'bg-red-950/40 border-red-800 text-red-300' : item.severity === 'MAJOR' ? 'bg-orange-950/40 border-orange-800 text-orange-300' : 'bg-blue-950/40 border-blue-800 text-blue-300'}`}>
                        {item.severity}
                      </span>
                    </div>
                    <p className="text-gray-500 mt-0.5">
                      {item.recommendation.replace(/_/g, ' ').toLowerCase()} · {item.affectedOpportunityCount} opportunity(ies),
                      {' '}{item.affectedPursuitCount} active pursuit(s)
                    </p>
                    <p className="text-gray-500">
                      Known affected value {money(item.knownAffectedValue)}
                      {item.unknownValueCount > 0 && ` · ${item.unknownValueCount} opportunity(ies) have no recorded value and are not counted as zero`}
                    </p>
                    {item.partnerNames.length > 0 && (
                      <p className="text-gray-500">Possible partner coverage: {item.partnerNames.join(', ')}</p>
                    )}
                    {item.limitations.map((l) => <p key={l} className="text-yellow-400">{l}</p>)}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* --- concentration ------------------------------------------- */}
          <div className="border-t border-gray-800 pt-2 mb-3" data-testid="portfolio-concentration">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Concentration risk</p>
            <div className="flex items-center gap-2">
              <span className={`text-[9px] px-1.5 py-0.5 rounded border ${CONCENTRATION_TONE[intel.concentration.state]}`}>
                {intel.concentration.state}
              </span>
              {intel.concentration.hhi !== null && <span className="text-[11px] font-mono text-gray-400">HHI {intel.concentration.hhi}</span>}
            </div>
            <p className="text-[11px] text-gray-500 mt-1">{intel.concentration.basis}</p>
          </div>

          {/* --- escalations ---------------------------------------------- */}
          {(view?.escalations.length ?? 0) > 0 && (
            <div className="border-t border-gray-800 pt-2" data-testid="intel-escalations">
              <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Open escalations</p>
              <ul className="space-y-2">
                {view!.escalations.map((e) => (
                  <li key={e.id} className="border border-gray-800 rounded-lg p-2 text-xs">
                    <div className="flex items-center gap-2 mb-1">
                      <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" />
                      <span className="text-gray-300">{e.title}</span>
                    </div>
                    <p className="text-gray-500">{e.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}

export { RateWithSample }
