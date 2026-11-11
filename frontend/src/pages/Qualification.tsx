import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { qualificationApi, gateReviewsApi, firmApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { PageHeader, Spinner, EmptyState, ErrorBanner } from '../components/ui'
import { CaptureEvidence } from '../components/CaptureEvidence'
import { WinProbabilityPanel } from '../components/WinProbabilityPanel'
import { ConfirmModal } from '../components/ConfirmModal'
import { ArrowLeft, ShieldCheck, AlertTriangle, History as HistoryIcon } from 'lucide-react'
import { QualificationAgentPanel } from '../components/section7/QualificationAgentPanel'
import { useIsContractor } from '../hooks/useAuth'
import {
  DecisionPanel, EngineSignals, RecommendationPanel, ScorecardPanel, label, recTone,
  type FirmUser, type HistoryRow, type ScorecardView,
} from '../components/qualify/QualifyScorecard'

interface GateReview { id: string; name: string; stage: string; status: string; reviewerUserId: string | null; dueDate: string | null; outcome: string | null; comments: string | null; isOverdue: boolean; isArchived: boolean; completedAt: string | null }

const gateTone: Record<string, string> = {
  NOT_STARTED: 'chip-neutral', IN_PROGRESS: 'chip-accent',
  APPROVED: 'chip-success', REJECTED: 'chip-danger',
  CHANGES_REQUIRED: 'chip-gold', WAIVED: 'chip-neutral',
}
const fieldCls = 'input !py-1.5 !px-2.5 !text-xs'
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')

export function QualificationPage() {
  const { pursuitId = '' } = useParams<{ pursuitId: string }>()
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const isContractor = useIsContractor()
  const qc = useQueryClient()
  const { toast } = useToast()
  // A consulting firm qualifies each client separately (?client=); a
  // contractor sends none and the backend uses its own company.
  const [params, setParams] = useSearchParams()
  const [clientId, setClientId] = useState<string | null>(params.get('client'))
  const forClient = isContractor ? null : clientId

  const sc = useQuery<{ data: ScorecardView }>({ queryKey: ['qualification', pursuitId, forClient], queryFn: () => qualificationApi.get(pursuitId, forClient) })
  // Adopt the client the backend chose (a firm's only client, or a legacy scorecard).
  const resolved = sc.data?.data.clientCompanyId
  useEffect(() => { if (!isContractor && !clientId && resolved) setClientId(resolved) }, [isContractor, clientId, resolved])
  const chooseClient = (id: string) => { setClientId(id); setParams((p) => { p.set('client', id); return p }, { replace: true }) }
  const gates = useQuery<{ data: GateReview[] }>({ queryKey: ['gate-reviews', pursuitId], queryFn: () => gateReviewsApi.listForPursuit(pursuitId) })
  const users = useQuery<{ data: FirmUser[] }>({ queryKey: ['firm-users'], queryFn: () => firmApi.users() })

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['qualification', pursuitId] }); qc.invalidateQueries({ queryKey: ['gate-reviews', pursuitId] }); qc.invalidateQueries({ queryKey: ['qualify-queue'] }) }
  const onError = (e: unknown) => toast((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Action failed', 'error')

  const [confirmReset, setConfirmReset] = useState(false)
  const start = useMutation({ mutationFn: () => qualificationApi.start(pursuitId, forClient), onSuccess: () => { invalidate(); toast('Scorecard started with suggested scores', 'success') }, onError })
  const saveScorecard = useMutation({ mutationFn: (scores: { key: string; score: number | null; evidence?: string | null }[]) => qualificationApi.saveScorecard(pursuitId, scores, forClient), onSuccess: () => { invalidate(); toast('Scores saved', 'success') }, onError })
  const refreshSuggestions = useMutation({ mutationFn: () => qualificationApi.refreshSuggestions(pursuitId, forClient), onSuccess: () => { invalidate(); toast('Suggestions refreshed', 'success') }, onError })
  const resetScorecard = useMutation({ mutationFn: () => qualificationApi.resetScorecard(pursuitId, forClient), onSuccess: () => { invalidate(); setConfirmReset(false); toast('Scores cleared', 'success') }, onError })
  const decide = useMutation({ mutationFn: (payload: Record<string, unknown>) => qualificationApi.decide(pursuitId, payload, forClient), onSuccess: () => { invalidate(); toast('Decision recorded', 'success') }, onError })
  const submitReview = useMutation({ mutationFn: (payload: Record<string, unknown>) => qualificationApi.submitReview(pursuitId, payload, forClient), onSuccess: () => { invalidate(); toast('Submitted for review', 'success') }, onError })
  const reassess = useMutation({ mutationFn: () => qualificationApi.reassess(pursuitId, undefined, forClient), onSuccess: () => { invalidate(); toast('Reopened for reassessment', 'success') }, onError })

  if (sc.isLoading) return <div className="flex justify-center mt-16"><Spinner size="lg" /></div>
  if (sc.error) {
    const msg = (sc.error as { response?: { data?: { error?: string } } })?.response?.data?.error
    return <div className="max-w-4xl mx-auto"><ErrorBanner message={msg ?? 'Could not load the scorecard. Please retry.'} /></div>
  }

  const data = sc.data!.data
  const opp = data.pursuit.opportunity
  const busy = start.isPending || saveScorecard.isPending || decide.isPending || submitReview.isPending || reassess.isPending

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link to="/pipeline" className="text-xs font-medium text-gray-500 hover:text-gray-300 inline-flex items-center gap-1"><ArrowLeft className="w-3 h-3" /> Back to pipeline</Link>
      <PageHeader title="Qualification" subtitle={`${opp.title} · ${opp.agency} · stage ${data.pursuit.pipelineStage}`} />
      <p className="text-xs text-gray-500">You can also qualify from the opportunity itself. <Link to={`/opportunities/${opp.id}${forClient ? `?client=${forClient}` : ''}#qualify`} className="text-blue-400 hover:text-blue-300">Open the opportunity →</Link></p>
      {!isAdmin && <p className="panel text-xs text-gray-500 px-3 py-2">Your team-member account has read-only access — scoring and decisions are available to firm admins.</p>}

      {!isContractor && (data.clients?.length ?? 0) > 0 && (
        <div className="card !py-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-500">Clients qualifying this notice:</span>
          {data.clients.map((c) => (
            <button key={c.clientCompanyId ?? 'firm'} type="button" aria-pressed={c.clientCompanyId === data.clientCompanyId}
              onClick={() => c.clientCompanyId && chooseClient(c.clientCompanyId)}
              className={`chip ${c.clientCompanyId === data.clientCompanyId ? 'chip-accent' : recTone[c.finalDecision ?? c.status] ?? 'chip-neutral'} cursor-pointer`}>
              {c.clientName}: {label(c.finalDecision ?? c.status)}
            </button>
          ))}
        </div>
      )}
      {data.signals && <EngineSignals signals={data.signals} />}

      {/* Win probability + calibration labelling (§5.1 Stage 3) */}
      <WinProbabilityPanel opportunityId={opp.id} />

      {/* §7.4 — the agent's recommendation and its evidence. It is a
          recommendation: the human decision lives in the scorecard below. */}
      <QualificationAgentPanel pursuitId={pursuitId!} />

      {!data.exists ? (
        <div className="card">
          <EmptyState message="Qualification has not been started for this opportunity." />
          <p className="text-xs text-gray-500 text-center mt-1">Bytescon fills in suggested scores from your records; you check them and decide.</p>
          {isAdmin && <div className="flex justify-center mt-3"><button disabled={busy} onClick={() => start.mutate()} className="btn-primary text-sm disabled:opacity-60">{start.isPending ? 'Starting…' : 'Start scorecard'}</button></div>}
        </div>
      ) : (
        <>
          <ScorecardPanel
            key={data.scorecard!.criteria.map((c) => `${c.key}:${c.score}:${c.evidence ?? ''}:${c.suggestedScore ?? ''}`).join('|')}
            scorecard={data.scorecard!}
            computed={data.computed!}
            isAdmin={isAdmin}
            closed={!!data.pursuit.closedAt}
            saving={saveScorecard.isPending}
            refreshing={refreshSuggestions.isPending}
            onSave={(scores) => saveScorecard.mutate(scores)}
            onRefresh={() => refreshSuggestions.mutate()}
            onReset={() => setConfirmReset(true)}
          />
          <RecommendationPanel scorecard={data.scorecard!} computed={data.computed!} />
          <DecisionPanel key={`${data.scorecard!.id}:${data.scorecard!.status}`} scorecard={data.scorecard!} computed={data.computed!} isAdmin={isAdmin} busy={busy} users={users.data?.data ?? []}
            noBidReasons={data.noBidReasons ?? []} onDecide={(p) => decide.mutate(p)} onSubmitReview={(p) => submitReview.mutate(p)} onReassess={() => reassess.mutate()} />
          <GateReviewsPanel pursuitId={pursuitId} scorecardId={data.scorecard!.id} isAdmin={isAdmin} userId={user?.id} users={users.data?.data ?? []}
            gates={gates.data?.data ?? []} loading={gates.isLoading} onChanged={invalidate} onError={onError} />
          <HistoryPanel history={data.scorecard!.history} />
        </>
      )}

      {/* Incumbent + competitor evidence (§5.1 Stage 3) — per opportunity */}
      <CaptureEvidence opportunityId={opp.id} />

      <ConfirmModal
        open={confirmReset}
        variant="archive"
        entityType="scorecard"
        entityName={opp.title}
        title="Reset scorecard?"
        confirmLabel="Reset scorecard"
        body="This clears every criterion score for this scorecard. The weighted total returns to 0. This is audited."
        loading={resetScorecard.isPending}
        onConfirm={() => resetScorecard.mutate()}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  )
}

function GateReviewsPanel({ pursuitId, scorecardId, isAdmin, userId, users, gates, loading, onChanged, onError }: {
  pursuitId: string; scorecardId: string; isAdmin: boolean; userId?: string; users: FirmUser[]
  gates: GateReview[]; loading: boolean; onChanged: () => void; onError: (e: unknown) => void
}) {
  const { toast } = useToast()
  const [showCreate, setShowCreate] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [name, setName] = useState('')
  const [reviewerUserId, setReviewerUserId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [comments, setComments] = useState('')

  const gq = useQuery<{ data: GateReview[] }>({ queryKey: ['gate-reviews', pursuitId, showArchived], queryFn: () => gateReviewsApi.listForPursuit(pursuitId, showArchived) })
  const rows = gq.data?.data ?? gates
  const isLoading = gq.isLoading || loading

  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); onChanged(); toast(msg, 'success') } catch (e) { onError(e) } }
  const reviewerName = (id: string | null) => { const u = users.find((x) => x.id === id); return u ? `${u.firstName} ${u.lastName}` : id ? 'reviewer' : 'unassigned' }
  // Reviewer actions require a reason ≥10 chars (server enforces; validate here too).
  const withReason = (label: string, run: (reason: string) => void) => {
    const r = window.prompt(label)
    if (r == null) return
    if (r.trim().length < 10) { toast('Reason must be at least 10 characters.', 'error'); return }
    run(r.trim())
  }

  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-2.5 mb-4"><span className="tile tile-sm tile-accent"><ShieldCheck className="w-4 h-4" /></span><h2 className="font-semibold text-gray-200 text-sm">Gate reviews</h2>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer select-none"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
          {isAdmin && <button onClick={() => setShowCreate((v) => !v)} className="btn-secondary btn-sm">New gate review</button>}
        </div>
      </div>

      {isAdmin && showCreate && (
        <form onSubmit={(e) => { e.preventDefault(); act(() => gateReviewsApi.create({ bidPursuitId: pursuitId, scorecardId, name, reviewerUserId: reviewerUserId || null, dueDate: dueDate ? new Date(dueDate).toISOString() : null, comments: comments.trim() || null }), 'Gate review created').then(() => { setShowCreate(false); setName(''); setReviewerUserId(''); setDueDate(''); setComments('') }) }} className="panel p-3 mb-4 grid grid-cols-1 md:grid-cols-3 gap-2 animate-fade-in">
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Review name *" className={`${fieldCls} md:col-span-2`} />
          <input value="GATE" disabled title="Stage" className={`${fieldCls} opacity-60`} />
          <select value={reviewerUserId} onChange={(e) => setReviewerUserId(e.target.value)} className={fieldCls}><option value="">Reviewer (ADMIN)</option>{users.filter((u) => u.role === 'ADMIN').map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}</select>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={fieldCls} />
          <button type="submit" className="btn-primary btn-sm">Create</button>
          <textarea value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Comments (optional)" rows={2} className={`${fieldCls} md:col-span-3`} />
        </form>
      )}

      {isLoading ? <Spinner size="sm" /> : rows.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-6">No gate reviews yet.</p>
      ) : (
        <ul className="stagger space-y-2">
          {rows.map((g) => {
            const isReviewer = g.reviewerUserId === userId
            return (
              <li key={g.id} className={`panel p-3 ${g.isArchived ? 'opacity-50' : g.isOverdue ? '!border-red-500/50' : ''}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-gray-200">{g.name}</span>
                  <span className={`chip ${gateTone[g.status] ?? 'chip-neutral'}`}>{g.status.replace('_', ' ')}</span>
                  {g.isArchived && <span className="chip chip-neutral !text-[9px] uppercase tracking-wide">archived</span>}
                  {g.isOverdue && !g.isArchived && <span className="chip chip-danger !text-[10px]"><AlertTriangle className="w-3 h-3" /> OVERDUE</span>}
                  <span className="text-[10px] text-gray-500 ml-auto tabular-nums">Reviewer: {reviewerName(g.reviewerUserId)} · due {fmtDate(g.dueDate)}</span>
                </div>
                {g.comments && <p className="text-[11px] text-gray-500 mt-1">{g.comments}</p>}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {g.isArchived ? (
                    isAdmin && <button onClick={() => act(() => gateReviewsApi.restore(g.id), 'Restored')} className="text-[11px] text-gray-500 hover:text-green-400">Restore</button>
                  ) : (
                    <>
                      {isAdmin && (g.status === 'NOT_STARTED' || g.status === 'CHANGES_REQUIRED') && <button onClick={() => act(() => gateReviewsApi.submit(g.id), 'Submitted')} className="btn-secondary btn-sm">Submit for review</button>}
                      {isReviewer && g.status === 'IN_PROGRESS' && <>
                        <button onClick={() => withReason('Reason for approval? (min 10 chars)', (r) => act(() => gateReviewsApi.approve(g.id, r), 'Approved'))} className="btn-secondary btn-sm !text-green-600 hover:!border-green-500">Approve</button>
                        <button onClick={() => withReason('Reason for requesting changes? (min 10 chars)', (r) => act(() => gateReviewsApi.requestChanges(g.id, r), 'Changes requested'))} className="btn-secondary btn-sm !text-amber-600 hover:!border-amber-500">Request changes</button>
                        <button onClick={() => withReason('Reason for rejection? (min 10 chars)', (r) => act(() => gateReviewsApi.reject(g.id, r), 'Rejected'))} className="btn-danger btn-sm">Reject</button>
                      </>}
                      {isAdmin && !['APPROVED', 'REJECTED', 'WAIVED'].includes(g.status) && <button onClick={() => withReason('Reason for waiving this gate? (min 10 chars)', (r) => act(() => gateReviewsApi.waive(g.id, r), 'Waived'))} className="text-[11px] px-2 py-0.5 rounded text-gray-500 hover:text-gray-300">Waive</button>}
                      {isAdmin && g.status === 'NOT_STARTED' && <button onClick={() => act(() => gateReviewsApi.archive(g.id), 'Archived')} className="text-[11px] px-2 py-0.5 rounded text-gray-500 hover:text-red-400 ml-auto">Archive</button>}
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function HistoryPanel({ history }: { history: HistoryRow[] }) {
  if (!history || history.length === 0) return null
  return (
    <div className="card">
      <div className="flex items-center gap-2.5 mb-4"><span className="tile tile-sm tile-neutral"><HistoryIcon className="w-4 h-4" /></span><h2 className="font-semibold text-gray-200 text-sm">Decision history</h2></div>
      <ul>
        {history.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center gap-2 text-xs py-2 border-b border-gray-800 last:border-0">
            <span className={`chip ${recTone[h.status] ?? recTone.NOT_REVIEWED}`}>{h.status.replace('_', ' ')}</span>
            <span className="text-gray-400">{h.changeReason}</span>
            {h.isOverride && <span className="text-[10px] text-amber-500">override: {h.overrideReason}</span>}
            <span className="text-gray-600 ml-auto font-mono tabular-nums">score {h.totalScore} · {new Date(h.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default QualificationPage
