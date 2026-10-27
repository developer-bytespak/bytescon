import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, FileText, CheckCircle, AlertTriangle, X, ArrowRight, Loader2, Building2, Hash, DollarSign, Calendar, Clock, Star, Trash2 } from 'lucide-react'
import { api, contractsApi, documentsApi } from '../services/api'
import { PageHeader } from '../components/ui'

type UploadState = 'idle' | 'uploading' | 'extracted' | 'error'
type FileStatus = 'pending' | 'uploading' | 'done' | 'error'

interface StagedFile {
  id: string
  file: File
  status: FileStatus
  statusMsg?: string
}

interface ExtractedData {
  opportunityId: string
  documentId: string
  extracted: {
    title: string
    agency: string
    naicsCode: string | null
    setAsideType: string
    estimatedValue: number | null
    responseDeadline: string
    description: string | null
    solicitationNumber: string | null
    noticeType: string
  }
}

// A previously uploaded contract, as returned by GET /api/contracts/manual.
// `id` is the opportunity id, so each row links straight to /opportunities/:id.
interface RecentContract {
  id: string
  title: string
  agency: string
  createdAt: string
  sourceUrl: string | null
  documents: { id: string; fileName: string; analysisStatus: string }[]
}

const ALLOWED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]
const ALLOWED_EXTS = ['.pdf', '.doc', '.docx', '.txt']
const MAX_FILES = 15

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function fmtDate(iso: string) {
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fileId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export default function ContractUploadPage() {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<UploadState>('idle')
  const [dragOver, setDragOver] = useState(false)
  const [staged, setStaged] = useState<StagedFile[]>([])
  const [result, setResult] = useState<ExtractedData | null>(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<string>('')
  const [recent, setRecent] = useState<RecentContract[]>([])
  const [recentLoading, setRecentLoading] = useState(true)
  const [recentError, setRecentError] = useState(false)

  // Load the firm's previously uploaded contracts so they stay reachable from
  // this page. Failure here is non-fatal — the list is a convenience, not a
  // prerequisite for uploading — but we surface a retry rather than hiding it.
  const loadRecent = useCallback(async () => {
    setRecentError(false)
    try {
      const res = await api.get<{ success: boolean; data: RecentContract[] }>('/contracts/manual')
      if (res.data?.success && Array.isArray(res.data.data)) {
        setRecent(res.data.data)
      }
    } catch {
      setRecentError(true)
    } finally {
      setRecentLoading(false)
    }
  }, [])

  useEffect(() => { loadRecent() }, [loadRecent])

  function validateFile(file: File): string | null {
    if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXTS.some(e => file.name.toLowerCase().endsWith(e))) {
      return 'Unsupported type — use PDF, Word (.docx/.doc), or text.'
    }
    if (file.size > 25 * 1024 * 1024) {
      return 'File too large (max 25 MB).'
    }
    return null
  }

  // Add a batch of files to the staging list. Valid files are appended (skipping
  // duplicates by name+size); invalid ones are summarized in the error banner so
  // the user knows what was rejected without blocking the rest.
  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return
    setStaged((prev) => {
      const skipped: string[] = []
      const next = [...prev]
      for (const file of files) {
        if (next.length >= MAX_FILES) { skipped.push(`${file.name} (max ${MAX_FILES} files)`); continue }
        const err = validateFile(file)
        if (err) { skipped.push(`${file.name} — ${err}`); continue }
        const dup = next.some((s) => s.file.name === file.name && s.file.size === file.size)
        if (dup) { skipped.push(`${file.name} (already added)`); continue }
        next.push({ id: fileId(), file, status: 'pending' })
      }
      setError(skipped.length ? `Skipped ${skipped.length} file(s): ${skipped.join('; ')}` : '')
      return next
    })
    setState('idle')
    setResult(null)
  }, [])

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    addFiles(Array.from(e.dataTransfer.files))
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files ?? []))
    // reset the input so re-selecting the same file fires onChange again
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function removeFile(id: string) {
    setStaged((prev) => prev.filter((s) => s.id !== id))
  }

  function clearStaged() {
    setStaged([])
    setError('')
  }

  function setFileStatus(id: string, status: FileStatus, statusMsg?: string) {
    setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, status, statusMsg } : s)))
  }

  // Submit the staged package as ONE contract: the first file creates the
  // opportunity (and drives metadata extraction); the rest attach to it as
  // additional documents. Each is queued for analysis server-side.
  async function handleAnalyze() {
    if (staged.length === 0) return
    setState('uploading')
    setError('')

    const [primary, ...rest] = staged
    let opportunityId: string | null = null
    let failedAttachments = 0

    // ── Primary: create the opportunity ──────────────────────────────────
    try {
      setProgress(rest.length ? `Analyzing primary document (1 of ${staged.length})…` : 'Analyzing document…')
      setFileStatus(primary.id, 'uploading')
      const res = await contractsApi.upload(primary.file)
      if (!res?.success || !res?.data?.opportunityId) {
        throw new Error(res?.error || 'Upload failed')
      }
      opportunityId = res.data.opportunityId
      setResult(res.data)
      setFileStatus(primary.id, 'done', 'Contract created')
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.response?.data?.message || err?.message || 'Upload failed'
      setFileStatus(primary.id, 'error', msg)
      setError(`Could not process "${primary.file.name}": ${msg}`)
      setState('error')
      setProgress('')
      return
    }

    // ── Attachments: add to the same opportunity ─────────────────────────
    for (let i = 0; i < rest.length; i++) {
      const sf = rest[i]
      try {
        setProgress(`Attaching document ${i + 2} of ${staged.length}: ${sf.file.name}…`)
        setFileStatus(sf.id, 'uploading')
        const res = await documentsApi.upload(opportunityId!, sf.file)
        if (res?.success === false) throw new Error(res?.error || 'Attach failed')
        setFileStatus(sf.id, 'done', 'Attached')
      } catch (err: any) {
        failedAttachments++
        const msg = err?.response?.data?.error || err?.response?.data?.message || err?.message || 'Attach failed'
        setFileStatus(sf.id, 'error', msg)
      }
    }

    setState('extracted')
    setProgress('')
    if (failedAttachments > 0) {
      setError(`${failedAttachments} attachment(s) could not be added — the contract and the rest were saved. You can retry from the opportunity page.`)
    }
    loadRecent()
  }

  function reset() {
    setState('idle')
    setStaged([])
    setResult(null)
    setError('')
    setProgress('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const busy = state === 'uploading'
  const totalSize = staged.reduce((s, f) => s + f.file.size, 0)

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <PageHeader
        title="Upload Contract / RFP"
        icon={<Upload />}
        subtitle="Add every file in the solicitation package — base RFP, amendments, SOW/PWS, attachments. The first file sets the contract details; the rest attach to the same opportunity, and all are analyzed together."
      />

      {/* Upload Zone */}
      {state !== 'extracted' && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload contract files: click or press Enter to browse, or drop files here"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => !busy && fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (!busy && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              fileInputRef.current?.click()
            }
          }}
          data-drag={dragOver}
          className={`dropzone cursor-pointer p-8 sm:p-10 text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${
            staged.length && !dragOver ? '!border-emerald-500/40' : ''
          } ${busy ? 'opacity-60 pointer-events-none' : ''}`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.txt"
            className="hidden"
            onChange={onFileInput}
          />
          <div className="flex flex-col items-center gap-3">
            <span className={`tile ${staged.length ? 'tile-success' : dragOver ? 'tile-accent' : 'tile-neutral'} !w-14 !h-14 !rounded-2xl`}>
              <Upload className="w-6 h-6" />
            </span>
            <div>
              <p className="text-sm font-medium text-slate-300">
                {staged.length ? 'Add more files or drop them here' : 'Drop your contract files here'}
              </p>
              <p className="text-xs text-slate-500 mt-1">PDF, Word (.docx), or text · Max 25 MB each · Up to {MAX_FILES} files</p>
            </div>
          </div>
        </div>
      )}

      {/* Error / warning banner */}
      {error && (
        <div className="flex items-start gap-3 rounded-xl p-4 animate-fade-in" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
          <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-300 min-w-0 break-words">{error}</p>
        </div>
      )}

      {/* Staging list */}
      {state !== 'extracted' && staged.length > 0 && (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <p className="overline">
                {staged.length === 1 ? 'Document to analyze' : `Documents to analyze (${staged.length})`}
              </p>
              <span className="text-[10px] text-slate-500 tabular-nums">{(totalSize / 1024 / 1024).toFixed(1)} MB total</span>
            </div>
            {!busy && (
              <button onClick={clearStaged} className="btn-ghost btn-sm">
                Clear all
              </button>
            )}
          </div>

          <div className="stagger space-y-1.5">
            {staged.map((sf, idx) => (
              <div
                key={sf.id}
                className="panel flex items-center gap-3 px-3 py-2.5"
              >
                <span className={`tile tile-sm flex-shrink-0 ${sf.status === 'done' ? 'tile-success' : sf.status === 'error' ? 'tile-danger' : 'tile-accent'}`}>
                  {sf.status === 'uploading' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : sf.status === 'done' ? (
                    <CheckCircle className="w-3.5 h-3.5" />
                  ) : sf.status === 'error' ? (
                    <AlertTriangle className="w-3.5 h-3.5" />
                  ) : (
                    <FileText className="w-3.5 h-3.5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-sm text-slate-300 truncate">{sf.file.name}</p>
                    {idx === 0 && (
                      <span className="chip chip-accent !text-[9px] flex-shrink-0">
                        <Star className="w-2.5 h-2.5" /> PRIMARY
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 truncate tabular-nums">
                    {(sf.file.size / 1024 / 1024).toFixed(2)} MB
                    {idx === 0 ? ' · sets contract details' : ''}
                    {sf.statusMsg ? ` · ${sf.statusMsg}` : ''}
                  </p>
                  {sf.status === 'uploading' && (
                    <div className="progress-track mt-2" aria-hidden="true"><div className="progress-indeterminate" /></div>
                  )}
                </div>
                {!busy && (
                  <button
                    onClick={() => removeFile(sf.id)}
                    aria-label={`Remove ${sf.file.name}`}
                    className="btn-ghost btn-sm !px-1.5 text-slate-500 hover:text-red-400 flex-shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">
            The <span className="text-blue-400">primary</span> file (first in the list) creates the opportunity and provides its title, agency, NAICS and deadline. Remove it to promote the next file.
          </p>
        </div>
      )}

      {/* Upload progress */}
      {busy && (
        <div className="rounded-xl p-4 space-y-3 animate-fade-in" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}>
          <div className="flex items-center gap-3">
            <Loader2 className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" />
            <p className="text-sm text-blue-300 min-w-0 break-words">{progress || 'Processing…'}</p>
          </div>
          <div className="progress-track" aria-hidden="true"><div className="progress-indeterminate" /></div>
        </div>
      )}

      {/* Analyze button */}
      {staged.length > 0 && state === 'idle' && (
        <button
          onClick={handleAnalyze}
          className="btn-primary w-full justify-center !py-3 flex items-center gap-2"
        >
          <Upload className="w-4 h-4" />
          {staged.length === 1 ? 'Upload & Analyze Contract' : `Analyze ${staged.length} Documents`}
        </button>
      )}

      {/* Retry after error */}
      {state === 'error' && staged.length > 0 && (
        <div className="flex gap-3">
          <button
            onClick={handleAnalyze}
            className="btn-primary flex-1 justify-center !py-3"
          >
            Retry
          </button>
          <button
            onClick={reset}
            aria-label="Clear and start over"
            className="btn-secondary !py-3"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Extraction Results */}
      {state === 'extracted' && result && (
        <div className="space-y-4 animate-fade-up">
          <div className="flex items-center gap-2">
            <span className="tile tile-sm tile-success"><CheckCircle className="w-4 h-4" /></span>
            <p className="text-sm font-semibold text-emerald-300 tabular-nums">
              Contract processed{staged.length > 1 ? ` · ${staged.filter(s => s.status === 'done').length} of ${staged.length} documents` : ''}
            </p>
          </div>

          <div className="card card-accent space-y-4">
            <h3 className="overline">Extracted Metadata</h3>

            <div>
              <p className="text-lg font-bold text-slate-100 leading-snug">{result.extracted.title}</p>
              {result.extracted.solicitationNumber && (
                <p className="text-xs text-slate-500 mt-0.5">Solicitation: {result.extracted.solicitationNumber}</p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="panel flex items-start gap-2.5 p-3">
                <Building2 className="w-3.5 h-3.5 text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="overline">Agency</p>
                  <p className="text-sm text-slate-300 mt-0.5 break-words">{result.extracted.agency}</p>
                </div>
              </div>
              <div className="panel flex items-start gap-2.5 p-3">
                <Hash className="w-3.5 h-3.5 text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="overline">NAICS Code</p>
                  <p className="text-sm text-slate-300 mt-0.5 tabular-nums">{result.extracted.naicsCode || 'Not detected'}</p>
                </div>
              </div>
              <div className="panel flex items-start gap-2.5 p-3">
                <DollarSign className="w-3.5 h-3.5 text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="overline">Est. Value</p>
                  <p className="text-sm text-slate-300 mt-0.5 tabular-nums">
                    {result.extracted.estimatedValue ? fmt(result.extracted.estimatedValue) : 'Not stated'}
                  </p>
                </div>
              </div>
              <div className="panel flex items-start gap-2.5 p-3">
                <Calendar className="w-3.5 h-3.5 text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="overline">Response Deadline</p>
                  <p className="text-sm text-slate-300 mt-0.5 tabular-nums">
                    {new Date(result.extracted.responseDeadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <span className="chip chip-accent">
                {result.extracted.noticeType}
              </span>
              {result.extracted.setAsideType !== 'NONE' && (
                <span className="chip chip-success">
                  {result.extracted.setAsideType}
                </span>
              )}
            </div>

            {result.extracted.description && (
              <p className="text-xs text-slate-500 leading-relaxed border-t border-ink/5 pt-3">
                {result.extracted.description}
              </p>
            )}
          </div>

          {/* Documents in this contract package */}
          {staged.length > 1 && (
            <div className="card space-y-3">
              <h3 className="overline">Documents ({staged.length})</h3>
              <div className="divide-y divide-gray-800">
                {staged.map((sf, idx) => (
                  <div key={sf.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                    {sf.status === 'done'
                      ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                      : <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}
                    <span className="text-sm text-slate-300 truncate flex-1 min-w-0">{sf.file.name}</span>
                    {idx === 0 && <span className="chip chip-accent !text-[9px]">primary</span>}
                    <span className={`text-[11px] flex-shrink-0 ${sf.status === 'done' ? 'text-slate-500' : 'text-red-400'}`}>
                      {sf.status === 'done' ? (idx === 0 ? 'contract created' : 'attached') : (sf.statusMsg || 'failed')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={() => navigate(`/opportunities/${result.opportunityId}`)}
              className="btn-primary flex-1 justify-center !py-3 flex items-center gap-2"
            >
              Open Opportunity <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={reset}
              className="btn-secondary justify-center !py-3"
            >
              Upload Another
            </button>
          </div>

          <p className="text-[11px] text-slate-500 text-center">
            All documents are queued for full AI analysis. Open the opportunity to run the compliance matrix and generate bid guidance.
          </p>
        </div>
      )}

      {/* Info card when idle and nothing staged */}
      {state === 'idle' && staged.length === 0 && (
        <div className="card space-y-3">
          <p className="overline">What happens after upload</p>
          <div className="space-y-2.5">
            {[
              ['AI Extraction', 'Title, agency, NAICS, deadline, estimated value, and scope are extracted from the primary file'],
              ['One Opportunity', 'A single opportunity is created with every uploaded file attached as a document'],
              ['Document Analysis', 'Each document queues for scope analysis: complexity score, alignment, incumbent signals'],
              ['Bid Intelligence', 'Run compliance matrix and proposal assist from the opportunity detail page'],
            ].map(([title, desc]) => (
              <div key={title} className="flex gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500/60 mt-1.5 flex-shrink-0" />
                <div>
                  <span className="text-xs font-medium text-slate-300">{title}: </span>
                  <span className="text-xs text-slate-500">{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recently uploaded — quick access back to any contract uploaded here.
          Hidden while the post-upload result card is showing so the same
          contract is not presented twice. */}
      {state !== 'extracted' && (
        <div className="card space-y-3">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-slate-500" />
            <p className="overline">Recently Uploaded</p>
            {recent.length > 0 && (
              <span className="tab-count">
                {recent.length}
              </span>
            )}
          </div>

          {recentLoading ? (
            <div className="flex items-center gap-2 py-1.5">
              <Loader2 className="w-3.5 h-3.5 text-slate-600 animate-spin flex-shrink-0" />
              <span className="text-xs text-slate-500">Loading your uploads...</span>
            </div>
          ) : recentError ? (
            <div className="flex items-center justify-between gap-3 py-1">
              <span className="text-xs text-slate-500">Could not load your uploads.</span>
              <button
                onClick={loadRecent}
                className="btn-secondary btn-sm"
              >
                Retry
              </button>
            </div>
          ) : recent.length === 0 ? (
            <p className="text-xs text-slate-500">Contracts you upload will appear here for quick access.</p>
          ) : (
            <div className="stagger space-y-1.5">
              {recent.map((c) => {
                const fileName = c.documents?.[0]?.fileName || c.sourceUrl?.replace(/^MANUAL:/, '') || ''
                return (
                  <button
                    key={c.id}
                    onClick={() => navigate(`/opportunities/${c.id}`)}
                    className="panel w-full text-left px-3 py-2.5 transition-colors flex items-center gap-3 group hover:border-blue-500/40"
                  >
                    <span className="tile tile-sm tile-accent flex-shrink-0">
                      <FileText className="w-3.5 h-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-slate-300 truncate group-hover:text-slate-100 transition-colors">{c.title}</p>
                      <p className="text-[11px] text-slate-500 truncate tabular-nums">
                        {c.agency}{fileName ? ` · ${fileName}` : ''}{fmtDate(c.createdAt) ? ` · ${fmtDate(c.createdAt)}` : ''}
                      </p>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-600 group-hover:text-blue-400 group-hover:translate-x-0.5 transition-all flex-shrink-0" />
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
