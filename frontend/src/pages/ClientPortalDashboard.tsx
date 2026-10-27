import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Shield, LogOut, FileText, DollarSign, Gift, CheckCircle,
  AlertTriangle, Clock, ChevronDown, ChevronUp, Upload,
  Briefcase, TrendingUp, Building2, X, Loader, Settings as SettingsIcon,
} from 'lucide-react'
import axios from 'axios'
import { clientPortalApi } from '../services/api'
import { ClientDeliverableReview } from '../components/ClientDeliverableReview'
import { NotificationPreferences } from '../components/NotificationPreferences'
import { useBranding } from '../hooks/useBranding'
import { fitDisplay } from '../utils/fitTier'
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
  if (t.includes('sole source')) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/60 text-orange-300 border border-orange-800">SOLE SOURCE</span>
  if (t.includes('sources sought') || t.includes('rfi')) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-900/60 text-cyan-300 border border-cyan-800">RFI</span>
  if (t.includes('presolicitation')) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/60 text-purple-300 border border-purple-800">PRESOL</span>
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
  if (urgency === 'OVERDUE') return <span className="chip chip-danger chip-lg"><AlertTriangle className="w-3.5 h-3.5" /> OVERDUE</span>
  if (urgency === 'URGENT') return <span className="chip chip-danger chip-lg"><AlertTriangle className="w-3.5 h-3.5" /> {daysUntil}d — URGENT</span>
  if (urgency === 'SOON') return <span className="chip chip-gold chip-lg"><Clock className="w-3.5 h-3.5" /> {daysUntil}d remaining</span>
  return <span className="chip chip-neutral chip-lg"><CheckCircle className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} /> {daysUntil}d remaining</span>
}

const URGENCY_RAIL: Record<string, string> = {
  OVERDUE: 'var(--danger)', URGENT: 'var(--danger)', SOON: 'var(--warning)', SUBMITTED: 'var(--success)',
}

function DocCard({ req, onMarkSubmitted, showNumericScore }: { req: DocRequirement; onMarkSubmitted: (id: string) => void; showNumericScore?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const fmt = (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`
  const due = new Date(req.dueDate)
  return (
    <div className="card !p-0 overflow-hidden relative transition-shadow hover:shadow-[var(--shadow-2)]">
      <span className="absolute left-0 inset-y-0 w-1" style={{ background: URGENCY_RAIL[req.urgency] ?? 'var(--line-strong)' }} aria-hidden="true" />
      <div className="p-4 sm:p-5 pl-5 sm:pl-6 flex gap-4">
        {/* Calendar-style due date */}
        <div className="hidden sm:flex flex-col items-center justify-center w-14 h-16 rounded-xl flex-shrink-0" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }} aria-hidden="true">
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>{due.toLocaleDateString('en-US', { month: 'short' })}</span>
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
              <span className="text-red-400">Penalty: {req.penaltyAmount ? `$${req.penaltyAmount.toLocaleString()} flat` : req.penaltyPercent ? `${req.penaltyPercent}%` : 'configured'}</span>
            )}
          </div>
          {req.description && <p className="text-sm text-gray-400 mb-3 leading-relaxed">{req.description}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {req.status === 'PENDING' && (
              <button onClick={() => onMarkSubmitted(req.id)} className="btn-primary btn-sm">
                <CheckCircle className="w-3.5 h-3.5" />
                Mark as Submitted
              </button>
            )}
            {req.opportunity?.scoreBreakdown && (
              <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="btn-ghost btn-sm">
                Why us? {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            )}
          </div>
          {expanded && req.opportunity?.scoreBreakdown && (
            <div className="mt-4 pt-4 border-t border-gray-800 animate-fade-up">
              <p className="overline mb-2">Why You're a Good Fit</p>
              <p className="text-xs text-blue-300 mb-3 font-medium">
                {`Fit: ${fitDisplay(req.opportunity.probabilityScore, showNumericScore)} (directional, not a guarantee)`}
                {req.opportunity.expectedValue ? ` · Est. value: ${fmt(req.opportunity.expectedValue)}` : ''}
              </p>
              <div className="space-y-2.5">
                {req.opportunity.scoreBreakdown?.factorContributions?.sort((a: any, b: any) => b.weight - a.weight).slice(0, 4).map((f: any, i: number) => (
                  <div key={f.factor} className="flex items-center gap-2">
                    <div className="flex-1 bg-gray-800 rounded-full h-1.5 overflow-hidden">
                      <div className={`h-1.5 rounded-full bar-grow ${f.pct >= 70 ? 'bg-green-500' : f.pct >= 40 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${f.pct}%`, animationDelay: `${i * 60}ms` }} />
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

function UploadModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleUpload = async () => {
    if (!file) return
    setUploading(true); setError('')
    try {
      await clientPortalApi.uploadDoc(file, title || file.name, notes || undefined)
      onUploaded(); onClose()
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Upload failed')
    } finally { setUploading(false) }
  }

  return (
    <div className="modal-backdrop fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="cp-upload-title" className="modal-panel w-full max-w-md rounded-2xl p-6" style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)' }}>
        <div className="flex items-center justify-between mb-2">
          <h3 id="cp-upload-title" className="font-semibold text-[15px] flex items-center gap-2.5" style={{ color: 'var(--text)' }}><span className="tile tile-accent tile-sm"><Upload /></span> Upload Document</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5" aria-label="Close"><X className="w-5 h-5 text-gray-500" /></button>
        </div>
        <p className="text-sm text-gray-500 mb-5">Send a document directly to your consultant. They'll be notified and can review it in your file.</p>
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
              <span className={`tile mx-auto mb-3 ${file ? 'tile-success' : 'tile-accent'}`}>{file ? <CheckCircle /> : <Upload />}</span>
              {file ? (
                <p className="text-sm text-gray-300 font-medium break-all">{file.name} <span className="text-gray-500 font-normal tabular-nums">({(file.size / 1024).toFixed(0)} KB)</span></p>
              ) : (
                <p className="text-sm text-gray-500">Click to choose file or drag &amp; drop</p>
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
          {error && <p role="alert" className="text-red-400 text-sm">{error}</p>}
          {uploading && <div className="progress-track" aria-hidden="true"><div className="progress-indeterminate" /></div>}
          <button onClick={handleUpload} disabled={!file || uploading} className="btn-primary w-full !py-2.5 !text-sm">
            {uploading ? <><Loader className="w-4 h-4 animate-spin" /> Uploading...</> : <><Upload className="w-4 h-4" /> Send to Consultant</>}
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
  const [contractFilter, setContractFilter] = useState<'all' | 'active' | 'declined'>('active')

  const auth = (() => { try { return JSON.parse(localStorage.getItem('bytescon_client_auth') ?? '') } catch { return null } })()
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

  useEffect(() => {
    if (tab === 'contracts' && contracts.length === 0) {
      setContractsLoading(true)
      clientPortalApi.getOpportunities()
        .then(r => setContracts(r.data || []))
        .catch(() => {})
        .finally(() => setContractsLoading(false))
    }
    if (tab === 'uploads') {
      clientPortalApi.getUploads().then(r => setUploads(r.data || [])).catch(() => {})
    }
  }, [tab])

  const handleMarkSubmitted = async (reqId: string) => {
    try {
      await axios.put(`${API_BASE}/api/client-portal/doc-requirements/${reqId}/submit`, {}, { headers: { Authorization: `Bearer ${auth.token}` } })
      loadDashboard()
    } catch {
      /* best-effort — requirement stays unmarked and can be retried */
    }
  }

  const handleLogout = () => { localStorage.removeItem('bytescon_client_auth'); navigate('/client-login') }

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
        <p className="text-red-400 mb-5">{error || 'Session expired'}</p>
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
      <div className="app-ambient" aria-hidden="true" />
      {showUploadModal && (
        <UploadModal onClose={() => setShowUploadModal(false)} onUploaded={() => {
          clientPortalApi.getUploads().then(r => setUploads(r.data || [])).catch(() => {})
        }} />
      )}

      {/* Header */}
      <header
        className="topbar px-4 sm:px-6 py-3"
        style={{
          borderColor: `${branding.secondaryColor}30`,
        }}
      >
        <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.displayName} className="w-9 h-9 rounded-lg object-contain" />
            ) : (
              <span className="grid place-items-center w-9 h-9 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}>
                <Shield className="w-5 h-5" style={{ color: branding.secondaryColor }} />
              </span>
            )}
            <div className="min-w-0">
              {/* Solid colour on purpose: gradient text renders as a filled box
                  inside the blurred (backdrop-filter) header in Chromium. */}
              <p className="font-display text-[1.05rem] leading-tight" style={{ color: 'var(--text)' }}>
                {branding.displayName}
              </p>
              <p className="text-xs text-gray-500 truncate">{client?.name} · {branding.tagline}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowUploadModal(true)}
              className="flex items-center gap-2 text-xs font-semibold px-3.5 py-2 rounded-[10px] transition-transform duration-150 hover:-translate-y-px active:scale-[0.98]"
              style={{
                background: `${branding.secondaryColor}26`,
                border: `1px solid ${branding.secondaryColor}66`,
                color: branding.secondaryColor,
              }}
            >
              <Upload className="w-3.5 h-3.5" /> Send File to Consultant
            </button>
            <button onClick={handleLogout} className="btn-ghost btn-sm hover:!text-red-400">
              <LogOut className="w-4 h-4" /> Sign Out
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
            <section className="hero-banner mb-6 sm:mb-8">
              <div className="hero-orb hero-orb-a" aria-hidden="true" />
              <div className="hero-orb hero-orb-b" aria-hidden="true" />
              <div className="hero-grid" aria-hidden="true" />
              <div className="relative flex flex-col md:flex-row md:items-center md:justify-between gap-6">
                <div className="min-w-0">
                  <span className="hero-chip">
                    {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                  </span>
                  <h1 className="hero-title mt-3">Welcome back, {client?.name}</h1>
                  <p className="hero-sub max-w-lg">
                    {summary.overdue > 0
                      ? `${summary.overdue} document${summary.overdue === 1 ? ' is' : 's are'} overdue — let's get ${summary.overdue === 1 ? 'it' : 'them'} in.`
                      : summary.pending > 0
                        ? `${summary.pending} document${summary.pending === 1 ? '' : 's'} waiting on you. Everything else is on track.`
                        : "You're all caught up. Nice work."}
                  </p>
                  <div className="flex flex-wrap gap-2 mt-5">
                    <button onClick={() => setShowUploadModal(true)} className="btn-primary">
                      <Upload className="w-4 h-4" /> Send File to Consultant
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-4 md:flex-col md:gap-2 md:text-center flex-shrink-0">
                  <ScoreRing value={pct} size={128} stroke={10} color={summary.overdue > 0 ? 'var(--danger)' : 'var(--success)'}>
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
        <div className="stagger grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-8">
          <StatCard
            label="Docs Due"
            value={summary.totalDocuments}
            sub={`${summary.submitted} submitted · ${summary.overdue} overdue`}
            tone={summary.overdue > 0 ? 'danger' : 'accent'}
            icon={<FileText />}
          />
          <StatCard
            label="Matched Contracts"
            value={contracts.filter(c => !c.isDeclined).length || '—'}
            sub="Based on your NAICS codes"
            tone="accent"
            icon={<Briefcase />}
          />
          <StatCard
            label="Outstanding Fees"
            value={`$${summary.totalOutstandingFees.toLocaleString()}`}
            tone={summary.totalOutstandingFees > 0 ? 'danger' : 'neutral'}
            icon={<DollarSign />}
          />
          <StatCard
            label="Active Rewards"
            value={summary.activeRewards}
            sub="Submit docs on time to earn"
            tone="success"
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
            { key: 'contracts', label: 'My Contracts', icon: Briefcase, count: contracts.filter(c => !c.isDeclined).length },
            { key: 'uploads', label: 'My Uploads', icon: Upload, count: uploads.length },
            { key: 'penalties', label: 'Fees', icon: DollarSign, count: penalties?.filter((p: any) => !p.isPaid).length },
            { key: 'rewards', label: 'Rewards', icon: Gift, count: summary.activeRewards },
            { key: 'settings', label: 'Notifications', icon: SettingsIcon, count: 0 },
          ] as const).map(({ key, label, icon: Icon, count }) => ({ key, label, icon: <Icon className="w-4 h-4" />, count }))}
        />

        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
        {/* Tab: Document Requirements */}
        {tab === 'docs' && (
          <div className="stagger space-y-3">
            {docRequirements?.length === 0 && <div className="card"><EmptyState message="No document requirements assigned." hint={null} icon={<FileText />} /></div>}
            {docRequirements?.map((req: DocRequirement) => (
              <DocCard key={req.id} req={req} onMarkSubmitted={handleMarkSubmitted} showNumericScore={(data as any)?.showNumericScore} />
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
            <div className="stagger space-y-2">
              {filteredContracts.map(opp => (
                <div key={opp.id} className={`card !p-4 transition-[opacity,border-color] ${opp.isDeclined ? 'opacity-50' : 'hover:border-[color:var(--line-strong)]'}`}>
                  <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <p className={`text-sm font-medium ${opp.isDeclined ? 'text-gray-600 line-through' : 'text-gray-200'}`}>{opp.title}</p>
                        <NoticeTag type={opp.noticeType} />
                        {opp.isDeclined && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-500">NOT PURSUING</span>}
                        {opp.recompeteFlag && <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/60 text-yellow-400 border border-yellow-800">RECOMPETE</span>}
                      </div>
                      <p className="text-xs text-gray-500">
                        <Building2 className="w-3 h-3 inline mr-1" />{opp.agency} · NAICS {opp.naicsCode} · {SET_ASIDE_LABELS[opp.setAsideType] || opp.setAsideType}
                      </p>
                    </div>
                    <div className="sm:text-right flex-shrink-0 flex sm:block items-center gap-4">
                      <p className="text-sm font-semibold tabular-nums text-gray-300">{opp.estimatedValue != null ? fmt(opp.estimatedValue) : 'TBD'}</p>
                      <div className="flex items-center gap-1 sm:justify-end sm:mt-1">
                        <TrendingUp className="w-3 h-3 text-green-500" />
                        <span className="text-xs text-green-400">{fitDisplay(opp.probabilityScore)}</span>
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
                <Upload className="w-3.5 h-3.5" /> Upload New File
              </button>
            </div>
            {uploads.length === 0 ? (
              <button type="button" onClick={() => setShowUploadModal(true)} className="dropzone w-full py-12 px-4 text-center">
                <span className="tile tile-accent mx-auto mb-3"><Upload /></span>
                <p className="text-gray-500 text-sm mb-2">No files uploaded yet.</p>
                <span className="text-sm font-medium" style={{ color: 'var(--accent-3)' }}>Send your first file →</span>
              </button>
            ) : (
              <div className="stagger space-y-2">
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
          <div className="stagger space-y-3">
            {penalties?.length === 0 && <div className="card"><EmptyState message="No penalties on record. Keep up the great work!" hint={null} icon={<CheckCircle />} /></div>}
            {penalties?.map((p: Penalty) => (
              <div key={p.id} className="card !p-4" style={p.isPaid ? undefined : { borderColor: 'var(--danger-border)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-gray-200">{p.reason}</p>
                    <p className="text-xs text-gray-500 mt-0.5">Applied: {new Date(p.appliedAt).toLocaleDateString()}</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-lg font-semibold tabular-nums ${p.isPaid ? 'text-gray-500' : 'text-red-400'}`}>${Number(p.amount).toLocaleString()}</p>
                    <span className={`chip mt-1 ${p.isPaid ? 'chip-success' : 'chip-danger'}`}>{p.isPaid ? '✓ Paid' : 'Outstanding'}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Tab: Rewards */}
        {tab === 'rewards' && (
          <div className="stagger space-y-3">
            {rewards?.length === 0 && (
              <div className="card"><EmptyState message="No rewards yet. Submit documents on time to earn rewards!" hint={null} icon={<Gift />} /></div>
            )}
            {rewards?.map((r: Reward) => (
              <div key={r.id} className={`card !p-4 ${r.isRedeemed ? 'opacity-60' : ''}`} style={r.isRedeemed ? undefined : { borderColor: 'var(--accent-line)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${r.rewardType === 'FEE_DISCOUNT' ? 'bg-green-900/40 text-green-300' : r.rewardType === 'SUBSCRIPTION_CREDIT' ? 'bg-blue-900/40 text-blue-300' : 'bg-purple-900/40 text-purple-300'}`}>
                        {r.rewardType.replace(/_/g, ' ')}
                      </span>
                      {r.isRedeemed && <span className="text-xs text-gray-500">Redeemed</span>}
                    </div>
                    <p className="text-sm text-gray-200">{r.description}</p>
                    {r.expiresAt && <p className="text-xs text-gray-500 mt-1">Expires: {new Date(r.expiresAt).toLocaleDateString()}</p>}
                  </div>
                  {(r.value || r.percentDiscount) && (
                    <div className="text-right">
                      {r.value && <p className="text-lg font-semibold tabular-nums text-blue-400">${Number(r.value).toLocaleString()}</p>}
                      {r.percentDiscount && <p className="text-lg font-semibold tabular-nums text-green-400">{r.percentDiscount}% off</p>}
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
