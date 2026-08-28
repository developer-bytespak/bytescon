// =============================================================
// §6.3D — Standing document library.
//
// Documents already stored elsewhere (registration, certification, insurance)
// appear here as REFERENCES to the same record — nothing is duplicated. The
// page also publishes the pre-submission validation catalogue, including the
// checks the platform explicitly cannot perform.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { FileCheck2, Link2, RefreshCw } from 'lucide-react'
import { useToast } from '../components/Toast'
import { useTabParam } from '../hooks/useTabParam'
import { PageHeader } from '../components/ui'
import {
  Badge, Disclaimer, EmptyPanel, ErrorPanel, ExpiryBadge, LoadingPanel, TabBar, VerifiedMark, formatDate,
} from '../components/section6/Section6Ui'
import { requirementsApi, type DocumentVersion, type StandingDocumentHealth } from '../services/section6Api'
import { ComplianceLibraryPanel } from '../components/section7/ComplianceAgentPanels'

const CATEGORIES = [
  'CAPABILITY_STATEMENT', 'CERTIFICATION', 'REGISTRATION', 'INSURANCE', 'BOND', 'FINANCIAL',
  'INDIRECT_RATE', 'RESUME', 'PAST_PERFORMANCE', 'REPRESENTATION', 'SIGNED_FORM', 'PROPOSAL_TEMPLATE', 'OTHER',
] as const

export default function DocumentLibrary() {
  const [tab, setTab] = useTabParam(['documents', 'checks', 'agent'] as const, 'documents')
  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <PageHeader
        title="Standing Document Library"
        subtitle="Reusable documents with expiry health, plus the exact pre-submission checks this platform does and does not perform."
      />
      <TabBar
        tabs={[{ key: 'documents', label: 'Documents' }, { key: 'checks', label: 'Validation checks' }, { key: 'agent', label: 'Compliance Agent' }]}
        active={tab}
        onChange={(k) => setTab(k as 'documents' | 'checks' | 'agent')}
      />
      <div className="mt-6">
        {tab === 'documents' && <DocumentsTab />}
        {tab === 'checks' && <ChecksTab />}
        {tab === 'agent' && <ComplianceLibraryPanel />}
      </div>
    </div>
  )
}

function DocumentsTab() {
  const { toast } = useToast()
  const [documents, setDocuments] = useState<StandingDocumentHealth[]>([])
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')
  const [form, setForm] = useState({ name: '', category: 'CAPABILITY_STATEMENT', expiryDate: '' })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await requirementsApi.listDocuments({
        ...(category ? { category } : {}),
        ...(search ? { search } : {}),
      })
      setDocuments(result.documents)
      setLabels(result.expiryLabels)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load the document library.')
    } finally {
      setLoading(false)
    }
  }, [category, search])

  useEffect(() => { void load() }, [load])

  const sync = async () => {
    setSyncing(true)
    try {
      const result = await requirementsApi.syncDocuments()
      toast(`${result.created} referenced, ${result.updated} refreshed. ${result.note}`, 'success')
      await load()
    } catch (err) {
      const e = err as { response?: { status?: number } }
      toast(e?.response?.status === 403 ? 'Only a firm admin can sync existing records.' : 'Could not sync existing records.', 'error')
    } finally {
      setSyncing(false)
    }
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) return
    setSubmitting(true)
    try {
      await requirementsApi.createDocument({
        name: form.name.trim(),
        category: form.category,
        ...(form.expiryDate ? { expiryDate: new Date(form.expiryDate).toISOString() } : {}),
      })
      setForm({ name: '', category: 'CAPABILITY_STATEMENT', expiryDate: '' })
      toast('Document added to the library.', 'success')
      await load()
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } }
      toast(e?.response?.data?.error || 'Could not add the document.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const approve = async (doc: StandingDocumentHealth) => {
    try {
      await requirementsApi.approveDocument(doc.id, !doc.approvedForReuse)
      await load()
    } catch {
      toast('Only a firm admin can approve a document for reuse.', 'error')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2 flex-wrap items-end">
        <div>
          <label htmlFor="doc-category" className="block text-[11px] text-gray-500 mb-1">Category</label>
          <select id="doc-category" value={category} onChange={(e) => setCategory(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500">
            <option value="">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="doc-search" className="block text-[11px] text-gray-500 mb-1">Search</label>
          <input id="doc-search" value={search} onChange={(e) => setSearch(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" placeholder="Document name" />
        </div>
        <button onClick={sync} disabled={syncing}
          className="text-xs px-3 py-2 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5">
          <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing…' : 'Reference existing records'}
        </button>
      </div>

      <form onSubmit={create} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Add a library document</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label htmlFor="new-doc-name" className="block text-[11px] text-gray-500 mb-1">Name</label>
            <input id="new-doc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
          </div>
          <div>
            <label htmlFor="new-doc-category" className="block text-[11px] text-gray-500 mb-1">Category</label>
            <select id="new-doc-category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="new-doc-expiry" className="block text-[11px] text-gray-500 mb-1">Expiry date (optional)</label>
            <input id="new-doc-expiry" type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
          </div>
        </div>
        <button type="submit" disabled={submitting || !form.name.trim()}
          className="mt-3 text-xs px-4 py-2 rounded text-gray-950 font-medium disabled:opacity-50"
          style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}>
          {submitting ? 'Adding…' : 'Add document'}
        </button>
      </form>

      {loading ? <LoadingPanel label="Loading documents…" />
        : error ? <ErrorPanel message={error} onRetry={load} />
        : documents.length === 0 ? (
          <EmptyPanel
            message="No documents in the library."
            hint="Use “Reference existing records” to surface the registration, certification and insurance files you already store."
          />
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => (
              <div key={doc.id} className="bg-gray-900 border border-gray-800 rounded-xl p-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-[220px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <FileCheck2 className="w-4 h-4 text-gray-500" />
                      <span className="text-sm text-gray-100">{doc.name}</span>
                      <Badge tone="neutral">{doc.category.replace(/_/g, ' ')}</Badge>
                      <ExpiryBadge state={doc.expiryState} label={labels[doc.expiryState] ?? doc.expiryState} message={doc.expiryMessage} />
                      {doc.approvedForReuse && <Badge tone="success">Approved for reuse</Badge>}
                      <VerifiedMark verified={doc.verification === 'VERIFIED'} />
                    </div>
                    <div className="flex gap-3 flex-wrap mt-1 text-[11px] text-gray-500">
                      <span>Expires {formatDate(doc.expiryDate)}</span>
                      <span className="inline-flex items-center gap-1"><Link2 className="w-3 h-3" /> used in {doc.usageCount} place(s)</span>
                      {doc.sourceSystem && doc.sourceSystem !== 'LIBRARY' && (
                        <span>
                          Referenced from{' '}
                          <Link to="/registration" className="text-amber-400 hover:text-amber-300">
                            {doc.sourceSystem.toLowerCase()}
                          </Link>
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-500 mt-1">{doc.expiryMessage}</p>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <button onClick={() => setOpenId((v) => (v === doc.id ? null : doc.id))}
                      aria-expanded={openId === doc.id}
                      className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors">
                      {openId === doc.id ? 'Hide history' : `History (v${doc.currentVersionNo})`}
                    </button>
                    <button onClick={() => approve(doc)}
                      className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors">
                      {doc.approvedForReuse ? 'Withdraw approval' : 'Approve for reuse'}
                    </button>
                  </div>
                </div>
                {openId === doc.id && <DocumentHistory doc={doc} onChanged={load} />}
              </div>
            ))}
          </div>
        )}

      <Disclaimer>
        Documents referenced from registration, certification or insurance records point at the same stored file — the library
        never keeps a second copy. Uploading a new version resets approval so it must be re-approved.
      </Disclaimer>
    </div>
  )
}

/**
 * Every version of one document, and where it is used.
 *
 * Superseded versions are kept rather than replaced: a proposal submitted last
 * year attached the file as it stood then, and that has to stay provable.
 * Recording a new version deliberately withdraws approval — the file people
 * vetted is not the file that is there now.
 */
function DocumentHistory({ doc, onChanged }: { doc: StandingDocumentHealth; onChanged: () => Promise<void> | void }) {
  const { toast } = useToast()
  const [versions, setVersions] = useState<DocumentVersion[]>([])
  const [links, setLinks] = useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ fileName: '', changeNote: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [v, u] = await Promise.all([
        requirementsApi.documentVersions(doc.id),
        requirementsApi.documentUsage(doc.id).catch(() => ({ links: [] })),
      ])
      setVersions(v.versions)
      setLinks((u.links ?? []) as Array<Record<string, unknown>>)
    } catch {
      setVersions([])
    } finally { setLoading(false) }
  }, [doc.id])
  useEffect(() => { void load() }, [load])

  const addVersion = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await requirementsApi.createDocumentVersion(doc.id, {
        fileName: form.fileName || null,
        changeNote: form.changeNote || null,
      })
      toast('New version recorded. Approval has been withdrawn until it is re-approved.', 'success')
      setForm({ fileName: '', changeNote: '' })
      await load()
      await onChanged()
    } catch (err) {
      toast((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not record that version.', 'error')
    } finally { setBusy(false) }
  }

  const input = 'bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 outline-none focus:border-blue-500'

  return (
    <div className="mt-3 pt-3 border-t border-gray-800 space-y-3">
      {loading ? <p className="text-[12px] text-gray-500">Loading history…</p> : versions.length === 0 ? (
        <p className="text-[12px] text-gray-500">No version has been recorded for this document yet.</p>
      ) : (
        <div className="space-y-1.5">
          {versions.map((v) => (
            <div key={v.id} className="flex items-center gap-2 flex-wrap text-[12px]">
              <span className="font-mono text-gray-400">v{v.versionNo}</span>
              {v.isCurrent ? <Badge tone="success">CURRENT</Badge> : <Badge tone="neutral">SUPERSEDED</Badge>}
              <span className="text-gray-500">{formatDate(v.createdAt)}</span>
              {v.fileName && <span className="text-gray-400">· {v.fileName}</span>}
              {v.changeNote && <span className="text-gray-500">· {v.changeNote}</span>}
            </div>
          ))}
        </div>
      )}

      {links.length > 0 && (
        <p className="text-[11px] text-gray-500">
          Used in {links.length} place(s). Replacing the file changes what those references point at.
        </p>
      )}

      <form onSubmit={addVersion} className="flex gap-2 flex-wrap items-center">
        <input aria-label="New version file name" placeholder="New file name" value={form.fileName}
          onChange={(e) => setForm({ ...form, fileName: e.target.value })} className={input} />
        <input aria-label="What changed" placeholder="What changed" value={form.changeNote}
          onChange={(e) => setForm({ ...form, changeNote: e.target.value })} className={`${input} flex-1 min-w-[180px]`} />
        <button type="submit" disabled={busy}
          className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-50">
          {busy ? 'Recording…' : 'Record new version'}
        </button>
      </form>
      <p className="text-[10px] text-gray-600">
        Recording a version withdraws approval. The file people vetted is not the file that is there now, so it has to be
        approved again before it can be reused.
      </p>
    </div>
  )
}

function ChecksTab() {
  const [checks, setChecks] = useState<Array<{ key: string; label: string; automatable: boolean; note?: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setChecks(await requirementsApi.validationCatalogue())
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load the validation catalogue.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <LoadingPanel label="Loading validation catalogue…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />

  const automated = checks.filter((c) => c.automatable)
  const manual = checks.filter((c) => !c.automatable)

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Checks the system performs automatically</h3>
        <div className="space-y-1.5">
          {automated.map((check) => (
            <div key={check.key} className="bg-gray-900 border border-gray-800 rounded-lg p-2.5 flex items-start justify-between gap-3">
              <div>
                <span className="text-xs text-gray-100">{check.label}</span>
                {check.note && <p className="text-[11px] text-gray-500 mt-0.5">{check.note}</p>}
              </div>
              <Badge tone="success">Automated</Badge>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Checks the system does NOT perform</h3>
        <p className="text-[11px] text-gray-500 mb-2">
          These are listed explicitly so nothing is assumed to have been verified when it was not. They must be confirmed by a person.
        </p>
        <div className="space-y-1.5">
          {manual.map((check) => (
            <div key={check.key} className="bg-gray-900 border border-gray-800 rounded-lg p-2.5 flex items-start justify-between gap-3">
              <div>
                <span className="text-xs text-gray-100">{check.label}</span>
                {check.note && <p className="text-[11px] text-gray-500 mt-0.5">{check.note}</p>}
              </div>
              <Badge tone="warning">Manual</Badge>
            </div>
          ))}
        </div>
      </div>

      <Disclaimer>
        Validation results are append-only. Re-running validation adds a new run and never erases the evidence from a previous one.
      </Disclaimer>
    </div>
  )
}
