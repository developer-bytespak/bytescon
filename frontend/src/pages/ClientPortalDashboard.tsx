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

function UrgencyBadge({ urgency, daysUntil }: { urgency: string; daysUntil: number }) {
  if (urgency === 'SUBMITTED') return <span className="inline-flex items-center gap-1 text-xs bg-green-900/40 text-green-300 border border-green-700 px-2 py-0.5 rounded"><CheckCircle className="w-3 h-3" /> Submitted</span>
  if (urgency === 'OVERDUE') return <span className="inline-flex items-center gap-1 text-xs bg-red-900/50 text-red-300 border border-red-700 px-2 py-0.5 rounded"><AlertTriangle className="w-3 h-3" /> OVERDUE</span>
  if (urgency === 'URGENT') return <span className="inline-flex items-center gap-1 text-xs bg-orange-900/40 text-orange-300 border border-orange-700 px-2 py-0.5 rounded"><AlertTriangle className="w-3 h-3" /> {daysUntil}d — URGENT</span>
  if (urgency === 'SOON') return <span className="inline-flex items-center gap-1 text-xs bg-yellow-900/40 text-yellow-300 border border-yellow-700 px-2 py-0.5 rounded"><Clock className="w-3 h-3" /> {daysUntil}d remaining</span>
  return <span className="inline-flex items-center gap-1 text-xs bg-green-900/20 text-green-400 border border-green-800 px-2 py-0.5 rounded"><CheckCircle className="w-3 h-3" /> {daysUntil}d remaining</span>
}

function DocCard({ req, onMarkSubmitted, showNumericScore }: { req: DocRequirement; onMarkSubmitted: (id: string) => void; showNumericScore?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const fmt = (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`
  return (
    <div className={`border rounded-lg ${req.urgency === 'OVERDUE' ? 'border-red-800 bg-red-950/10' : req.urgency === 'URGENT' ? 'border-orange-800 bg-orange-950/10' : req.urgency === 'SUBMITTED' ? 'border-green-800/40 bg-green-950/10' : 'border-gray-800'}`}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-200 text-sm">{req.title}</h3>
            {req.opportunity && <p className="text-xs text-gray-500 mt-0.5 truncate">Related to: {req.opportunity.title}</p>}
          </div>
          <UrgencyBadge urgency={req.urgency} daysUntil={req.daysUntil} />
        </div>
        <div className="flex items-center gap-4 text-xs text-gray-500 mb-3">
          <span>Due: {new Date(req.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
          {req.isPenaltyEnabled && req.urgency !== 'SUBMITTED' && (
            <span className="text-red-400">Penalty: {req.penaltyAmount ? `$${req.penaltyAmount.toLocaleString()} flat` : req.penaltyPercent ? `${req.penaltyPercent}%` : 'configured'}</span>
          )}
        </div>
        {req.description && <p className="text-xs text-gray-400 mb-3">{req.description}</p>}
        <div className="flex items-center gap-2">
          {req.status === 'PENDING' && (
            <button onClick={() => onMarkSubmitted(req.id)} className="text-xs bg-blue-900/40 hover:bg-blue-900/60 text-blue-300 border border-blue-700 px-3 py-1.5 rounded transition-colors">
              Mark as Submitted
            </button>
          )}
          {req.opportunity?.scoreBreakdown && (
            <button onClick={() => setExpanded(!expanded)} className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1 transition-colors">
              Why us? {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </div>
        {expanded && req.opportunity?.scoreBreakdown && (
          <div className="mt-3 pt-3 border-t border-gray-800">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Why You're a Good Fit</p>
            <p className="text-xs text-blue-300 mb-3 font-medium">
              {`Fit: ${fitDisplay(req.opportunity.probabilityScore, showNumericScore)} (directional, not a guarantee)`}
              {req.opportunity.expectedValue ? ` · Est. value: ${fmt(req.opportunity.expectedValue)}` : ''}
            </p>
            <div className="space-y-2">
              {req.opportunity.scoreBreakdown?.factorContributions?.sort((a: any, b: any) => b.weight - a.weight).slice(0, 4).map((f: any) => (
                <div key={f.factor} className="flex items-center gap-2">
                  <div className="flex-1 bg-gray-800 rounded-full h-1.5">
                    <div className={`h-1.5 rounded-full ${f.pct >= 70 ? 'bg-green-500' : f.pct >= 40 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${f.pct}%` }} />
                  </div>
                  <span className="text-xs text-gray-400 w-20 text-right truncate">{f.factor.replace(/Score$/, '').replace(/([A-Z])/g, ' $1').trim()}</span>
                  <span className="text-xs font-mono text-gray-500 w-8 text-right">{f.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-200 flex items-center gap-2"><Upload className="w-4 h-4 text-blue-400" /> Upload Document</h3>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-500 hover:text-gray-300" /></button>
        </div>
        <p className="text-xs text-gray-500 mb-4">Send a document directly to your consultant. They'll be notified and can review it in your file.</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">File *</label>
            <div
              className="border-2 border-dashed border-gray-700 rounded-lg p-4 text-center cursor-pointer hover:border-blue-600 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              {file ? (
                <p className="text-sm text-gray-300">{file.name} <span className="text-gray-500">({(file.size / 1024).toFixed(0)} KB)</span></p>
              ) : (
                <p className="text-sm text-gray-500">Click to choose file or drag &amp; drop</p>
              )}
            </div>
            <input ref={fileRef} type="file" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Title (optional)</label>
            <input className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" placeholder="e.g. Q2 Capability Statement" value={title} onChange={e => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Notes (optional)</label>
            <textarea className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 resize-none" rows={2} placeholder="Any notes for your consultant..." value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button onClick={handleUpload} disabled={!file || uploading} className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors flex items-center justify-center gap-2">
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

  if (loading) return <div className="min-h-screen bg-gray-950 flex items-center justify-center"><div className="text-gray-400 text-sm">Loading your dashboard...</div></div>
  if (error || !data) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center">
        <p className="text-red-400 mb-4">{error || 'Session expired'}</p>
        <button onClick={() => navigate('/client-login')} className="text-blue-400 hover:underline text-sm">Return to login</button>
      </div>
    </div>
  )

  const { client, docRequirements, penalties, rewards, summary } = data
  const fmt = (v?: number) => !v ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v}`
  const filteredContracts = contracts.filter(c =>
    contractFilter === 'all' ? true : contractFilter === 'active' ? !c.isDeclined : c.isDeclined
  )

  return (
    <div className="min-h-screen bg-gray-950">
      {showUploadModal && (
        <UploadModal onClose={() => setShowUploadModal(false)} onUploaded={() => {
          clientPortalApi.getUploads().then(r => setUploads(r.data || [])).catch(() => {})
        }} />
      )}

      {/* Header */}
      <header
        className="border-b px-6 py-4"
        style={{
          background: 'linear-gradient(180deg, #050e1e 0%, #071120 100%)',
          borderColor: `${branding.secondaryColor}30`,
        }}
      >
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.displayName} className="w-8 h-8 rounded object-contain" />
            ) : (
              <Shield className="w-5 h-5" style={{ color: branding.secondaryColor }} />
            )}
            <div>
              <p
                className="text-sm font-bold tracking-wide"
                style={{
                  background: `linear-gradient(90deg, ${branding.primaryColor}, ${branding.secondaryColor})`,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                {branding.displayName}
              </p>
              <p className="text-xs text-gray-500">{client?.name} · {branding.tagline}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowUploadModal(true)}
              className="flex items-center gap-2 text-xs px-3 py-1.5 rounded transition-colors"
              style={{
                background: `${branding.secondaryColor}26`,
                border: `1px solid ${branding.secondaryColor}66`,
                color: branding.secondaryColor,
              }}
            >
              <Upload className="w-3.5 h-3.5" /> Send File to Consultant
            </button>
            <button onClick={handleLogout} className="flex items-center gap-2 text-xs text-gray-500 hover:text-red-400 transition-colors">
              <LogOut className="w-4 h-4" /> Sign Out
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* KPI Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">Docs Due</p>
            <p className="text-2xl font-bold text-gray-200">{summary.totalDocuments}</p>
            <p className="text-xs text-gray-600 mt-1">{summary.submitted} submitted · {summary.overdue} overdue</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">Matched Contracts</p>
            <p className="text-2xl font-bold text-blue-400">{contracts.filter(c => !c.isDeclined).length || '—'}</p>
            <p className="text-xs text-gray-600 mt-1">Based on your NAICS codes</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">Outstanding Fees</p>
            <p className={`text-2xl font-bold font-mono ${summary.totalOutstandingFees > 0 ? 'text-red-400' : 'text-gray-400'}`}>
              ${summary.totalOutstandingFees.toLocaleString()}
            </p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">Active Rewards</p>
            <p className="text-2xl font-bold text-green-400">{summary.activeRewards}</p>
            <p className="text-xs text-gray-600 mt-1">Submit docs on time to earn</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-gray-800 overflow-x-auto">
          {([
            { key: 'docs', label: 'Documents', icon: FileText, count: summary.pending },
            { key: 'deliverables', label: 'Proposals', icon: FileText, count: 0 },
            { key: 'contracts', label: 'My Contracts', icon: Briefcase, count: contracts.filter(c => !c.isDeclined).length },
            { key: 'uploads', label: 'My Uploads', icon: Upload, count: uploads.length },
            { key: 'penalties', label: 'Fees', icon: DollarSign, count: penalties?.filter((p: any) => !p.isPaid).length },
            { key: 'rewards', label: 'Rewards', icon: Gift, count: summary.activeRewards },
            { key: 'settings', label: 'Notifications', icon: SettingsIcon, count: 0 },
          ] as const).map(({ key, label, icon: Icon, count }) => (
            <button key={key} onClick={() => setTab(key as any)}
              className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 transition-colors -mb-px whitespace-nowrap ${tab === key ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
            >
              <Icon className="w-4 h-4" />
              {label}
              {count > 0 && <span className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">{count}</span>}
            </button>
          ))}
        </div>

        {/* Tab: Document Requirements */}
        {tab === 'docs' && (
          <div className="space-y-3">
            {docRequirements?.length === 0 && <p className="text-gray-500 text-sm text-center py-8">No document requirements assigned.</p>}
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
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-gray-400">
                Contracts matched to your NAICS codes — active, open solicitations. Your consultant reviews these on your behalf.
              </p>
              <div className="flex gap-1">
                {(['active', 'all', 'declined'] as const).map(f => (
                  <button key={f} onClick={() => setContractFilter(f)}
                    className={`text-xs px-3 py-1.5 rounded transition-colors ${contractFilter === f ? 'bg-blue-900/50 text-blue-300' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            {contractsLoading && <div className="text-center py-10 text-gray-500 text-sm">Loading contracts...</div>}
            {!contractsLoading && filteredContracts.length === 0 && (
              <div className="text-center py-12 border border-dashed border-gray-700 rounded-lg">
                <Briefcase className="w-10 h-10 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-500 text-sm">{contracts.length === 0 ? 'No contracts matched to your NAICS codes yet.' : 'No contracts in this filter.'}</p>
              </div>
            )}
            <div className="space-y-2">
              {filteredContracts.map(opp => (
                <div key={opp.id} className={`border rounded-lg p-4 transition-colors ${opp.isDeclined ? 'border-gray-800 opacity-50 bg-gray-900/30' : 'border-gray-800 bg-gray-900/50 hover:border-gray-600'}`}>
                  <div className="flex items-start gap-3">
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
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-mono text-gray-300">{opp.estimatedValue != null ? fmt(opp.estimatedValue) : 'TBD'}</p>
                      <div className="flex items-center gap-1 justify-end mt-1">
                        <TrendingUp className="w-3 h-3 text-green-500" />
                        <span className="text-xs text-green-400">{fitDisplay(opp.probabilityScore)}</span>
                      </div>
                      <p className="text-xs text-gray-600 mt-1">Due {new Date(opp.responseDeadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
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
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-gray-400">Files you've sent to your consultant. They can download these from your client file.</p>
              <button onClick={() => setShowUploadModal(true)} className="flex items-center gap-2 text-xs bg-blue-900/40 hover:bg-blue-900/60 text-blue-300 border border-blue-700 px-3 py-1.5 rounded transition-colors">
                <Upload className="w-3.5 h-3.5" /> Upload New File
              </button>
            </div>
            {uploads.length === 0 ? (
              <div className="text-center py-12 border border-dashed border-gray-700 rounded-lg">
                <Upload className="w-10 h-10 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-500 text-sm mb-2">No files uploaded yet.</p>
                <button onClick={() => setShowUploadModal(true)} className="text-blue-400 hover:text-blue-300 text-sm">Send your first file →</button>
              </div>
            ) : (
              <div className="space-y-2">
                {uploads.map((u: any) => (
                  <div key={u.id} className="border border-gray-800 rounded-lg p-4 flex items-center gap-3">
                    <FileText className="w-8 h-8 text-gray-600 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-200 font-medium truncate">{u.title || u.fileName}</p>
                      <p className="text-xs text-gray-500">{u.fileName} · {(u.fileSize / 1024).toFixed(0)} KB · Uploaded {new Date(u.createdAt).toLocaleDateString()}</p>
                      {u.notes && <p className="text-xs text-gray-500 italic mt-0.5">"{u.notes}"</p>}
                    </div>
                    <span className="text-xs bg-green-900/30 text-green-400 border border-green-900 px-2 py-0.5 rounded flex-shrink-0">
                      <CheckCircle className="w-3 h-3 inline mr-1" />Received
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
            {penalties?.length === 0 && <p className="text-gray-500 text-sm text-center py-8">No penalties on record. Keep up the great work!</p>}
            {penalties?.map((p: Penalty) => (
              <div key={p.id} className={`border rounded-lg p-4 ${p.isPaid ? 'border-gray-800' : 'border-red-800/50'}`}>
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm text-gray-200">{p.reason}</p>
                    <p className="text-xs text-gray-500 mt-0.5">Applied: {new Date(p.appliedAt).toLocaleDateString()}</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-lg font-bold font-mono ${p.isPaid ? 'text-gray-500' : 'text-red-400'}`}>${Number(p.amount).toLocaleString()}</p>
                    <span className={`text-xs ${p.isPaid ? 'text-green-400' : 'text-red-400'}`}>{p.isPaid ? '✓ Paid' : 'Outstanding'}</span>
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
              <div className="text-center py-8">
                <Gift className="w-10 h-10 text-gray-700 mx-auto mb-2" />
                <p className="text-gray-500 text-sm">No rewards yet. Submit documents on time to earn rewards!</p>
              </div>
            )}
            {rewards?.map((r: Reward) => (
              <div key={r.id} className={`border rounded-lg p-4 ${r.isRedeemed ? 'border-gray-800 opacity-60' : 'border-blue-800/50 bg-blue-950/10'}`}>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${r.rewardType === 'FEE_DISCOUNT' ? 'bg-green-900/40 text-green-300' : r.rewardType === 'SUBSCRIPTION_CREDIT' ? 'bg-blue-900/40 text-blue-300' : 'bg-purple-900/40 text-purple-300'}`}>
                        {r.rewardType.replace(/_/g, ' ')}
                      </span>
                      {r.isRedeemed && <span className="text-xs text-gray-500">Redeemed</span>}
                    </div>
                    <p className="text-sm text-gray-200">{r.description}</p>
                    {r.expiresAt && <p className="text-xs text-gray-500 mt-1">Expires: {new Date(r.expiresAt).toLocaleDateString()}</p>}
                  </div>
                  {(r.value || r.percentDiscount) && (
                    <div className="text-right">
                      {r.value && <p className="text-lg font-bold font-mono text-blue-400">${Number(r.value).toLocaleString()}</p>}
                      {r.percentDiscount && <p className="text-lg font-bold font-mono text-green-400">{r.percentDiscount}% off</p>}
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
      </div>
    </div>
  )
}
