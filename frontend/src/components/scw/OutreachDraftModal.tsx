// =============================================================
// SCW-4 — Outreach Draft modal
//
// Spec §3 SCW-4 + §6 Phase 5: modal that shows an LLM-drafted outreach
// email with the factsCited block and the interactive reviewChecklist.
// The Approve button only enables once every checklist item is ticked.
// Approval calls the PATCH route — it does NOT send the email (spec §2.7).
// =============================================================

import { useEffect, useState } from 'react'
import {
  Loader, X, AlertTriangle, CheckSquare, Square, MessageSquare,
  Copy as CopyIcon, Send, Mail, ShieldCheck,
} from 'lucide-react'
import { scwApi, ScwLikelyPrime, ScwOutreachDraft } from '../../services/api'

interface Props {
  opportunityId: string
  prime: ScwLikelyPrime
  onClose: () => void
}

function VerificationBadge({ status }: { status?: ScwOutreachDraft['emailVerificationStatus'] }) {
  const s = status ?? 'unknown'
  const styles =
    s === 'verified'
      ? 'chip-success'
      : s === 'probable'
        ? 'badge-yellow'
        : 'chip-neutral'
  return (
    <span className={`chip ${styles}`}>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </span>
  )
}

const OUTREACH_TYPES: Array<{ value: ScwOutreachDraft['outreachType']; label: string }> = [
  { value: 'cold_first_touch', label: 'Cold first touch' },
  { value: 'warm_follow_up', label: 'Warm follow-up' },
  { value: 'urgent_deadline_driven', label: 'Urgent (deadline-driven)' },
]

export function OutreachDraftModal({ opportunityId, prime, onClose }: Props) {
  const [outreachType, setOutreachType] = useState<ScwOutreachDraft['outreachType']>('cold_first_touch')
  const [capabilityStatement, setCapabilityStatement] = useState('')
  const [draft, setDraft] = useState<ScwOutreachDraft | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [checklistTicked, setChecklistTicked] = useState<Set<number>>(new Set())
  const [approving, setApproving] = useState(false)
  const [approved, setApproved] = useState(false)
  const [pastDrafts, setPastDrafts] = useState<ScwOutreachDraft[]>([])

  // Earlier drafts for this prime on this opportunity, newest first.
  useEffect(() => {
    let cancelled = false
    scwApi
      .listOutreachDrafts({ opportunityId })
      .then((resp) => {
        if (!cancelled) setPastDrafts(resp.data.filter((d) => d.primeName === prime.primeName))
      })
      .catch(() => undefined) // The history is a convenience; drafting still works without it.
    return () => {
      cancelled = true
    }
  }, [opportunityId, prime.primeName])

  function openPastDraft(past: ScwOutreachDraft) {
    setDraft(past)
    setError('')
    setChecklistTicked(past.humanApprovedAt ? new Set(past.reviewChecklist.map((_, i) => i)) : new Set())
    setApproved(!!past.humanApprovedAt)
  }

  // Esc-to-close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function reset() {
    setDraft(null)
    setError('')
    setChecklistTicked(new Set())
    setApproved(false)
  }

  async function handleGenerate() {
    if (!capabilityStatement.trim()) {
      setError('Capability statement is required — paste a paragraph describing your firm and capabilities.')
      return
    }
    reset()
    setGenerating(true)
    try {
      const resp = await scwApi.draftOutreach({
        opportunityId,
        primeUei: prime.primeUei || null,
        primeName: prime.primeName,
        outreachType,
        tenantCapabilityStatement: capabilityStatement.trim(),
      })
      setDraft(resp.data)
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to draft outreach')
    } finally {
      setGenerating(false)
    }
  }

  async function handleApprove() {
    if (!draft) return
    setApproving(true)
    try {
      await scwApi.approveOutreachDraft(draft.id, draft.reviewChecklist)
      setApproved(true)
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to approve draft')
    } finally {
      setApproving(false)
    }
  }

  function toggleChecklist(idx: number) {
    setChecklistTicked((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  function copyToClipboard() {
    if (!draft) return
    const fullText = [draft.salutation, '', draft.body, '', draft.closing].join('\n')
    navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${fullText}`).catch(() => undefined)
  }

  const allTicked = draft ? checklistTicked.size === draft.reviewChecklist.length : false

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4">
      <div className="modal-panel max-w-3xl w-full my-8">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4" style={{ borderBottom: '1px solid var(--line)' }}>
          <h2 className="v3-h3 text-gray-100 flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-gray-400" />
            Draft outreach: {prime.primeName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost btn-sm !px-2"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Inputs row — only visible before a draft exists */}
          {!draft && (
            <>
              <div>
                <label className="label mb-1.5 block">Outreach type</label>
                <div className="flex flex-wrap gap-2">
                  {OUTREACH_TYPES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setOutreachType(t.value)}
                      aria-pressed={outreachType === t.value}
                      className="v3-tag"
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="label mb-1.5 block">
                  Capability statement
                  <span className="text-gray-500 font-normal ml-1.5">
                    (inline for v1 — paste 1–2 paragraphs)
                  </span>
                </label>
                <textarea
                  value={capabilityStatement}
                  onChange={(e) => setCapabilityStatement(e.target.value)}
                  rows={5}
                  className="input w-full text-sm"
                  placeholder="Bytes Platform is an SDVOSB-certified small business specializing in..."
                />
              </div>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating || !capabilityStatement.trim()}
                className="btn-primary"
              >
                {generating ? <Loader className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
                {generating ? 'Generating...' : 'Generate draft'}
              </button>
              {pastDrafts.length > 0 && (
                <div>
                  <div className="label mb-1.5">
                    Earlier drafts for {prime.primeName} ({pastDrafts.length})
                  </div>
                  <ul className="space-y-1">
                    {pastDrafts.map((past) => (
                      <li key={past.id}>
                        <button
                          type="button"
                          onClick={() => openPastDraft(past)}
                          className="panel w-full text-left text-xs px-3 py-2 text-gray-300 hover:text-gray-100 flex items-center justify-between gap-3"
                        >
                          <span className="truncate">{past.subject}</span>
                          <span className="shrink-0 text-gray-500">
                            {past.humanApprovedAt ? 'Approved' : 'Not approved'} · {new Date(past.createdAt).toLocaleDateString()}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {error && (
            <div className="text-sm rounded-xl p-3 flex items-start gap-2" style={{ background: 'var(--danger-bg)', color: 'var(--danger-text)' }}>
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Draft view */}
          {draft && (
            <>
              <div className="panel p-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-gray-500">Subject</p>
                  <button
                    type="button"
                    onClick={copyToClipboard}
                    className="text-[11px] text-gray-500 hover:text-gray-300 inline-flex items-center gap-1"
                  >
                    <CopyIcon className="w-3 h-3" /> Copy
                  </button>
                </div>
                <p className="text-gray-200 font-medium mb-3">{draft.subject}</p>

                <p className="text-xs text-gray-500 mb-1">Body</p>
                <div className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                  <p>{draft.salutation}</p>
                  <p className="mt-2">{draft.body}</p>
                  <p className="mt-2">{draft.closing}</p>
                </div>
              </div>

              {/* Recipient (GB-104) */}
              <div className="panel p-4">
                <p className="text-xs text-gray-500 mb-2">Recipient</p>
                {draft.recipientEmail ? (
                  <>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Mail className="w-4 h-4 text-gray-400 shrink-0" />
                      <span className="text-sm text-gray-200 font-mono break-all">{draft.recipientEmail}</span>
                      <VerificationBadge status={draft.emailVerificationStatus} />
                      {draft.emailSource && (
                        <span className="text-[11px] text-gray-500">via {draft.emailSource}</span>
                      )}
                    </div>
                    {draft.emailVerificationStatus !== 'verified' ? (
                      <p className="mt-2 text-xs text-amber-400 flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        This address is {draft.emailVerificationStatus ?? 'unverified'}, not verified — confirm it is the
                        right contact before sending. Auto-send is disabled.
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-green-400 flex items-start gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        Verified recipient.
                      </p>
                    )}
                  </>
                ) : (
                  <div className="text-xs rounded-xl p-2 flex items-start gap-2" style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}>
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>Recipient email missing — supply a deliverable address before sending.</span>
                  </div>
                )}
              </div>

              {/* Facts cited */}
              <div className="panel p-4">
                <p className="text-xs font-semibold text-gray-300 mb-2">
                  Facts cited ({draft.factsCited.length})
                </p>
                {draft.factsCited.length === 0 ? (
                  <p className="text-xs text-amber-400">
                    No facts cited — verify every numeric claim in the body manually.
                  </p>
                ) : (
                  <ul className="text-[11px] space-y-1">
                    {draft.factsCited.map((f, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-gray-300">{f.claim}</span>
                        <span className="text-gray-600">←</span>
                        <span className="text-gray-500">{f.source}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Review checklist */}
              <div className="panel p-4">
                <p className="text-xs font-semibold text-gray-300 mb-2">
                  Review checklist ({checklistTicked.size}/{draft.reviewChecklist.length})
                </p>
                <ul className="space-y-1.5">
                  {draft.reviewChecklist.map((item, i) => {
                    const ticked = checklistTicked.has(i)
                    return (
                      <li key={i}>
                        <button
                          type="button"
                          onClick={() => toggleChecklist(i)}
                          disabled={approved}
                          className="text-xs flex items-start gap-2 text-left w-full hover:text-gray-200 transition-colors"
                        >
                          {ticked ? (
                            <CheckSquare className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                          ) : (
                            <Square className="w-4 h-4 text-gray-600 shrink-0 mt-0.5" />
                          )}
                          <span className={ticked ? 'text-gray-300' : 'text-gray-400'}>{item}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>

              {/* Approve / send guidance */}
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-gray-500">
                  {draft.llmProvider && draft.llmModel
                    ? `Drafted by ${draft.llmProvider} ${draft.llmModel} · ${draft.tokensUsed} tokens`
                    : ''}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={reset}
                    disabled={approving}
                    className="btn-secondary btn-sm"
                  >
                    Re-roll
                  </button>
                  <button
                    type="button"
                    onClick={handleApprove}
                    disabled={!allTicked || approving || approved}
                    title={!allTicked ? 'Tick every checklist item to enable Approve' : 'Mark draft human-approved (does NOT send)'}
                    className="btn-primary btn-sm"
                  >
                    {approving ? <Loader className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    {approved ? 'Approved' : approving ? 'Approving...' : 'Approve draft'}
                  </button>
                </div>
              </div>

              {approved && (
                <div className="text-xs rounded-xl p-3" style={{ background: 'var(--success-bg)', color: 'var(--success-text)' }}>
                  Draft marked human-approved. Copy the body above into your email client to send —
                  the system does NOT auto-send (spec §2.7).
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
