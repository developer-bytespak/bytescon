// FIX-6 — human-in-the-loop attestation on AI-drafted proposals.
// Renders under the proposal draft: an operator must affirm they reviewed
// the AI draft (a professional-responsibility acknowledgement) before the
// gated "final / human-reviewed" PDF can be exported. Goes stale — and
// re-locks the final export — if the draft is regenerated after attesting.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { proposalAssistApi } from '../services/api'
import { ShieldCheck, AlertTriangle, FileDown } from 'lucide-react'

interface AttestationData {
  hasDraft: boolean
  statement: string
  statementVersion: string
  attested: boolean
  isStale: boolean
  attestation: { attestedByName: string; attestedAt: string; statementVersion: string } | null
  /** Hash of the draft this response describes — echoed back on attest. */
  draftContentHash?: string | null
  confidence?: { high: number; medium: number; low: number; unrated: number }
  flaggedSections?: { title: string; confidence: 'MEDIUM' | 'LOW' }[]
}

export function ProposalAttestationPanel({ opportunityId }: { opportunityId: string }) {
  const qc = useQueryClient()
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState('')

  const { data } = useQuery({
    queryKey: ['proposal-attestation', opportunityId],
    queryFn: () => proposalAssistApi.getAttestation(opportunityId),
  })
  const att: AttestationData | undefined = data?.data

  const attestMutation = useMutation({
    // Echo the hash of the draft this panel DISPLAYED — the server 409s if
    // the draft changed between review and click (review-what-you-attest).
    mutationFn: () => proposalAssistApi.attest(opportunityId, att?.draftContentHash ?? ''),
    onSuccess: () => {
      setChecked(false)
      qc.invalidateQueries({ queryKey: ['proposal-attestation', opportunityId] })
    },
    onError: (err: unknown) => {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Attestation failed')
      // On DRAFT_CHANGED_SINCE_REVIEW (or any failure), refetch so the panel
      // shows the current draft state + fresh hash for the retry.
      qc.invalidateQueries({ queryKey: ['proposal-attestation', opportunityId] })
    },
  })

  const downloadFinal = async () => {
    setError('')
    try {
      const blob = await proposalAssistApi.downloadFinalPdf(opportunityId)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Proposal_FINAL_${opportunityId.slice(0, 8)}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err: unknown) {
      // downloadFinalPdf parses blob-JSON error bodies into Error.message
      // (e.g. the actionable ATTESTATION_STALE "re-review and re-attest" text).
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        (err instanceof Error && err.message !== 'Network Error' ? err.message : '') ||
        'Could not export final proposal'
      setError(msg)
      // The most common cause is a stale attestation — refresh so the panel
      // flips back to the re-attest prompt instead of staying green.
      qc.invalidateQueries({ queryKey: ['proposal-attestation', opportunityId] })
    }
  }

  // Only meaningful once a draft exists.
  if (!att?.hasDraft) return null

  const reviewed = att.attested && !att.isStale

  return (
    <div
      className="p-3 rounded-lg mt-2"
      style={
        reviewed
          ? { background: 'rgba(22,163,74,0.08)', border: '1px solid rgba(22,163,74,0.3)' }
          : { background: 'rgba(91,116,255,0.08)', border: '1px solid rgba(91,116,255,0.3)' }
      }
    >
      {reviewed ? (
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-emerald-200">
              Human-reviewed — attested by {att.attestation?.attestedByName}
              {att.attestation?.attestedAt
                ? ` on ${new Date(att.attestation.attestedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                : ''}
              .
            </p>
            <p className="text-[11px] text-gray-500 mt-0.5">The final PDF carries a HUMAN-REVIEWED cover stamp.</p>
          </div>
          <button
            onClick={downloadFinal}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium flex-shrink-0"
            style={{ background: 'rgba(22,163,74,0.18)', border: '1px solid rgba(22,163,74,0.4)', color: '#4ade80' }}
          >
            <FileDown className="w-3.5 h-3.5" /> Download Final (Reviewed)
          </button>
        </div>
      ) : (
        <div>
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm text-amber-200 font-medium">
                {att.isStale
                  ? 'The draft changed since it was last attested. Re-review and re-attest to unlock the final export.'
                  : 'This is an AI-generated draft. A responsible person must review and attest before it can be exported as final.'}
              </p>
              {att.flaggedSections && att.flaggedSections.length > 0 && (
                <div className="mt-2 px-2.5 py-2 rounded" style={{ background: 'rgba(0,0,0,0.25)' }}>
                  <p className="text-[11px] font-semibold text-amber-300 mb-1">
                    The AI flagged {att.flaggedSections.length} section{att.flaggedSections.length > 1 ? 's' : ''} as
                    less grounded — review these first:
                  </p>
                  <ul className="space-y-0.5">
                    {att.flaggedSections.map((s) => (
                      <li key={s.title} className="text-[11px] text-gray-300 flex items-center gap-1.5">
                        <span
                          className="text-[9px] font-mono font-bold px-1 py-px rounded"
                          style={
                            s.confidence === 'LOW'
                              ? { background: 'rgba(239,68,68,0.15)', color: '#fca5a5' }
                              : { background: 'rgba(91,116,255,0.15)', color: '#a3b1ff' }
                          }
                        >
                          {s.confidence}
                        </span>
                        {s.title}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <label className="flex items-start gap-2 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                <span className="text-xs text-gray-300">{att.statement}</span>
              </label>
              {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
              <button
                onClick={() => attestMutation.mutate()}
                disabled={!checked || attestMutation.isPending}
                className="mt-2 text-sm px-3 py-1.5 rounded-lg font-medium disabled:opacity-50"
                style={{ background: 'rgba(91,116,255,0.18)', border: '1px solid rgba(91,116,255,0.4)', color: '#7b8fff' }}
              >
                {attestMutation.isPending ? 'Recording…' : 'Attest & unlock final export'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ProposalAttestationPanel
