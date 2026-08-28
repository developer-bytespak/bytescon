// =============================================================
// §7.5 — Teaming Agent panel for /teaming.
//
// Renders the backend's TEAMING_PLAN. Nothing here matches a partner, ranks a
// candidate, computes a rate, or decides a risk state.
//
// THE RULES THIS UI ENFORCES
//   · Every agreement/NDA draft shows REQUIRES LEGAL REVIEW — NOT EXECUTABLE,
//     styled as a warning. A draft never resembles a signed document.
//   · Every outreach draft shows DRAFT — HUMAN SEND REQUIRED.
//   · There is NO Execute, Auto-sign, Send, or e-signature control. E-signature
//     is Section 8 scope and is deliberately absent here.
//   · A performance grade is never shown when the sample is insufficient.
//   · "No suitable partner" always reads as a statement about THIS network.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Bot, FileWarning, Mail, RefreshCw, Scale, Target } from 'lucide-react'
import {
  Badge, Disclaimer, EmptyPanel, ErrorPanel, LoadingPanel, PartialDataNotice, formatDate,
} from '../section6/Section6Ui'
import {
  teamingAgentApi,
  type GapSeverity,
  type RiskState,
  type TeamingAgentView,
  type TeamingPlanCandidate,
} from '../../services/teamingAgentApi'

const SEVERITY_TONE: Record<GapSeverity, 'danger' | 'warning' | 'info'> = {
  CRITICAL: 'danger',
  MAJOR: 'warning',
  MINOR: 'info',
}

const RISK_TONE: Record<RiskState, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ON_TRACK: 'success',
  WATCH: 'warning',
  AT_RISK: 'danger',
  MISSED: 'danger',
  INSUFFICIENT_DATA: 'neutral',
}

const MITIGATION_LABEL: Record<string, string> = {
  UNRESOLVED: 'Unresolved',
  PROPOSED_MITIGATION: 'Partner proposed — gap still open',
  HUMAN_APPROVED_ARRANGEMENT: 'Arrangement approved by a person',
}

export function TeamingAgentPanel({ pursuitId }: { pursuitId: string }) {
  const [data, setData] = useState<TeamingAgentView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await teamingAgentApi.plan(pursuitId))
    } catch (err) {
      setError(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Could not load the Teaming Agent status.',
      )
    } finally {
      setLoading(false)
    }
  }, [pursuitId])

  useEffect(() => { void load() }, [load])

  if (loading) return <LoadingPanel label="Loading Teaming Agent status…" />
  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!data) return <EmptyPanel message="No Teaming Agent data." />

  const { plan, schedule, lastRun, escalations, policy } = data

  return (
    <div className="space-y-4" data-testid="teaming-agent-panel">
      {/* --- status ------------------------------------------------------ */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-gray-400" />
            <div>
              <h3 className="text-sm font-medium text-gray-200">Teaming Agent</h3>
              <p className="text-xs text-gray-500">
                Proposes partners and prepares drafts. It never signs, executes, or sends anything.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="success">IMPLEMENTED</Badge>
            {schedule?.isEnabled ? <Badge tone="success">ENABLED</Badge> : <Badge tone="neutral">DISABLED</Badge>}
            <button
              onClick={() => void load()}
              className="text-gray-500 hover:text-gray-300 transition-colors"
              aria-label="Refresh Teaming Agent status"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          <div>
            <dt className="text-gray-500">Last run</dt>
            <dd className="text-gray-300" data-testid="teaming-last-run">
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
          <p className="mt-2 text-[11px] text-red-400" data-testid="teaming-last-failure">{schedule.lastFailureMessage}</p>
        )}
      </div>

      {!plan ? (
        <EmptyPanel
          message="The Teaming Agent has not planned this pursuit yet."
          hint="Enable it on the Agent Operations page, or trigger a run there."
        />
      ) : (
        <>
          {/* --- gaps ---------------------------------------------------- */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="teaming-gaps">
            <div className="flex items-center gap-2 mb-2">
              <Target className="w-4 h-4 text-gray-400" />
              <h3 className="text-sm font-medium text-gray-200">Capability gaps ({plan.capabilityGaps.length})</h3>
            </div>
            {plan.capabilityGaps.length === 0 ? (
              <p className="text-xs text-gray-500">No open capability gap was found for this opportunity.</p>
            ) : (
              <ul className="space-y-2">
                {plan.capabilityGaps.map((gap) => (
                  <li key={gap.gapId} className="border border-gray-800 rounded-lg p-2 text-xs">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-gray-200">{gap.requirement}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        <Badge tone={SEVERITY_TONE[gap.severity]}>{gap.severity}</Badge>
                        <Badge tone="neutral">{gap.gapClass}</Badge>
                      </div>
                    </div>
                    <p className="text-gray-500 mt-1">{gap.evidence}</p>
                    <p className="text-gray-400 mt-0.5" data-testid={`gap-mitigation-${gap.gapId}`}>
                      {MITIGATION_LABEL[gap.mitigationStatus] ?? gap.mitigationStatus}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* --- candidates ---------------------------------------------- */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="teaming-candidates">
            <h3 className="text-sm font-medium text-gray-200 mb-2">
              Partner candidates ({plan.partnerCandidates.length})
            </h3>

            {plan.noSuitablePartner && plan.noSuitablePartnerMessage && (
              <div
                className="bg-orange-950/40 border border-orange-800 rounded-lg p-3 text-xs text-orange-300 mb-3"
                data-testid="teaming-no-partner"
              >
                <AlertTriangle className="w-4 h-4 inline mr-1" />
                {plan.noSuitablePartnerMessage} This describes your own partner network — the platform has not searched
                the market.
              </div>
            )}

            {plan.partnerCandidates.length === 0 ? (
              <p className="text-xs text-gray-500">No partner record was evaluated for this opportunity.</p>
            ) : (
              <ul className="space-y-3">
                {plan.partnerCandidates.map((c) => <CandidateCard key={c.partnerId} candidate={c} minimumSample={policy.minimumPerformanceSample} />)}
              </ul>
            )}
          </div>

          {/* --- proposed workshare -------------------------------------- */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs" data-testid="teaming-workshare">
            <h3 className="text-sm font-medium text-gray-200 mb-1">Proposed workshare</h3>
            {plan.proposedWorkshare.status === 'NOT_AVAILABLE' ? (
              <p className="text-gray-500">No workshare is proposed.</p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Badge tone="warning">{plan.proposedWorkshare.status}</Badge>
                  <span className="text-gray-300 font-mono">
                    prime {plan.proposedWorkshare.primePercent ?? '—'}% · partner {plan.proposedWorkshare.partnerPercent ?? '—'}%
                  </span>
                </div>
                {plan.proposedWorkshare.description && <p className="text-gray-500 mt-1">{plan.proposedWorkshare.description}</p>}
              </>
            )}
            {plan.proposedWorkshare.limitations.map((l) => (
              <p key={l} className="text-yellow-400 mt-1">{l}</p>
            ))}
          </div>

          {/* --- drafts --------------------------------------------------- */}
          {plan.drafts.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="teaming-drafts">
              <div className="flex items-center gap-2 mb-2">
                <FileWarning className="w-4 h-4 text-gray-400" />
                <h3 className="text-sm font-medium text-gray-200">Agreement and NDA drafts</h3>
              </div>
              <ul className="space-y-2">
                {plan.drafts.map((d) => (
                  <li
                    key={d.draftId}
                    className="border border-yellow-800 bg-yellow-950/20 rounded-lg p-3 text-xs"
                    data-testid={`teaming-draft-${d.draftId}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-gray-200 font-mono">{d.documentType}</span>
                      <div className="flex items-center gap-1">
                        <Badge tone="warning">{d.status}</Badge>
                        <Badge tone="neutral">{d.source === 'LLM_ASSISTED' ? 'AI-ASSISTED' : 'TEMPLATE'}</Badge>
                      </div>
                    </div>
                    {/* The banner is prominent and never styled as an approval. */}
                    <p className="mt-2 text-red-300 font-semibold tracking-wide" data-testid="teaming-draft-banner">
                      {d.banner}
                    </p>
                    <p className="text-gray-500 mt-1">
                      Legal review required: {d.legalReviewRequired ? 'yes' : 'no'} · Execution allowed:{' '}
                      {d.executionAllowed ? 'yes' : 'no'}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* --- outreach -------------------------------------------------- */}
          {plan.outreachDrafts.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="teaming-outreach">
              <div className="flex items-center gap-2 mb-2">
                <Mail className="w-4 h-4 text-gray-400" />
                <h3 className="text-sm font-medium text-gray-200">Partner outreach drafts</h3>
              </div>
              <ul className="space-y-2">
                {plan.outreachDrafts.map((o) => (
                  <li key={o.draftId} className="border border-gray-800 rounded-lg p-3 text-xs">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-gray-200">{o.subject ?? 'Untitled draft'}</span>
                      <Badge tone="warning">DRAFT — HUMAN SEND REQUIRED</Badge>
                    </div>
                    <p className="text-gray-500 mt-1" data-testid={`outreach-send-${o.draftId}`}>
                      Sending is not automated. Review the draft and send it yourself.
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* --- subcontracting goals -------------------------------------- */}
          {plan.subcontractingGoals.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="teaming-goals">
              <div className="flex items-center gap-2 mb-2">
                <Scale className="w-4 h-4 text-gray-400" />
                <h3 className="text-sm font-medium text-gray-200">Subcontracting goals</h3>
              </div>
              <ul className="space-y-2">
                {plan.subcontractingGoals.map((g) => (
                  <li key={g.goalId} className="border border-gray-800 rounded-lg p-3 text-xs" data-testid={`goal-${g.goalId}`}>
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-gray-200 font-mono">{g.goalType}</span>
                      <div className="flex items-center gap-1">
                        <Badge tone={RISK_TONE[g.riskState]}>{g.riskState}</Badge>
                        {g.isHumanVerified
                          ? <Badge tone="success">VERIFIED</Badge>
                          : <Badge tone="neutral">UNVERIFIED</Badge>}
                      </div>
                    </div>
                    <dl className="grid grid-cols-3 gap-2 mt-2">
                      <div>
                        <dt className="text-gray-500">Target</dt>
                        <dd className="text-gray-300 font-mono">
                          {g.target ?? '—'}{g.targetType === 'PERCENT' && g.target ? '%' : ''}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-gray-500">Achieved</dt>
                        <dd className="text-gray-300 font-mono">
                          {g.achieved ?? 'INSUFFICIENT_DATA'}{g.targetType === 'PERCENT' && g.achieved ? '%' : ''}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-gray-500">Remaining</dt>
                        <dd className="text-gray-300 font-mono">
                          {g.remaining ?? '—'}{g.targetType === 'PERCENT' && g.remaining ? '%' : ''}
                        </dd>
                      </div>
                    </dl>
                    <p className="text-gray-500 mt-1">
                      Due {formatDate(g.dueDate)}
                      {g.workingDaysRemaining !== null ? ` · ${g.workingDaysRemaining} working day(s) remaining` : ''}
                      {' · '}Source {g.source} · Data {g.dataSufficiency}
                    </p>
                    {g.limitations.map((l) => <p key={l} className="text-yellow-400 mt-1">{l}</p>)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* --- partner performance --------------------------------------- */}
          {plan.partnerPerformance.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="teaming-performance">
              <h3 className="text-sm font-medium text-gray-200 mb-2">Partner performance</h3>
              <ul className="space-y-2">
                {plan.partnerPerformance.map((p) => (
                  <li key={p.partnerId} className="border border-gray-800 rounded-lg p-3 text-xs" data-testid={`performance-${p.partnerId}`}>
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-gray-200">{p.partnerName}</span>
                      <div className="flex items-center gap-1">
                        <Badge tone={p.dataSufficiency === 'INSUFFICIENT_DATA' ? 'neutral' : 'info'}>
                          {p.dataSufficiency}
                        </Badge>
                        {p.declineDetected && <Badge tone="warning">DECLINE DETECTED</Badge>}
                      </div>
                    </div>
                    <p className="text-gray-300 mt-1 font-mono">On time: {p.onTime}</p>
                    <p className="text-gray-300 font-mono">Accepted: {p.acceptance}</p>
                    <p className="text-gray-500 mt-1">Sample size {p.sampleSize} · {p.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.dataLimitations.length > 0 && <PartialDataNotice limitations={plan.dataLimitations} />}
        </>
      )}

      {/* --- escalations ----------------------------------------------- */}
      {escalations.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="teaming-escalations">
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
        The Teaming Agent proposes; it never commits. It does not execute a teaming arrangement, sign or send an
        agreement, clear a legal review, contact a partner, or change a bid decision. Every draft it prepares requires
        human and legal review before use.
      </Disclaimer>

      <ul className="text-[11px] text-gray-600 list-disc list-inside space-y-0.5">
        {policy.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </div>
  )
}

function CandidateCard({ candidate, minimumSample }: { candidate: TeamingPlanCandidate; minimumSample: number }) {
  const insufficient = candidate.performanceSummary.dataSufficiency === 'INSUFFICIENT_DATA'
  return (
    <li className="border border-gray-800 rounded-lg p-3 text-xs" data-testid={`candidate-${candidate.partnerId}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="text-gray-200">{candidate.name}</span>
        <div className="flex items-center gap-1">
          <Badge tone="info">fit {candidate.overallFit}</Badge>
          <Badge tone={candidate.eligibilityState === 'POSSIBLY_ELIGIBLE' ? 'success' : 'neutral'}>
            {candidate.eligibilityState}
          </Badge>
        </div>
      </div>

      {/* Dimension-by-dimension, never a single opaque score. */}
      <ul className="mt-2 space-y-0.5" data-testid={`dimensions-${candidate.partnerId}`}>
        {candidate.dimensions.map((d) => (
          <li key={d.dimension} className="flex items-start justify-between gap-2">
            <span className="text-gray-400">{d.dimension}</span>
            <span className="text-gray-500 text-right">{d.detail}</span>
          </li>
        ))}
      </ul>

      <p className="text-gray-500 mt-2">
        Certifications: {candidate.certifications.claimed.length > 0 ? candidate.certifications.claimed.join(', ') : 'none recorded'}
        {' · '}
        <span data-testid={`cert-state-${candidate.partnerId}`}>{candidate.certifications.verificationState}</span>
      </p>
      <p className="text-gray-500">Geography: {candidate.geography.level} — {candidate.geography.detail}</p>
      <p className="text-gray-500">{candidate.relevantExperience.detail}</p>

      <p className="text-gray-500 mt-1" data-testid={`perf-${candidate.partnerId}`}>
        {insufficient
          ? `Performance: no grade shown — ${candidate.performanceSummary.sampleSize} attributed deliverable(s), below the minimum sample of ${minimumSample}.`
          : `Performance: on time ${candidate.performanceSummary.onTime} · accepted ${candidate.performanceSummary.acceptance}`}
      </p>

      {candidate.limitations.map((l) => <p key={l} className="text-yellow-400 mt-1">{l}</p>)}
    </li>
  )
}
