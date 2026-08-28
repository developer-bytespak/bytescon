// =============================================================
// §7.2 — Opportunity Agent panel for /discovery.
//
// Renders the backend's OPPORTUNITY_BRIEF. Nothing here computes a match score,
// a learned weight, a deadline or a health state — every figure comes from the
// agent's persisted artifact.
//
// The pursuit-learning surface is the human approval point. Below the minimum
// sample it says INSUFFICIENT DATA and shows no Apply control at all; above it,
// an ADMIN sees the sample, the dimension-by-dimension delta and the evidence
// before confirming. Apply and Revert both require an explicit confirmation.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Bot, Brain, CalendarClock, Database, RefreshCw, Undo2 } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useToast } from '../Toast'
import {
  Badge, Disclaimer, EligibilityBadge, EmptyPanel, ErrorPanel,
  LoadingPanel, PartialDataNotice, formatDate,
} from '../section6/Section6Ui'
import { opportunityAgentApi, type OpportunityAgentLatest } from '../../services/opportunityAgentApi'
import type { EligibilityState } from '../../services/section6Api'

const SOURCE_STATE_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  OK: 'success',
  STALE: 'warning',
  NEVER_SYNCED: 'warning',
  FAILING: 'danger',
  NOT_CONFIGURED: 'neutral',
  DISABLED: 'neutral',
}

export function OpportunityAgentPanel({ onCount }: { onCount?: (n: number) => void }) {
  const { user } = useAuth()
  const { toast } = useToast()
  const isAdmin = user?.role === 'ADMIN'

  const [data, setData] = useState<OpportunityAgentLatest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await opportunityAgentApi.getLatest()
      setData(result)
      onCount?.(result.brief?.tenantSummary.highPriorityMatches ?? 0)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load the Opportunity Agent status.')
    } finally {
      setLoading(false)
    }
  }, [onCount])

  useEffect(() => { void load() }, [load])

  const act = async (signalId: string, mode: 'apply' | 'revert') => {
    const question = mode === 'apply'
      ? 'Apply this learned pursuit-preference weighting? It changes how opportunities are ranked for your whole firm. Eligibility is unaffected.'
      : 'Revert this learned weighting and restore the preserved baseline?'
    if (!window.confirm(question)) return

    setActing(signalId)
    try {
      const result = mode === 'apply'
        ? await opportunityAgentApi.applyFeedback(signalId)
        : await opportunityAgentApi.revertFeedback(signalId)
      toast(
        mode === 'apply'
          ? `Weighting applied. ${result.matchesRefreshed} match(es) refreshed.`
          : `Weighting reverted. ${result.matchesRefreshed} match(es) refreshed.`,
        'success',
      )
      await load()
    } catch (err) {
      toast(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'The action could not be completed.',
        'error',
      )
    } finally {
      setActing(null)
    }
  }

  if (loading) return <LoadingPanel label="Loading Opportunity Agent status…" />
  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!data) return <EmptyPanel message="No Opportunity Agent data." />

  const { schedule, lastRun, lastSuccessfulRun, brief, sourceTotals, escalations, learning, policy } = data

  return (
    <div className="space-y-4" data-testid="opportunity-agent-panel">
      {/* --- status ------------------------------------------------ */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-gray-400" />
            <div>
              <h3 className="text-sm font-medium text-gray-200">Opportunity Agent</h3>
              <p className="text-xs text-gray-500">
                Deterministic. No AI inference, no tokens, no cost.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="success">IMPLEMENTED</Badge>
            {schedule?.isEnabled
              ? <Badge tone="success">ENABLED</Badge>
              : <Badge tone="neutral" title="An administrator enables this agent on the Agent Operations page.">DISABLED</Badge>}
            <button
              onClick={() => void load()}
              className="text-gray-500 hover:text-gray-300 transition-colors"
              title="Refresh"
              aria-label="Refresh Opportunity Agent status"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 text-xs">
          <div>
            <dt className="text-gray-500">Last run</dt>
            <dd className="text-gray-300" data-testid="last-run">
              {lastRun ? `${lastRun.status} · ${formatDate(lastRun.createdAt)}` : 'Never run'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Last successful run</dt>
            <dd className="text-gray-300">{lastSuccessfulRun ? formatDate(lastSuccessfulRun.finishedAt) : '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Next scheduled run</dt>
            <dd className="text-gray-300">{schedule?.isEnabled ? formatDate(schedule.nextRunAt) : '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Autonomy</dt>
            <dd className="text-gray-300 font-mono">{schedule?.autonomyLevel ?? 'PROPOSE'}</dd>
          </div>
        </dl>

        {lastRun && (
          <p className="mt-3 text-[11px] text-gray-500">
            Run <Link to={`/agents/runs/${lastRun.id}`} className="text-blue-400 hover:underline">{lastRun.id.slice(0, 8)}</Link>
            {' · '}{lastRun.tokenInput + lastRun.tokenOutput} tokens · ${Number(lastRun.estimatedCostUsd).toFixed(2)}
            {lastRun.outputSummary ? ` · ${lastRun.outputSummary}` : ''}
          </p>
        )}
      </div>

      {/* --- source health ----------------------------------------- */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Database className="w-4 h-4 text-gray-400" />
          <h3 className="text-sm font-medium text-gray-200">Source health</h3>
          <span className="text-xs text-gray-500">
            {sourceTotals.healthy} healthy · {sourceTotals.failing} failing · {sourceTotals.stale} stale · {sourceTotals.notConfigured} not configured
          </span>
        </div>
        {data.sourceHealth.length === 0 ? (
          <EmptyPanel message="No opportunity sources are configured." hint="Add one on the Sources tab." />
        ) : (
          <ul className="space-y-2" data-testid="source-health-list">
            {data.sourceHealth.map((s) => (
              <li key={s.sourceConfigId} className="flex items-start justify-between gap-3 text-xs border border-gray-800 rounded-lg p-2">
                <div>
                  <p className="text-gray-300">{s.displayName}</p>
                  <p className="text-gray-500">{s.freshnessLabel} · staleness window {s.stalenessHours}h · {s.verification}</p>
                  {s.lastFailureMessage && s.state === 'FAILING' && (
                    <p className="text-red-400 mt-1">{s.consecutiveFailures} consecutive failure(s): {s.lastFailureMessage}</p>
                  )}
                </div>
                <Badge tone={SOURCE_STATE_TONE[s.state] ?? 'neutral'}>{s.state}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --- pursuit learning --------------------------------------- */}
      <PursuitLearningCard
        learning={learning}
        policy={policy}
        isAdmin={isAdmin}
        acting={acting}
        onAct={act}
      />

      {/* --- the brief ---------------------------------------------- */}
      {!brief ? (
        <EmptyPanel
          message="The Opportunity Agent has not produced a brief yet."
          hint="Enable it on the Agent Operations page, or trigger a run there, and the brief will appear here."
        />
      ) : (
        <>
          {brief.dataLimitations.length > 0 && <PartialDataNotice limitations={brief.dataLimitations} />}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Kpi label="Live opportunities" value={brief.tenantSummary.liveOpportunities} />
            <Kpi label="Critical matches" value={brief.tenantSummary.criticalMatches} />
            <Kpi label="High matches" value={brief.tenantSummary.highPriorityMatches} />
            <Kpi label="Pre-solicitation" value={brief.tenantSummary.preSolicitationCount} />
          </div>

          {brief.operations.failedSources.length > 0 && (
            <div className="bg-red-950/40 border border-red-800 rounded-xl p-3 text-xs text-red-300" data-testid="failed-sources">
              <AlertTriangle className="w-4 h-4 inline mr-1" />
              This brief was built with {brief.operations.failedSources.length} source(s) failing:{' '}
              {brief.operations.failedSources.join(', ')}. It may be incomplete.
            </div>
          )}

          <BriefSection title="High-priority matches" testId="high-matches" empty="No opportunity currently scores above the high-match threshold.">
            {brief.highMatchOpportunities.map((row) => (
              <li key={row.opportunityId} className="border border-gray-800 rounded-lg p-3 text-xs space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <Link to={`/opportunities/${row.opportunityId}`} className="text-gray-200 hover:underline font-medium">
                    {row.title}
                  </Link>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge tone={row.priority === 'CRITICAL' ? 'danger' : 'warning'}>{row.priority}</Badge>
                    <span className="font-mono text-gray-300">{row.matchScore}</span>
                  </div>
                </div>
                <p className="text-gray-500">
                  {row.agency} · closes {formatDate(row.deadline)}
                  {row.workingDaysToDeadline !== null && ` · ${row.workingDaysToDeadline} working day(s) away`}
                </p>
                {row.weightProfile === 'PURSUIT_ADJUSTED' && (
                  <p className="text-amber-400" data-testid={`adjusted-${row.opportunityId}`}>
                    Ranked with a human-applied pursuit-preference adjustment. Base score: {row.baseMatchScore ?? '—'}.
                  </p>
                )}
                {row.eligibility && (
                  <EligibilityBadge state={row.eligibility as EligibilityState} reason={row.eligibilityReason ?? undefined} />
                )}
                {row.certificationWarnings.map((warning) => (
                  <p key={warning} className="text-yellow-400">{warning}</p>
                ))}
                {row.whyItMatched.length > 0 && (
                  <ul className="text-gray-500 list-disc list-inside">
                    {row.whyItMatched.map((why) => <li key={why}>{why}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </BriefSection>

          <BriefSection title="Pre-solicitation notices" testId="presolicitation" empty="No pre-solicitation notices are currently tracked.">
            {brief.preSolicitation.map((row) => (
              <li key={row.opportunityId} className="border border-gray-800 rounded-lg p-3 text-xs space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <Link to={`/opportunities/${row.opportunityId}`} className="text-gray-200 hover:underline">{row.title}</Link>
                  <Badge tone="info" title={`Classified from the ${row.basis === 'NOTICE_TYPE' ? 'feed notice type' : 'title'}`}>{row.label}</Badge>
                </div>
                <p className="text-gray-500">{row.agency} · responds {formatDate(row.responseDeadline)}</p>
                {/* Verbatim from the backend — deliberately conditional wording. */}
                {row.whyEarlyResponseMayMatter && <p className="text-gray-500">{row.whyEarlyResponseMayMatter}</p>}
              </li>
            ))}
          </BriefSection>

          <BriefSection title="Re-compete candidates" testId="recompetes" empty="No re-compete signals in the forward horizon.">
            {brief.recompetes.map((row) => (
              <li key={row.signalId} className="border border-gray-800 rounded-lg p-3 text-xs space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-gray-200">{row.contractNumber ?? 'Contract number not recorded'}</span>
                  <Badge tone={row.requiresHumanAcceptance ? 'warning' : 'success'}>{row.status}</Badge>
                </div>
                <p className="text-gray-500">
                  {row.agency ?? 'Agency not recorded'} · incumbent {row.incumbent ?? 'unknown'} ·
                  estimated window {formatDate(row.estimatedWindowStart)} – {formatDate(row.estimatedWindowEnd)}
                </p>
                <p className="text-gray-500">Confidence {row.confidence}. {row.confidenceReason}</p>
                {row.requiresHumanAcceptance && (
                  <p className="text-yellow-400">
                    Estimated from period-of-performance evidence, not an announced date. A human must accept it on the Re-competes tab.
                  </p>
                )}
              </li>
            ))}
          </BriefSection>

          <BriefSection title="Agency forecasts" testId="forecasts" empty="No agency forecasts are tracked.">
            {brief.forecasts.map((row) => (
              <li key={row.forecastId} className="border border-gray-800 rounded-lg p-3 text-xs space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-gray-200">{row.title}</span>
                  <Badge tone={row.requiresHumanConfirmation ? 'warning' : 'neutral'}>{row.linkState}</Badge>
                </div>
                <p className="text-gray-500">
                  {row.agency} · anticipated {formatDate(row.anticipatedSolicitationDate)}
                </p>
                <p className="text-gray-500">{row.note}</p>
                {row.requiresHumanConfirmation && (
                  <p className="text-yellow-400">This forecast-to-solicitation link needs human confirmation on the Forecasts tab.</p>
                )}
              </li>
            ))}
          </BriefSection>
        </>
      )}

      {/* --- escalations -------------------------------------------- */}
      {escalations.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="agent-escalations">
          <div className="flex items-center gap-2 mb-3">
            <CalendarClock className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-medium text-gray-200">Open escalations ({escalations.length})</h3>
          </div>
          <ul className="space-y-2">
            {escalations.map((e) => (
              <li key={e.id} className="border border-gray-800 rounded-lg p-2 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-gray-200">{e.title}</span>
                  <Badge tone={e.severity === 'CRITICAL' || e.severity === 'HIGH' ? 'danger' : 'warning'}>{e.severity}</Badge>
                </div>
                <p className="text-gray-500 mt-1">{e.reason}</p>
                {e.recommendedAction && <p className="text-gray-500 mt-1">Recommended: {e.recommendedAction}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Disclaimer>
        The Opportunity Agent proposes; it never decides. It does not record a bid decision, verify a
        capability, accept a re-compete signal, confirm a forecast link, or apply a learned weighting.
      </Disclaimer>
    </div>
  )
}

// -------------------------------------------------------------
// Pursuit learning — the human approval surface
// -------------------------------------------------------------

function PursuitLearningCard({
  learning, policy, isAdmin, acting, onAct,
}: {
  learning: OpportunityAgentLatest['learning']
  policy: OpportunityAgentLatest['policy']
  isAdmin: boolean
  acting: string | null
  onAct: (id: string, mode: 'apply' | 'revert') => void
}) {
  const signal = learning.appliedSignal ?? learning.proposedSignal ?? learning.insufficientSignal

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="pursuit-learning">
      <div className="flex items-center gap-2 mb-3">
        <Brain className="w-4 h-4 text-gray-400" />
        <h3 className="text-sm font-medium text-gray-200">Pursuit preference learning</h3>
        <Badge tone={learning.effectiveWeightProfile === 'PURSUIT_ADJUSTED' ? 'warning' : 'neutral'}>
          {learning.effectiveWeightProfile === 'PURSUIT_ADJUSTED' ? 'ADJUSTED RANKING' : 'BASE RANKING'}
        </Badge>
      </div>

      {!signal ? (
        <EmptyPanel
          message="Pursuit feedback has not been analysed yet."
          hint="It is analysed on every Opportunity Agent run."
        />
      ) : (
        <div className="space-y-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={
              signal.status === 'APPLIED' ? 'success'
                : signal.status === 'PROPOSED' ? 'info'
                  : signal.status === 'INSUFFICIENT_DATA' ? 'warning' : 'neutral'
            }>
              {signal.status === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT DATA' : signal.status}
            </Badge>
            <span className="text-gray-500 font-mono">{signal.algorithmVersion}</span>
            <span className="text-gray-500">generated {formatDate(signal.generatedAt)}</span>
          </div>

          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Sample size" value={`${signal.sampleSize} / ${signal.minimumSampleSize} needed`} testId="sample-size" />
            <Stat label="Pursued" value={String(signal.pursuedSampleSize)} />
            <Stat label="Declined" value={String(signal.ignoredSampleSize)} />
            <Stat label="Confidence" value={signal.confidenceState} />
          </dl>

          <p className="text-gray-400">{signal.summary}</p>

          {signal.status !== 'INSUFFICIENT_DATA' && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-gray-500 text-left">
                    <th className="py-1 pr-3">Dimension</th>
                    <th className="py-1 pr-3">Pursued avg</th>
                    <th className="py-1 pr-3">Declined avg</th>
                    <th className="py-1 pr-3">Base weight</th>
                    <th className="py-1 pr-3">Proposed weight</th>
                    <th className="py-1">Why</th>
                  </tr>
                </thead>
                <tbody data-testid="dimension-deltas">
                  {(signal.evidence?.dimensions ?? []).map((d) => (
                    <tr key={d.dimension} className="border-t border-gray-800 align-top">
                      <td className="py-1 pr-3 text-gray-300 font-mono">{d.dimension}</td>
                      <td className="py-1 pr-3 text-gray-400">{d.pursuedMean ?? '—'}</td>
                      <td className="py-1 pr-3 text-gray-400">{d.ignoredMean ?? '—'}</td>
                      <td className="py-1 pr-3 text-gray-400 font-mono">{d.baseWeight}</td>
                      <td className={`py-1 pr-3 font-mono ${d.proposedWeight > d.baseWeight ? 'text-green-400' : d.proposedWeight < d.baseWeight ? 'text-red-400' : 'text-gray-400'}`}>
                        {d.proposedWeight}
                      </td>
                      <td className="py-1 text-gray-500">{d.explanation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {signal.status === 'APPLIED' && (
            <p className="text-gray-500" data-testid="applied-by">
              Applied by user {signal.appliedByUserId ?? 'unknown'} on {formatDate(signal.appliedAt)}.
              The preserved baseline is restored exactly on revert.
            </p>
          )}

          <div className="flex items-center gap-2 pt-1">
            {/* No Apply control exists below the minimum sample — there is
                nothing safe to apply, so the button is not rendered at all. */}
            {signal.status === 'PROPOSED' && (
              <button
                data-testid="apply-feedback"
                disabled={!isAdmin || acting === signal.id}
                onClick={() => onAct(signal.id, 'apply')}
                title={isAdmin ? 'Apply this weighting' : 'Only an administrator can apply a learned weighting.'}
                className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-40 transition-colors"
              >
                {acting === signal.id ? 'Applying…' : 'Apply weighting'}
              </button>
            )}
            {signal.status === 'APPLIED' && (
              <button
                data-testid="revert-feedback"
                disabled={!isAdmin || acting === signal.id}
                onClick={() => onAct(signal.id, 'revert')}
                title={isAdmin ? 'Restore the preserved baseline' : 'Only an administrator can revert a learned weighting.'}
                className="text-xs px-3 py-1.5 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-700 disabled:opacity-40 transition-colors inline-flex items-center gap-1"
              >
                <Undo2 className="w-3 h-3" />
                {acting === signal.id ? 'Reverting…' : 'Revert'}
              </button>
            )}
          </div>
        </div>
      )}

      <ul className="mt-3 text-[11px] text-gray-600 list-disc list-inside space-y-0.5">
        {policy.notes.map((note) => <li key={note}>{note}</li>)}
      </ul>
    </div>
  )
}

// -------------------------------------------------------------
// Small presentational helpers
// -------------------------------------------------------------

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <p className="text-[10px] text-gray-500 tracking-widest uppercase">{label}</p>
      <p className="text-2xl font-bold text-gray-100 font-mono">{value}</p>
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

function BriefSection({
  title, testId, empty, children,
}: {
  title: string
  testId: string
  empty: string
  children: React.ReactNode
}) {
  const items = Array.isArray(children) ? children : [children]
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid={testId}>
      <h3 className="text-sm font-medium text-gray-200 mb-3">{title}</h3>
      {items.length === 0 ? <EmptyPanel message={empty} /> : <ul className="space-y-2">{children}</ul>}
    </div>
  )
}
