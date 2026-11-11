// =============================================================
// The qualification scorecard pieces, shared by the qualify panel on the
// opportunity page and the full qualification page (/pipeline/:id):
//   EngineSignals   what the scoring engine already says (inputs, not the decision)
//   ScorecardPanel  criteria pre-filled with suggested scores and their reasons
//   RecommendationPanel / DecisionPanel  the system recommendation, then the
//                   person's Bid / No-bid / Conditional / Defer, with a reason
// Data: /api/qualification (backend routes/qualification.ts).
// =============================================================
import { useState } from 'react'
import { AlertTriangle, Gavel, RefreshCw, Scale, ShieldCheck, Sparkles } from 'lucide-react'

export interface FirmUser { id: string; firstName: string; lastName: string; email: string; role: string }
export interface Criterion {
  id: string; key: string; name: string; description: string | null; weight: number; score: number | null; required: boolean
  displayOrder: number; evidence: string | null; suggestedScore?: number | null; suggestionNote?: string | null
}
export interface Computed { totalScore: number; recommendation: string; complete: boolean; missingRequiredKeys: string[]; recommendationVersion: string }
export interface HistoryRow { id: string; status: string; recommendation: string | null; totalScore: number; isOverride: boolean; overrideReason: string | null; changeReason: string | null; createdAt: string }
export interface Scorecard {
  id: string; status: string; totalScore: number; recommendation: string | null; recommendationVersion: string
  finalDecision: string | null; isOverride: boolean; overrideReason: string | null; decidedByUserId: string | null; decidedAt: string | null
  reviewerUserId: string | null; reviewerComments: string | null; submittedForReviewAt: string | null
  noBidReason?: string | null; noBidNote?: string | null; quickDecision?: boolean
  criteria: Criterion[]; history: HistoryRow[]
}
export interface ClientLine { clientCompanyId: string | null; clientName: string; status: string; finalDecision: string | null; totalScore: number }
export interface Signals { winProbability: number | null; engineRecommendation: string | null; scoredAt: string | null }
export interface NoBidReason { key: string; label: string }
export interface ScorecardView {
  exists: boolean; scorecard?: Scorecard; computed?: Computed
  clientCompanyId: string | null; clients: ClientLine[]; signals: Signals; noBidReasons: NoBidReason[]
  pursuit: { id: string; pipelineStage: string; closedAt: string | null; opportunity: { id: string; title: string; agency: string } }
}

export const FINAL_DECISIONS = ['BID', 'NO_BID', 'CONDITIONAL', 'DEFERRED'] as const
export const DECIDED = ['BID', 'NO_BID', 'CONDITIONAL', 'DEFERRED']
export const recTone: Record<string, string> = {
  BID: 'chip-success', NO_BID: 'chip-danger', CONDITIONAL: 'chip-gold', REVIEW_REQUIRED: 'chip-accent',
  DEFERRED: 'chip-neutral', NOT_REVIEWED: 'chip-neutral', IN_REVIEW: 'chip-accent',
}
export const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
const fieldCls = 'input !py-1.5 !px-2.5 !text-xs'
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')

/** Mirrors the backend override rule; the server re-checks it. */
export function isOverride(recommendation: string | null | undefined, decision: string): boolean {
  if (!recommendation || recommendation === 'REVIEW_REQUIRED') return true
  return recommendation !== decision
}

/** The scoring engine's view, shown as an input to the person's decision. */
export function EngineSignals({ signals }: { signals: Signals }) {
  const pct = signals.winProbability == null ? null : Math.round(signals.winProbability * 100)
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs" style={{ color: 'var(--text-2)' }}>
      <span className="inline-flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} aria-hidden="true" />
        AI win probability: <strong style={{ color: 'var(--text)' }}>{pct == null ? 'not scored yet' : `${pct}%`}</strong></span>
      {signals.engineRecommendation && (
        <span>Bid Decisions engine suggests: <strong style={{ color: 'var(--text)' }}>{label(signals.engineRecommendation)}</strong></span>
      )}
      <span style={{ color: 'var(--text-muted)' }}>Inputs to your decision, not the decision.</span>
    </div>
  )
}

interface DraftRow { score: string; evidence: string }

export function ScorecardPanel({ scorecard, computed, isAdmin, closed, saving, refreshing, onSave, onReset, onRefresh, compact = false }: {
  scorecard: Scorecard; computed: Computed; isAdmin: boolean; closed: boolean; saving: boolean; refreshing?: boolean
  onSave: (scores: { key: string; score: number | null; evidence?: string | null }[]) => void; onReset?: () => void; onRefresh?: () => void
  /** In the qualify panel: no card frame. */
  compact?: boolean
}) {
  // The parent remounts this (via key) when persisted scores change, so the
  // draft is re-seeded from fresh props after every save, refresh or reset.
  const [draft, setDraft] = useState<Record<string, DraftRow>>(() =>
    Object.fromEntries(scorecard.criteria.map((c) => [c.key, { score: c.score != null ? String(c.score) : '', evidence: c.evidence ?? '' }])))

  const invalid = (v: string) => v !== '' && (!Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) > 100)
  const anyInvalid = scorecard.criteria.some((c) => invalid(draft[c.key]?.score ?? ''))
  const decided = DECIDED.includes(scorecard.status)
  const editable = isAdmin && !closed && !decided
  const dirty = scorecard.criteria.some((c) => (draft[c.key]?.score ?? '') !== (c.score != null ? String(c.score) : '') || (draft[c.key]?.evidence ?? '') !== (c.evidence ?? ''))
  const needsYou = scorecard.criteria.filter((c) => c.required && (draft[c.key]?.score ?? '') === '')

  const submit = () => {
    if (anyInvalid) return
    onSave(scorecard.criteria.map((c) => ({
      key: c.key,
      score: draft[c.key]?.score === '' ? null : Number(draft[c.key].score),
      evidence: draft[c.key]?.evidence?.trim() ? draft[c.key].evidence.trim() : null,
    })))
  }

  return (
    <div className={compact ? '' : 'card'}>
      <div className="flex flex-wrap items-center gap-2.5 mb-2">
        {!compact && <span className="tile tile-sm tile-accent"><Scale className="w-4 h-4" /></span>}
        <h3 className="font-semibold text-gray-200 text-sm">Scorecard</h3>
        <span className="text-xs text-gray-500">Weighted total <strong className="text-gray-200 tabular-nums">{computed.totalScore}/100</strong></span>
        {editable && onRefresh && (
          <button type="button" onClick={onRefresh} disabled={refreshing || saving} className="btn-secondary btn-sm ml-auto inline-flex items-center gap-1" title="Recompute the suggestions from your latest records; your own scores are kept">
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /> {refreshing ? 'Refreshing…' : 'Refresh suggestions'}
          </button>
        )}
      </div>
      <p className="text-[11px] text-gray-500 mb-3">
        Scores start from Bytescon's suggestions, worked out from your records; check each one and change any you disagree with.
        {editable && needsYou.length > 0 && <span className="text-amber-500"> Still needs your score: {needsYou.map((c) => c.name).join(', ')}.</span>}
      </p>
      {closed && <p className="text-[11px] text-gray-500 mb-2">This pursuit is closed — the scorecard is read-only. Reopen the pursuit to edit.</p>}
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Criterion</th><th className="w-14 !text-right">Weight</th><th className="w-24">Score</th><th>Why</th></tr></thead>
          <tbody>
            {scorecard.criteria.map((c) => {
              const row = draft[c.key] ?? { score: '', evidence: '' }
              const bad = invalid(row.score)
              const changed = c.suggestedScore != null && row.score !== '' && Number(row.score) !== c.suggestedScore
              return (
                <tr key={c.id} className="align-top">
                  <td className="min-w-[10rem]">
                    <span className="text-gray-200 font-medium">{c.name}</span>{c.required && <span className="ml-1 text-[9px] text-red-400" aria-label="required">*</span>}
                    {!compact && c.description && <p className="text-[10px] text-gray-500 mt-0.5">{c.description}</p>}
                  </td>
                  <td className="text-gray-400 text-xs text-right tabular-nums">{c.weight}</td>
                  <td>
                    {editable ? (
                      <>
                        <input type="number" min={0} max={100} value={row.score} disabled={saving} placeholder="0–100"
                          onChange={(e) => setDraft((d) => ({ ...d, [c.key]: { ...row, score: e.target.value } }))}
                          className={`${fieldCls} !w-20 tabular-nums ${bad ? '!border-red-500' : ''}`} aria-label={`Score for ${c.name}`} aria-invalid={bad || undefined} />
                        {bad && <p className="text-[10px] text-red-400 mt-0.5">0–100 only</p>}
                      </>
                    ) : <span className="text-gray-300 text-xs tabular-nums">{c.score ?? '—'}</span>}
                  </td>
                  <td className="min-w-[14rem]">
                    {c.suggestionNote && (
                      <p className="text-[11px] text-gray-400">
                        {c.suggestedScore != null
                          ? <span className="text-gray-500">Suggested {c.suggestedScore}{changed && <span className="text-amber-500"> (you changed it)</span>} · </span>
                          : null}
                        {c.suggestionNote}
                      </p>
                    )}
                    {editable ? (
                      <input value={row.evidence} placeholder="Your notes (optional)" disabled={saving}
                        onChange={(e) => setDraft((d) => ({ ...d, [c.key]: { ...row, evidence: e.target.value } }))}
                        className={`${fieldCls} mt-1 w-full`} aria-label={`Notes for ${c.name}`} />
                    ) : c.evidence ? <p className="text-[11px] text-gray-500 mt-1">{c.evidence}</p> : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <button type="button" disabled={saving || anyInvalid || !dirty} onClick={submit} className="btn-primary text-sm disabled:opacity-50">{saving ? 'Saving…' : 'Save scores'}</button>
          {onReset && <button type="button" disabled={saving} onClick={onReset} className="btn-secondary text-sm disabled:opacity-50">Clear all scores</button>}
          {anyInvalid && <span className="text-[11px] text-red-400">Fix out-of-range scores before saving.</span>}
        </div>
      )}
    </div>
  )
}

export function RecommendationPanel({ scorecard, computed, compact = false }: { scorecard: Scorecard; computed: Computed; compact?: boolean }) {
  return (
    <div className={compact ? '' : 'card'}>
      <div className="flex items-center gap-2.5 mb-2">{!compact && <span className="tile tile-sm tile-accent"><ShieldCheck className="w-4 h-4" /></span>}<h3 className="font-semibold text-gray-200 text-sm">System recommendation</h3></div>
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`chip chip-lg ${recTone[computed.recommendation] ?? 'chip-neutral'}`}><span className="chip-dot" aria-hidden="true" />{label(computed.recommendation)}</span>
        <span className="text-xs text-gray-500">{`score ${computed.totalScore}/100`} · bid at 70 or more · conditional 50–69 · no-bid under 50</span>
      </div>
      {!computed.complete && (
        <p className="text-[11px] text-amber-500 mt-2 flex items-center gap-1"><AlertTriangle className="w-3 h-3" aria-hidden="true" /> Score every required criterion to get a recommendation.</p>
      )}
      {scorecard.isOverride && scorecard.finalDecision && (
        <div className="mt-3 rounded-lg p-3" style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          <p className="text-[11px] text-amber-600 font-medium">The decision ({label(scorecard.finalDecision)}) differs from the recommendation.</p>
          <p className="text-[11px] text-gray-400 mt-1">Reason: {scorecard.overrideReason}</p>
        </div>
      )}
    </div>
  )
}

export function DecisionPanel({ scorecard, computed, isAdmin, busy, users, noBidReasons, onDecide, onSubmitReview, onReassess, compact = false }: {
  scorecard: Scorecard; computed: Computed; isAdmin: boolean; busy: boolean; users: FirmUser[]; noBidReasons: NoBidReason[]
  onDecide: (p: Record<string, unknown>) => void; onSubmitReview?: (p: Record<string, unknown>) => void; onReassess: () => void
  compact?: boolean
}) {
  const [decision, setDecision] = useState('')
  const [reason, setReason] = useState('')
  const [noBidReason, setNoBidReason] = useState('')
  const [noBidNote, setNoBidNote] = useState('')
  const [reviewerUserId, setReviewerUserId] = useState(scorecard.reviewerUserId ?? '')
  const decided = DECIDED.includes(scorecard.status)
  const overrideNeeded = decision !== '' && isOverride(computed.recommendation, decision)
  const reasonLabel = (key?: string | null) => noBidReasons.find((r) => r.key === key)?.label ?? key
  const ready = decision !== '' && computed.complete && (!overrideNeeded || reason.trim().length >= 20) && (decision !== 'NO_BID' || noBidReason !== '')

  return (
    <div className={compact ? '' : 'card'}>
      <div className="flex items-center gap-2.5 mb-3">{!compact && <span className="tile tile-sm tile-accent"><Gavel className="w-4 h-4" /></span>}<h3 className="font-semibold text-gray-200 text-sm">Your decision</h3>
        <span className={`chip ml-auto ${recTone[scorecard.status] ?? recTone.NOT_REVIEWED}`}>{label(scorecard.status)}</span>
      </div>

      {decided ? (
        <div className="space-y-2">
          <p className="text-sm text-gray-200">
            Decision: <span className={`chip ${recTone[scorecard.finalDecision ?? scorecard.status] ?? 'chip-neutral'}`}>{label(scorecard.finalDecision ?? scorecard.status)}</span>
            {scorecard.isOverride && <span className="ml-2 text-[10px] text-amber-500">(differs from the recommendation)</span>}
            {scorecard.quickDecision && <span className="ml-2 text-[10px] text-gray-500">(quick no-bid)</span>}
          </p>
          {scorecard.finalDecision === 'NO_BID' && scorecard.noBidReason && (
            <p className="text-xs text-gray-400">Why: {reasonLabel(scorecard.noBidReason)}{scorecard.noBidNote ? ` — ${scorecard.noBidNote}` : ''}</p>
          )}
          <p className="text-xs text-gray-500">Decided {fmtDate(scorecard.decidedAt)}. Changing it keeps this entry in the history.</p>
          {isAdmin && <button type="button" disabled={busy} onClick={onReassess} className="btn-secondary text-xs disabled:opacity-60">Change decision</button>}
        </div>
      ) : !isAdmin ? (
        <p className="text-xs text-gray-500">Waiting for a firm admin to record the decision.</p>
      ) : (
        <div className="space-y-3">
          {onSubmitReview && (
            <div className="flex flex-wrap items-center gap-2">
              <select value={reviewerUserId} onChange={(e) => setReviewerUserId(e.target.value)} className={`${fieldCls} !w-auto`} aria-label="Reviewer">
                <option value="">Reviewer (optional)</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}
              </select>
              <button type="button" disabled={busy || !computed.complete} onClick={() => onSubmitReview({ reviewerUserId: reviewerUserId || null })} className="btn-secondary text-xs disabled:opacity-50">Ask for a review</button>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Decision">
            {FINAL_DECISIONS.map((d) => (
              <button type="button" key={d} aria-pressed={decision === d} onClick={() => setDecision(d)} className={decision === d ? `chip chip-lg ${recTone[d]} !px-3 !py-1.5 !text-xs` : 'btn-secondary btn-sm'}>{d === 'NO_BID' ? 'No-bid' : label(d)}</button>
            ))}
          </div>
          {decision === 'NO_BID' && (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-[11px] text-gray-400">Why not bid?
                <select value={noBidReason} onChange={(e) => setNoBidReason(e.target.value)} className={`${fieldCls} mt-1 w-full`}>
                  <option value="">Choose a reason…</option>
                  {noBidReasons.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </label>
              <label className="text-[11px] text-gray-400">Note (optional)
                <input value={noBidNote} onChange={(e) => setNoBidNote(e.target.value)} maxLength={2000} className={`${fieldCls} mt-1 w-full`} />
              </label>
            </div>
          )}
          {overrideNeeded && (
            <div>
              <label htmlFor={`override-${scorecard.id}`} className="text-[11px] text-amber-600 flex items-center gap-1 mb-1"><AlertTriangle className="w-3 h-3" aria-hidden="true" /> This differs from the {label(computed.recommendation)} recommendation. Say why (at least 20 characters).</label>
              <textarea id={`override-${scorecard.id}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={fieldCls} />
              <p className={`text-[10px] mt-0.5 ${reason.trim().length < 20 ? 'text-red-400' : 'text-gray-500'}`}>{reason.trim().length}/20 characters minimum</p>
            </div>
          )}
          <button
            type="button"
            disabled={busy || !ready}
            onClick={() => onDecide({
              decision,
              overrideReason: overrideNeeded ? reason.trim() : undefined,
              ...(decision === 'NO_BID' ? { noBidReason, noBidNote: noBidNote.trim() || undefined } : {}),
            })}
            className="btn-primary text-sm disabled:opacity-50">{busy ? 'Recording…' : 'Record decision'}</button>
          {!computed.complete && <p className="text-[10px] text-amber-500">Score every required criterion first. To pass without scoring, use No-bid in the "To qualify" list.</p>}
        </div>
      )}
    </div>
  )
}
