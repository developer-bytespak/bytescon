import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Send, MessageSquare, Loader, Users } from 'lucide-react'
import { clientReviewApi, clientsApi, type ReviewPacketKind } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from './Toast'
import { DeliverableThread } from './DeliverableThread'

interface Packet {
  id: string
  title: string
  createdAt: string
  clientCompany: { id: string; name: string } | null
  commentCount: number
  clientReview: { status: 'APPROVED' | 'CHANGES_REQUESTED'; notes: string | null; at: string } | null
}

// An export endpoint answers errors as a Blob (responseType: 'blob'); read the JSON message out of it.
async function errorMessage(err: any, fallback: string): Promise<string> {
  const data = err?.response?.data
  if (data instanceof Blob) {
    try { return JSON.parse(await data.text())?.error || fallback } catch { return fallback }
  }
  return data?.error || fallback
}

/**
 * "Publish" stage for a proposal or price volume: download it as a PDF, send it
 * to a client's portal for approval, and follow the client's verdict and
 * comments on every version sent. Shown inside the Proposal and Pricing workspaces.
 */
export function ClientReviewPanel({ kind, sourceId, fileName, defaultClientId, scenarioId, canSend, hint }: {
  kind: ReviewPacketKind
  sourceId: string
  fileName: string
  defaultClientId?: string | null
  scenarioId?: string
  canSend: boolean
  hint?: string
}) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { user, token } = useAuth()
  const [clientId, setClientId] = useState(defaultClientId ?? '')
  const [notes, setNotes] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)

  const reviews = useQuery<{ data: Packet[] }>({
    queryKey: ['client-reviews', kind, sourceId],
    queryFn: () => clientReviewApi.list(kind, sourceId),
    refetchInterval: 30_000,
  })
  const clients = useQuery({
    queryKey: ['clients', 'review-panel'],
    queryFn: () => clientsApi.list({ limit: 100, active: true }),
    enabled: canSend,
    staleTime: 5 * 60 * 1000,
  })
  const clientOptions: { id: string; name: string }[] = clients.data?.data ?? []

  const send = useMutation({
    mutationFn: () => clientReviewApi.send(kind, sourceId, { clientCompanyId: clientId, notes: notes.trim() || undefined, scenarioId }),
    onSuccess: (r: any) => {
      setNotes('')
      qc.invalidateQueries({ queryKey: ['client-reviews', kind, sourceId] })
      const unapproved = r?.data?.unapprovedSections ?? 0
      toast(unapproved > 0
        ? `Sent to client. Note: ${unapproved} section${unapproved === 1 ? ' is' : 's are'} not approved internally yet.`
        : 'Sent to the client for review', unapproved > 0 ? 'warning' : 'success')
    },
    onError: async (e: any) => toast(await errorMessage(e, 'Could not send to client'), 'error'),
  })

  const download = async () => {
    setDownloading(true)
    try { await clientReviewApi.downloadPdf(kind, sourceId, fileName, scenarioId ? { scenarioId } : undefined) }
    catch (e: any) { toast(await errorMessage(e, 'Could not build the PDF'), 'error') }
    finally { setDownloading(false) }
  }

  const packets = reviews.data?.data ?? []

  return (
    <section className="card mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-100 flex items-center gap-2"><Users className="w-4 h-4 text-blue-400" /> Client review</h2>
          <p className="text-xs text-gray-500 mt-0.5">{hint ?? 'Send a PDF to the client portal for approval. Their decision and comments show below.'}</p>
        </div>
        <button onClick={download} disabled={downloading} className="btn-secondary btn-sm flex items-center gap-1.5 disabled:opacity-50">
          {downloading ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download PDF
        </button>
      </div>

      {canSend && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="input !w-auto !py-1.5 !text-xs min-w-[180px]">
            <option value="">Select client…</option>
            {clientOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note to client (optional)" className="input !py-1.5 !text-xs flex-1 min-w-[180px]" />
          <button onClick={() => send.mutate()} disabled={!clientId || send.isPending} className="btn-primary btn-sm flex items-center gap-1.5 disabled:opacity-50">
            {send.isPending ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Send to client
          </button>
        </div>
      )}

      {packets.length === 0 ? (
        <p className="text-xs text-gray-500">Not sent to a client yet.</p>
      ) : (
        <div className="space-y-2">
          {packets.map((p) => (
            <div key={p.id} className="panel px-3 py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-gray-200 font-medium">{p.clientCompany?.name ?? 'Client'}</span>
                <span className="text-xs text-gray-500 tabular-nums">sent {new Date(p.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                {p.clientReview?.status === 'APPROVED' && <span className="chip chip-success !text-[10px] !py-0">Client approved</span>}
                {p.clientReview?.status === 'CHANGES_REQUESTED' && <span className="chip chip-gold !text-[10px] !py-0">Changes requested</span>}
                {!p.clientReview && <span className="chip chip-neutral !text-[10px] !py-0">Awaiting client</span>}
                <button
                  onClick={() => setOpenThreadId(openThreadId === p.id ? null : p.id)}
                  className="ml-auto text-xs text-gray-500 hover:text-blue-400 flex items-center gap-1"
                  title="Comments with the client"
                >
                  <MessageSquare className="w-3.5 h-3.5" /> {p.commentCount}
                </button>
              </div>
              {p.clientReview?.status === 'CHANGES_REQUESTED' && p.clientReview.notes && (
                <p className="text-xs text-amber-400 mt-1">Client feedback: {p.clientReview.notes}</p>
              )}
              {openThreadId === p.id && user && (
                <div className="mt-3 pt-3 border-t border-gray-800">
                  {/* Consultant sessions ride the http-only cookie; token is usually null here. */}
                  <DeliverableThread deliverableId={p.id} authToken={token ?? ''} currentAuthorId={user.id} currentAuthorType="CONSULTANT" />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
