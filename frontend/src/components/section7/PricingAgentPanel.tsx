// =============================================================
// §7.6 — Pricing Agent / competitive benchmark panel.
//
// Renders the backend's PRICING_ASSESSMENT. Nothing here recalculates a total,
// a percentile, or a range verdict.
//
// THE RULES THIS UI ENFORCES
//   · Insufficient data is shown PROMINENTLY and never as an empty position on
//     a scale. No percentile is drawn when the backend returned null.
//   · A relaxed cohort filter is named, not hidden.
//   · The cohort's public composition is inspectable, award by award.
//   · Below/above the historical range is presented as position, not verdict.
//   · Multiple scenarios are shown side by side; none is recommended.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Bot, ChevronDown, ChevronRight, Gauge, RefreshCw, Scale } from 'lucide-react'
import {
  Badge, Disclaimer, EmptyPanel, ErrorPanel, LoadingPanel, PartialDataNotice, formatDate,
} from '../section6/Section6Ui'
import {
  pricingAgentApi,
  type CohortComposition,
  type PricingAgentView,
  type RangeState,
  type ScenarioAssessment,
} from '../../services/pricingAgentApi'

const RANGE_TONE: Record<RangeState, 'success' | 'warning' | 'danger' | 'neutral'> = {
  WITHIN_HISTORICAL_RANGE: 'success',
  BELOW_HISTORICAL_RANGE: 'warning',
  ABOVE_HISTORICAL_RANGE: 'warning',
  EXTREME_OUTLIER: 'danger',
  INSUFFICIENT_DATA: 'neutral',
}

const RANGE_LABEL: Record<RangeState, string> = {
  WITHIN_HISTORICAL_RANGE: 'WITHIN HISTORICAL RANGE',
  BELOW_HISTORICAL_RANGE: 'BELOW HISTORICAL RANGE',
  ABOVE_HISTORICAL_RANGE: 'ABOVE HISTORICAL RANGE',
  EXTREME_OUTLIER: 'EXTREME OUTLIER',
  INSUFFICIENT_DATA: 'INSUFFICIENT DATA',
}

const money = (v: string | null) => (v === null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)

export function PricingAgentPanel({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<PricingAgentView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await pricingAgentApi.assessment(workspaceId))
    } catch (err) {
      setError(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Could not load the Pricing Agent status.',
      )
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { void load() }, [load])

  if (loading) return <LoadingPanel label="Loading Pricing Agent status…" />
  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!data) return <EmptyPanel message="No Pricing Agent data." />

  const { assessment, schedule, lastRun, escalations, policy } = data

  return (
    <div className="space-y-4" data-testid="pricing-agent-panel">
      {/* --- status ------------------------------------------------------ */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-gray-400" />
            <div>
              <h3 className="text-sm font-medium text-gray-200">Pricing Agent</h3>
              <p className="text-xs text-gray-500">
                Deterministic. No AI inference, no tokens, no cost. It benchmarks and warns; it never changes a price.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="success">IMPLEMENTED</Badge>
            {schedule?.isEnabled ? <Badge tone="success">ENABLED</Badge> : <Badge tone="neutral">DISABLED</Badge>}
            <button
              onClick={() => void load()}
              className="text-gray-500 hover:text-gray-300 transition-colors"
              aria-label="Refresh Pricing Agent status"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          <div>
            <dt className="text-gray-500">Last run</dt>
            <dd className="text-gray-300" data-testid="pricing-last-run">
              {lastRun ? `${lastRun.status} · ${formatDate(lastRun.createdAt)}` : 'Never run'}
            </dd>
          </div>
          <div><dt className="text-gray-500">Last success</dt><dd className="text-gray-300">{formatDate(schedule?.lastSuccessfulRunAt ?? null)}</dd></div>
          <div><dt className="text-gray-500">Next run</dt><dd className="text-gray-300">{schedule?.isEnabled ? formatDate(schedule.nextRunAt) : '—'}</dd></div>
          <div><dt className="text-gray-500">Autonomy</dt><dd className="text-gray-300 font-mono">{schedule?.autonomyLevel ?? 'PROPOSE'}</dd></div>
        </dl>
        {lastRun && (
          <p className="mt-3 text-[11px] text-gray-500">
            Run <Link to={`/agents/runs/${lastRun.id}`} className="text-blue-400 hover:underline">{lastRun.id.slice(0, 8)}</Link>
            {' · '}{lastRun.tokenInput + lastRun.tokenOutput} tokens · ${Number(lastRun.estimatedCostUsd).toFixed(2)}
          </p>
        )}
        {schedule?.lastFailureMessage && (
          <p className="mt-2 text-[11px] text-red-400" data-testid="pricing-last-failure">{schedule.lastFailureMessage}</p>
        )}
      </div>

      {!assessment ? (
        <EmptyPanel
          message="The Pricing Agent has not assessed this workspace yet."
          hint="Enable it on the Agent Operations page, or trigger a run there."
        />
      ) : (
        <>
          {assessment.preferredScenarioState === 'NO_PREFERRED_SCENARIO' && assessment.scenarios.length > 1 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-xs text-gray-400" data-testid="pricing-no-preferred">
              No preferred scenario has been selected. Every scenario below was assessed; the agent selected none.
            </div>
          )}

          {assessment.scenarios.map((scenario) => (
            <ScenarioCard key={scenario.scenarioId} scenario={scenario} minimumCohortSize={policy.minimumCohortSize} />
          ))}

          {/* --- sensitivity ---------------------------------------------- */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs" data-testid="pricing-sensitivity">
            <div className="flex items-center gap-2 mb-2">
              <Gauge className="w-4 h-4 text-gray-400" />
              <h3 className="text-sm font-medium text-gray-200">Price sensitivity</h3>
              <Badge tone={assessment.sensitivity.probabilityMode === 'CALIBRATED' ? 'success' : 'neutral'}>
                {assessment.sensitivity.probabilityMode}
              </Badge>
              <Badge tone="neutral">{assessment.sensitivity.status}</Badge>
            </div>
            {assessment.sensitivity.points.length === 0 ? (
              <p className="text-gray-500">No sensitivity curve is available for this workspace.</p>
            ) : (
              <ul className="space-y-0.5">
                {assessment.sensitivity.points.map((p) => (
                  <li key={`${p.label}-${p.price}`} className="flex items-center justify-between gap-2">
                    <span className="text-gray-400">{p.label}</span>
                    <span className="text-gray-300 font-mono">
                      {money(p.price)} · {(p.probability * 100).toFixed(1)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {assessment.sensitivity.limitations.map((l) => (
              <p key={l} className="text-yellow-400 mt-1">{l}</p>
            ))}
          </div>

          {/* --- amendment impact ------------------------------------------ */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs" data-testid="pricing-amendment">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm font-medium text-gray-200">Amendment pricing impact</h3>
              <Badge tone={assessment.amendmentImpact.reviewRequired ? 'warning' : 'neutral'}>
                {assessment.amendmentImpact.status}
              </Badge>
            </div>
            {assessment.amendmentImpact.evidence.map((e) => (
              <p key={e} className="text-gray-500">{e}</p>
            ))}
          </div>

          {assessment.recommendedHumanActions.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs" data-testid="pricing-actions">
              <h3 className="text-sm font-medium text-gray-200 mb-1">Recommended human actions</h3>
              <ul className="list-disc list-inside space-y-0.5 text-gray-400">
                {assessment.recommendedHumanActions.map((a) => <li key={a}>{a}</li>)}
              </ul>
            </div>
          )}

          {assessment.dataLimitations.length > 0 && <PartialDataNotice limitations={assessment.dataLimitations} />}
        </>
      )}

      {escalations.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="pricing-escalations">
          <h3 className="text-sm font-medium text-gray-200 mb-2">Open escalations ({escalations.length})</h3>
          <ul className="space-y-2">
            {escalations.map((e) => (
              <li key={e.id} className="border border-gray-800 rounded-lg p-2 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-gray-200">{e.title}</span>
                  <Badge tone={e.severity === 'CRITICAL' || e.severity === 'HIGH' ? 'danger' : 'warning'}>{e.severity}</Badge>
                </div>
                <p className="text-gray-500 mt-1">{e.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Disclaimer>
        The Pricing Agent benchmarks against public federal awards and warns. It never changes a labour rate, hours, an
        indirect rate, an ODC or subcontract amount, or a fee; it never selects the preferred scenario; and it never
        approves a pricing review. Historical position is not a verdict on whether a price is right.
      </Disclaimer>

      <ul className="text-[11px] text-gray-600 list-disc list-inside space-y-0.5">
        {policy.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </div>
  )
}

function ScenarioCard({ scenario, minimumCohortSize }: { scenario: ScenarioAssessment; minimumCohortSize: number }) {
  const [showCohort, setShowCohort] = useState(false)
  const [cohort, setCohort] = useState<CohortComposition | null>(null)
  const [cohortError, setCohortError] = useState<string | null>(null)
  const insufficient = scenario.benchmark.rangeState === 'INSUFFICIENT_DATA'

  const toggleCohort = async () => {
    const next = !showCohort
    setShowCohort(next)
    if (next && !cohort && scenario.benchmark.cohortId) {
      try {
        setCohort(await pricingAgentApi.cohort(scenario.benchmark.cohortId))
      } catch (err) {
        setCohortError(
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load the cohort.',
        )
      }
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid={`pricing-scenario-${scenario.scenarioId}`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <Scale className="w-4 h-4 text-gray-400" />
          <h3 className="text-sm font-medium text-gray-200">{scenario.name}</h3>
          {scenario.isPreferred && <Badge tone="info">PREFERRED</Badge>}
        </div>
        <Badge tone={RANGE_TONE[scenario.benchmark.rangeState]}>{RANGE_LABEL[scenario.benchmark.rangeState]}</Badge>
      </div>

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
        <Stat label="Direct labour" value={money(scenario.totals.directLabor)} />
        <Stat label="Fringe" value={money(scenario.totals.fringe)} />
        <Stat label="Overhead" value={money(scenario.totals.overhead)} />
        <Stat label="G&A" value={money(scenario.totals.ga)} />
        <Stat label="ODC" value={money(scenario.totals.odc)} />
        <Stat label="Subcontractor" value={money(scenario.totals.subcontractor)} />
        <Stat label="Fee" value={money(scenario.totals.fee)} />
        <Stat label="Total proposed price" value={money(scenario.totals.totalProposedPrice)} testId={`total-${scenario.scenarioId}`} />
      </dl>

      {scenario.rateStructure.state === 'INCOMPLETE_RATE_STRUCTURE' && (
        <div className="bg-orange-950/40 border border-orange-800 rounded-lg p-2 text-xs text-orange-300 mb-3" data-testid={`rate-structure-${scenario.scenarioId}`}>
          <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />
          INCOMPLETE RATE STRUCTURE
          <ul className="list-disc list-inside mt-1">
            {scenario.rateStructure.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}

      {scenario.rateDrift.length > 0 && (
        <div className="bg-yellow-950/30 border border-yellow-800 rounded-lg p-2 text-xs text-yellow-200 mb-3" data-testid={`rate-drift-${scenario.scenarioId}`}>
          RATE_REVIEW_REQUIRED
          <ul className="list-disc list-inside mt-1">
            {scenario.rateDrift.map((d) => (
              <li key={d.rateType}>
                {d.rateType}: scenario {d.scenarioPercent}% · template "{d.templateName}" {d.templatePercent}%. {d.note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* --- benchmark ------------------------------------------------- */}
      <div className="border border-gray-800 rounded-lg p-3 text-xs" data-testid={`benchmark-${scenario.scenarioId}`}>
        {insufficient ? (
          // Prominent, and with no scale to imply a position on.
          <div className="bg-gray-800/60 border border-gray-700 rounded p-3" data-testid={`insufficient-${scenario.scenarioId}`}>
            <p className="text-sm font-semibold text-gray-200 tracking-wide">INSUFFICIENT DATA</p>
            <p className="text-gray-400 mt-1">{scenario.benchmark.summary}</p>
            <p className="text-gray-500 mt-1">
              {scenario.benchmark.cohortSize} comparable public award(s) were available against a minimum of {minimumCohortSize}.
            </p>
          </div>
        ) : (
          <>
            <p className="text-gray-300" data-testid={`range-summary-${scenario.scenarioId}`}>{scenario.benchmark.summary}</p>
            <dl className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-2">
              <Stat label="Cohort size" value={String(scenario.benchmark.cohortSize)} />
              <Stat label="p25" value={money(scenario.benchmark.p25)} />
              <Stat label="Median" value={money(scenario.benchmark.median)} />
              <Stat label="p75" value={money(scenario.benchmark.p75)} />
              <Stat
                label="Price percentile"
                testId={`percentile-${scenario.scenarioId}`}
                value={scenario.benchmark.proposedPricePercentile === null ? '—' : `${scenario.benchmark.proposedPricePercentile}%`}
              />
            </dl>
          </>
        )}

        <p className="text-gray-500 mt-2">
          Filter level {scenario.benchmark.filterLevel} · lookback {formatDate(scenario.benchmark.periodStart)} to{' '}
          {formatDate(scenario.benchmark.periodEnd)} · {scenario.benchmark.sourceIds.length} public source(s)
        </p>

        {scenario.benchmark.relaxedFilters.length > 0 && (
          <p className="text-yellow-400 mt-1" data-testid={`relaxed-${scenario.scenarioId}`}>
            Filters relaxed to find comparable awards: {scenario.benchmark.relaxedFilters.join(', ')}.
          </p>
        )}

        {scenario.benchmark.limitations.map((l) => (
          <p key={l} className="text-gray-500 mt-1">{l}</p>
        ))}

        {scenario.benchmark.cohortId && (
          <button
            onClick={() => void toggleCohort()}
            data-testid={`cohort-toggle-${scenario.scenarioId}`}
            className="mt-2 flex items-center gap-1 text-gray-400 hover:text-gray-200 transition-colors"
          >
            {showCohort ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            Inspect the public awards in this cohort
          </button>
        )}

        {showCohort && (
          <div className="mt-2" data-testid={`cohort-list-${scenario.scenarioId}`}>
            {cohortError && <p className="text-red-400">{cohortError}</p>}
            {cohort && (
              <>
                <p className="text-gray-500 mb-1">{cohort.provenance.note}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-gray-500 text-left">
                        <th className="pr-2">Award</th>
                        <th className="pr-2">Agency</th>
                        <th className="pr-2">NAICS</th>
                        <th className="pr-2">Date</th>
                        <th className="pr-2 text-right">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cohort.cohort.distributionData.map((a) => (
                        <tr key={a.awardId} className="text-gray-400">
                          <td className="pr-2 font-mono">{a.contractNumber ?? a.awardId.slice(0, 8)}</td>
                          <td className="pr-2">{a.agency}</td>
                          <td className="pr-2 font-mono">{a.naics ?? '—'}</td>
                          <td className="pr-2">{formatDate(a.awardDate)}</td>
                          <td className="pr-2 text-right font-mono">{money(a.awardAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {cohort.cohort.exclusionReasons.length > 0 && (
                  <div className="mt-2" data-testid={`cohort-excluded-${scenario.scenarioId}`}>
                    <p className="text-gray-500">Excluded from the cohort:</p>
                    <ul className="list-disc list-inside text-gray-600">
                      {cohort.cohort.exclusionReasons.map((e) => <li key={e.awardId}>{e.reason}</li>)}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <p className="text-gray-500 text-xs mt-2" data-testid={`template-${scenario.scenarioId}`}>
        Rate template: {scenario.templateStatus.state}
        {scenario.templateStatus.staleItems.length > 0 ? ` — ${scenario.templateStatus.staleItems.join('; ')}` : ''}
      </p>
    </div>
  )
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-300 font-mono" data-testid={testId}>{value}</dd>
    </div>
  )
}
