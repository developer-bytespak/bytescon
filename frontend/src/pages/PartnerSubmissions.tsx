// =============================================================
// §8.3 — What subcontractors sent back, and the prime's decision on it.
//
// Three separate queues on purpose. A document, a deliverable response and a
// profile edit are three different kinds of claim, and each has its own
// consequence: only the profile decision writes to a prime record. Merging
// them into one "approve" button would hide that difference.
//
// Nothing here is automatic. Every row waits for a person.
// =============================================================
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Download, FileText, Inbox, UserCog } from 'lucide-react'
import {
  partnerSubmissionsApi,
  type PartnerDeliverableSubmissionRow, type PartnerProfileChangeRow, type PartnerUploadRow,
} from '../services/crmApi'
import { useTabParam } from '../hooks/useTabParam'
import { useToast } from '../components/Toast'
import { Spinner, ErrorBanner, EmptyState } from '../components/ui'

type Queue = 'documents' | 'deliverables' | 'profile'

const QUEUES: { id: Queue; label: string; icon: typeof Inbox }[] = [
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'deliverables', label: 'Deliverable responses', icon: Inbox },
  { id: 'profile', label: 'Profile changes', icon: UserCog },
]

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

const fmtSize = (bytes: number | null) =>
  bytes ? `${(bytes / 1024).toFixed(0)} KB` : '—'

const TONE: Record<string, string> = {
  PENDING_REVIEW: 'bg-yellow-950/40 border-yellow-800 text-yellow-300',
  SUBMITTED: 'bg-yellow-950/40 border-yellow-800 text-yellow-300',
  ACCEPTED: 'bg-green-950/40 border-green-800 text-green-300',
  ACCEPTED_BY_PRIME: 'bg-green-950/40 border-green-800 text-green-300',
  REJECTED: 'bg-red-950/40 border-red-800 text-red-300',
  CHANGES_REQUESTED: 'bg-orange-950/40 border-orange-800 text-orange-300',
  DRAFT: 'bg-gray-800 border-gray-700 text-gray-400',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${TONE[status] ?? TONE.DRAFT}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

/** Decision controls shared by all three queues. Notes travel with the verdict. */
function Decision({ onDecide, acceptLabel, rejectLabel, busy }: {
  onDecide: (accept: boolean, notes: string) => void
  acceptLabel: string
  rejectLabel: string
  busy: boolean
}) {
  const [notes, setNotes] = useState('')
  return (
    <div className="flex items-center gap-2 flex-wrap mt-2">
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note to the partner (optional)"
        className="flex-1 min-w-[200px] bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500" />
      <button disabled={busy} onClick={() => onDecide(true, notes)}
        className="text-xs px-3 py-1.5 rounded bg-green-900/40 hover:bg-green-900/60 text-green-300 border border-green-700 disabled:opacity-50">
        {acceptLabel}
      </button>
      <button disabled={busy} onClick={() => onDecide(false, notes)}
        className="text-xs px-3 py-1.5 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-700 disabled:opacity-50">
        {rejectLabel}
      </button>
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">{children}</div>
}

function DocumentsQueue() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { data, isLoading, error } = useQuery({
    queryKey: ['partner-uploads'],
    queryFn: partnerSubmissionsApi.listUploads,
  })
  const review = useMutation({
    mutationFn: ({ id, accept, notes }: { id: string; accept: boolean; notes: string }) =>
      partnerSubmissionsApi.reviewUpload(id, { status: accept ? 'ACCEPTED' : 'REJECTED', reviewNotes: notes || null }),
    onSuccess: () => { toast('Decision recorded', 'success'); void qc.invalidateQueries({ queryKey: ['partner-uploads'] }) },
    onError: (err: any) => toast(err?.response?.data?.error || 'Could not record the decision', 'error'),
  })

  if (isLoading) return <Spinner />
  if (error) return <ErrorBanner message="Could not load partner documents." />
  const rows = (data ?? []) as PartnerUploadRow[]
  if (rows.length === 0) return <EmptyState message="No subcontractor has uploaded a document yet." />

  return (
    <div className="space-y-3">
      {rows.map((u) => (
        <Row key={u.id}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm text-gray-100">{u.title}</p>
                <StatusBadge status={u.reviewStatus} />
              </div>
              <p className="text-[11px] text-gray-500 mt-0.5">
                {u.partner.name} · {u.category} · {u.fileName} ({fmtSize(u.fileSize)}) · {fmtDate(u.createdAt)}
              </p>
              {u.notes && <p className="text-[12px] text-gray-400 mt-1">{u.notes}</p>}
              {u.reviewNotes && <p className="text-[12px] text-gray-500 mt-1">Your note: {u.reviewNotes}</p>}
            </div>
            <button onClick={() => void partnerSubmissionsApi.downloadUpload(u.id, u.fileName)}
              className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 flex items-center gap-1 flex-shrink-0">
              <Download className="w-3 h-3" /> Download
            </button>
          </div>
          {u.reviewStatus === 'PENDING_REVIEW' && (
            <Decision busy={review.isPending} acceptLabel="Accept" rejectLabel="Reject"
              onDecide={(accept, notes) => review.mutate({ id: u.id, accept, notes })} />
          )}
        </Row>
      ))}
      <p className="text-[10px] text-gray-600">
        Accepting records that you received what you asked for. It does not move the file into your document library.
      </p>
    </div>
  )
}

function DeliverablesQueue() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { data, isLoading, error } = useQuery({
    queryKey: ['partner-deliverable-submissions'],
    queryFn: partnerSubmissionsApi.listDeliverableSubmissions,
  })
  const review = useMutation({
    mutationFn: ({ id, accept, notes }: { id: string; accept: boolean; notes: string }) =>
      partnerSubmissionsApi.reviewDeliverableSubmission(id, {
        status: accept ? 'ACCEPTED_BY_PRIME' : 'CHANGES_REQUESTED', reviewNotes: notes || null,
      }),
    onSuccess: () => { toast('Decision recorded', 'success'); void qc.invalidateQueries({ queryKey: ['partner-deliverable-submissions'] }) },
    onError: (err: any) => toast(err?.response?.data?.error || 'Could not record the decision', 'error'),
  })

  if (isLoading) return <Spinner />
  if (error) return <ErrorBanner message="Could not load deliverable responses." />
  const rows = (data ?? []) as PartnerDeliverableSubmissionRow[]
  if (rows.length === 0) return <EmptyState message="No subcontractor has submitted a deliverable response yet." />

  return (
    <div className="space-y-3">
      {rows.map((s) => (
        <Row key={s.id}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm text-gray-100">{s.deliverable.name}</p>
                <StatusBadge status={s.status} />
              </div>
              <p className="text-[11px] text-gray-500 mt-0.5">
                {s.partner.name} · CDRL {s.deliverable.cdrlNumber || '—'} · due {fmtDate(s.deliverable.dueDate)}
                {s.submittedAt ? ` · sent ${fmtDate(s.submittedAt)}` : ''}
              </p>
              {s.note && <p className="text-[12px] text-gray-400 mt-1">{s.note}</p>}
              {s.reviewNotes && <p className="text-[12px] text-gray-500 mt-1">Your note: {s.reviewNotes}</p>}
              <Link to={`/contracts/${s.deliverable.contractId}`} className="text-[11px] text-blue-400 hover:text-blue-300">
                Open the contract
              </Link>
            </div>
            {s.fileName && (
              <button onClick={() => void partnerSubmissionsApi.downloadDeliverableSubmission(s.id, s.fileName!)}
                className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 flex items-center gap-1 flex-shrink-0">
                <Download className="w-3 h-3" /> Download
              </button>
            )}
          </div>
          {s.status === 'SUBMITTED' && (
            <Decision busy={review.isPending} acceptLabel="Accept response" rejectLabel="Request changes"
              onDecide={(accept, notes) => review.mutate({ id: s.id, accept, notes })} />
          )}
        </Row>
      ))}
      <p className="text-[10px] text-gray-600">
        Accepting means the prime accepted the subcontractor's work. It does not change the deliverable's own status —
        that stays your record of what the government accepted.
      </p>
    </div>
  )
}

/** Field-by-field diff. An approval writes to `Partner`, so it must be legible. */
function ProfileDiff({ previous, proposed }: { previous: Record<string, unknown>; proposed: Record<string, unknown> }) {
  const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v === null || v === undefined || v === '' ? '—' : String(v))
  const fields = Object.keys(proposed)
  if (fields.length === 0) return <p className="text-[12px] text-gray-500">Nothing was proposed.</p>
  return (
    <div className="mt-2 space-y-1">
      {fields.map((f) => (
        <div key={f} className="grid grid-cols-3 gap-2 text-[11px] items-start">
          <span className="text-gray-500">{f}</span>
          <span className="text-gray-600 line-through break-words">{show(previous?.[f])}</span>
          <span className="text-gray-200 break-words">{show(proposed[f])}</span>
        </div>
      ))}
    </div>
  )
}

function ProfileQueue() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { data, isLoading, error } = useQuery({
    queryKey: ['partner-profile-changes'],
    queryFn: partnerSubmissionsApi.listProfileChanges,
  })
  const review = useMutation({
    mutationFn: ({ id, accept, notes }: { id: string; accept: boolean; notes: string }) =>
      partnerSubmissionsApi.reviewProfileChange(id, { status: accept ? 'ACCEPTED' : 'REJECTED', reviewNotes: notes || null }),
    onSuccess: (res) => {
      const applied = res?.appliedFields ?? []
      toast(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Decision recorded', 'success')
      void qc.invalidateQueries({ queryKey: ['partner-profile-changes'] })
    },
    onError: (err: any) => toast(err?.response?.data?.error || 'Could not record the decision', 'error'),
  })

  if (isLoading) return <Spinner />
  if (error) return <ErrorBanner message="Could not load profile change requests." />
  const rows = (data ?? []) as PartnerProfileChangeRow[]
  if (rows.length === 0) return <EmptyState message="No subcontractor has proposed a profile change yet." />

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <Row key={r.id}>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm text-gray-100">{r.partner.name}</p>
            <StatusBadge status={r.status} />
            <span className="text-[11px] text-gray-500">
              {r.portalUser ? `${r.portalUser.firstName} ${r.portalUser.lastName}` : 'portal user'} · {fmtDate(r.createdAt)}
            </span>
          </div>
          {r.submittedNote && <p className="text-[12px] text-gray-400 mt-1">{r.submittedNote}</p>}
          <ProfileDiff previous={r.previous ?? {}} proposed={r.proposed ?? {}} />
          {r.reviewNotes && <p className="text-[12px] text-gray-500 mt-2">Your note: {r.reviewNotes}</p>}
          {r.status === 'PENDING_REVIEW' && (
            <Decision busy={review.isPending} acceptLabel="Approve and apply" rejectLabel="Reject"
              onDecide={(accept, notes) => review.mutate({ id: r.id, accept, notes })} />
          )}
        </Row>
      ))}
      <p className="text-[10px] text-gray-600">
        Approving writes the allowlisted fields onto the partner record. Your CRM notes and relationship score are never
        touched, and a partner can never propose them.
      </p>
    </div>
  )
}

export default function PartnerSubmissions() {
  const [queue, setQueue] = useTabParam(QUEUES.map((q) => q.id), 'documents')
  return (
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Partner submissions</h1>
        <p className="text-sm text-gray-500 mt-1">
          Everything your subcontractors sent through the portal. Nothing here changes a prime record until you decide.
        </p>
      </div>

      <div className="flex gap-1 border-b border-gray-800">
        {QUEUES.map((q) => (
          <button key={q.id} onClick={() => setQueue(q.id)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
              queue === q.id ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}>
            <q.icon className="w-4 h-4" /> {q.label}
          </button>
        ))}
      </div>

      {queue === 'documents' && <DocumentsQueue />}
      {queue === 'deliverables' && <DeliverablesQueue />}
      {queue === 'profile' && <ProfileQueue />}
    </div>
  )
}
