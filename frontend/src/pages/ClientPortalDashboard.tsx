import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  LogOut, FileText, DollarSign, Gift, CheckCircle,
  AlertTriangle, Clock, ChevronDown, ChevronUp, Upload,
  Briefcase, TrendingUp, Building2, X, Loader, Settings as SettingsIcon,
} from 'lucide-react'
import axios from 'axios'
import { clientPortalApi } from '../services/api'
import { penaltyReasonText } from '../utils/penaltyReason'
import { ClientDeliverableReview } from '../components/ClientDeliverableReview'
import { NotificationPreferences } from '../components/NotificationPreferences'
import { useBranding } from '../hooks/useBranding'
import { fitDisplay } from '../utils/fitTier'
import { humanize } from '../lib/humanize'
import { motion } from 'framer-motion'
import { StatCard, EmptyState, Skeleton, SkeletonStats, Tabs, useCardSpotlight, ScoreRing } from '../components/ui'

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

const SET_ASIDE_LABELS: Record<string, string> = {
  NONE: 'Open', SMALL_BUSINESS: 'SB', SDVOSB: 'SDVOSB',
  WOSB: 'WOSB', HUBZONE: 'HUBZone', SBA_8A: '8(a)', TOTAL_SMALL_BUSINESS: 'TSB',
}

function NoticeTag({ type }: { type?: string }) {
  if (!type) return null
  const t = type.toLowerCase()
  if (t.includes('sole source')) return <span className="chip chip-neutral">Sole source</span>
  if (t.includes('sources sought') || t.includes('rfi')) return <span className="chip chip-neutral">RFI</span>
  if (t.includes('presolicitation')) return <span className="chip chip-neutral">Presolicitation</span>
  return null
}

interface DocRequirement {
  id: string; title: string; description?: string; dueDate: string
  status: string; daysUntil: number; urgency: string
  isPenaltyEnabled: boolean; penaltyAmount?: number; penaltyPercent?: number
  opportunity?: { id: string; title: string; estimatedValue?: number | null; probabilityScore?: number | null; expectedValue?: number | null; scoreBreakdown?: any }
}
interface Penalty { id: string; amount: number; reason: string; isPaid: boolean; appliedAt: string }
interface Reward { id: string; rewardType: string; description: string; value?: number; percentDiscount?: number; isRedeemed: boolean; expiresAt?: string; triggerReason: string }
// probabilityScore is null when this client has no BidDecision of their own for
// the opportunity. The backend deliberately no longer falls back to the
// firm-wide score (which belongs to whichever client matched best), and
// fitDisplay(null) renders 'not yet scored'.
interface ContractOpp { id: string; title: string; agency: string; naicsCode: string; setAsideType: string; noticeType?: string; estimatedValue?: number; probabilityScore: number | null; responseDeadline: string; recompeteFlag: boolean; isDeclined: boolean }

// One clear status per document. Same words as before, larger and colour-coded.
function UrgencyBadge({ urgency, daysUntil }: { urgency: string; daysUntil: number }) {
  if (urgency === 'SUBMITTED') return <span className="chip chip-success chip-lg"><CheckCircle className="w-3.5 h-3.5" /> Submitted</span>
  if (urgency === 'OVERDUE') return <span className="chip chip-danger chip-lg"><AlertTriangle className="w-3.5 h-3.5" /> Overdue</span>
  if (urgency === 'URGENT') return <span className="chip chip-danger chip-lg"><AlertTriangle className="w-3.5 h-3.5" /> Urgent, {daysUntil}d left</span>
  if (urgency === 'SOON') return <span className="chip badge-yellow chip-lg"><Clock className="w-3.5 h-3.5" /> {daysUntil}d remaining</span>
  return <span className="chip chip-neutral chip-lg"><CheckCircle className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} /> {daysUntil}d remaining</span>
}


function DocCard({ req, onMarkSubmitted, onUploadFor, showNumericScore }: { req: DocRequirement; onMarkSubmitted: (id: string) => void; onUploadFor: (req: DocRequirement) => void; showNumericScore?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const fmt = (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`
  const due = new Date(req.dueDate)
  return (
    <div className="card !p-0 overflow-hidden relative">
      <div className="p-5 sm:p-6 flex gap-4">
        {/* Calendar-style due date */}
        <div className="hidden sm:flex flex-col items-center justify-center w-14 h-16 rounded-xl flex-shrink-0" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }} aria-hidden="true">
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{due.toLocaleDateString('en-US', { month: 'short' })}</span>
          <span className="text-xl font-semibold leading-none tabular-nums" style={{ color: 'var(--text)' }}>{due.getDate()}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-col-reverse sm:flex-row sm:items-start justify-between gap-2 sm:gap-3 mb-2">
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-[15px]" style={{ color: 'var(--text)' }}>{req.title}</h3>
              {req.opportunity && <p className="text-xs text-gray-500 mt-0.5 truncate">Related to: {req.opportunity.title}</p>}
            </div>
            <div className="flex-shrink-0"><UrgencyBadge urgency={req.urgency} daysUntil={req.daysUntil} /></div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 mb-3">
            <span className="tabular-nums">Due: {new Date(req.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            {req.isPenaltyEnabled && req.urgency !== 'SUBMITTED' && (
              <span style={{ color: 'var(--danger-text)' }}>Penalty: {req.penaltyAmount ? `$${req.penaltyAmount.toLocaleString()} flat` : req.penaltyPercent ? `${req.penaltyPercent}%` : 'configured'}</span>
            )}
          </div>
          {req.description && <p className="text-sm text-gray-400 mb-3 leading-relaxed">{req.description}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {req.status === 'PENDING' && (
              <>
                <button onClick={() => onUploadFor(req)} className="btn-primary btn-sm">
                  <Upload className="w-3.5 h-3.5" />
                  Upload and submit
                </button>
                <button onClick={() => onMarkSubmitted(req.id)} className="btn-secondary btn-sm">
                  <CheckCircle className="w-3.5 h-3.5" />
                  Mark as submitted
                </button>
              </>
            )}
            {req.opportunity?.scoreBreakdown && (
              <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="btn-ghost btn-sm">
                Why us? {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            )}
          </div>
          {expanded && req.opportunity?.scoreBreakdown && (
            <div className="mt-4 pt-4 border-t border-gray-800 animate-fade-up">
              <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text)' }}>Why you're a good fit</p>
              <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                {`Fit: ${fitDisplay(req.opportunity.probabilityScore, showNumericScore)} (directional, not a guarantee)`}
                {req.opportunity.expectedValue ? ` · Est. value: ${fmt(req.opportunity.expectedValue)}` : ''}
              </p>
              <div className="space-y-2.5">
                {req.opportunity.scoreBreakdown?.factorContributions?.sort((a: any, b: any) => b.weight - a.weight).slice(0, 4).map((f: any, i: number) => (
                  <div key={f.factor} className="flex items-center gap-2">
                    <div className="v3-bar flex-1">
                      <i style={{ width: `${f.pct}%`, animationDelay: `${i * 60}ms` }} />
                    </div>
                    <span className="text-xs text-gray-400 w-24 text-right truncate">{f.factor.replace(/Score$/, '').replace(/([A-Z])/g, ' $1').trim()}</span>
                    <span className="text-xs font-semibold tabular-nums text-gray-500 w-8 text-right">{f.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// When `requirement` is set the upload answers that document request: the title
// is prefilled so the consultant can match it, and onUploaded marks it submitted.
function UploadModal({ onClose, onUploaded, requirement }: { onClose: () => void; onUploaded: () => void | Promise<void>; requirement?: { id: string; title: string } }) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState(requirement?.title ?? '')
  const [notes, setNotes] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleUpload = async () => {
    if (!file) return
    setUploading(true); setError('')
    try {
      const requestNote = requirement ? `For document request: ${requirement.title}` : ''
      await clientPortalApi.uploadDoc(file, title || file.name, [requestNote, notes].filter(Boolean).join('\n') || undefined)
      await onUploaded(); onClose()
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Upload failed')
    } finally { setUploading(false) }
  }

  return (
    <div className="modal-backdrop fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="cp-upload-title" className="modal-panel w-full max-w-md p-7" style={{ background: 'var(--surface)' }}>
        <div className="flex items-center justify-between mb-2">
          <h3 id="cp-upload-title" className="v3-h3" style={{ color: 'var(--text)' }}>Upload document</h3>
          <button onClick={onClose} className="btn-ghost btn-sm !px-2" aria-label="Close"><X className="w-5 h-5 text-gray-500" /></button>
        </div>
        <p className="text-sm text-gray-500 mb-5">
          {requirement
            ? <>Upload the file for <span className="font-medium text-gray-300">{requirement.title}</span>. The request is marked submitted once the upload finishes.</>
            : "Send a document directly to your consultant. They'll be notified and can review it in your file."}
        </p>
        <div className="space-y-4">
          <div>
            <label className="label">File *</label>
            <div
              role="button"
              tabIndex={0}
              className="dropzone p-6 text-center cursor-pointer"
              data-drag={dragging}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click() } }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f) }}
            >
              <span className={`tile mx-auto mb-3 ${file ? 'tile-success' : 'tile-neutral'}`}>{file ? <CheckCircle /> : <Upload />}</span>
              {file ? (
                <p className="text-sm text-gray-300 font-medium break-all">{file.name} <span className="text-gray-500 font-normal tabular-nums">({(file.size / 1024).toFixed(0)} KB)</span></p>
              ) : (
                <p className="text-sm text-gray-500">Click to choose a file, or drag and drop it here</p>
              )}
            </div>
            <input ref={fileRef} type="file" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
          </div>
          <div>
            <label className="label" htmlFor="cp-upload-title-input">Title (optional)</label>
            <input id="cp-upload-title-input" className="input" placeholder="e.g. Q2 Capability Statement" value={title} onChange={e => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="cp-upload-notes">Notes (optional)</label>
            <textarea id="cp-upload-notes" className="input resize-none" rows={2} placeholder="Any notes for your consultant..." value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm" style={{ color: 'var(--danger-text)' }}>{error}</p>}
          {uploading && <div className="progress-track" aria-hidden="true"><div className="progress-indeterminate" /></div>}
          <button onClick={handleUpload} disabled={!file || uploading} className="btn-primary w-full">
            {uploading ? <><Loader className="w-4 h-4 animate-spin" /> Uploading...</> : <><Upload className="w-4 h-4" /> Send to consultant</>}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ClientPortalDashboard() {
  const navigate = useNavigate()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'docs' | 'deliverables' | 'contracts' | 'uploads' | 'penalties' | 'rewards' | 'settings'>('docs')
  const [contracts, setContracts] = useState<ContractOpp[]>([])
  const [contractsLoading, setContractsLoading] = useState(false)
  const [uploads, setUploads] = useState<any[]>([])
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [uploadForReq, setUploadForReq] = useState<DocRequirement | null>(null)
  const [contractFilter, setContractFilter] = useState<'all' | 'active' | 'declined'>('active')

  const auth = (() => { try { return JSON.parse(localStorage.getItem('bytesgov_client_auth') ?? '') } catch { return null } })()
  const { branding } = useBranding(data?.client?.consultingFirmId)
  useCardSpotlight()

  const loadDashboard = () => {
    if (!auth?.token) { navigate('/client-login'); return }
    axios.get(`${API_BASE}/api/client-portal/dashboard`, { headers: { Authorization: `Bearer ${auth.token}` } })
      .then(r => setData(r.data.data))
      .catch(err => setError(
        err?.response?.data?.code === 'PORTAL_UNAVAILABLE'
          ? err.response.data.error
          : 'Failed to load dashboard'
      ))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadDashboard() }, [])

  // Contracts and uploads load up front — the stat card and tab counts read them
  // before either tab is opened.
  useEffect(() => {
    setContractsLoading(true)
    clientPortalApi.getOpportunities()
      .then(r => setContracts(r.data || []))
      .catch(() => {})
      .finally(() => setContractsLoading(false))
  }, [])

  useEffect(() => {
    clientPortalApi.getUploads().then(r => setUploads(r.data || [])).catch(() => {})
  }, [tab === 'uploads'])

  const handleMarkSubmitted = async (reqId: string) => {
    try {
      await axios.put(`${API_BASE}/api/client-portal/doc-requirements/${reqId}/submit`, {}, { headers: { Authorization: `Bearer ${auth.token}` } })
      loadDashboard()
    } catch {
      /* best-effort — requirement stays unmarked and can be retried */
    }
  }

  const handleLogout = () => { localStorage.removeItem('bytesgov_client_auth'); navigate('/client-login') }

  if (loading) return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }} aria-busy="true">
      <span className="sr-only">Loading your dashboard...</span>
      <div className="h-16" style={{ borderBottom: '1px solid var(--line)' }} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        <SkeletonStats count={4} />
        <Skeleton className="h-10 w-full" />
        {[0, 1, 2].map((i) => <div key={i} className="card space-y-3"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-1/3" /><Skeleton className="h-8 w-36" /></div>)}
      </div>
    </div>
  )
  if (error || !data) return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg)' }}>
      <div className="card text-center max-w-sm w-full animate-fade-up">
        <span className="tile tile-danger mx-auto mb-4"><AlertTriangle /></span>
        <p className="mb-5" style={{ color: 'var(--danger-text)' }}>{error || 'Session expired'}</p>
        <button onClick={() => navigate('/client-login')} className="btn-secondary">Return to login</button>
      </div>
    </div>
  )

  const { client, docRequirements, penalties, rewards, summary } = data
  const fmt = (v?: number) => !v ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v}`
  const filteredContracts = contracts.filter(c =>
    contractFilter === 'all' ? true : contractFilter === 'active' ? !c.isDeclined : c.isDeclined
  )

  return (
    <div className="relative isolate min-h-screen" style={{ background: 'var(--bg)' }}>
      {showUploadModal && (
        <UploadModal onClose={() => setShowUploadModal(false)} onUploaded={() => {
          clientPortalApi.getUploads().then(r => setUploads(r.data || [])).catch(() => {})
        }} />
      )}
      {uploadForReq && (
        <UploadModal
          requirement={{ id: uploadForReq.id, title: uploadForReq.title }}
          onClose={() => setUploadForReq(null)}
          onUploaded={async () => {
            await handleMarkSubmitted(uploadForReq.id)
            clientPortalApi.getUploads().then(r => setUploads(r.data || [])).catch(() => {})
          }}
        />
      )}

      {/* Header */}
      <header
        className="topbar px-4 sm:px-6 py-4"
      >
        <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.displayName} className="w-10 h-10 rounded-xl object-contain" style={{ background: 'var(--surface)' }} />
            ) : (
              <span aria-hidden="true" style={{ fontSize: 24, lineHeight: 1, fontWeight: 800, letterSpacing: '-0.06em', color: 'var(--text)' }}>
                B<i style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 999, background: 'var(--v3-blue)', marginLeft: 1 }} />
              </span>
            )}
            <div className="min-w-0">
              {/* Solid colour on purpose: gradient text renders as a filled box
                  inside the blurred (backdrop-filter) header in Chromium. */}
              <p className="text-base font-semibold leading-tight tracking-[-0.01em]" style={{ color: 'var(--text)' }}>
                {branding.displayName}
              </p>
              <p className="text-xs text-gray-500 truncate">{client?.name} · {branding.tagline}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowUploadModal(true)} className="btn-secondary btn-sm">
              <Upload className="w-3.5 h-3.5" /> Send file to consultant
            </button>
            <button onClick={handleLogout} className="btn-ghost btn-sm">
              <LogOut className="w-4 h-4" /> Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Welcome hero */}
        {(() => {
          const total = summary.totalDocuments ?? 0
          const done = summary.submitted ?? 0
          const pct = total > 0 ? Math.round((done / total) * 100) : 100
          return (
            <section className="v3-surface mb-4">
              <div className="relative flex flex-col md:flex-row md:items-center md:justify-between gap-6">
                <div className="min-w-0">
                  <h1 className="v3-h2" style={{ color: 'var(--text)' }}>Welcome back, {client?.name}</h1>
                  <p className="v3-lede mt-3 max-w-lg" style={{ color: 'var(--text-muted)' }}>
                    {summary.overdue > 0
                      ? `${summary.overdue} document${summary.overdue === 1 ? ' is' : 's are'} overdue. Send ${summary.overdue === 1 ? 'it' : 'them'} in as soon as you can.`
                      : summary.pending > 0
                        ? `${summary.pending} document${summary.pending === 1 ? '' : 's'} waiting on you. Everything else is on track.`
                        : "You're all caught up."}
                  </p>
                  <div className="flex flex-wrap gap-2 mt-5">
                    <button onClick={() => setShowUploadModal(true)} className="btn-primary">
                      <Upload className="w-4 h-4" /> Send file to consultant
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-4 md:flex-col md:gap-2 md:text-center flex-shrink-0">
                  <ScoreRing value={pct} size={128} stroke={10} color={summary.overdue > 0 ? 'var(--danger)' : 'var(--text)'}>
                    <div>
                      <p className="text-3xl font-semibold tabular-nums leading-none" style={{ color: 'var(--text)' }}>{pct}%</p>
                      <p className="overline mt-1">submitted</p>
                    </div>
                  </ScoreRing>
                  <p className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {done} of {total} documents
                  </p>
                </div>
              </div>
            </section>
          )
        })()}

        {/* KPI Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-8">
          <StatCard
            label="Docs due"
            value={summary.totalDocuments}
            sub={`${summary.submitted} submitted · ${summary.overdue} overdue`}
            tone={summary.overdue > 0 ? 'danger' : 'neutral'}
            icon={<FileText />}
          />
          <StatCard
            label="Matched contracts"
            value={contractsLoading ? '—' : contracts.filter(c => !c.isDeclined).length}
            sub="Based on your NAICS codes"
            tone="neutral"
            icon={<Briefcase />}
          />
          <StatCard
            label="Outstanding fees"
            value={`$${summary.totalOutstandingFees.toLocaleString()}`}
            tone={summary.totalOutstandingFees > 0 ? 'danger' : 'neutral'}
            icon={<DollarSign />}
          />
          <StatCard
            label="Active rewards"
            value={summary.activeRewards}
            sub="Submit docs on time to earn"
            tone="neutral"
            icon={<Gift />}
          />
        </div>

        {/* Tabs */}
        <Tabs
          id="client-portal"
          className="mb-6"
          value={tab}
          onChange={(k) => setTab(k)}
          items={([
            { key: 'docs', label: 'Documents', icon: FileText, count: summary.pending },
            { key: 'deliverables', label: 'Proposals', icon: FileText, count: 0 },
            { key: 'contracts', label: 'My contracts', icon: Briefcase, count: contracts.filter(c => !c.isDeclined).length },
            { key: 'uploads', label: 'My uploads', icon: Upload, count: uploads.length },
            { key: 'penalties', label: 'Fees', icon: DollarSign, count: penalties?.filter((p: any) => !p.isPaid).length },
            { key: 'rewards', label: 'Rewards', icon: Gift, count: summary.activeRewards },
            { key: 'settings', label: 'Notifications', icon: SettingsIcon, count: 0 },
          ] as const).map(({ key, label, icon: Icon, count }) => ({ key, label, icon: <Icon className="w-4 h-4" />, count }))}
        />

        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
        {/* Tab: Document Requirements */}
        {tab === 'docs' && (
          <div className="space-y-3">
            {docRequirements?.length === 0 && <div className="card"><EmptyState message="No document requirements assigned." hint={null} icon={<FileText />} /></div>}
            {docRequirements?.map((req: DocRequirement) => (
              <DocCard key={req.id} req={req} onMarkSubmitted={handleMarkSubmitted} onUploadFor={setUploadForReq} showNumericScore={(data as any)?.showNumericScore} />
            ))}
          </div>
        )}

        {/* Tab: Deliverables Review */}
        {tab === 'deliverables' && (
          <ClientDeliverableReview clientAuth={auth} onDeliverableUpdated={loadDashboard} />
        )}

        {/* Tab: Matched Contracts */}
        {tab === 'contracts' && (
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <p className="text-sm text-gray-400 max-w-xl">
                Contracts matched to your NAICS codes — active, open solicitations. Your consultant reviews these on your behalf.
              </p>
              <div className="segmented self-start flex-shrink-0">
                {(['active', 'all', 'declined'] as const).map(f => (
                  <button key={f} onClick={() => setContractFilter(f)} data-active={contractFilter === f}>
                    {contractFilter === f && <motion.span layoutId="cp-contract-filter" className="segmented-thumb" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            {contractsLoading && (
              <div className="space-y-2" aria-busy="true">
                <span className="sr-only">Loading contracts...</span>
                {[0, 1, 2].map((i) => <div key={i} className="card space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/3" /></div>)}
              </div>
            )}
            {!contractsLoading && filteredContracts.length === 0 && (
              <div className="card">
                <EmptyState message={contracts.length === 0 ? 'No contracts matched to your NAICS codes yet.' : 'No contracts in this filter.'} hint={null} icon={<Briefcase />} />
              </div>
            )}
            <div className="space-y-2">
              {filteredContracts.map(opp => (
                <div key={opp.id} className={`card !p-4 transition-[opacity,border-color] ${opp.isDeclined ? 'opacity-50' : 'hover:border-[color:var(--line-strong)]'}`}>
                  <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <p className={`text-sm font-medium ${opp.isDeclined ? 'text-gray-600 line-through' : 'text-gray-200'}`}>{opp.title}</p>
                        <NoticeTag type={opp.noticeType} />
                        {opp.isDeclined && <span className="chip chip-neutral">Not pursuing</span>}
                        {opp.recompeteFlag && <span className="chip chip-neutral">Recompete</span>}
                      </div>
                      <p className="text-xs text-gray-500">
                        <Building2 className="w-3 h-3 inline mr-1" />{opp.agency} · NAICS {opp.naicsCode} · {SET_ASIDE_LABELS[opp.setAsideType] || opp.setAsideType}
                      </p>
                    </div>
                    <div className="sm:text-right flex-shrink-0 flex sm:block items-center gap-4">
                      <p className="text-sm font-semibold tabular-nums text-gray-300">{opp.estimatedValue != null ? fmt(opp.estimatedValue) : 'TBD'}</p>
                      <div className="flex items-center gap-1 sm:justify-end sm:mt-1">
                        <TrendingUp className="w-3 h-3 text-gray-500" aria-hidden="true" />
                        <span className="text-xs text-gray-400">{fitDisplay(opp.probabilityScore)}</span>
                      </div>
                      <p className="text-xs text-gray-600 sm:mt-1 tabular-nums">Due {new Date(opp.responseDeadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tab: My Uploads */}
        {tab === 'uploads' && (
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <p className="text-sm text-gray-400">Files you've sent to your consultant. They can download these from your client file.</p>
              <button onClick={() => setShowUploadModal(true)} className="btn-primary btn-sm self-start flex-shrink-0">
                <Upload className="w-3.5 h-3.5" /> Upload new file
              </button>
            </div>
            {uploads.length === 0 ? (
              <button type="button" onClick={() => setShowUploadModal(true)} className="dropzone w-full py-12 px-4 text-center">
                <span className="tile tile-accent mx-auto mb-3"><Upload /></span>
                <p className="text-gray-500 text-sm mb-2">No files uploaded yet.</p>
                <span className="text-sm font-semibold underline underline-offset-2" style={{ color: 'var(--text)' }}>Send your first file</span>
              </button>
            ) : (
              <div className="space-y-2">
                {uploads.map((u: any) => (
                  <div key={u.id} className="card !p-4 flex flex-wrap sm:flex-nowrap items-center gap-3">
                    <span className="tile tile-neutral"><FileText /></span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-200 font-medium truncate">{u.title || u.fileName}</p>
                      <p className="text-xs text-gray-500">{u.fileName} · {(u.fileSize / 1024).toFixed(0)} KB · Uploaded {new Date(u.createdAt).toLocaleDateString()}</p>
                      {u.notes && <p className="text-xs text-gray-500 italic mt-0.5">"{u.notes}"</p>}
                    </div>
                    <span className="chip chip-success flex-shrink-0">
                      <CheckCircle className="w-3 h-3" />Received
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab: Penalties */}
        {tab === 'penalties' && (
          <div className="space-y-3">
            {penalties?.length === 0 && <div className="card"><EmptyState message="No penalties on record." hint={null} icon={<CheckCircle />} /></div>}
            {penalties?.map((p: Penalty) => (
              <div key={p.id} className="card !p-4" >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-gray-200">{penaltyReasonText(p.reason)}</p>
                    <p className="text-xs text-gray-500 mt-0.5">Applied: {new Date(p.appliedAt).toLocaleDateString()}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-semibold tabular-nums" style={{ color: p.isPaid ? 'var(--text-muted)' : 'var(--danger-text)' }}>${Number(p.amount).toLocaleString()}</p>
                    <span className={`chip mt-1 ${p.isPaid ? 'chip-success' : 'chip-danger'}`}>{p.isPaid ? 'Paid' : 'Outstanding'}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Tab: Rewards */}
        {tab === 'rewards' && (
          <div className="space-y-3">
            {rewards?.length === 0 && (
              <div className="card"><EmptyState message="No rewards yet. Submit documents on time to earn rewards." hint={null} icon={<Gift />} /></div>
            )}
            {rewards?.map((r: Reward) => (
              <div key={r.id} className={`card !p-4 ${r.isRedeemed ? 'opacity-60' : ''}`} >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="chip chip-neutral">
                        {humanize(r.rewardType)}
                      </span>
                      {r.isRedeemed && <span className="text-xs text-gray-500">Redeemed</span>}
                    </div>
                    <p className="text-sm text-gray-200">{r.description}</p>
                    {r.expiresAt && <p className="text-xs text-gray-500 mt-1">Expires: {new Date(r.expiresAt).toLocaleDateString()}</p>}
                  </div>
                  {(r.value || r.percentDiscount) && (
                    <div className="text-right">
                      {r.value && <p className="text-lg font-semibold tabular-nums" style={{ color: 'var(--text)' }}>${Number(r.value).toLocaleString()}</p>}
                      {r.percentDiscount && <p className="text-lg font-semibold tabular-nums" style={{ color: 'var(--success-text)' }}>{r.percentDiscount}% off</p>}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Tab: Notification Settings */}
        {tab === 'settings' && (
          <NotificationPreferences clientAuth={auth} brandingColor={branding.secondaryColor} />
        )}
        </motion.div>
      </div>
    </div>
  )
}
