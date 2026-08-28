// =============================================================
// §7.7 — Proposal Agent panel for the proposal workspace.
//
// Renders the backend's PROPOSAL_STATUS. Nothing here computes coverage, scores
// relevance, judges readiness, or decides whether a requirement is answered.
//
// THE RULES THIS UI ENFORCES
//   · There is NO Approve, Verify, Select, Sign-off or Submit control anywhere
//     in this panel. Those acts belong to the human proposal workspace.
//   · An approved section is shown as LOCKED. The agent may not write over it.
//   · A skeleton is labelled a skeleton — never "covered".
//   · An AI compliance finding is labelled advisory and never reads as verified.
//   · Past performance appears as CANDIDATES a person must choose between.
//   · With no provider the panel says so plainly instead of showing an
//     empty drafting section that looks like a failure.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Bot, BookOpen, FileText, ListChecks, Lock, RefreshCw, Users } from 'lucide-react'
import {
  Badge, Disclaimer, EmptyPanel, ErrorPanel, LoadingPanel, PartialDataNotice, formatDate,
} from '../section6/Section6Ui'
import {
  proposalAgentApi,
  type CoverageState,
  type DraftState,
  type ProposalAgentView,
  type SectionStatus,
} from '../../services/proposalAgentApi'

const DRAFT_LABEL: Record<DraftState, string> = {
  NO_DRAFT: 'No draft',
  SKELETON_ONLY: 'Skeleton only — not an answer',
  AI_DRAFT_PENDING_REVIEW: 'AI draft — pending human review',
  HUMAN_DRAFT: 'Human draft',
  APPROVED: 'Approved by a person',
}

const DRAFT_TONE: Record<DraftState, 'neutral' | 'warning' | 'info' | 'success'> = {
  NO_DRAFT: 'neutral',
  SKELETON_ONLY: 'warning',
  AI_DRAFT_PENDING_REVIEW: 'warning',
  HUMAN_DRAFT: 'info',
  APPROVED: 'success',
}

const COVERAGE_LABEL: Record<CoverageState, string> = {
  COVERED: 'Covered',
  PARTIAL: 'Partially covered',
  SKELETON_ONLY: 'Skeleton only',
  UNMAPPED: 'Unmapped',
  HUMAN_REVIEW_REQUIRED: 'Human review required',
}

const COVERAGE_TONE: Record<CoverageState, 'success' | 'warning' | 'danger' | 'neutral'> = {
  COVERED: 'success',
  PARTIAL: 'warning',
  SKELETON_ONLY: 'warning',
  UNMAPPED: 'danger',
  HUMAN_REVIEW_REQUIRED: 'warning',
}

export function ProposalAgentPanel({ proposalId }: { proposalId: string }) {
  const [data, setData] = useState<ProposalAgentView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await proposalAgentApi.status(proposalId))
    } catch (err) {
      setError(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Could not load the Proposal Agent status.',
      )
    } finally {
      setLoading(false)
    }
  }, [proposalId])

  useEffect(() => { void load() }, [load])

  if (loading) return <LoadingPanel label="Loading Proposal Agent status…" />
  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!data) return <EmptyPanel message="No Proposal Agent data." />

  const { status, schedule, lastRun, escalations, policy } = data

  return (
    <div className="space-y-4" data-testid="proposal-agent-panel">
      {/* --- status ------------------------------------------------------ */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-gray-400" />
            <div>
              <h3 className="text-sm font-medium text-gray-200">Proposal Agent</h3>
              <p className="text-xs text-gray-500">
                Drafts, maps and tracks. It never approves a section, verifies a requirement, or submits a proposal.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="success">IMPLEMENTED</Badge>
            {schedule?.isEnabled ? <Badge tone="success">ENABLED</Badge> : <Badge tone="neutral">DISABLED</Badge>}
            <button
              onClick={() => void load()}
              className="text-gray-500 hover:text-gray-300 transition-colors"
              aria-label="Refresh Proposal Agent status"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          <div>
            <dt className="text-gray-500">Last run</dt>
            <dd className="text-gray-300" data-testid="proposal-last-run">
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
          <p className="mt-2 text-[11px] text-red-400" data-testid="proposal-last-failure">{schedule.lastFailureMessage}</p>
        )}
      </div>

      {!status ? (
        <EmptyPanel
          message="The Proposal Agent has not assessed this proposal yet."
          hint="Enable it on the Agent Operations page, or trigger a run there."
        />
      ) : (
        <>
          {/* --- outline coverage ---------------------------------------- */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs" data-testid="proposal-outline">
            <div className="flex items-center gap-2 mb-2">
              <ListChecks className="w-4 h-4 text-gray-400" />
              <h3 className="text-sm font-medium text-gray-200">Outline coverage</h3>
              <Badge tone={status.outline.coverageState === 'COMPLETE' ? 'success' : 'warning'}>
                {status.outline.coverageState}
              </Badge>
            </div>
            <p className="text-gray-400">
              {status.outline.mappedMandatoryRequirements} of {status.outline.mandatoryRequirements} mandatory
              requirement(s) sit in a real proposal section, across {status.outline.totalItems} outline item(s).
            </p>
            {status.outline.unmappedMandatoryRequirements.length > 0 && (
              <ul className="mt-2 space-y-1" data-testid="proposal-unmapped">
                {status.outline.unmappedMandatoryRequirements.map((u) => (
                  <li key={u.requirementId} className="border border-red-900/60 bg-red-950/20 rounded p-2">
                    <span className="text-red-300 font-mono">{u.section}</span>
                    <span className="text-gray-400"> — {u.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            {status.outline.ambiguities.map((a) => (
              <p key={a} className="text-yellow-400 mt-1">{a}</p>
            ))}
          </div>

          {/* --- drafting ------------------------------------------------- */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs" data-testid="proposal-drafting">
            <div className="flex items-center gap-2 mb-2">
              <FileText className="w-4 h-4 text-gray-400" />
              <h3 className="text-sm font-medium text-gray-200">Drafting</h3>
              <Badge tone={status.drafting.providerAvailable ? 'success' : 'neutral'}>
                {status.drafting.providerAvailable ? 'AI DRAFTING AVAILABLE' : 'DETERMINISTIC ONLY'}
              </Badge>
            </div>
            <p className="text-gray-400">
              {status.drafting.sectionsDrafted} draft(s) prepared · {status.drafting.sectionsReadyForDraft} section(s)
              ready · {status.drafting.sectionsNeedingSourceMaterial} awaiting approved source material.
            </p>
            {status.drafting.limitations.map((l) => (
              <p key={l} className="text-yellow-400 mt-1" data-testid="proposal-drafting-limitation">{l}</p>
            ))}
          </div>

          {/* --- sections ------------------------------------------------- */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="proposal-sections">
            <h3 className="text-sm font-medium text-gray-200 mb-2">Sections ({status.sections.length})</h3>
            {status.sections.length === 0 ? (
              <p className="text-xs text-gray-500">No sections exist for this proposal yet.</p>
            ) : (
              <ul className="space-y-2">
                {status.sections.map((s) => <SectionRow key={s.sectionId} section={s} />)}
              </ul>
            )}
          </div>

          {/* --- capability library --------------------------------------- */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs" data-testid="proposal-library">
            <div className="flex items-center gap-2 mb-1">
              <BookOpen className="w-4 h-4 text-gray-400" />
              <h3 className="text-sm font-medium text-gray-200">Capability library</h3>
              <Badge tone={status.capabilityLibrary.available ? 'success' : 'warning'}>
                {status.capabilityLibrary.approvedVersions} approved
              </Badge>
            </div>
            <p className="text-gray-400">{status.capabilityLibrary.detail}</p>
            {status.capabilityLibrary.narrativesWithoutApproval > 0 && (
              <p className="text-yellow-400 mt-1">
                {status.capabilityLibrary.narrativesWithoutApproval} narrative(s) have no approved version and cannot be
                quoted.
              </p>
            )}
          </div>

          {/* --- past performance ----------------------------------------- */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs" data-testid="proposal-past-performance">
            <h3 className="text-sm font-medium text-gray-200 mb-1">Past performance candidates</h3>
            <Disclaimer>
              These are candidates ranked by relevance. The agent does not select final past performance — a person does.
            </Disclaimer>
            {status.pastPerformance.proposedSelections.length === 0 ? (
              <p className="text-gray-500 mt-2">No past-performance candidate met the relevance threshold.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {status.pastPerformance.proposedSelections.map((p) => (
                  <li key={p.recordId} className="flex items-start justify-between gap-2 border border-gray-800 rounded p-2">
                    <div>
                      <p className="text-gray-300">{p.title}</p>
                      <p className="text-gray-500">{p.explanation}</p>
                    </div>
                    <Badge tone="neutral">{p.relevanceScore} · {p.confidence}</Badge>
                  </li>
                ))}
              </ul>
            )}
            {status.pastPerformance.approvedSelections.length > 0 && (
              <p className="text-gray-500 mt-2" data-testid="proposal-pp-approved">
                {status.pastPerformance.approvedSelections.length} record(s) have been selected by a person.
              </p>
            )}
            {status.pastPerformance.unsupportedClaims.map((u) => (
              <p key={`${u.recordId}-${u.claim}`} className="text-yellow-400 mt-1">
                Unsupported claim on {u.recordId}: {u.claim} — {u.reason}
              </p>
            ))}
          </div>

          {/* --- compliance ------------------------------------------------ */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs" data-testid="proposal-compliance">
            <h3 className="text-sm font-medium text-gray-200 mb-1">Compliance cross-check</h3>
            <Disclaimer>{status.compliance.aiAdvisoryNote}</Disclaimer>
            {status.compliance.deterministicBlockers.length > 0 && (
              <ul className="mt-2 space-y-1" data-testid="proposal-blockers">
                {status.compliance.deterministicBlockers.map((b) => (
                  <li key={b} className="border border-red-900/60 bg-red-950/20 rounded p-2 text-red-300">{b}</li>
                ))}
              </ul>
            )}
            {status.compliance.manualRequiredChecks.map((m) => (
              <p key={m} className="text-yellow-400 mt-1">{m}</p>
            ))}
            {status.compliance.legalReviewItems.map((l) => (
              <p key={l} className="text-orange-300 mt-1">{l}</p>
            ))}
          </div>

          {/* --- reviews ---------------------------------------------------- */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs" data-testid="proposal-reviews">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-gray-400" />
              <h3 className="text-sm font-medium text-gray-200">Review cycles</h3>
              <span className="text-gray-600 font-mono">{policy.cycleOrder.join(' → ')}</span>
            </div>
            {status.reviewCycles.length === 0 ? (
              <p className="text-gray-500">No review cycle has been opened.</p>
            ) : (
              <ul className="space-y-1">
                {status.reviewCycles.map((c) => (
                  <li key={c.cycleId} className="flex items-start justify-between gap-2 border border-gray-800 rounded p-2">
                    <div>
                      <span className="text-gray-300 font-mono">{c.cycleType}</span>
                      <p className="text-gray-500">{c.nextAction}</p>
                    </div>
                    <Badge tone={c.hasStalled ? 'danger' : c.isClosed ? 'success' : 'neutral'}>{c.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
            {status.sectionReviews.filter((r) => r.reviewerAssignmentRequired).map((r) => (
              <p key={r.sectionId} className="text-yellow-400 mt-1" data-testid="proposal-reviewer-required">
                “{r.title}” is awaiting review with no assigned reviewer. The agent does not choose a reviewer.
              </p>
            ))}
          </div>

          {/* --- readiness --------------------------------------------------- */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs" data-testid="proposal-readiness">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm font-medium text-gray-200">Submission readiness</h3>
              <Badge tone={status.submissionReadiness.state === 'READY' ? 'success' : 'warning'}>
                {status.submissionReadiness.state}
              </Badge>
            </div>
            <Disclaimer>
              Readiness is an assessment, not a submission. The agent never submits a proposal or sends anything to a
              government portal.
            </Disclaimer>
            {status.submissionReadiness.blockers.map((b) => (
              <p key={b} className="text-red-300 mt-1">{b}</p>
            ))}
            {status.submissionReadiness.manualRequired.map((m) => (
              <p key={m} className="text-yellow-400 mt-1">{m}</p>
            ))}
          </div>

          {status.recommendedHumanActions.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs" data-testid="proposal-actions">
              <h3 className="text-sm font-medium text-gray-200 mb-1">Recommended human actions</h3>
              <ul className="list-disc list-inside space-y-0.5 text-gray-400">
                {status.recommendedHumanActions.map((a) => <li key={a}>{a}</li>)}
              </ul>
            </div>
          )}

          {status.dataLimitations.length > 0 && <PartialDataNotice limitations={status.dataLimitations} />}
        </>
      )}

      {escalations.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="proposal-escalations">
          <h3 className="text-sm font-medium text-gray-200 mb-2">Open escalations ({escalations.length})</h3>
          <ul className="space-y-2">
            {escalations.map((e) => (
              <li key={e.id} className="border border-gray-800 rounded-lg p-2 text-xs">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" />
                  <span className="text-gray-300">{e.title}</span>
                  <Badge tone={e.severity === 'HIGH' ? 'danger' : 'warning'}>{e.severity}</Badge>
                </div>
                <p className="text-gray-500">{e.reason}</p>
                {e.recommendedAction && <p className="text-gray-400 mt-1">{e.recommendedAction}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-[11px] text-gray-500" data-testid="proposal-policy">
        <p className="text-gray-400 mb-1">Policy {policy.policyVersion}</p>
        <ul className="list-disc list-inside space-y-0.5">
          {policy.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </div>
    </div>
  )
}

function SectionRow({ section }: { section: SectionStatus }) {
  return (
    <li className="border border-gray-800 rounded-lg p-2 text-xs" data-testid={`proposal-section-${section.sectionId}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-gray-300">
            {section.sectionNumber && <span className="font-mono text-gray-500 mr-1">{section.sectionNumber}</span>}
            {section.title}
          </p>
          <p className="text-gray-500">
            {section.mandatoryRequirementIds.length} mandatory requirement(s) · review {section.reviewState}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {section.isLocked && (
            <span className="flex items-center gap-1 text-green-400" title="Approved — the agent may not overwrite it">
              <Lock className="w-3 h-3" />
              <span className="text-[10px] tracking-widest uppercase">Locked</span>
            </span>
          )}
          <Badge tone={COVERAGE_TONE[section.coverageState]}>{COVERAGE_LABEL[section.coverageState]}</Badge>
          <Badge tone={DRAFT_TONE[section.draftState]}>{DRAFT_LABEL[section.draftState]}</Badge>
        </div>
      </div>
      {section.sourceMaterialState === 'SOURCE_MATERIAL_REQUIRED' && (
        <p className="text-yellow-400 mt-1">
          No approved source material covers this section. Add and approve a capability narrative before drafting.
        </p>
      )}
      {section.overdue && <p className="text-orange-300 mt-1">This review is overdue.</p>}
    </li>
  )
}

export default ProposalAgentPanel
