// =============================================================
// §7.0 — Agent run detail.
//
// Shows what a run actually did: inputs, progress, outcome, confidence, data
// sufficiency, warnings, limitations, artifacts, escalations, token cost and
// the audit trail. Confidence and limitations are rendered verbatim from the
// backend — this page never upgrades a claim the run did not make.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Ban, FileJson, ShieldAlert } from 'lucide-react'
import { useToast } from '../components/Toast'
import { useAuth } from '../hooks/useAuth'
import {
  Badge, EmptyPanel, ErrorPanel, LoadingPanel, PartialDataNotice, VerifiedMark, formatDate,
} from '../components/section6/Section6Ui'
import { agentsApi, type AgentRunDetail as RunDetail, type AgentRunStatus } from '../services/agentsApi'
import { StatusPill } from '../components/ui'

// Tone word handed to StatusPill (the raw status is what gets displayed).
const STATUS_TONE: Record<AgentRunStatus, string> = {
  QUEUED: 'neutral', RUNNING: 'running', WAITING_FOR_REVIEW: 'review', COMPLETED: 'completed',
  FAILED: 'failed', CANCELLED: 'neutral', TIMED_OUT: 'failed', SKIPPED: 'neutral',
}

const CONFIDENCE_TONE = {
  HIGH: 'success', MEDIUM: 'info', LOW: 'warning', INSUFFICIENT_DATA: 'warning',
} as const

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } } }
  return e?.response?.data?.error || fallback
}

export default function AgentRunDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { toast } = useToast()
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'

  const [run, setRun] = useState<RunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    setError(null)
    try {
      setRun(await agentsApi.getRun(id))
    } catch (err) {
      setError(errorMessage(err, 'Could not load this run.'))
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  const cancel = async () => {
    if (!id) return
    setCancelling(true)
    try {
      await agentsApi.cancelRun(id)
      toast('Cancellation requested.', 'success')
      await load()
    } catch (err) {
      toast(errorMessage(err, 'Could not cancel this run.'), 'error')
    } finally { setCancelling(false) }
  }

  if (error) return <div className="max-w-5xl mx-auto px-6 py-8"><ErrorPanel message={error} onRetry={load} /></div>
  if (!run) return <div className="max-w-5xl mx-auto px-6 py-8"><LoadingPanel label="Loading run…" /></div>

  const cancellable = ['QUEUED', 'RUNNING', 'WAITING_FOR_REVIEW'].includes(run.status)

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <Link to="/agents" className="btn-ghost btn-sm -ml-2">
        <ArrowLeft className="w-3 h-3" /> Back to Agent Operations
      </Link>

      <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title">{run.agentName}</h1>
          <p className="text-xs mt-1 font-mono truncate" style={{ color: 'var(--text-faint)' }}>{run.id}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={STATUS_TONE[run.status]} size="lg">{run.status}</StatusPill>
          {run.confidenceState && <Badge tone={CONFIDENCE_TONE[run.confidenceState]}>{run.confidenceState}</Badge>}
          {cancellable && (
            <button
              type="button" onClick={() => void cancel()} disabled={!isAdmin || cancelling}
              title={isAdmin ? 'Cancel this run' : 'Only a firm admin can cancel a run.'}
              className="btn-danger btn-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Ban className="w-3 h-3" />{cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
        </div>
      </div>

      {run.outputSummary && <p className="text-sm text-gray-300">{run.outputSummary}</p>}

      {run.status === 'RUNNING' && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-gray-500">
            <span>{run.progressStage ?? 'in progress'}</span>
            <span className="tabular-nums">{run.progressPercent}%</span>
          </div>
          <div className="progress-track" style={{ height: 6 }}>
            <div className="progress-fill" style={{ transform: `scaleX(${run.progressPercent / 100})` }} />
          </div>
        </div>
      )}

      <section className="card">
        <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text)' }}>Execution</h2>
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2.5 text-[11px]">
          <Field label="Trigger" value={run.triggerType} />
          <Field label="Autonomy" value={run.autonomyLevel} mono />
          <Field label="Attempt" value={`${run.attempt} / ${run.maxAttempts}`} mono />
          <Field label="Data sufficiency" value={run.dataSufficiency ?? '—'} />
          <Field label="Started" value={formatDate(run.startedAt)} />
          <Field label="Finished" value={formatDate(run.finishedAt)} />
          <Field label="Duration" value={run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'} mono />
          <Field label="Last heartbeat" value={formatDate(run.heartbeatAt)} />
          <Field label="Entity" value={run.triggerEntityType ? `${run.triggerEntityType}:${run.triggerEntityId ?? '—'}` : '—'} mono />
          <Field label="Tokens in / out" value={`${run.tokenInput} / ${run.tokenOutput}`} mono />
          <Field label="Estimated cost" value={`$${Number(run.estimatedCostUsd ?? 0).toFixed(4)}`} mono />
          <Field label="Schedule" value={run.schedule ? `${run.schedule.cronExpression ?? run.schedule.scheduleType}` : '—'} mono />
        </dl>
      </section>

      {(run.errorCode || run.errorMessage) && (
        <section className="rounded-xl p-4 animate-fade-up" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
          <h2 className="text-sm font-semibold text-red-300 mb-1">Error</h2>
          <p className="text-xs text-red-300/90 font-mono">{run.errorCode}</p>
          <p className="text-xs text-red-300/80 mt-1">{run.errorMessage}</p>
        </section>
      )}

      {run.warnings?.length > 0 && (
        <section className="rounded-xl p-4" style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          <h2 className="text-sm font-semibold text-yellow-300 mb-2">Warnings</h2>
          <ul className="space-y-1 text-xs text-yellow-200/90 list-disc list-inside">
            {run.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </section>
      )}

      {run.limitations?.length > 0 && <PartialDataNotice limitations={run.limitations} />}

      <section>
        <h2 className="text-sm font-semibold text-gray-100 mb-3 flex items-center gap-2">
          <FileJson className="w-4 h-4 text-gray-500" /> Artifacts ({run.artifacts.length})
        </h2>
        {run.artifacts.length === 0 ? (
          <EmptyPanel message="This run produced no artifacts." />
        ) : (
          <div className="stagger space-y-3">
            {run.artifacts.map((a) => (
              <div key={a.id} data-testid={`artifact-${a.id}`} className="card space-y-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium text-gray-100">{a.title}</h3>
                    {a.summary && <p className="text-[11px] text-gray-500 mt-0.5">{a.summary}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{a.artifactType}</Badge>
                    <VerifiedMark verified={a.isHumanVerified} label={a.isHumanVerified ? 'Human-verified' : 'Not verified'} />
                  </div>
                </div>
                {a.supersededByArtifactId && (
                  <p className="text-[11px] text-gray-600">Superseded by a newer artifact.</p>
                )}
                <pre className="panel text-[10px] text-gray-400 p-3 overflow-x-auto">
                  {JSON.stringify(a.structuredData, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </section>

      {run.escalations.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-100 mb-3 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-orange-400" /> Escalations ({run.escalations.length})
          </h2>
          <div className="stagger space-y-2">
            {run.escalations.map((e) => (
              <div key={e.id} className="card p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-gray-200">{e.title}</span>
                  <div className="flex items-center gap-2">
                    <Badge tone="warning">{e.severity}</Badge>
                    <StatusPill status={e.status === 'OPEN' ? 'pending' : 'done'}>{e.status}</StatusPill>
                  </div>
                </div>
                <p className="text-[11px] text-gray-500 mt-1">{e.reason}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-gray-100 mb-3">Audit trail</h2>
        {run.auditEvents.length === 0 ? (
          <EmptyPanel message="No audit events recorded for this run." />
        ) : (
          <ol className="card p-0 divide-y divide-gray-800">
            {run.auditEvents.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 text-[11px]">
                <span className="text-gray-600 tabular-nums whitespace-nowrap">{formatDate(a.createdAt)}</span>
                <span className="text-gray-300 font-mono">{a.action}</span>
                <span className="text-gray-500">{a.rationale}</span>
                {!a.actorUserId && <span className="text-gray-700">(system)</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-gray-500">{label}</dt>
      <dd className={`text-gray-300 ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </>
  )
}
