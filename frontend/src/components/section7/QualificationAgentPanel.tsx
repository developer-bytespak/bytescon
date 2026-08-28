// =============================================================
// §7.4 — Qualification Agent panel for /pipeline/:pursuitId.
//
// Renders the backend's QUALIFICATION_BRIEF. Nothing here scores, calibrates,
// derives an interval, or decides what is borderline.
//
// THE ONE RULE THIS UI ENFORCES
// An agent recommendation is never labelled a decision. The header says "Agent
// recommendation — human decision required" until a person has actually
// recorded one, and when they have, the two are shown side by side:
//   Agent recommended: BID   Human decided: NO_BID   Rationale: …
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Bot, Gavel, RefreshCw, Scale } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useToast } from '../Toast'
import {
  Badge, Disclaimer, EmptyPanel, ErrorPanel, LoadingPanel, PartialDataNotice, formatDate,
} from '../section6/Section6Ui'
import {
  qualificationAgentApi,
  type FinalDecision,
  type QualificationAgentView,
  type RecommendationResult,
} from '../../services/qualificationAgentApi'

const RESULT_TONE: Record<RecommendationResult, 'success' | 'danger' | 'warning' | 'neutral'> = {
  RECOMMEND_BID: 'success',
  RECOMMEND_NO_BID: 'danger',
  BORDERLINE_REVIEW: 'warning',
  INSUFFICIENT_DATA: 'neutral',
}

const RESULT_LABEL: Record<RecommendationResult, string> = {
  RECOMMEND_BID: 'RECOMMENDS BID',
  RECOMMEND_NO_BID: 'RECOMMENDS NO-BID',
  BORDERLINE_REVIEW: 'BORDERLINE — HUMAN REVIEW REQUIRED',
  INSUFFICIENT_DATA: 'INSUFFICIENT DATA',
}

const DECISIONS: FinalDecision[] = ['BID', 'NO_BID', 'CONDITIONAL', 'DEFERRED']

export function QualificationAgentPanel({ pursuitId }: { pursuitId: string }) {
  const { user } = useAuth()
  const { toast } = useToast()
  const isAdmin = user?.role === 'ADMIN'

  const [data, setData] = useState<QualificationAgentView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState(false)
  const [decision, setDecision] = useState<FinalDecision | ''>('')
  const [rationale, setRationale] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await qualificationAgentApi.get(pursuitId))
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load the Qualification Agent status.')
    } finally {
      setLoading(false)
    }
  }, [pursuitId])

  useEffect(() => { void load() }, [load])

  const act = async (mode: 'accept' | 'reject') => {
    if (!data?.recommendation) return
    const question =
      mode === 'accept'
        ? 'Accept this agent recommendation and record the corresponding bid/no-bid decision? The decision is recorded as yours.'
        : 'Reject this agent recommendation and record your own decision? The agent recommendation is preserved as evidence.'
    if (!window.confirm(question)) return

    setActing(true)
    try {
      if (mode === 'accept') {
        await qualificationAgentApi.accept(data.recommendation.id, {
          ...(decision ? { decision } : {}),
          ...(rationale ? { overrideReason: rationale } : {}),
        })
        toast('Recommendation accepted and your decision recorded.', 'success')
      } else {
        if (!decision) {
          toast('Choose the decision you are recording instead.', 'error')
          return
        }
        await qualificationAgentApi.reject(data.recommendation.id, {
          decision,
          ...(rationale ? { overrideReason: rationale } : {}),
        })
        toast('Your decision was recorded. The agent recommendation is preserved.', 'success')
      }
      setDecision('')
      setRationale('')
      await load()
    } catch (err) {
      toast((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'The action could not be completed.', 'error')
    } finally {
      setActing(false)
    }
  }

  if (loading) return <LoadingPanel label="Loading Qualification Agent status…" />
  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!data) return <EmptyPanel message="No Qualification Agent data." />

  const { recommendation, brief, schedule, lastRun, gateReview, humanDecision, escalations, policy } = data

  return (
    <div className="space-y-4" data-testid="qualification-agent-panel">
      {/* --- status --------------------------------------------------- */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-gray-400" />
            <div>
              <h3 className="text-sm font-medium text-gray-200">Qualification Agent</h3>
              <p className="text-xs text-gray-500">Deterministic. No AI inference, no tokens, no cost.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="success">IMPLEMENTED</Badge>
            {schedule?.isEnabled ? <Badge tone="success">ENABLED</Badge> : <Badge tone="neutral">DISABLED</Badge>}
            <button
              onClick={() => void load()}
              className="text-gray-500 hover:text-gray-300 transition-colors"
              aria-label="Refresh Qualification Agent status"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          <div>
            <dt className="text-gray-500">Last run</dt>
            <dd className="text-gray-300" data-testid="qual-last-run">
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
      </div>

      {!recommendation || !brief ? (
        <EmptyPanel
          message="The Qualification Agent has not qualified this pursuit yet."
          hint="Enable it on the Agent Operations page, or trigger a run there."
        />
      ) : (
        <>
          {/* --- the recommendation ------------------------------------ */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="qual-recommendation">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
                <Scale className="w-4 h-4 text-gray-400" />
                {/* Never "Final Bid Decision" — this is a recommendation. */}
                <h3 className="text-sm font-medium text-gray-200">Agent recommendation — human decision required</h3>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={RESULT_TONE[recommendation.recommendation]}>{RESULT_LABEL[recommendation.recommendation]}</Badge>
                <Badge tone="neutral">v{recommendation.version}</Badge>
                <Badge tone={recommendation.status === 'ACTIVE' ? 'info' : 'neutral'}>{recommendation.status}</Badge>
              </div>
            </div>

            <pre className="whitespace-pre-wrap text-xs text-gray-300 font-sans" data-testid="qual-narrative">{recommendation.narrative}</pre>

            <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-xs">
              <Stat label="Scorecard" value={recommendation.scorecardScore !== null ? String(recommendation.scorecardScore) : '—'} />
              <Stat
                label="Probability"
                testId="qual-probability"
                value={
                  recommendation.finalProbability !== null
                    ? `${recommendation.finalProbability}% (${recommendation.probabilityMode ?? 'RAW'})`
                    : '—'
                }
              />
              <Stat
                label="Interval"
                testId="qual-interval"
                value={
                  brief.probability.intervalAvailable && recommendation.confidenceLower !== null
                    ? `${recommendation.confidenceLower}–${recommendation.confidenceUpper}%`
                    : brief.probability.intervalUnavailableLabel ?? 'unavailable'
                }
              />
              <Stat label="Confidence" value={recommendation.confidenceState} />
              <Stat label="Match" value={brief.capability.matchScore !== null ? String(brief.capability.matchScore) : '—'} />
              <Stat label="Capability gap" value={recommendation.capabilityGapSeverity ?? '—'} testId="qual-gap" />
              <Stat label="Capacity" value={recommendation.capacityState ?? '—'} testId="qual-capacity" />
              <Stat label="Data sufficiency" value={recommendation.dataSufficiency} />
            </dl>

            {recommendation.proposedPriority && (
              <p className="mt-2 text-[11px] text-gray-500" data-testid="qual-proposed-priority">
                Proposed priority: {recommendation.proposedPriority}. The agent does not change the pursuit's priority —
                apply it yourself if you agree.
              </p>
            )}
          </div>

          {/* --- evidence ----------------------------------------------- */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <EvidenceCard title="Incumbent" testId="qual-incumbent">
              {brief.incumbent.name ? (
                <>
                  <p className="text-gray-300">{brief.incumbent.name}</p>
                  {brief.incumbent.retentionDenominator !== null && (
                    <p className="text-gray-500">
                      Retained {brief.incumbent.retentionNumerator} of {brief.incumbent.retentionDenominator} comparable award(s)
                      {brief.incumbent.retentionRatePct !== null ? ` · ${brief.incumbent.retentionRatePct}%` : ''}
                    </p>
                  )}
                  <p className="text-gray-600">{brief.incumbent.basisLabel}</p>
                  {brief.incumbent.limitation && <p className="text-yellow-400">{brief.incumbent.limitation}</p>}
                </>
              ) : (
                <p className="text-gray-500">No incumbent could be identified from the award evidence.</p>
              )}
            </EvidenceCard>

            <EvidenceCard title="Competitors" testId="qual-competitors">
              {brief.competitors.length === 0 ? (
                <p className="text-gray-500">No competitor award evidence is available.</p>
              ) : (
                <ul className="space-y-1">
                  {brief.competitors.map((c) => (
                    <li key={c.name}>
                      <span className="text-gray-300">{c.name}</span>{' '}
                      {c.observedAwardSharePct !== null ? (
                        <span className={c.isConfirmedWinRate ? 'text-green-400' : 'text-gray-400'}>
                          {/* Wording is structural: only a confirmed denominator earns "win rate". */}
                          {c.isConfirmedWinRate
                            ? `confirmed win rate ${c.observedAwardSharePct}% of ${c.totalObserved} bid(s)`
                            : `observed award share ${c.observedAwardSharePct}% (${c.awardsObserved} of ${c.totalObserved} awards)`}
                        </span>
                      ) : (
                        <span className="text-gray-500">insufficient data</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {brief.competitorLimitation && <p className="text-yellow-400 mt-1">{brief.competitorLimitation}</p>}
            </EvidenceCard>

            <EvidenceCard title="Capability & capacity" testId="qual-capability">
              <p className="text-gray-300">Gap severity: {brief.capability.severity}</p>
              {brief.capability.criticalGaps.map((g) => <p key={g} className="text-red-400">{g}</p>)}
              <p className="text-gray-500 mt-1">{brief.capacity.detail}</p>
            </EvidenceCard>

            <EvidenceCard title="Past performance, pricing & compliance" testId="qual-other-evidence">
              <p className="text-gray-300">{brief.pastPerformance.relevantRecords} relevant past-performance record(s)</p>
              <p className="text-gray-500">{brief.pricing.detail}</p>
              <p className="text-gray-500">{brief.compliance.detail}</p>
            </EvidenceCard>
          </div>

          {brief.stageContradiction.contradicts && brief.stageContradiction.reason && (
            <div className="bg-orange-950/40 border border-orange-800 rounded-xl p-3 text-xs text-orange-300" data-testid="qual-contradiction">
              <AlertTriangle className="w-4 h-4 inline mr-1" />
              {brief.stageContradiction.reason}
            </div>
          )}

          {brief.dataLimitations.length > 0 && <PartialDataNotice limitations={brief.dataLimitations} />}

          {gateReview && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-xs" data-testid="qual-gate-review">
              <div className="flex items-center gap-2">
                <Gavel className="w-4 h-4 text-gray-400" />
                <span className="text-gray-200">{gateReview.name}</span>
                <Badge tone="warning">{gateReview.status}</Badge>
              </div>
              <p className="text-gray-500 mt-1">{gateReview.comments}</p>
            </div>
          )}

          {escalations.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="qual-escalations">
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

          {/* --- the human decision ------------------------------------- */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="qual-human-decision">
            <h3 className="text-sm font-medium text-gray-200 mb-2">Human decision</h3>

            {humanDecision?.finalDecision ? (
              <div className="text-xs space-y-1" data-testid="qual-decision-recorded">
                <p className="text-gray-300">
                  Agent recommended: <span className="font-mono">{recommendation.recommendation}</span>
                </p>
                <p className="text-gray-300">
                  Human decided: <span className="font-mono">{humanDecision.finalDecision}</span>
                </p>
                {humanDecision.overrideReason && (
                  <p className="text-gray-500">Rationale: {humanDecision.overrideReason}</p>
                )}
                <p className="text-gray-600">Recorded {formatDate(humanDecision.decidedAt)} by user {humanDecision.decidedByUserId}</p>
              </div>
            ) : (
              <>
                <p className="text-xs text-gray-500 mb-2">
                  No decision has been recorded. The agent has not recorded one and cannot.
                </p>
                {isAdmin ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2 items-center">
                      <select
                        data-testid="qual-decision-select"
                        value={decision}
                        onChange={(e) => setDecision(e.target.value as FinalDecision | '')}
                        className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
                      >
                        <option value="">Decision…</option>
                        {DECISIONS.map((d) => <option key={d} value={d}>{d.replace('_', ' ')}</option>)}
                      </select>
                      <input
                        data-testid="qual-rationale"
                        value={rationale}
                        onChange={(e) => setRationale(e.target.value)}
                        placeholder="Rationale (required when overriding)"
                        className="flex-1 min-w-[14rem] bg-gray-800 border border-gray-700 rounded px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        data-testid="qual-accept"
                        disabled={acting || recommendation.status !== 'ACTIVE'}
                        onClick={() => void act('accept')}
                        className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-40 transition-colors"
                      >
                        {acting ? 'Recording…' : 'Accept recommendation'}
                      </button>
                      <button
                        data-testid="qual-reject"
                        disabled={acting || recommendation.status !== 'ACTIVE'}
                        onClick={() => void act('reject')}
                        className="text-xs px-3 py-1.5 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-700 disabled:opacity-40 transition-colors"
                      >
                        Reject and decide myself
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-gray-500" data-testid="qual-consultant-note">
                    Only a firm administrator can record a qualification decision.
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}

      <Disclaimer>
        The Qualification Agent recommends; it never decides. It does not record a bid/no-bid decision, approve or
        reject a gate review, write a rationale on your behalf, or change the pursuit's priority.
      </Disclaimer>

      <ul className="text-[11px] text-gray-600 list-disc list-inside space-y-0.5">
        {policy.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
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

function EvidenceCard({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs space-y-1" data-testid={testId}>
      <h3 className="text-sm font-medium text-gray-200 mb-1">{title}</h3>
      {children}
    </div>
  )
}
