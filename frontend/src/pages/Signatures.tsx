// =============================================================
// §8.4 — Signature requests for teaming agreements, NDAs and subcontracts.
//
// Sending is the moment a document leaves the building, so it is a separate,
// deliberate act: a request is created as a DRAFT, and only a person with
// ESIGN_SEND can send it. No agent can reach any of this.
//
// The screen is honest about the provider. Without a connected e-signature
// account nothing can actually be sent, and saying so up front is better than
// a create button that fails at the last step.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, FileSignature, PenLine, Plus, Send, X } from 'lucide-react'
import { PageHeader, Spinner } from '../components/ui'
import { Badge, EmptyPanel, ErrorPanel } from '../components/section6/Section6Ui'
import { useToast } from '../components/Toast'
import { SignaturePad } from '../components/SignaturePad'
import {
  esignApi, integrationsApi,
  type IntegrationConnection, type SignatureRequestRow,
} from '../services/integrationsApi'

const DOCUMENT_TYPES = ['TEAMING_AGREEMENT', 'NDA', 'SUBCONTRACT', 'OTHER'] as const
type DocumentType = (typeof DOCUMENT_TYPES)[number]

const TYPE_LABEL: Record<DocumentType, string> = {
  TEAMING_AGREEMENT: 'Teaming agreement',
  NDA: 'NDA',
  SUBCONTRACT: 'Subcontract',
  OTHER: 'Other',
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  DRAFT: 'neutral',
  READY_TO_SEND: 'info',
  SENT: 'info',
  VIEWED: 'info',
  PARTIALLY_SIGNED: 'warning',
  COMPLETED: 'success',
  DECLINED: 'danger',
  VOIDED: 'neutral',
  ERROR: 'danger',
}

const PANEL = 'bg-gray-900 border border-gray-800 rounded-xl p-4'
const INPUT = 'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500'

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

/** A request can only be sent while it is still unsent. */
const isSendable = (r: SignatureRequestRow) => r.status === 'DRAFT' || r.status === 'READY_TO_SEND'
/** Voiding a finished agreement would misrepresent what happened. */
const isVoidable = (r: SignatureRequestRow) =>
  !['COMPLETED', 'VOIDED', 'DECLINED'].includes(r.status)

interface SignerDraft { name: string; email: string; role: string }

function CreateForm({ onCreated }: { onCreated: () => Promise<void> | void }) {
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [f, setF] = useState({ title: '', documentType: 'TEAMING_AGREEMENT' as DocumentType })
  const [signers, setSigners] = useState<SignerDraft[]>([{ name: '', email: '', role: '' }])

  const setSigner = (i: number, patch: Partial<SignerDraft>) =>
    setSigners((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const filled = signers.filter((s) => s.name.trim() && s.email.trim())
    if (filled.length === 0) {
      toast('Add at least one signer with a name and an email.', 'error')
      return
    }
    setSaving(true)
    try {
      await esignApi.create({
        title: f.title,
        documentType: f.documentType,
        sourceType: 'UPLOAD',
        signers: filled.map((s, i) => ({
          name: s.name.trim(), email: s.email.trim(),
          role: s.role.trim() || null, routingOrder: i + 1,
        })),
      }, file)
      toast('Signature request created as a draft. It has not been sent.', 'success')
      setF({ title: '', documentType: 'TEAMING_AGREEMENT' })
      setSigners([{ name: '', email: '', role: '' }])
      setFile(null)
      await onCreated()
    } catch (err) {
      toast(readError(err, 'Could not create that request.'), 'error')
    } finally { setSaving(false) }
  }

  return (
    <form onSubmit={submit} className={`${PANEL} space-y-3`}>
      <p className="text-sm font-semibold text-gray-200">New signature request</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <input required aria-label="Title" placeholder="Title *" value={f.title}
          onChange={(e) => setF({ ...f, title: e.target.value })} className={INPUT} />
        <select aria-label="Document type" value={f.documentType}
          onChange={(e) => setF({ ...f, documentType: e.target.value as DocumentType })} className={INPUT}>
          {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      </div>

      <label className="block">
        <span className="text-[11px] text-gray-500">Document</span>
        <input type="file" aria-label="Document" className={INPUT}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>

      <div className="space-y-2">
        <p className="text-[11px] uppercase tracking-widest text-gray-500">Signers, in signing order</p>
        {signers.map((s, i) => (
          <div key={i} className="grid grid-cols-1 md:grid-cols-4 gap-2 items-center">
            <span className="text-[11px] text-gray-600 font-mono md:col-span-0">#{i + 1}</span>
            <input aria-label={`Signer ${i + 1} name`} placeholder="Name" value={s.name}
              onChange={(e) => setSigner(i, { name: e.target.value })} className={INPUT} />
            <input aria-label={`Signer ${i + 1} email`} type="email" placeholder="Email" value={s.email}
              onChange={(e) => setSigner(i, { email: e.target.value })} className={INPUT} />
            <input aria-label={`Signer ${i + 1} role`} placeholder="Role (optional)" value={s.role}
              onChange={(e) => setSigner(i, { role: e.target.value })} className={INPUT} />
          </div>
        ))}
        <button type="button" onClick={() => setSigners((p) => [...p, { name: '', email: '', role: '' }])}
          className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">
          Add another signer
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button type="submit" disabled={saving}
          className="text-xs px-4 py-2 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-50 flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5" /> {saving ? 'Creating…' : 'Create draft'}
        </button>
        <p className="text-[11px] text-gray-600">Creating never sends. Sending is a separate act.</p>
      </div>
    </form>
  )
}

export default function Signatures() {
  const { toast } = useToast()
  const [rows, setRows] = useState<SignatureRequestRow[]>([])
  const [connections, setConnections] = useState<IntegrationConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [padOpen, setPadOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [requests, integrations] = await Promise.all([
        esignApi.list(),
        // Failure-tolerant: not knowing the provider state must not hide the
        // requests themselves, which are the point of the page.
        integrationsApi.list().catch(() => [] as IntegrationConnection[]),
      ])
      setRows(requests)
      setConnections(integrations)
    } catch (err) {
      setError(readError(err, 'Could not load signature requests.'))
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const esignConnected = connections.some(
    (c) => c.provider === 'DOCUSIGN' && c.status === 'CONNECTED',
  )

  const send = async (r: SignatureRequestRow) => {
    if (!window.confirm(`Send "${r.title}" to ${r.signers.length} signer(s)? This leaves the building and cannot be unsent.`)) return
    setBusy(true)
    try {
      await esignApi.send(r.id)
      toast('Sent for signature.', 'success')
      await load()
    } catch (err) {
      toast(readError(err, 'Could not send that request.'), 'error')
    } finally { setBusy(false) }
  }

  const voidRequest = async (r: SignatureRequestRow) => {
    const reason = window.prompt(`Why is "${r.title}" being voided?`)
    if (!reason) return
    setBusy(true)
    try {
      await esignApi.void(r.id, reason)
      toast('Request voided.', 'success')
      await load()
    } catch (err) {
      toast(readError(err, 'Could not void that request.'), 'error')
    } finally { setBusy(false) }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
      <PageHeader
        title="Signatures"
        subtitle="Teaming agreements, NDAs and subcontracts sent for signature — and what happened to each one."
      />

      {!loading && !esignConnected && (
        <div className="bg-amber-950/20 border border-amber-900/60 rounded-xl p-4 flex gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-[13px] text-gray-200">No e-signature account is connected.</p>
            <p className="text-[12px] text-gray-400 mt-0.5">
              You can still prepare requests here, but nothing can be sent until an account is connected under
              Integrations.
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={() => setCreating((v) => !v)}
          className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 flex items-center gap-1.5">
          <FileSignature className="w-3.5 h-3.5" /> {creating ? 'Cancel' : 'New request'}
        </button>
      </div>

      {creating && <CreateForm onCreated={async () => { setCreating(false); await load() }} />}

      <div>
        <button onClick={() => setPadOpen((v) => !v)} aria-expanded={padOpen}
          className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 flex items-center gap-1.5">
          <PenLine className="w-3.5 h-3.5" /> {padOpen ? 'Close signature pad' : 'Signature pad'}
        </button>
      </div>
      {padOpen && <SignaturePad />}

      {loading ? <Spinner /> : error ? <ErrorPanel message={error} onRetry={load} /> : rows.length === 0 ? (
        <EmptyPanel
          message="No signature request yet."
          hint="Prepare a teaming agreement, NDA or subcontract here. It stays a draft until someone sends it."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className={PANEL}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-gray-100">{r.title}</span>
                    <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status.replace(/_/g, ' ')}</Badge>
                    <Badge tone="neutral">{TYPE_LABEL[r.documentType as DocumentType] ?? r.documentType}</Badge>
                  </div>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Created {fmt(r.createdAt)}
                    {r.sentAt ? ` · sent ${fmt(r.sentAt)}` : ''}
                    {r.completedAt ? ` · completed ${fmt(r.completedAt)}` : ''}
                    {r.provider ? ` · ${r.provider}` : ''}
                  </p>
                </div>

                <div className="flex gap-2 flex-shrink-0">
                  {r.fileName && (
                    <button onClick={() => void esignApi.downloadDocument(r.id, r.fileName!)}
                      className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 flex items-center gap-1">
                      <Download className="w-3 h-3" /> Document
                    </button>
                  )}
                  {isSendable(r) && (
                    <button disabled={busy} onClick={() => void send(r)}
                      className="text-[11px] px-2 py-1 rounded bg-green-900/40 hover:bg-green-900/60 text-green-300 border border-green-800 disabled:opacity-50 flex items-center gap-1">
                      <Send className="w-3 h-3" /> Send
                    </button>
                  )}
                  {isVoidable(r) && (
                    <button disabled={busy} onClick={() => void voidRequest(r)}
                      className="text-[11px] px-2 py-1 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-800 disabled:opacity-50 flex items-center gap-1">
                      <X className="w-3 h-3" /> Void
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-2 space-y-1">
                {r.signers.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 flex-wrap text-[12px]">
                    <span className="font-mono text-gray-600">#{s.routingOrder}</span>
                    <span className="text-gray-300">{s.name}</span>
                    <span className="text-gray-500">{s.email}</span>
                    <Badge tone={s.status === 'SIGNED' ? 'success' : s.status === 'DECLINED' ? 'danger' : 'neutral'}>
                      {s.status}
                    </Badge>
                    {s.signedAt && <span className="text-gray-600">{fmt(s.signedAt)}</span>}
                  </div>
                ))}
              </div>

              {r.declineReason && (
                <p className="text-[12px] text-red-300 mt-2">Declined: {r.declineReason}</p>
              )}
              {r.lastError && (
                <p className="text-[12px] text-amber-500/90 mt-2 flex gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />{r.lastError}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-gray-600">
        Sending is a human action gated on the ESIGN_SEND permission. No agent can create, send or void a signature
        request, and a completed agreement can never be voided — the record of what was signed has to stand.
      </p>
    </div>
  )
}
