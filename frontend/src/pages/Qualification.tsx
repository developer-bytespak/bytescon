import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { qualificationApi, gateReviewsApi, firmApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { PageHeader, Spinner, EmptyState, ErrorBanner } from '../components/ui'
import { CaptureEvidence } from '../components/CaptureEvidence'
import { WinProbabilityPanel } from '../components/WinProbabilityPanel'
import { ConfirmModal } from '../components/ConfirmModal'
import { ArrowLeft, Scale, ShieldCheck, AlertTriangle, History as HistoryIcon, Gavel } from 'lucide-react'
import { QualificationAgentPanel } from '../components/section7/QualificationAgentPanel'

interface FirmUser { id: string; firstName: string; lastName: string; email: string; role: string }
interface Criterion { id: string; key: string; name: string; description: string | null; weight: number; score: number | null; required: boolean; displayOrder: number; evidence: string | null }
interface Computed { totalScore: number; recommendation: string; complete: boolean; missingRequiredKeys: string[]; recommendationVersion: string }
interface Scorecard {
  id: string; status: string; totalScore: number; recommendation: string | null; recommendationVersion: string
  finalDecision: string | null; isOverride: boolean; overrideReason: string | null; decidedByUserId: string | null; decidedAt: string | null
  reviewerUserId: string | null; reviewerComments: string | null; submittedForReviewAt: string | null
  criteria: Criterion[]; history: HistoryRow[]
}
interface HistoryRow { id: string; status: string; recommendation: string | null; totalScore: number; isOverride: boolean; overrideReason: string | null; changeReason: string | null; createdAt: string }
interface GateReview { id: string; name: string; stage: string; status: string; reviewerUserId: string | null; dueDate: string | null; outcome: string | null; comments: string | null; isOverdue: boolean; isArchived: boolean; completedAt: string | null }
interface ScorecardResponse { data: { exists: boolean; scorecard?: Scorecard; computed?: Computed; pursuit: { id: string; pipelineStage: string; closedAt: string | null; opportunity: { id: string; title: string; agency: string } } } }

const FINAL_DECISIONS = ['BID', 'NO_BID', 'CONDITIONAL', 'DEFERRED'] as const
const recTone: Record<string, string> = {
  BID: 'bg-green-950/40 border-green-800 text-green-300',
  NO_BID: 'bg-red-950/40 border-red-800 text-red-300',
  CONDITIONAL: 'bg-yellow-950/40 border-yellow-800 text-yellow-300',
  REVIEW_REQUIRED: 'bg-blue-950/40 border-blue-800 text-blue-300',
  DEFERRED: 'bg-gray-800 border-gray-700 text-gray-300',
  NOT_REVIEWED: 'bg-gray-800 border-gray-700 text-gray-400',
  IN_REVIEW: 'bg-blue-950/40 border-blue-800 text-blue-300',
}
const gateTone: Record<string, string> = {
  NOT_STARTED: 'bg-gray-800 border-gray-700 text-gray-400', IN_PROGRESS: 'bg-blue-950/40 border-blue-800 text-blue-300',
  APPROVED: 'bg-green-950/40 border-green-800 text-green-300', REJECTED: 'bg-red-950/40 border-red-800 text-red-300',
  CHANGES_REQUIRED: 'bg-orange-950/40 border-orange-800 text-orange-300', WAIVED: 'bg-gray-800 border-gray-700 text-gray-400',
}
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')
// Mirrors backend override rule: a decision differing from a concrete system
// recommendation is an override (server re-validates + requires the reason).
function isOverride(recommendation: string | null | undefined, decision: string): boolean {
  if (!recommendation || recommendation === 'REVIEW_REQUIRED') return true
  return recommendation !== decision
}

export function QualificationPage() {
  const { pursuitId = '' } = useParams<{ pursuitId: string }>()
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const qc = useQueryClient()
  const { toast } = useToast()

  const sc = useQuery<ScorecardResponse>({ queryKey: ['qualification', pursuitId], queryFn: () => qualificationApi.get(pursuitId) })
  const gates = useQuery<{ data: GateReview[] }>({ queryKey: ['gate-reviews', pursuitId], queryFn: () => gateReviewsApi.listForPursuit(pursuitId) })
  const users = useQuery<{ data: FirmUser[] }>({ queryKey: ['firm-users'], queryFn: () => firmApi.users() })

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['qualification', pursuitId] }); qc.invalidateQueries({ queryKey: ['gate-reviews', pursuitId] }) }
  const onError = (e: unknown) => toast((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Action failed', 'error')

  const [confirmReset, setConfirmReset] = useState(false)
  const start = useMutation({ mutationFn: () => qualificationApi.start(pursuitId), onSuccess: () => { invalidate(); toast('Qualification started', 'success') }, onError })
  const score = useMutation({ mutationFn: ({ key, payload }: { key: string; payload: Record<string, unknown> }) => qualificationApi.score(pursuitId, key, payload), onSuccess: invalidate, onError })
  const saveScorecard = useMutation({ mutationFn: (scores: { key: string; score: number | null; evidence?: string | null }[]) => qualificationApi.saveScorecard(pursuitId, scores), onSuccess: () => { invalidate(); toast('Scorecard saved', 'success') }, onError })
  const resetScorecard = useMutation({ mutationFn: () => qualificationApi.resetScorecard(pursuitId), onSuccess: () => { invalidate(); setConfirmReset(false); toast('Scorecard reset', 'success') }, onError })
  const decide = useMutation({ mutationFn: (payload: Record<string, unknown>) => qualificationApi.decide(pursuitId, payload), onSuccess: () => { invalidate(); toast('Decision recorded', 'success') }, onError })
  const submitReview = useMutation({ mutationFn: (payload: Record<string, unknown>) => qualificationApi.submitReview(pursuitId, payload), onSuccess: () => { invalidate(); toast('Submitted for review', 'success') }, onError })
  const reassess = useMutation({ mutationFn: () => qualificationApi.reassess(pursuitId), onSuccess: () => { invalidate(); toast('Reopened for reassessment', 'success') }, onError })

  if (sc.isLoading) return <div className="flex justify-center mt-16"><Spinner size="lg" /></div>
  if (sc.error) return <div className="max-w-4xl mx-auto"><ErrorBanner message="Could not load the scorecard. Please retry." /></div>

  const data = sc.data!.data
  const opp = data.pursuit.opportunity
  const busy = start.isPending || score.isPending || decide.isPending || submitReview.isPending || reassess.isPending

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <Link to="/pipeline" className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1"><ArrowLeft className="w-3 h-3" /> Back to pipeline</Link>
      <PageHeader title="Qualification" subtitle={`${opp.title} · ${opp.agency} · stage ${data.pursuit.pipelineStage}`} />
      {!isAdmin && <p className="text-xs text-gray-500">Your team-member account has read-only access — scoring and decisions are available to firm admins.</p>}

      {/* Win probability + calibration labelling (§5.1 Stage 3) */}
      <WinProbabilityPanel opportunityId={opp.id} />

      {/* §7.4 — the agent's recommendation and its evidence. It is a
          recommendation: the human decision lives in the scorecard below. */}
      <QualificationAgentPanel pursuitId={pursuitId!} />

      {!data.exists ? (
        <div className="card">
          <EmptyState message="Qualification has not been started for this opportunity." />
          {isAdmin && <div className="flex justify-center mt-3"><button disabled={busy} onClick={() => start.mutate()} className="btn-primary text-sm disabled:opacity-60">{start.isPending ? 'Starting…' : 'Start qualification'}</button></div>}
        </div>
      ) : (
        <>
          <ScorecardPanel
            key={data.scorecard!.criteria.map((c) => `${c.key}:${c.score}:${c.evidence ?? ''}`).join('|')}
            scorecard={data.scorecard!}
            computed={data.computed!}
            isAdmin={isAdmin}
            closed={!!data.pursuit.closedAt}
            saving={saveScorecard.isPending}
            onSave={(scores) => saveScorecard.mutate(scores)}
            onReset={() => setConfirmReset(true)}
          />
          <RecommendationPanel scorecard={data.scorecard!} computed={data.computed!} />
          <DecisionPanel scorecard={data.scorecard!} computed={data.computed!} isAdmin={isAdmin} busy={busy} users={users.data?.data ?? []}
            onDecide={(p) => decide.mutate(p)} onSubmitReview={(p) => submitReview.mutate(p)} onReassess={() => reassess.mutate()} />
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

interface DraftRow { score: string; evidence: string }

function ScorecardPanel({ scorecard, computed, isAdmin, closed, saving, onSave, onReset }: {
  scorecard: Scorecard; computed: Computed; isAdmin: boolean; closed: boolean; saving: boolean
  onSave: (scores: { key: string; score: number | null; evidence?: string | null }[]) => void; onReset: () => void
}) {
  // Local draft keyed by criterion; re-seeded whenever the persisted scorecard
  // changes (updatedAt in the key). Server recomputes the total on save.
  const seed = (): Record<string, DraftRow> => {
    const m: Record<string, DraftRow> = {}
    for (const c of scorecard.criteria) m[c.key] = { score: c.score != null ? String(c.score) : '', evidence: c.evidence ?? '' }
    return m
  }
  // Parent remounts this panel (via key) when persisted scores change, so the
  // draft is re-seeded from fresh props after every save/reset.
  const [draft, setDraft] = useState<Record<string, DraftRow>>(seed)

  const invalid = (v: string): boolean => {
    if (v === '') return false
    const n = Number(v)
    return !Number.isInteger(n) || n < 0 || n > 100
  }
  const anyInvalid = scorecard.criteria.some((c) => invalid(draft[c.key]?.score ?? ''))
  const editable = isAdmin && !closed

  const contribution = (c: Criterion) => {
    const v = draft[c.key]?.score ?? ''
    return v !== '' && !invalid(v) ? Math.round((Number(v) * c.weight) / 100) : '—'
  }

  const submit = () => {
    if (anyInvalid) return
    onSave(scorecard.criteria.map((c) => ({
      key: c.key,
      score: draft[c.key]?.score === '' ? null : Number(draft[c.key].score),
      evidence: draft[c.key]?.evidence?.trim() ? draft[c.key].evidence.trim() : null,
    })))
  }

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-3">
        <Scale className="w-4 h-4 text-blue-400" />
        <h2 className="font-semibold text-gray-200 text-sm">Weighted scorecard</h2>
        <span className="text-[10px] text-gray-500 font-mono ml-auto">{computed.recommendationVersion} · weights total 100</span>
      </div>
      {closed && <p className="text-[11px] text-gray-500 mb-2">This pursuit is closed — the scorecard is read-only. Reopen the pursuit to edit.</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2 pr-3">Criterion</th><th className="w-16">Weight</th><th className="w-28">Score (0–100)</th><th className="w-24">Contribution</th><th>Evidence</th></tr></thead>
          <tbody>
            {scorecard.criteria.map((c) => {
              const row = draft[c.key] ?? { score: '', evidence: '' }
              const bad = invalid(row.score)
              return (
                <tr key={c.id} className="border-b border-gray-900 align-top">
                  <td className="py-2 pr-3">
                    <span className="text-gray-200">{c.name}</span>{c.required && <span className="ml-1 text-[9px] text-red-400">*</span>}
                    {c.description && <p className="text-[10px] text-gray-500 mt-0.5">{c.description}</p>}
                  </td>
                  <td className="text-gray-400 text-xs">{c.weight}</td>
                  <td>
                    {editable ? (
                      <>
                        <input type="number" min={0} max={100} value={row.score} disabled={saving}
                          onChange={(e) => setDraft((d) => ({ ...d, [c.key]: { ...row, score: e.target.value } }))}
                          className={`w-16 bg-gray-800 border rounded px-2 py-1 text-xs text-gray-200 ${bad ? 'border-red-600' : 'border-gray-700'}`} aria-label={`Score for ${c.name}`} />
                        {bad && <p className="text-[10px] text-red-400 mt-0.5">0–100 only</p>}
                      </>
                    ) : <span className="text-gray-300 text-xs">{c.score ?? '—'}</span>}
                  </td>
                  <td className="text-gray-400 text-xs">{editable ? contribution(c) : (c.score != null ? Math.round((c.score * c.weight) / 100) : '—')}</td>
                  <td>
                    {editable ? (
                      <input value={row.evidence} placeholder="notes / evidence" disabled={saving}
                        onChange={(e) => setDraft((d) => ({ ...d, [c.key]: { ...row, evidence: e.target.value } }))}
                        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-300" aria-label={`Evidence for ${c.name}`} />
                    ) : <span className="text-[11px] text-gray-500">{c.evidence || '—'}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot><tr><td className="pt-2 text-gray-300 font-medium" colSpan={3}>Weighted total (server-computed)</td><td className="pt-2 text-gray-100 font-bold font-mono">{`${computed.totalScore}/100`}</td><td /></tr></tfoot>
        </table>
      </div>
      {editable && (
        <div className="flex items-center gap-2 mt-3">
          <button disabled={saving || anyInvalid} onClick={submit} className="btn-primary text-sm disabled:opacity-50">{saving ? 'Saving…' : 'Save scorecard'}</button>
          <button disabled={saving} onClick={onReset} className="text-sm px-4 py-2 rounded-lg border bg-red-900/30 hover:bg-red-900/50 text-red-300 border-red-700 disabled:opacity-50">Reset scorecard</button>
          {anyInvalid && <span className="text-[11px] text-red-400">Fix out-of-range scores before saving.</span>}
        </div>
      )}
    </div>
  )
}

function RecommendationPanel({ scorecard, computed }: { scorecard: Scorecard; computed: Computed }) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-2"><ShieldCheck className="w-4 h-4 text-blue-400" /><h2 className="font-semibold text-gray-200 text-sm">System recommendation</h2></div>
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`text-xs px-2 py-1 rounded border font-medium ${recTone[computed.recommendation]}`}>{computed.recommendation.replace('_', ' ')}</span>
        <span className="text-xs text-gray-500">{`score ${computed.totalScore}/100`} · thresholds BID≥70 · CONDITIONAL 50-69 · NO_BID&lt;50</span>
      </div>
      {!computed.complete && (
        <p className="text-[11px] text-yellow-400 mt-2 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Missing required scores: {computed.missingRequiredKeys.join(', ')}</p>
      )}
      <p className="text-[10px] text-gray-500 mt-2">This is a system recommendation, not the final decision. A human records the bid/no-bid decision below.</p>
      {scorecard.isOverride && scorecard.finalDecision && (
        <div className="mt-3 bg-orange-950/20 border border-orange-800/60 rounded-lg p-2.5">
          <p className="text-[11px] text-orange-300 font-medium">⚠ Human override — final decision {scorecard.finalDecision.replace('_', ' ')} differs from the system recommendation.</p>
          <p className="text-[11px] text-gray-400 mt-1">Reason: {scorecard.overrideReason}</p>
        </div>
      )}
    </div>
  )
}

function DecisionPanel({ scorecard, computed, isAdmin, busy, users, onDecide, onSubmitReview, onReassess }: {
  scorecard: Scorecard; computed: Computed; isAdmin: boolean; busy: boolean; users: FirmUser[]
  onDecide: (p: Record<string, unknown>) => void; onSubmitReview: (p: Record<string, unknown>) => void; onReassess: () => void
}) {
  const [decision, setDecision] = useState('')
  const [reason, setReason] = useState('')
  const [reviewerUserId, setReviewerUserId] = useState(scorecard.reviewerUserId ?? '')
  const decided = ['BID', 'NO_BID', 'CONDITIONAL', 'DEFERRED'].includes(scorecard.status)
  const overrideNeeded = decision !== '' && isOverride(computed.recommendation, decision)

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-3"><Gavel className="w-4 h-4 text-blue-400" /><h2 className="font-semibold text-gray-200 text-sm">Final human decision</h2>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ml-auto ${recTone[scorecard.status] ?? recTone.NOT_REVIEWED}`}>{scorecard.status.replace('_', ' ')}</span>
      </div>

      {decided ? (
        <div className="space-y-2">
          <p className="text-sm text-gray-200">
            Decision: <span className={`px-1.5 py-0.5 rounded border text-xs ${recTone[scorecard.finalDecision ?? scorecard.status]}`}>{(scorecard.finalDecision ?? scorecard.status).replace('_', ' ')}</span>
            {scorecard.isOverride && <span className="ml-2 text-[10px] text-orange-300">(override)</span>}
            <span className="ml-2 text-[11px] text-gray-500">vs system {(scorecard.recommendation ?? '—').replace('_', ' ')}</span>
          </p>
          <p className="text-xs text-gray-500">Decided {fmtDate(scorecard.decidedAt)}. Decisions are immutable — recording a new one supersedes this entry but never deletes it (see history).</p>
          {isAdmin && <button disabled={busy} onClick={onReassess} className="btn-secondary text-xs disabled:opacity-60">Record new decision</button>}
        </div>
      ) : !isAdmin ? (
        <p className="text-xs text-gray-500">Awaiting a firm admin to record the decision.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select value={reviewerUserId} onChange={(e) => setReviewerUserId(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200">
              <option value="">Reviewer (optional)</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}
            </select>
            <button disabled={busy || !computed.complete} onClick={() => onSubmitReview({ reviewerUserId: reviewerUserId || null })} className="btn-secondary text-xs disabled:opacity-50">Submit for review</button>
          </div>
          <div className="border-t border-gray-800 pt-3">
            <p className="text-[11px] text-gray-500 mb-2">System recommends <span className={`px-1.5 py-0.5 rounded border ${recTone[computed.recommendation]}`}>{computed.recommendation.replace('_', ' ')}</span> — your decision is recorded next to it and either endorses or overrides it.</p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {FINAL_DECISIONS.map((d) => (
                <button key={d} onClick={() => setDecision(d)} className={`text-xs px-3 py-1.5 rounded border ${decision === d ? recTone[d] : 'bg-gray-800 border-gray-700 text-gray-300'}`}>{d.replace('_', ' ')}</button>
              ))}
            </div>
            {overrideNeeded && (
              <div className="mb-2">
                <label className="text-[11px] text-orange-300 flex items-center gap-1 mb-1"><AlertTriangle className="w-3 h-3" /> This overrides the {computed.recommendation.replace('_', ' ')} recommendation — a reason of at least 20 characters is required.</label>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Override reason (min 20 characters)" className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200" />
                <p className={`text-[10px] mt-0.5 ${reason.trim().length < 20 ? 'text-red-400' : 'text-gray-500'}`}>{reason.trim().length}/20 characters minimum</p>
              </div>
            )}
            <button
              disabled={busy || decision === '' || !computed.complete || (overrideNeeded && reason.trim().length < 20)}
              onClick={() => onDecide({ decision, overrideReason: overrideNeeded ? reason.trim() : undefined })}
              className="btn-primary text-sm disabled:opacity-50">{busy ? 'Recording…' : 'Record decision'}</button>
            {!computed.complete && <p className="text-[10px] text-yellow-400 mt-1">Score all required criteria before deciding.</p>}
          </div>
        </div>
      )}
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
      <div className="flex items-center gap-2 mb-3"><ShieldCheck className="w-4 h-4 text-blue-400" /><h2 className="font-semibold text-gray-200 text-sm">Gate reviews</h2>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
          {isAdmin && <button onClick={() => setShowCreate((v) => !v)} className="btn-secondary text-xs">New gate review</button>}
        </div>
      </div>

      {isAdmin && showCreate && (
        <form onSubmit={(e) => { e.preventDefault(); act(() => gateReviewsApi.create({ bidPursuitId: pursuitId, scorecardId, name, reviewerUserId: reviewerUserId || null, dueDate: dueDate ? new Date(dueDate).toISOString() : null, comments: comments.trim() || null }), 'Gate review created').then(() => { setShowCreate(false); setName(''); setReviewerUserId(''); setDueDate(''); setComments('') }) }} className="bg-gray-900/50 border border-gray-800 rounded-lg p-3 mb-3 grid grid-cols-1 md:grid-cols-3 gap-2">
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Review name *" className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 md:col-span-2" />
          <input value="GATE" disabled title="Stage" className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-500" />
          <select value={reviewerUserId} onChange={(e) => setReviewerUserId(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200"><option value="">Reviewer (ADMIN)</option>{users.filter((u) => u.role === 'ADMIN').map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}</select>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200" />
          <button type="submit" className="btn-primary text-xs">Create</button>
          <textarea value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Comments (optional)" rows={2} className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 md:col-span-3" />
        </form>
      )}

      {isLoading ? <Spinner size="sm" /> : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No gate reviews yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((g) => {
            const isReviewer = g.reviewerUserId === userId
            return (
              <li key={g.id} className={`border rounded-lg p-2.5 ${g.isArchived ? 'opacity-50 border-gray-800' : g.isOverdue ? 'border-red-800/70 bg-red-950/10' : 'border-gray-800'}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-gray-200">{g.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${gateTone[g.status]}`}>{g.status.replace('_', ' ')}</span>
                  {g.isArchived && <span className="text-[9px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded px-1">archived</span>}
                  {g.isOverdue && !g.isArchived && <span className="text-[10px] text-red-300 flex items-center gap-0.5"><AlertTriangle className="w-3 h-3" /> OVERDUE</span>}
                  <span className="text-[10px] text-gray-500 ml-auto">Reviewer: {reviewerName(g.reviewerUserId)} · due {fmtDate(g.dueDate)}</span>
                </div>
                {g.comments && <p className="text-[11px] text-gray-500 mt-1">{g.comments}</p>}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {g.isArchived ? (
                    isAdmin && <button onClick={() => act(() => gateReviewsApi.restore(g.id), 'Restored')} className="text-[11px] text-gray-500 hover:text-green-400">Restore</button>
                  ) : (
                    <>
                      {isAdmin && (g.status === 'NOT_STARTED' || g.status === 'CHANGES_REQUIRED') && <button onClick={() => act(() => gateReviewsApi.submit(g.id), 'Submitted')} className="text-[11px] px-2 py-0.5 rounded bg-gray-700 text-gray-100">Submit for review</button>}
                      {isReviewer && g.status === 'IN_PROGRESS' && <>
                        <button onClick={() => withReason('Reason for approval? (min 10 chars)', (r) => act(() => gateReviewsApi.approve(g.id, r), 'Approved'))} className="text-[11px] px-2 py-0.5 rounded bg-green-900/40 border border-green-700 text-green-300">Approve</button>
                        <button onClick={() => withReason('Reason for requesting changes? (min 10 chars)', (r) => act(() => gateReviewsApi.requestChanges(g.id, r), 'Changes requested'))} className="text-[11px] px-2 py-0.5 rounded bg-orange-900/40 border border-orange-700 text-orange-300">Request changes</button>
                        <button onClick={() => withReason('Reason for rejection? (min 10 chars)', (r) => act(() => gateReviewsApi.reject(g.id, r), 'Rejected'))} className="text-[11px] px-2 py-0.5 rounded bg-red-900/40 border border-red-700 text-red-300">Reject</button>
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
      <div className="flex items-center gap-2 mb-3"><HistoryIcon className="w-4 h-4 text-blue-400" /><h2 className="font-semibold text-gray-200 text-sm">Decision history</h2></div>
      <ul className="space-y-1.5">
        {history.map((h) => (
          <li key={h.id} className="flex items-center gap-2 text-xs border-b border-gray-900 pb-1.5">
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${recTone[h.status] ?? recTone.NOT_REVIEWED}`}>{h.status.replace('_', ' ')}</span>
            <span className="text-gray-400">{h.changeReason}</span>
            {h.isOverride && <span className="text-[10px] text-orange-300">override: {h.overrideReason}</span>}
            <span className="text-gray-600 ml-auto font-mono">score {h.totalScore} · {new Date(h.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default QualificationPage
