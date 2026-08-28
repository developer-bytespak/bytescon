// =============================================================
// §6 — Per-opportunity intelligence panel.
//
// Mounted on the opportunity detail page. Six tabs:
//   Match        §6.1E/§6.1F  capability match + set-aside eligibility
//   Score        §6.2A/§6.2H  factor breakdown, calibration, interval
//   Competition  §6.2C/§6.2D  incumbent retention + competitor mapping
//   Pricing      §6.2E        price sensitivity (read-only over scenarios)
//   Gaps         §6.2F        capability gaps + partner recommendations
//   Requirements §6.3         extraction, L/M mapping, clauses, expiry
//   Timeline     §6.4         milestones, schedule, amendments
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, FileText, Info, Users } from 'lucide-react'
import { useToast } from '../Toast'
import {
  Badge, ConfidenceInterval, DimensionRow, Disclaimer, EligibilityBadge, EmptyPanel,
  ErrorPanel, ExpiryBadge, LoadingPanel, PartialDataNotice, RateWithBasis, TabBar,
  VerifiedMark, formatDate, formatMoney,
} from './Section6Ui'
import {
  discoveryApi, milestonesApi, requirementsApi, scoringApi,
  type AmendmentRevision, type ClauseObligation, type ExplainedScore, type GapAssessment,
  type LmCoverage, type OpportunityMatch, type SensitivityAnalysis, type Timeline,
} from '../../services/section6Api'
import { OpportunityCompliancePanel } from '../section7/ComplianceAgentPanels'

type TabKey = 'match' | 'score' | 'competition' | 'pricing' | 'gaps' | 'requirements' | 'timeline' | 'compliance'

const DIMENSION_LABELS: Record<string, string> = {
  capability: 'Capability overlap',
  naics: 'NAICS fit',
  psc: 'PSC fit',
  certification: 'Certification / set-aside',
  pastPerformance: 'Past-performance relevance',
  geography: 'Geography fit',
  vehicle: 'Contract vehicle fit',
  keyword: 'Keyword similarity',
}

export function OpportunityIntelPanel({ opportunityId }: { opportunityId: string }) {
  const [tab, setTab] = useState<TabKey>('match')

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 pt-3">
        <TabBar
          tabs={[
            { key: 'match', label: 'Match' },
            { key: 'score', label: 'Score' },
            { key: 'competition', label: 'Competition' },
            { key: 'pricing', label: 'Pricing' },
            { key: 'gaps', label: 'Gaps' },
            { key: 'requirements', label: 'Requirements' },
            { key: 'timeline', label: 'Timeline' },
            { key: 'compliance', label: 'Compliance' },
          ]}
          active={tab}
          onChange={(k) => setTab(k as TabKey)}
        />
      </div>
      <div className="p-4">
        {tab === 'match' && <MatchTab opportunityId={opportunityId} />}
        {tab === 'score' && <ScoreTab opportunityId={opportunityId} />}
        {tab === 'competition' && <CompetitionTab />}
        {tab === 'pricing' && <PricingTab opportunityId={opportunityId} />}
        {tab === 'gaps' && <GapsTab opportunityId={opportunityId} />}
        {tab === 'requirements' && <RequirementsTab opportunityId={opportunityId} />}
        {tab === 'timeline' && <TimelineTab opportunityId={opportunityId} />}
        {/* §7.3 — a compact Compliance Agent summary. The full matrix lives on
            its own page; this never duplicates it. */}
        {tab === 'compliance' && <OpportunityCompliancePanel opportunityId={opportunityId} />}
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// §6.1E / §6.1F
// -------------------------------------------------------------

function MatchTab({ opportunityId }: { opportunityId: string }) {
  const { toast } = useToast()
  const [match, setMatch] = useState<OpportunityMatch | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setMatch(await discoveryApi.getMatch(opportunityId))
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load the capability match.')
    } finally {
      setLoading(false)
    }
  }, [opportunityId])

  useEffect(() => { void load() }, [load])

  const refresh = async () => {
    setRefreshing(true)
    try {
      setMatch(await discoveryApi.refreshMatch(opportunityId))
      toast('Match recalculated.', 'success')
    } catch {
      toast('Could not recalculate the match.', 'error')
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) return <LoadingPanel label="Computing capability match…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (!match) return <EmptyPanel message="No match has been computed for this opportunity." />

  const dimensions = match.evidence?.dimensions ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-3xl font-bold text-gray-100 font-mono">{match.overallScore}%</div>
          <div className="text-[10px] text-gray-500 uppercase tracking-widest">Capability match</div>
          <p className="text-[10px] text-gray-600 mt-1 font-mono">
            {match.matchMethod} · calculated {formatDate(match.calculatedAt)}
          </p>
        </div>
        <div className="text-right space-y-2">
          <EligibilityBadge state={match.eligibility} reason={match.eligibilityReason} />
          <div>
            <button onClick={refresh} disabled={refreshing}
              className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors disabled:opacity-50">
              {refreshing ? 'Recalculating…' : 'Recalculate'}
            </button>
          </div>
        </div>
      </div>

      {!match.hasSufficientData && <PartialDataNotice limitations={match.dataLimitations} />}

      <div className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
        <h4 className="text-xs font-semibold text-gray-300 mb-1">Set-aside eligibility</h4>
        <p className="text-[11px] text-gray-400">{match.eligibilityReason}</p>
        {match.eligibilityEvidence?.evidence?.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {match.eligibilityEvidence.evidence.map((item, index) => (
              <li key={index} className="text-[11px] text-gray-500">
                <span className="text-gray-600 font-mono">[{item.source}]</span> {item.detail}
              </li>
            ))}
          </ul>
        )}
        {match.eligibilityEvidence?.disclaimer && (
          <div className="mt-2"><Disclaimer>{match.eligibilityEvidence.disclaimer}</Disclaimer></div>
        )}
      </div>

      {/* §7.2 — a learned pursuit-preference adjustment is never hidden. When one
          is applied the panel names it and shows the unadjusted score alongside. */}
      {match.evidence?.weightProfile === 'PURSUIT_ADJUSTED' && (
        <div className="bg-amber-950/25 border border-amber-800/60 rounded-lg p-3" data-testid="learned-adjustment-disclosure">
          <p className="text-[11px] text-amber-200/90">
            This score is ranked with a pursuit-preference weighting an administrator applied
            {typeof match.evidence.baseOverallScore === 'number'
              ? `. Under the unadjusted Section 6 weighting it scores ${match.evidence.baseOverallScore}%.`
              : '.'}
            {' '}Preference affects ranking only — it is not capability, not win probability, and not
            set-aside eligibility, which is calculated independently.
          </p>
        </div>
      )}

      <div>
        <h4 className="text-xs font-semibold text-gray-300 mb-1">How the match was scored</h4>
        <div className="bg-gray-950/60 border border-gray-800 rounded-lg px-3">
          {dimensions.map((dimension) => (
            <DimensionRow
              key={dimension.key}
              label={DIMENSION_LABELS[dimension.key] ?? dimension.key}
              score={dimension.score}
              weight={dimension.weight}
              evidence={dimension.evidence}
              absentReason={dimension.absentReason}
            />
          ))}
        </div>
      </div>

      {match.capacityWarning && (
        <div className="bg-yellow-950/25 border border-yellow-800/60 rounded-lg p-3">
          <p className="text-[11px] text-yellow-200/90">{match.capacityWarning}</p>
        </div>
      )}

      {match.missingCapabilities.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-300 mb-1">Recorded capabilities that do not align</h4>
          <div className="flex flex-wrap gap-1.5">
            {match.missingCapabilities.map((name) => <Badge key={name} tone="neutral">{name}</Badge>)}
          </div>
        </div>
      )}
    </div>
  )
}

// -------------------------------------------------------------
// §6.2A / §6.2H
// -------------------------------------------------------------

function ScoreTab({ opportunityId }: { opportunityId: string }) {
  const [score, setScore] = useState<ExplainedScore | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setScore(await scoringApi.getScore(opportunityId))
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load the score breakdown.')
    } finally {
      setLoading(false)
    }
  }, [opportunityId])

  useEffect(() => { void load() }, [load])

  if (loading) return <LoadingPanel label="Loading score breakdown…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (!score) return null

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-3xl font-bold text-gray-100 font-mono">{score.finalScore}%</div>
          <div className="text-[10px] text-gray-500 uppercase tracking-widest">Win probability</div>
          <div className="mt-1 flex items-center gap-2">
            <Badge tone={score.scoreType === 'CALIBRATED' ? 'success' : score.scoreType === 'FALLBACK' ? 'warning' : 'neutral'}>
              {score.scoreType}
            </Badge>
            <Badge tone="neutral" title="Which calibration layer was applied. They are never stacked.">
              {score.calibration.applied === 'NONE' ? 'Uncalibrated' : `${score.calibration.applied} calibration`}
            </Badge>
          </div>
        </div>
        <div className="w-full md:w-72">
          <ConfidenceInterval interval={score.interval} />
        </div>
      </div>

      <div className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
        <p className="text-xs text-gray-300 leading-relaxed">{score.explanation}</p>
      </div>

      <div className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
        <h4 className="text-xs font-semibold text-gray-300 mb-1">Calibration</h4>
        <p className="text-[11px] text-gray-500">{score.calibration.reason}</p>
        {score.calibration.tenantSampleSize !== null && (
          <p className="text-[11px] text-gray-600 mt-1 font-mono">
            n = {score.calibration.tenantSampleSize}
            {score.calibration.tenantBrier !== null && ` · Brier ${score.calibration.tenantBrier} vs baseline ${score.calibration.tenantBaselineBrier}`}
          </p>
        )}
      </div>

      <div>
        <h4 className="text-xs font-semibold text-gray-300 mb-1">Factor contributions</h4>
        <div className="bg-gray-950/60 border border-gray-800 rounded-lg px-3">
          {score.factors.map((factor) => (
            <div key={factor.key} className="py-2 border-b border-gray-800 last:border-0">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-gray-300">{factor.label}</span>
                {factor.contribution === null ? (
                  <Badge tone="neutral">{factor.direction === 'ABSENT' ? 'Input missing' : 'Not recorded'}</Badge>
                ) : (
                  <span className={`text-xs font-mono ${factor.contribution > 0 ? 'text-green-400' : factor.contribution < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                    {factor.contribution > 0 ? '+' : ''}{factor.contribution}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-gray-500 mt-0.5">{factor.explanation}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
        <h4 className="text-xs font-semibold text-gray-300 mb-1">Data quality</h4>
        <p className="text-[11px] text-gray-500">{score.dataQuality.note}</p>
        <p className="text-[10px] text-gray-600 mt-1 font-mono">
          Completeness {(score.dataQuality.completeness * 100).toFixed(0)}% · model {score.modelVersion}
        </p>
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// §6.2C / §6.2D
// -------------------------------------------------------------

function CompetitionTab() {
  const [retention, setRetention] = useState<Awaited<ReturnType<typeof scoringApi.listRetention>> | null>(null)
  const [competitors, setCompetitors] = useState<Awaited<ReturnType<typeof scoringApi.listCompetitors>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [r, c] = await Promise.all([scoringApi.listRetention(), scoringApi.listCompetitors()])
      setRetention(r)
      setCompetitors(c)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load competition evidence.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <LoadingPanel label="Loading competition evidence…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />

  const hasData = (retention?.stats.length ?? 0) > 0 || (competitors?.stats.length ?? 0) > 0
  if (!hasData) {
    return (
      <EmptyPanel
        message="No incumbent or competitor evidence yet."
        hint="Evidence is derived from award history. Enrich opportunities and refresh evidence from the scoring intelligence API."
      />
    )
  }

  return (
    <div className="space-y-5">
      {competitors && competitors.stats.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-300 mb-2 flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /> Competitors
          </h4>
          <div className="space-y-2">
            {competitors.stats.slice(0, 12).map((stat) => (
              <div key={stat.id} className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-100">{stat.competitorName}</span>
                      {stat.isIncumbent && <Badge tone="brand">Incumbent</Badge>}
                      <Badge tone="neutral">{stat.confidence}</Badge>
                    </div>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      {stat.agency ?? 'Any agency'}{stat.naicsCode ? ` · NAICS ${stat.naicsCode}` : ''}
                    </p>
                  </div>
                  <RateWithBasis
                    rate={stat.confirmedWinRate ?? stat.observedAwardShare}
                    basisLabel={stat.basisLabel}
                    sampleSize={stat.sampleSize}
                  />
                </div>
                <p className="text-[11px] text-gray-500 mt-1.5">{stat.explanation}</p>
              </div>
            ))}
          </div>
          <div className="mt-2"><Disclaimer>{competitors.note}</Disclaimer></div>
        </div>
      )}

      {retention && retention.stats.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-300 mb-2">Incumbent retention</h4>
          <div className="space-y-2">
            {retention.stats.slice(0, 12).map((stat) => (
              <div key={stat.id} className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <span className="text-xs text-gray-100">{stat.incumbentName}</span>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      {stat.agency ?? 'Any agency'}{stat.naicsCode ? ` · NAICS ${stat.naicsCode}` : ''} ·
                      {' '}retained {stat.retainedCount} / lost {stat.lostRecompeteCount}
                    </p>
                  </div>
                  <RateWithBasis rate={stat.retentionRate} basisLabel="Retention" sampleSize={stat.sampleSize} />
                </div>
                <p className="text-[11px] text-gray-500 mt-1.5">{stat.explanation}</p>
              </div>
            ))}
          </div>
          <div className="mt-2"><Disclaimer>{retention.note}</Disclaimer></div>
        </div>
      )}
    </div>
  )
}

// -------------------------------------------------------------
// §6.2E
// -------------------------------------------------------------

const PERCENT_STEPS = [-15, -10, -5, 5, 10, 15]

function PricingTab({ opportunityId }: { opportunityId: string }) {
  const { toast } = useToast()
  const [analysis, setAnalysis] = useState<SensitivityAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setAnalysis(await scoringApi.getSensitivity(opportunityId))
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load pricing sensitivity.')
    } finally {
      setLoading(false)
    }
  }, [opportunityId])

  useEffect(() => { void load() }, [load])

  const run = async () => {
    setRunning(true)
    try {
      setAnalysis(await scoringApi.runSensitivity(opportunityId, { percentAdjustments: PERCENT_STEPS }))
      toast('Sensitivity analysis complete. Approved pricing was not modified.', 'success')
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } }
      toast(e?.response?.data?.error || 'Could not run the analysis.', 'error')
    } finally {
      setRunning(false)
    }
  }

  if (loading) return <LoadingPanel label="Loading pricing sensitivity…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-gray-500">
          Reads your pricing scenarios and models how price position affects win probability. It never writes back to approved pricing.
        </p>
        <button onClick={run} disabled={running}
          className="text-xs px-3 py-1.5 rounded text-gray-950 font-medium disabled:opacity-50"
          style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}>
          {running ? 'Running…' : 'Run analysis'}
        </button>
      </div>

      {!analysis ? (
        <EmptyPanel message="No sensitivity analysis has been run for this opportunity." hint="Run one to compare your scenarios and percentage adjustments." />
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={analysis.validity === 'CALIBRATED' ? 'success' : 'warning'}>{analysis.validity}</Badge>
            <Badge tone="neutral">{analysis.isMonotonic ? 'Monotonic' : 'NOT monotonic'}</Badge>
            {analysis.benchmarkSource && (
              <Badge tone="neutral">Benchmark: {analysis.benchmarkSource.replace(/_/g, ' ')} {formatMoney(analysis.benchmarkValue)}</Badge>
            )}
          </div>

          {analysis.points.length === 0 ? (
            <EmptyPanel message="No pricing scenarios exist for this opportunity." hint="Create scenarios in the Pricing Workspace first." />
          ) : (
            <div className="overflow-x-auto border border-gray-800 rounded-lg">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-950/60 text-gray-500">
                    <th className="text-left px-3 py-2 font-medium">Scenario</th>
                    <th className="text-right px-3 py-2 font-medium">Price</th>
                    <th className="text-right px-3 py-2 font-medium">% of benchmark</th>
                    <th className="text-right px-3 py-2 font-medium">Modelled win prob.</th>
                    <th className="text-right px-3 py-2 font-medium">Range</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.points.map((point) => (
                    <tr key={`${point.label}-${point.price}`} className={`border-t border-gray-800 ${point.isBase ? 'bg-amber-950/10' : ''}`}>
                      <td className="px-3 py-2 text-gray-200">
                        {point.label} {point.isBase && <Badge tone="brand">Base</Badge>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-200">{formatMoney(point.price)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{point.percentOfBenchmark.toFixed(1)}%</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-300">{(point.probability * 100).toFixed(1)}%</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-500">
                        {point.lower === null ? '—' : `${(point.lower * 100).toFixed(0)}–${((point.upper ?? 0) * 100).toFixed(0)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
            <h4 className="text-xs font-semibold text-gray-300 mb-1">Assumptions</h4>
            <ul className="space-y-1">
              {analysis.assumptions.map((assumption, index) => (
                <li key={index} className="text-[11px] text-gray-500">• {assumption}</li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

// -------------------------------------------------------------
// §6.2F
// -------------------------------------------------------------

function GapsTab({ opportunityId }: { opportunityId: string }) {
  const { toast } = useToast()
  const [gaps, setGaps] = useState<GapAssessment | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setGaps(await scoringApi.getGaps(opportunityId))
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load gap analysis.')
    } finally {
      setLoading(false)
    }
  }, [opportunityId])

  useEffect(() => { void load() }, [load])

  const refresh = async () => {
    setRefreshing(true)
    try {
      setGaps(await scoringApi.refreshGaps(opportunityId))
      toast('Gap analysis refreshed.', 'success')
    } catch {
      toast('Could not refresh the gap analysis.', 'error')
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) return <LoadingPanel label="Analysing capability gaps…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (!gaps) return <EmptyPanel message="No gap analysis available." />

  const groups: Array<[string, string[], 'success' | 'warning' | 'danger' | 'neutral']> = [
    ['Confirmed coverage', gaps.confirmedCoverage, 'success'],
    ['Partial coverage (unverified)', gaps.partialCoverage, 'warning'],
    ['Missing capabilities', gaps.missingCapabilities, 'danger'],
    ['Missing certifications', gaps.missingCertifications, 'danger'],
    ['Capacity gaps', gaps.capacityGaps, 'warning'],
    ['Geography gaps', gaps.geographyGaps, 'warning'],
    ['Contract vehicle gaps', gaps.vehicleGaps, 'warning'],
  ]

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={refresh} disabled={refreshing}
          className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors disabled:opacity-50">
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {groups.filter(([, items]) => items.length > 0).map(([title, items, tone]) => (
          <div key={title} className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
            <h4 className="text-xs font-semibold text-gray-300 mb-1.5">{title}</h4>
            <div className="flex flex-wrap gap-1.5">
              {items.map((item, index) => <Badge key={index} tone={tone}>{item}</Badge>)}
            </div>
          </div>
        ))}
      </div>

      {gaps.missingEligibility.length > 0 && (
        <div className="bg-red-950/25 border border-red-800/60 rounded-lg p-3">
          <h4 className="text-xs font-semibold text-red-300 mb-1">Eligibility</h4>
          {gaps.missingEligibility.map((item, index) => (
            <p key={index} className="text-[11px] text-red-200/90">{item}</p>
          ))}
        </div>
      )}

      <div>
        <h4 className="text-xs font-semibold text-gray-300 mb-2">Partner recommendations</h4>
        {gaps.partnerRecommendations.length === 0 ? (
          <p className="text-[11px] text-gray-600">No partner in your records closes an open gap on this opportunity.</p>
        ) : (
          <div className="space-y-2">
            {gaps.partnerRecommendations.map((partner) => (
              <div key={partner.partnerId} className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-xs text-gray-100">{partner.partnerName}</span>
                  <Badge tone={partner.gapCloseScore >= 60 ? 'success' : 'warning'}>Closes {partner.gapCloseScore}% of gaps</Badge>
                </div>
                <p className="text-[11px] text-gray-500 mt-1">{partner.why}</p>
                {partner.remainingGaps.length > 0 && (
                  <p className="text-[11px] text-gray-600 mt-1">
                    Remaining: {partner.remainingGaps.join('; ')}
                  </p>
                )}
                {partner.worksharConsiderations.map((note, index) => (
                  <p key={index} className="text-[11px] text-yellow-200/70 mt-1">⚠ {note}</p>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <PartialDataNotice limitations={gaps.limitations} />
    </div>
  )
}

// -------------------------------------------------------------
// §6.3
// -------------------------------------------------------------

function RequirementsTab({ opportunityId }: { opportunityId: string }) {
  const { toast } = useToast()
  const [lm, setLm] = useState<LmCoverage | null>(null)
  const [clauses, setClauses] = useState<{ clauses: ClauseObligation[]; disclaimer: string } | null>(null)
  const [expiry, setExpiry] = useState<Awaited<ReturnType<typeof requirementsApi.getExpiry>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [extracting, setExtracting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [l, c, e] = await Promise.all([
        requirementsApi.getLm(opportunityId),
        requirementsApi.listClauses(opportunityId),
        requirementsApi.getExpiry(opportunityId),
      ])
      setLm(l)
      setClauses(c)
      setExpiry(e)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load requirement intelligence.')
    } finally {
      setLoading(false)
    }
  }, [opportunityId])

  useEffect(() => { void load() }, [load])

  const extract = async () => {
    setExtracting(true)
    try {
      const result = await requirementsApi.runExtraction(opportunityId)
      toast(
        result.status === 'FAILED'
          ? `Extraction failed: ${result.error ?? 'unknown error'}`
          : `Extraction ${result.status.toLowerCase()} — ${result.requirementsCreated} new requirement(s).`,
        result.status === 'FAILED' ? 'error' : 'success',
      )
      await load()
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } }
      toast(e?.response?.data?.error || 'Could not run extraction.', 'error')
    } finally {
      setExtracting(false)
    }
  }

  const decide = async (mappingId: string, decision: 'CONFIRM' | 'REJECT') => {
    try {
      await requirementsApi.decideMapping(mappingId, { decision })
      await load()
    } catch {
      toast('Could not record that decision.', 'error')
    }
  }

  if (loading) return <LoadingPanel label="Loading requirement intelligence…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-gray-500">
          Deterministic parsing runs first. Extracted requirements are never auto-verified, and verified records are never overwritten.
        </p>
        <button onClick={extract} disabled={extracting}
          className="text-xs px-3 py-1.5 rounded text-gray-950 font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
          style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}>
          <FileText className="w-3 h-3" />
          {extracting ? 'Extracting…' : 'Run extraction'}
        </button>
      </div>

      <div>
        <h4 className="text-xs font-semibold text-gray-300 mb-2">Section L ↔ Section M</h4>
        {!lm || (lm.instructions.length === 0 && lm.evaluations.length === 0) ? (
          <EmptyPanel message="No Section L or M requirements extracted yet." hint="Run extraction on the solicitation document." />
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center">
              <MiniStat label="Instructions" value={lm.instructions.length} />
              <MiniStat label="Evaluation factors" value={lm.evaluations.length} />
              <MiniStat label="Unmapped L" value={lm.unmappedInstructions.length} />
              <MiniStat label="Unmapped M" value={lm.unmappedEvaluations.length} />
            </div>

            {lm.gaps.length > 0 && (
              <div className="bg-yellow-950/25 border border-yellow-800/60 rounded-lg p-3">
                {lm.gaps.map((gap, index) => <p key={index} className="text-[11px] text-yellow-200/90">• {gap}</p>)}
              </div>
            )}

            {lm.mappings.length > 0 && (
              <div className="space-y-1.5">
                {lm.mappings.slice(0, 15).map((mapping) => (
                  <div key={mapping.id} className="bg-gray-950/60 border border-gray-800 rounded-lg p-2.5">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-xs text-gray-200 font-mono">
                        {mapping.instructionSourceSection} → {mapping.evaluationSourceSection ?? '?'}
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge tone="neutral">{(mapping.confidence * 100).toFixed(0)}%</Badge>
                        <Badge tone={mapping.verification === 'CONFIRMED' ? 'success' : mapping.verification === 'REJECTED' ? 'neutral' : 'warning'}>
                          {mapping.verification}
                        </Badge>
                      </span>
                    </div>
                    {mapping.relationshipExplanation && (
                      <p className="text-[11px] text-gray-500 mt-1">{mapping.relationshipExplanation}</p>
                    )}
                    {mapping.verification === 'UNVERIFIED' && (
                      <div className="flex gap-2 mt-2">
                        <button onClick={() => decide(mapping.id, 'CONFIRM')}
                          className="text-[11px] px-2.5 py-1 rounded bg-green-900/40 hover:bg-green-900/60 text-green-300 border border-green-700 transition-colors">
                          Confirm
                        </button>
                        <button onClick={() => decide(mapping.id, 'REJECT')}
                          className="text-[11px] px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors">
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <h4 className="text-xs font-semibold text-gray-300 mb-2">FAR / DFARS clause obligations</h4>
        {!clauses || clauses.clauses.length === 0 ? (
          <p className="text-[11px] text-gray-600">No clauses have been extracted from this solicitation yet.</p>
        ) : (
          <div className="space-y-1.5">
            {clauses.clauses.map((clause) => (
              <div key={clause.id} className="bg-gray-950/60 border border-gray-800 rounded-lg p-2.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs text-gray-100 font-mono">{clause.clauseNumber}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone={
                      clause.flowDownStatus === 'EXPLICIT_FLOWDOWN' ? 'danger'
                        : clause.flowDownStatus === 'CONDITIONAL_FLOWDOWN' ? 'warning'
                        : clause.flowDownStatus === 'REVIEW_REQUIRED' ? 'warning' : 'neutral'
                    }>
                      {clause.flowDownStatus.replace(/_/g, ' ')}
                    </Badge>
                    <VerifiedMark verified={clause.isManuallyVerified} />
                  </span>
                </div>
                {clause.clauseTitle && <p className="text-[11px] text-gray-400 mt-0.5">{clause.clauseTitle}</p>}
                {clause.flowDownCondition && <p className="text-[11px] text-gray-500 mt-1">Condition: {clause.flowDownCondition}</p>}
              </div>
            ))}
            <Disclaimer>{clauses.disclaimer}</Disclaimer>
          </div>
        )}
      </div>

      <div>
        <h4 className="text-xs font-semibold text-gray-300 mb-2">Document expiry vs period of performance</h4>
        {!expiry || expiry.items.length === 0 ? (
          <p className="text-[11px] text-gray-600">No certifications, insurance policies or library documents to check.</p>
        ) : (
          <div className="space-y-1.5">
            {expiry.items.filter((item) => item.state !== 'VALID').slice(0, 20).map((item) => (
              <div key={`${item.kind}-${item.id}`} className="bg-gray-950/60 border border-gray-800 rounded-lg p-2.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs text-gray-100">{item.name}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone="neutral">{item.kind}</Badge>
                    <ExpiryBadge state={item.state} label={item.label} message={item.message} />
                  </span>
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5">{item.message}</p>
              </div>
            ))}
            {expiry.items.every((item) => item.state === 'VALID') && (
              <p className="text-[11px] text-green-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-3 h-3" /> Every recorded document covers the performance period.
              </p>
            )}
            <Disclaimer>{expiry.note}</Disclaimer>
          </div>
        )}
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// §6.4
// -------------------------------------------------------------

function TimelineTab({ opportunityId }: { opportunityId: string }) {
  const { toast } = useToast()
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [amendments, setAmendments] = useState<{ revisions: AmendmentRevision[]; note: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [t, a] = await Promise.all([
        milestonesApi.getTimeline(opportunityId),
        milestonesApi.listAmendments(opportunityId),
      ])
      setTimeline(t)
      setAmendments(a)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load the timeline.')
    } finally {
      setLoading(false)
    }
  }, [opportunityId])

  useEffect(() => { void load() }, [load])

  const generate = async (preview: boolean) => {
    setGenerating(true)
    try {
      const result = await milestonesApi.generateSchedule(opportunityId, { preview })
      if (!result.isFeasible) {
        toast(result.infeasibilityReason ?? 'This schedule does not fit before the deadline.', 'warning')
      } else {
        toast(
          preview
            ? `Preview: ${result.phases.length} phases, ${result.overdueCount} already overdue.`
            : `Schedule v${result.versionNo} applied — ${result.milestonesCreated} created, ${result.lockedPreserved} locked milestone(s) preserved.`,
          'success',
        )
      }
      if (!preview) await load()
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } }
      toast(e?.response?.data?.error || 'Could not generate the schedule.', 'error')
    } finally {
      setGenerating(false)
    }
  }

  const acknowledge = async (revisionId: string) => {
    try {
      await milestonesApi.acknowledgeRevision(revisionId)
      toast('Amendment acknowledged.', 'success')
      await load()
    } catch {
      toast('Could not acknowledge the amendment.', 'error')
    }
  }

  if (loading) return <LoadingPanel label="Loading timeline…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />

  const buckets: Array<[string, typeof timeline extends null ? never : NonNullable<Timeline>['items']]> = timeline
    ? [
        ['Overdue', timeline.buckets.overdue],
        ['At risk', timeline.buckets.atRisk],
        ['Upcoming', timeline.buckets.upcoming],
        ['Changed by amendment', timeline.buckets.amendmentChanged],
        ['Unscheduled', timeline.buckets.unscheduled],
        ['Completed', timeline.buckets.completed],
      ]
    : []

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-gray-500">
          One timeline per opportunity, assembled from the records that already own each date. Locked and completed
          milestones are never moved by regeneration.
        </p>
        <div className="flex gap-2">
          <button onClick={() => generate(true)} disabled={generating}
            className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors disabled:opacity-50">
            Preview schedule
          </button>
          <button onClick={() => generate(false)} disabled={generating}
            className="text-xs px-3 py-1.5 rounded text-gray-950 font-medium disabled:opacity-50"
            style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}>
            {generating ? 'Working…' : 'Generate schedule'}
          </button>
        </div>
      </div>

      {!timeline || timeline.items.length === 0 ? (
        <EmptyPanel message="No milestones yet." hint="Generate a working-backward schedule, or run extraction to pull dates out of the solicitation." />
      ) : (
        <div className="space-y-4">
          {buckets.filter(([, items]) => items.length > 0).map(([title, items]) => (
            <div key={title}>
              <h4 className="text-xs font-semibold text-gray-300 mb-1.5 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> {title}
                <span className="text-[10px] text-gray-600 font-mono">{items.length}</span>
              </h4>
              <div className="space-y-1.5">
                {items.map((item) => (
                  <div key={item.id} className="bg-gray-950/60 border border-gray-800 rounded-lg p-2.5">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-xs text-gray-100">{item.title}</span>
                      <span className="flex items-center gap-2">
                        {item.isLocked && <Badge tone="info" title={item.lockReason ?? undefined}>Locked</Badge>}
                        {item.isMandatory && <Badge tone="neutral">Mandatory</Badge>}
                        <Badge tone={item.derived.isOverdue ? 'danger' : item.derived.isAtRisk ? 'warning' : 'neutral'}>
                          {formatDate(item.endAt)}
                        </Badge>
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-600 mt-0.5 font-mono">
                      {item.milestoneType.replace(/_/g, ' ')} · from {item.origin.toLowerCase()}
                      {item.derived.daysRemaining !== null && ` · ${item.derived.daysRemaining}d`}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <h4 className="text-xs font-semibold text-gray-300 mb-2">Amendments</h4>
        {!amendments || amendments.revisions.length === 0 ? (
          <p className="text-[11px] text-gray-600">No amendment revisions recorded for this opportunity.</p>
        ) : (
          <div className="space-y-2">
            {amendments.revisions.map((revision) => (
              <div key={revision.id} className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs text-gray-100">
                    Revision {revision.revisionNo}{revision.amendmentNumber ? ` · ${revision.amendmentNumber}` : ''}
                  </span>
                  <span className="flex items-center gap-2">
                    {revision.humanReviewRequired && !revision.acknowledgedAt && <Badge tone="warning">Needs review</Badge>}
                    {revision.acknowledgedAt && <Badge tone="success">Acknowledged</Badge>}
                  </span>
                </div>
                {revision.diffSummary?.summary && (
                  <p className="text-[11px] text-gray-500 mt-1">{revision.diffSummary.summary}</p>
                )}
                {revision.impacts.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {revision.impacts.map((impact) => (
                      <div key={impact.id} className="flex items-start gap-1.5">
                        <AlertTriangle className="w-3 h-3 text-yellow-400 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="text-[11px] text-gray-300">
                            <span className="font-mono text-gray-500">[{impact.area.replace(/_/g, ' ')}]</span> {impact.impact}
                          </p>
                          {impact.recommendedAction && <p className="text-[11px] text-gray-600">{impact.recommendedAction}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {!revision.acknowledgedAt && (
                  <button onClick={() => acknowledge(revision.id)}
                    className="mt-2 text-[11px] px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors">
                    Acknowledge
                  </button>
                )}
              </div>
            ))}
            <Disclaimer>{amendments.note}</Disclaimer>
          </div>
        )}
      </div>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-gray-950/60 border border-gray-800 rounded-lg p-2">
      <div className="text-sm font-bold text-gray-100 font-mono">{value}</div>
      <div className="text-[10px] text-gray-500">{label}</div>
    </div>
  )
}

export default OpportunityIntelPanel
export { Info }
