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
      ? 'border-green-700 bg-green-950/40 text-green-300'
      : s === 'probable'
        ? 'border-yellow-700 bg-yellow-950/40 text-yellow-300'
        : 'border-gray-700 bg-gray-800 text-gray-400'
  return (
    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border font-mono ${styles}`}>
      {s}
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
      await scwApi.approveOutreachDraft(draft.id)
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
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 overflow-y-auto p-4">
      <div className="bg-gray-950 border border-gray-800 rounded-xl max-w-3xl w-full my-8 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-200 flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-blue-400" />
            Draft Outreach — {prime.primeName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors"
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
                <label className="text-xs uppercase tracking-wide text-gray-500 mb-1.5 block">Outreach type</label>
                <div className="flex flex-wrap gap-2">
                  {OUTREACH_TYPES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setOutreachType(t.value)}
                      className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                        outreachType === t.value
                          ? 'border-blue-700 bg-blue-950/40 text-blue-200'
                          : 'border-gray-700 bg-gray-900 text-gray-400 hover:bg-gray-800'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-gray-500 mb-1.5 block">
                  Capability statement
                  <span className="text-gray-600 normal-case ml-1.5">
                    (inline for v1 — paste 1–2 paragraphs)
                  </span>
                </label>
                <textarea
                  value={capabilityStatement}
                  onChange={(e) => setCapabilityStatement(e.target.value)}
                  rows={5}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
                  placeholder="Bytes Platform is an SDVOSB-certified small business specializing in..."
                />
              </div>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating || !capabilityStatement.trim()}
                className="text-sm px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed text-white inline-flex items-center gap-2 transition-colors"
              >
                {generating ? <Loader className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
                {generating ? 'Generating...' : 'Generate draft'}
              </button>
            </>
          )}

          {error && (
            <div className="text-sm text-red-300 bg-red-950/40 border border-red-800 rounded p-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Draft view */}
          {draft && (
            <>
              <div className="border border-gray-800 rounded-lg p-4 bg-gray-900">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] uppercase tracking-wide text-gray-500">Subject</p>
                  <button
                    type="button"
                    onClick={copyToClipboard}
                    className="text-[11px] text-gray-500 hover:text-gray-300 inline-flex items-center gap-1"
                  >
                    <CopyIcon className="w-3 h-3" /> Copy
                  </button>
                </div>
                <p className="text-gray-200 font-medium mb-3">{draft.subject}</p>

                <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Body</p>
                <div className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                  <p>{draft.salutation}</p>
                  <p className="mt-2">{draft.body}</p>
                  <p className="mt-2">{draft.closing}</p>
                </div>
              </div>

              {/* Recipient (GB-104) */}
              <div className="border border-gray-800 rounded-lg p-4 bg-gray-900">
                <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Recipient</p>
                {draft.recipientEmail ? (
                  <>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Mail className="w-4 h-4 text-gray-400 shrink-0" />
                      <span className="text-sm text-gray-200 font-mono break-all">{draft.recipientEmail}</span>
                      <VerificationBadge status={draft.emailVerificationStatus} />
                      {draft.emailSource && (
                        <span className="text-[10px] text-gray-600">via {draft.emailSource}</span>
                      )}
                    </div>
                    {draft.emailVerificationStatus !== 'verified' ? (
                      <p className="mt-2 text-[11px] text-yellow-400/80 flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        This address is {draft.emailVerificationStatus ?? 'unverified'}, not verified — confirm it is the
                        right contact before sending. Auto-send is disabled.
                      </p>
                    ) : (
                      <p className="mt-2 text-[11px] text-green-400/80 flex items-start gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        Verified recipient.
                      </p>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-yellow-300 bg-yellow-950/40 border border-yellow-800 rounded p-2 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>Recipient email missing — supply a deliverable address before sending.</span>
                  </div>
                )}
              </div>

              {/* Facts cited */}
              <div className="border border-gray-800 rounded-lg p-4 bg-gray-900">
                <p className="text-xs font-semibold text-gray-300 mb-2">
                  Facts cited ({draft.factsCited.length})
                </p>
                {draft.factsCited.length === 0 ? (
                  <p className="text-[11px] text-yellow-400/80">
                    No facts cited — verify every numeric claim in the body manually.
                  </p>
                ) : (
                  <ul className="text-[11px] space-y-1">
                    {draft.factsCited.map((f, i) => (
                      <li key={i} className="flex items-start gap-2 font-mono">
                        <span className="text-gray-300">{f.claim}</span>
                        <span className="text-gray-600">←</span>
                        <span className="text-gray-500">{f.source}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Review checklist */}
              <div className="border border-gray-800 rounded-lg p-4 bg-gray-900">
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
                <p className="text-[10px] text-gray-500">
                  {draft.llmProvider && draft.llmModel
                    ? `Drafted by ${draft.llmProvider} ${draft.llmModel} · ${draft.tokensUsed} tokens`
                    : ''}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={reset}
                    disabled={approving}
                    className="text-xs px-3 py-1.5 rounded border border-gray-700 bg-gray-900 text-gray-400 hover:bg-gray-800 transition-colors"
                  >
                    Re-roll
                  </button>
                  <button
                    type="button"
                    onClick={handleApprove}
                    disabled={!allTicked || approving || approved}
                    title={!allTicked ? 'Tick every checklist item to enable Approve' : 'Mark draft human-approved (does NOT send)'}
                    className="text-sm px-4 py-1.5 rounded bg-green-700 hover:bg-green-600 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed text-white inline-flex items-center gap-2 transition-colors"
                  >
                    {approving ? <Loader className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    {approved ? 'Approved' : approving ? 'Approving...' : 'Approve draft'}
                  </button>
                </div>
              </div>

              {approved && (
                <div className="text-xs text-green-300 bg-green-950/40 border border-green-800 rounded p-3">
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
