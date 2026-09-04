import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, FileText, CheckCircle, AlertTriangle, X, ArrowRight, Loader2, Building2, Hash, DollarSign, Calendar, Clock, Star, Trash2 } from 'lucide-react'
import { api, contractsApi, documentsApi } from '../services/api'

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
      <div>
        <div className="flex items-center gap-3 mb-1">
          <div className="p-2 rounded-lg" style={{ background: 'rgba(91,116,255,0.12)', border: '1px solid rgba(91,116,255,0.2)' }}>
            <Upload className="w-5 h-5 text-amber-400" />
          </div>
          <h1 className="text-2xl font-bold text-slate-100">Upload Contract / RFP</h1>
        </div>
        <p className="text-sm text-slate-500 ml-14">
          Add every file in the solicitation package — base RFP, amendments, SOW/PWS, attachments.
          The first file sets the contract details; the rest attach to the same opportunity, and all are analyzed together.
        </p>
      </div>

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
          className={`relative cursor-pointer rounded-xl p-10 text-center transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 ${
            dragOver ? 'border-amber-500/60' : staged.length ? 'border-emerald-500/40' : 'border-white/10 hover:border-white/20'
          } ${busy ? 'opacity-60 pointer-events-none' : ''}`}
          style={{
            border: `2px dashed ${dragOver ? 'rgba(91,116,255,0.5)' : staged.length ? 'rgba(52,211,153,0.4)' : 'rgba(255,255,255,0.1)'}`,
            background: dragOver ? 'rgba(91,116,255,0.05)' : 'rgba(255,255,255,0.02)',
          }}
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
            <div className="p-3 rounded-full" style={{ background: staged.length ? 'rgba(52,211,153,0.12)' : 'rgba(255,255,255,0.05)' }}>
              <Upload className={`w-8 h-8 ${staged.length ? 'text-emerald-400' : 'text-slate-500'}`} />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-400">
                {staged.length ? 'Add more files or drop them here' : 'Drop your contract files here'}
              </p>
              <p className="text-xs text-slate-600 mt-1">PDF, Word (.docx), or text · Max 25 MB each · Up to {MAX_FILES} files</p>
            </div>
          </div>
        </div>
      )}

      {/* Error / warning banner */}
      {error && (
        <div className="flex items-start gap-3 rounded-xl p-4" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
          <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* Staging list */}
      {state !== 'extracted' && staged.length > 0 && (
        <div className="rounded-xl p-5 space-y-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                {staged.length === 1 ? 'Document to analyze' : `Documents to analyze (${staged.length})`}
              </p>
              <span className="text-[10px] text-slate-600">{(totalSize / 1024 / 1024).toFixed(1)} MB total</span>
            </div>
            {!busy && (
              <button onClick={clearStaged} className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors">
                Clear all
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            {staged.map((sf, idx) => (
              <div
                key={sf.id}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div className="p-1.5 rounded-md flex-shrink-0" style={{ background: 'rgba(91,116,255,0.1)' }}>
                  {sf.status === 'uploading' ? (
                    <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                  ) : sf.status === 'done' ? (
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                  ) : sf.status === 'error' ? (
                    <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                  ) : (
                    <FileText className="w-3.5 h-3.5 text-amber-400/80" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-slate-300 truncate">{sf.file.name}</p>
                    {idx === 0 && (
                      <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full font-semibold flex-shrink-0" style={{ background: 'rgba(91,116,255,0.14)', border: '1px solid rgba(91,116,255,0.3)', color: '#7b8fff' }}>
                        <Star className="w-2.5 h-2.5" /> PRIMARY
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-600 truncate">
                    {(sf.file.size / 1024 / 1024).toFixed(2)} MB
                    {idx === 0 ? ' · sets contract details' : ''}
                    {sf.statusMsg ? ` · ${sf.statusMsg}` : ''}
                  </p>
                </div>
                {!busy && (
                  <button
                    onClick={() => removeFile(sf.id)}
                    aria-label={`Remove ${sf.file.name}`}
                    className="text-slate-600 hover:text-red-400 transition-colors flex-shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-600">
            The <span className="text-amber-400/90">primary</span> file (first in the list) creates the opportunity and provides its title, agency, NAICS and deadline. Remove it to promote the next file.
          </p>
        </div>
      )}

      {/* Upload progress */}
      {busy && (
        <div className="flex items-center gap-3 rounded-xl p-4" style={{ background: 'rgba(91,116,255,0.06)', border: '1px solid rgba(91,116,255,0.2)' }}>
          <Loader2 className="w-4 h-4 text-amber-400 animate-spin flex-shrink-0" />
          <p className="text-sm text-amber-300">{progress || 'Processing…'}</p>
        </div>
      )}

      {/* Analyze button */}
      {staged.length > 0 && state === 'idle' && (
        <button
          onClick={handleAnalyze}
          className="w-full py-3 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2"
          style={{ background: 'linear-gradient(135deg, rgba(91,116,255,0.9), rgba(234,88,12,0.9))', color: '#131318' }}
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
            className="flex-1 py-3 rounded-xl font-semibold text-sm transition-all"
            style={{ background: 'rgba(91,116,255,0.15)', border: '1px solid rgba(91,116,255,0.3)', color: '#7b8fff' }}
          >
            Retry
          </button>
          <button
            onClick={reset}
            className="px-4 py-3 rounded-xl text-sm text-slate-500 hover:text-slate-300 transition-colors"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Extraction Results */}
      {state === 'extracted' && result && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-emerald-400" />
            <p className="text-sm font-semibold text-emerald-300">
              Contract processed{staged.length > 1 ? ` · ${staged.filter(s => s.status === 'done').length} of ${staged.length} documents` : ''}
            </p>
          </div>

          <div className="rounded-xl p-5 space-y-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-500">Extracted Metadata</h3>

            <div>
              <p className="text-lg font-bold text-slate-100 leading-snug">{result.extracted.title}</p>
              {result.extracted.solicitationNumber && (
                <p className="text-xs text-slate-500 mt-0.5">Solicitation: {result.extracted.solicitationNumber}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-start gap-2">
                <Building2 className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-[10px] text-slate-600 uppercase tracking-wider">Agency</p>
                  <p className="text-sm text-slate-300">{result.extracted.agency}</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Hash className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-[10px] text-slate-600 uppercase tracking-wider">NAICS Code</p>
                  <p className="text-sm text-slate-300">{result.extracted.naicsCode || 'Not detected'}</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <DollarSign className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-[10px] text-slate-600 uppercase tracking-wider">Est. Value</p>
                  <p className="text-sm text-slate-300">
                    {result.extracted.estimatedValue ? fmt(result.extracted.estimatedValue) : 'Not stated'}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Calendar className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-[10px] text-slate-600 uppercase tracking-wider">Response Deadline</p>
                  <p className="text-sm text-slate-300">
                    {new Date(result.extracted.responseDeadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(91,116,255,0.12)', border: '1px solid rgba(91,116,255,0.25)', color: '#5b74ff' }}>
                {result.extracted.noticeType}
              </span>
              {result.extracted.setAsideType !== 'NONE' && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', color: '#34d399' }}>
                  {result.extracted.setAsideType}
                </span>
              )}
            </div>

            {result.extracted.description && (
              <p className="text-xs text-slate-500 leading-relaxed border-t border-white/5 pt-3">
                {result.extracted.description}
              </p>
            )}
          </div>

          {/* Documents in this contract package */}
          {staged.length > 1 && (
            <div className="rounded-xl p-5 space-y-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-500">Documents ({staged.length})</h3>
              <div className="space-y-1.5">
                {staged.map((sf, idx) => (
                  <div key={sf.id} className="flex items-center gap-3">
                    {sf.status === 'done'
                      ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                      : <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}
                    <span className="text-sm text-slate-300 truncate flex-1">{sf.file.name}</span>
                    {idx === 0 && <span className="text-[9px] text-amber-400/80">primary</span>}
                    <span className={`text-[11px] flex-shrink-0 ${sf.status === 'done' ? 'text-slate-500' : 'text-red-400'}`}>
                      {sf.status === 'done' ? (idx === 0 ? 'contract created' : 'attached') : (sf.statusMsg || 'failed')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => navigate(`/opportunities/${result.opportunityId}`)}
              className="flex-1 py-3 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, rgba(91,116,255,0.9), rgba(234,88,12,0.9))', color: '#131318' }}
            >
              Open Opportunity <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={reset}
              className="px-4 py-3 rounded-xl text-sm font-medium transition-all"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#b3aebb' }}
            >
              Upload Another
            </button>
          </div>

          <p className="text-[11px] text-slate-600 text-center">
            All documents are queued for full AI analysis. Open the opportunity to run the compliance matrix and generate bid guidance.
          </p>
        </div>
      )}

      {/* Info card when idle and nothing staged */}
      {state === 'idle' && staged.length === 0 && (
        <div className="rounded-xl p-5 space-y-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-600">What happens after upload</p>
          <div className="space-y-2">
            {[
              ['AI Extraction', 'Title, agency, NAICS, deadline, estimated value, and scope are extracted from the primary file'],
              ['One Opportunity', 'A single opportunity is created with every uploaded file attached as a document'],
              ['Document Analysis', 'Each document queues for scope analysis: complexity score, alignment, incumbent signals'],
              ['Bid Intelligence', 'Run compliance matrix and proposal assist from the opportunity detail page'],
            ].map(([title, desc]) => (
              <div key={title} className="flex gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-500/50 mt-1.5 flex-shrink-0" />
                <div>
                  <span className="text-xs font-medium text-slate-400">{title}: </span>
                  <span className="text-xs text-slate-600">{desc}</span>
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
        <div className="rounded-xl p-5 space-y-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-slate-500" />
            <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Recently Uploaded</p>
            {recent.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full text-slate-500" style={{ background: 'rgba(255,255,255,0.05)' }}>
                {recent.length}
              </span>
            )}
          </div>

          {recentLoading ? (
            <div className="flex items-center gap-2 py-1.5">
              <Loader2 className="w-3.5 h-3.5 text-slate-600 animate-spin flex-shrink-0" />
              <span className="text-xs text-slate-600">Loading your uploads...</span>
            </div>
          ) : recentError ? (
            <div className="flex items-center justify-between gap-3 py-1">
              <span className="text-xs text-slate-500">Could not load your uploads.</span>
              <button
                onClick={loadRecent}
                className="text-[11px] font-medium px-2 py-1 rounded-md transition-colors"
                style={{ background: 'rgba(91,116,255,0.12)', border: '1px solid rgba(91,116,255,0.25)', color: '#7b8fff' }}
              >
                Retry
              </button>
            </div>
          ) : recent.length === 0 ? (
            <p className="text-xs text-slate-600">Contracts you upload will appear here for quick access.</p>
          ) : (
            <div className="space-y-1.5">
              {recent.map((c) => {
                const fileName = c.documents?.[0]?.fileName || c.sourceUrl?.replace(/^MANUAL:/, '') || ''
                return (
                  <button
                    key={c.id}
                    onClick={() => navigate(`/opportunities/${c.id}`)}
                    className="w-full text-left rounded-lg px-3 py-2.5 transition-all flex items-center gap-3 group hover:border-white/20"
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
                  >
                    <div className="p-1.5 rounded-md flex-shrink-0" style={{ background: 'rgba(91,116,255,0.1)' }}>
                      <FileText className="w-3.5 h-3.5 text-amber-400/80" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-slate-300 truncate group-hover:text-slate-100 transition-colors">{c.title}</p>
                      <p className="text-[11px] text-slate-600 truncate">
                        {c.agency}{fileName ? ` · ${fileName}` : ''}{fmtDate(c.createdAt) ? ` · ${fmtDate(c.createdAt)}` : ''}
                      </p>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-600 group-hover:text-amber-400 transition-colors flex-shrink-0" />
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
