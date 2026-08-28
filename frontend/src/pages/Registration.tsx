import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { registrationApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { PageHeader, Spinner, EmptyState, ErrorBanner } from '../components/ui'
import { ShieldCheck, AlertTriangle, XCircle, HelpCircle, Plus, Archive, CalendarClock, Pencil, X, FileCheck } from 'lucide-react'
import { staleWriteMessage } from '../lib/staleWrite'
import { ComplianceRegistrationPanel } from '../components/section7/ComplianceAgentPanels'
import { ConfirmModal } from '../components/ConfirmModal'

type ExpiryStatus = 'ACTIVE' | 'EXPIRING_SOON' | 'EXPIRED' | 'MISSING'

interface HealthItem {
  kind: 'SAM_REGISTRATION' | 'CERTIFICATION' | 'INSURANCE'
  id: string
  label: string
  expiryDate: string | null
  status: ExpiryStatus
  daysUntil: number | null
}
interface Health {
  summary: { active: number; expiringSoon: number; expired: number; missing: number; total: number }
  attention: HealthItem[]
  items: HealthItem[]
}
interface Cert { id: string; name: string; category: string; issuingBody?: string | null; certNumber?: string | null; issueDate?: string | null; expiryDate?: string | null; notes?: string | null; isArchived?: boolean; updatedAt: string }
interface Policy { id: string; policyType: string; carrier?: string | null; policyNumber?: string | null; coverageAmount?: string | null; effectiveDate?: string | null; expiryDate?: string | null; notes?: string | null; isArchived?: boolean; updatedAt: string }
interface SamProfile {
  id: string
  samStatus: string
  samExpiryDate: string | null
  uei: string | null
  cageCode: string | null
  naicsCodes: string[]
  setAsideCerts: string[]
  notes: string | null
  updatedAt: string
}

const SAM_STATUS_OPTIONS = ['ACTIVE', 'PENDING', 'EXPIRED', 'NOT_REGISTERED'] as const
const SAM_STATUS_STYLE: Record<string, string> = {
  ACTIVE: 'bg-green-950/40 border-green-800 text-green-300',
  PENDING: 'bg-yellow-950/40 border-yellow-800 text-yellow-300',
  EXPIRED: 'bg-red-950/40 border-red-800 text-red-300',
  NOT_REGISTERED: 'bg-gray-800 border-gray-700 text-gray-400',
  INACTIVE: 'bg-gray-800 border-gray-700 text-gray-400',
  UNKNOWN: 'bg-gray-800 border-gray-700 text-gray-400',
}
// value -> display label. Values are stored; labels are shown.
const SET_ASIDE_OPTIONS: { value: string; label: string }[] = [
  { value: 'SDVOSB', label: 'SDVOSB' },
  { value: 'VOSB', label: 'VOSB' },
  { value: '8A', label: '8(a)' },
  { value: 'HUBZONE', label: 'HUBZone' },
  { value: 'WOSB', label: 'WOSB' },
  { value: 'SB', label: 'SB' },
  { value: 'TSB', label: 'TSB' },
]
const setAsideLabel = (v: string) => SET_ASIDE_OPTIONS.find((o) => o.value === v)?.label ?? v

const statusStyle: Record<ExpiryStatus, string> = {
  ACTIVE: 'bg-green-950/40 border-green-800 text-green-300',
  EXPIRING_SOON: 'bg-yellow-950/40 border-yellow-800 text-yellow-300',
  EXPIRED: 'bg-red-950/40 border-red-800 text-red-300',
  MISSING: 'bg-gray-800 border-gray-700 text-gray-400',
}
const statusLabel: Record<ExpiryStatus, string> = {
  ACTIVE: 'Active', EXPIRING_SOON: 'Expiring soon', EXPIRED: 'Expired', MISSING: 'No expiry set',
}

function StatusBadge({ status }: { status: ExpiryStatus }) {
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${statusStyle[status]}`}>{statusLabel[status]}</span>
}

const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')

export function RegistrationPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const qc = useQueryClient()
  const { toast } = useToast()
  const [showCert, setShowCert] = useState(false)
  const [showPolicy, setShowPolicy] = useState(false)
  const [editCert, setEditCert] = useState<Cert | null>(null)
  const [editPolicy, setEditPolicy] = useState<Policy | null>(null)
  const [showArchivedCerts, setShowArchivedCerts] = useState(false)
  const [showArchivedPolicies, setShowArchivedPolicies] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<{ kind: 'cert' | 'policy'; id: string; name: string } | null>(null)

  const health = useQuery<{ data: Health }>({ queryKey: ['reg-health'], queryFn: () => registrationApi.health() })
  const certs = useQuery<{ data: Cert[] }>({ queryKey: ['reg-certs', showArchivedCerts], queryFn: () => registrationApi.listCertifications(showArchivedCerts) })
  const policies = useQuery<{ data: Policy[] }>({ queryKey: ['reg-insurance', showArchivedPolicies], queryFn: () => registrationApi.listInsurance(showArchivedPolicies) })
  const profile = useQuery<{ data: SamProfile | null }>({ queryKey: ['reg-profile'], queryFn: () => registrationApi.getProfile() })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['reg-health'] })
    qc.invalidateQueries({ queryKey: ['reg-certs'] })
    qc.invalidateQueries({ queryKey: ['reg-insurance'] })
    qc.invalidateQueries({ queryKey: ['reg-profile'] })
  }

  const saveProfile = useMutation({
    mutationFn: (p: Record<string, unknown>) => registrationApi.saveProfile(p),
    onSuccess: () => { invalidate(); toast('SAM registration saved', 'success') },
    onError: (e: any) => toast(staleWriteMessage(e) || e?.response?.data?.error || 'Failed to save SAM registration', 'error'),
  })

  const createCert = useMutation({
    mutationFn: (p: Record<string, unknown>) => registrationApi.createCertification(p),
    onSuccess: () => { invalidate(); setShowCert(false); toast('Certification added', 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Failed to add certification', 'error'),
  })
  const archiveCert = useMutation({
    mutationFn: (id: string) => registrationApi.archiveCertification(id),
    onSuccess: () => { invalidate(); toast('Certification archived', 'success') },
  })
  const createPolicy = useMutation({
    mutationFn: (p: Record<string, unknown>) => registrationApi.createInsurance(p),
    onSuccess: () => { invalidate(); setShowPolicy(false); toast('Policy added', 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Failed to add policy', 'error'),
  })
  const archivePolicy = useMutation({
    mutationFn: (id: string) => registrationApi.archiveInsurance(id),
    onSuccess: () => { invalidate(); toast('Policy archived', 'success') },
  })
  const updateCertM = useMutation({
    mutationFn: ({ id, p }: { id: string; p: Record<string, unknown> }) => registrationApi.updateCertification(id, p),
    onSuccess: () => { invalidate(); setEditCert(null); toast('Certification updated', 'success') },
    onError: (e: any) => toast(staleWriteMessage(e) || e?.response?.data?.error || 'Failed to update certification', 'error'),
  })
  const restoreCert = useMutation({
    mutationFn: (id: string) => registrationApi.restoreCertification(id),
    onSuccess: () => { invalidate(); toast('Certification restored', 'success') },
  })
  const updatePolicyM = useMutation({
    mutationFn: ({ id, p }: { id: string; p: Record<string, unknown> }) => registrationApi.updateInsurance(id, p),
    onSuccess: () => { invalidate(); setEditPolicy(null); toast('Policy updated', 'success') },
    onError: (e: any) => toast(staleWriteMessage(e) || e?.response?.data?.error || 'Failed to update policy', 'error'),
  })
  const restorePolicy = useMutation({
    mutationFn: (id: string) => registrationApi.restoreInsurance(id),
    onSuccess: () => { invalidate(); toast('Policy restored', 'success') },
  })

  const confirmArchive = () => {
    if (!archiveTarget) return
    if (archiveTarget.kind === 'cert') archiveCert.mutate(archiveTarget.id)
    else archivePolicy.mutate(archiveTarget.id)
    setArchiveTarget(null)
  }

  if (health.isLoading || certs.isLoading || policies.isLoading || profile.isLoading) {
    return <div className="flex justify-center mt-16"><Spinner size="lg" /></div>
  }
  if (health.error || certs.error || policies.error || profile.error) {
    return <ErrorBanner message="Could not load registration data. Please retry." />
  }

  const h = health.data!.data
  const cert = statusById(h, 'CERTIFICATION')
  const pol = statusById(h, 'INSURANCE')

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader title="Registration & Compliance" subtitle="SAM, certifications, insurance & bonding — expiry health and renewal tracking" />

      {/* §7.3 — Compliance Agent status. Backend-authoritative; this page does
          not decide compliance, it renders what the agent computed. */}
      <div className="mb-6">
        <ComplianceRegistrationPanel />
      </div>

      {/* SAM Registration */}
      <SamRegistrationSection
        profile={profile.data!.data}
        isAdmin={isAdmin}
        onSave={(p) => saveProfile.mutateAsync(p)}
        saving={saveProfile.isPending}
      />

      {/* Health summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <SummaryCard icon={ShieldCheck} tone="green" label="Active" value={h.summary.active} />
        <SummaryCard icon={AlertTriangle} tone="yellow" label="Expiring soon" value={h.summary.expiringSoon} />
        <SummaryCard icon={XCircle} tone="red" label="Expired" value={h.summary.expired} />
        <SummaryCard icon={HelpCircle} tone="gray" label="No expiry set" value={h.summary.missing} />
      </div>

      {/* Attention / in-app reminders */}
      <div className="card mb-6">
        <div className="flex items-center gap-2 mb-3">
          <CalendarClock className="w-4 h-4 text-yellow-400" />
          <h2 className="font-semibold text-gray-200">Needs attention</h2>
        </div>
        {h.attention.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing expiring inside your reminder window. You're all clear.</p>
        ) : (
          <ul className="space-y-2">
            {h.attention.map((i) => (
              <li key={`${i.kind}-${i.id}`} className="flex items-center justify-between border border-gray-800 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-gray-200 truncate">{i.label}</p>
                  <p className="text-xs text-gray-500">{i.kind.replace('_', ' ').toLowerCase()} · expires {fmtDate(i.expiryDate)}{i.daysUntil != null && ` (${i.daysUntil < 0 ? `${-i.daysUntil}d overdue` : `${i.daysUntil}d`})`}</p>
                </div>
                <StatusBadge status={i.status} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Certifications */}
      <section className="card mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-200">Certifications & set-asides</h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" checked={showArchivedCerts} onChange={(e) => setShowArchivedCerts(e.target.checked)} /> Show archived
            </label>
            {isAdmin && (
              <button onClick={() => { setEditCert(null); setShowCert((v) => !v) }} className="btn-primary text-xs flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" /> Add certification
              </button>
            )}
          </div>
        </div>
        {isAdmin && showCert && !editCert && <CertForm onSubmit={(p) => createCert.mutate(p)} saving={createCert.isPending} onCancel={() => setShowCert(false)} />}
        {isAdmin && editCert && <CertForm initial={editCert} onSubmit={(p) => updateCertM.mutate({ id: editCert.id, p: { ...p, updatedAt: editCert.updatedAt } })} saving={updateCertM.isPending} onCancel={() => setEditCert(null)} />}
        {certs.data!.data.length === 0 ? (
          <EmptyState message="No certifications tracked yet." />
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2">Name</th><th>Issuing body</th><th>Number</th><th>Expiry</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {certs.data!.data.map((c) => (
                <tr key={c.id} className={`border-b border-gray-900 ${c.isArchived ? 'opacity-50' : ''}`}>
                  <td className="py-2 text-gray-200">{c.name}{c.isArchived && <span className="ml-2 text-[9px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded px-1">archived</span>}</td>
                  <td className="text-gray-400">{c.issuingBody || '—'}</td>
                  <td className="text-gray-400 font-mono text-xs">{c.certNumber || '—'}</td>
                  <td className="text-gray-400">{fmtDate(c.expiryDate)}</td>
                  <td>{cert[c.id] && <StatusBadge status={cert[c.id]} />}</td>
                  <td className="text-right">
                    {isAdmin && (c.isArchived ? (
                      <button onClick={() => restoreCert.mutate(c.id)} className="text-gray-500 hover:text-green-400 text-xs">Restore</button>
                    ) : (
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => { setShowCert(false); setEditCert(c) }} aria-label={`Edit ${c.name}`} className="text-gray-600 hover:text-blue-400"><Pencil className="w-4 h-4" /></button>
                        <button onClick={() => setArchiveTarget({ kind: 'cert', id: c.id, name: c.name })} aria-label={`Archive ${c.name}`} className="text-gray-600 hover:text-red-400"><Archive className="w-4 h-4" /></button>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Insurance & bonding */}
      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-200">Insurance & bonding</h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" checked={showArchivedPolicies} onChange={(e) => setShowArchivedPolicies(e.target.checked)} /> Show archived
            </label>
            {isAdmin && (
              <button onClick={() => { setEditPolicy(null); setShowPolicy((v) => !v) }} className="btn-primary text-xs flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" /> Add policy
              </button>
            )}
          </div>
        </div>
        {isAdmin && showPolicy && !editPolicy && <PolicyForm onSubmit={(p) => createPolicy.mutate(p)} saving={createPolicy.isPending} onCancel={() => setShowPolicy(false)} />}
        {isAdmin && editPolicy && <PolicyForm initial={editPolicy} onSubmit={(p) => updatePolicyM.mutate({ id: editPolicy.id, p: { ...p, updatedAt: editPolicy.updatedAt } })} saving={updatePolicyM.isPending} onCancel={() => setEditPolicy(null)} />}
        {policies.data!.data.length === 0 ? (
          <EmptyState message="No insurance policies or bonds tracked yet." />
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2">Type</th><th>Carrier</th><th>Policy #</th><th>Coverage</th><th>Expiry</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {policies.data!.data.map((p) => (
                <tr key={p.id} className={`border-b border-gray-900 ${p.isArchived ? 'opacity-50' : ''}`}>
                  <td className="py-2 text-gray-200">{p.policyType.replace(/_/g, ' ')}{p.isArchived && <span className="ml-2 text-[9px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded px-1">archived</span>}</td>
                  <td className="text-gray-400">{p.carrier || '—'}</td>
                  <td className="text-gray-400 font-mono text-xs">{p.policyNumber || '—'}</td>
                  <td className="text-gray-400">{p.coverageAmount != null ? `$${Number(p.coverageAmount).toLocaleString()}` : '—'}</td>
                  <td className="text-gray-400">{fmtDate(p.expiryDate)}</td>
                  <td>{pol[p.id] && <StatusBadge status={pol[p.id]} />}</td>
                  <td className="text-right">
                    {isAdmin && (p.isArchived ? (
                      <button onClick={() => restorePolicy.mutate(p.id)} className="text-gray-500 hover:text-green-400 text-xs">Restore</button>
                    ) : (
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => { setShowPolicy(false); setEditPolicy(p) }} aria-label={`Edit ${p.policyType} policy`} className="text-gray-600 hover:text-blue-400"><Pencil className="w-4 h-4" /></button>
                        <button onClick={() => setArchiveTarget({ kind: 'policy', id: p.id, name: `${p.policyType.replace(/_/g, ' ')}${p.policyNumber ? ` (${p.policyNumber})` : ''}` })} aria-label={`Archive ${p.policyType} policy`} className="text-gray-600 hover:text-red-400"><Archive className="w-4 h-4" /></button>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {!isAdmin && <p className="text-xs text-gray-600 mt-4">You have read-only access. Ask an administrator to add or change compliance records.</p>}

      <ConfirmModal
        open={!!archiveTarget}
        variant="archive"
        entityType={archiveTarget?.kind === 'cert' ? 'certification' : 'insurance policy'}
        entityName={archiveTarget?.name ?? ''}
        loading={archiveCert.isPending || archivePolicy.isPending}
        onConfirm={confirmArchive}
        onCancel={() => setArchiveTarget(null)}
      />
    </div>
  )
}

function statusById(h: Health, kind: HealthItem['kind']): Record<string, ExpiryStatus> {
  const map: Record<string, ExpiryStatus> = {}
  for (const i of h.items) if (i.kind === kind) map[i.id] = i.status
  return map
}

function SummaryCard({ icon: Icon, tone, label, value }: { icon: typeof ShieldCheck; tone: 'green' | 'yellow' | 'red' | 'gray'; label: string; value: number }) {
  const toneCls = { green: 'text-green-400', yellow: 'text-yellow-400', red: 'text-red-400', gray: 'text-gray-500' }[tone]
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1"><Icon className={`w-4 h-4 ${toneCls}`} /><span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span></div>
      <p className="text-2xl font-bold text-gray-100">{value}</p>
    </div>
  )
}

function toSamForm(p: SamProfile | null) {
  const status = p?.samStatus && (SAM_STATUS_OPTIONS as readonly string[]).includes(p.samStatus) ? p.samStatus : 'NOT_REGISTERED'
  return {
    samStatus: status,
    uei: p?.uei ?? '',
    cageCode: p?.cageCode ?? '',
    samExpiryDate: p?.samExpiryDate ? p.samExpiryDate.slice(0, 10) : '',
    naicsCodes: p?.naicsCodes ?? [],
    setAsideCerts: p?.setAsideCerts ?? [],
    notes: p?.notes ?? '',
  }
}

function SamRegistrationSection({ profile, isAdmin, onSave, saving }: {
  profile: SamProfile | null
  isAdmin: boolean
  onSave: (p: Record<string, unknown>) => Promise<unknown>
  saving: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(() => toSamForm(profile))
  const [naicsInput, setNaicsInput] = useState('')

  const beginEdit = () => { setForm(toSamForm(profile)); setNaicsInput(''); setEditing(true) }
  const addNaics = () => {
    const codes = naicsInput.split(',').map((c) => c.trim()).filter(Boolean)
    if (!codes.length) return
    setForm((f) => ({ ...f, naicsCodes: Array.from(new Set([...f.naicsCodes, ...codes])) }))
    setNaicsInput('')
  }
  const removeNaics = (c: string) => setForm((f) => ({ ...f, naicsCodes: f.naicsCodes.filter((x) => x !== c) }))
  const toggleSetAside = (v: string) =>
    setForm((f) => ({ ...f, setAsideCerts: f.setAsideCerts.includes(v) ? f.setAsideCerts.filter((x) => x !== v) : [...f.setAsideCerts, v] }))

  const submit = async () => {
    try {
      await onSave({
        samStatus: form.samStatus,
        uei: form.uei.trim() ? form.uei.trim().toUpperCase() : null,
        cageCode: form.cageCode.trim() ? form.cageCode.trim().toUpperCase() : null,
        samExpiryDate: form.samExpiryDate ? new Date(form.samExpiryDate).toISOString() : null,
        naicsCodes: form.naicsCodes,
        setAsideCerts: form.setAsideCerts,
        notes: form.notes.trim() ? form.notes.trim() : null,
        updatedAt: profile?.updatedAt,
      })
      setEditing(false)
    } catch {
      /* parent surfaces the error toast (incl. stale-write) — keep edits open */
    }
  }

  const status = profile?.samStatus ?? 'NOT_REGISTERED'

  return (
    <section className="card mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <FileCheck className="w-4 h-4 text-blue-400" />
          <h2 className="font-semibold text-gray-200">SAM Registration</h2>
          {!editing && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${SAM_STATUS_STYLE[status] || SAM_STATUS_STYLE.UNKNOWN}`}>
              {status.replace(/_/g, ' ')}
            </span>
          )}
        </div>
        {isAdmin && !editing && (
          <button onClick={beginEdit} className="btn-secondary text-xs flex items-center gap-1.5">
            <Pencil className="w-3.5 h-3.5" /> Edit
          </button>
        )}
      </div>

      {!editing ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <InfoField label="UEI" value={profile?.uei} mono />
          <InfoField label="CAGE Code" value={profile?.cageCode} mono />
          <InfoField label="SAM Expiry" value={profile?.samExpiryDate ? new Date(profile.samExpiryDate).toLocaleDateString() : null} />
          <div className="md:col-span-3">
            <p className="text-xs text-gray-500 mb-1">NAICS Codes</p>
            {profile?.naicsCodes?.length ? (
              <div className="flex flex-wrap gap-1.5">{profile.naicsCodes.map((c) => <span key={c} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-300">{c}</span>)}</div>
            ) : <p className="text-gray-600">—</p>}
          </div>
          <div className="md:col-span-3">
            <p className="text-xs text-gray-500 mb-1">Set-Aside Certifications</p>
            {profile?.setAsideCerts?.length ? (
              <div className="flex flex-wrap gap-1.5">{profile.setAsideCerts.map((c) => <span key={c} className="text-[11px] px-1.5 py-0.5 rounded bg-blue-950/40 border border-blue-800 text-blue-300">{setAsideLabel(c)}</span>)}</div>
            ) : <p className="text-gray-600">—</p>}
          </div>
          {profile?.notes && <div className="md:col-span-3"><p className="text-xs text-gray-500 mb-1">Notes</p><p className="text-gray-300 whitespace-pre-wrap">{profile.notes}</p></div>}
          <p className="md:col-span-3 text-[11px] text-gray-600">Status is entered manually — Bytescon does not auto-renew SAM.gov registrations.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="text-xs text-gray-500">SAM Status
              <select value={form.samStatus} onChange={(e) => setForm({ ...form, samStatus: e.target.value })} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200">
                {SAM_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-500">UEI (12 chars)
              <input value={form.uei} maxLength={12} onChange={(e) => setForm({ ...form, uei: e.target.value.toUpperCase() })} placeholder="12 alphanumeric" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 font-mono outline-none focus:border-blue-500" />
            </label>
            <label className="text-xs text-gray-500">CAGE Code (5 chars)
              <input value={form.cageCode} maxLength={5} onChange={(e) => setForm({ ...form, cageCode: e.target.value.toUpperCase() })} placeholder="5 alphanumeric" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 font-mono outline-none focus:border-blue-500" />
            </label>
            <label className="text-xs text-gray-500">SAM Expiry Date
              <input type="date" value={form.samExpiryDate} onChange={(e) => setForm({ ...form, samExpiryDate: e.target.value })} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200" />
            </label>
          </div>

          <div>
            <p className="text-xs text-gray-500 mb-1">NAICS Codes</p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {form.naicsCodes.map((c) => (
                <span key={c} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-300 flex items-center gap-1">
                  {c}<button onClick={() => removeNaics(c)} className="text-gray-500 hover:text-red-400"><X className="w-3 h-3" /></button>
                </span>
              ))}
              {form.naicsCodes.length === 0 && <span className="text-xs text-gray-600">None added</span>}
            </div>
            <div className="flex gap-2">
              <input value={naicsInput} onChange={(e) => setNaicsInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNaics() } }} placeholder="e.g. 541512" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500" />
              <button type="button" onClick={addNaics} className="btn-secondary text-xs flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add</button>
            </div>
          </div>

          <div>
            <p className="text-xs text-gray-500 mb-1.5">Set-Aside Certifications</p>
            <div className="flex flex-wrap gap-2">
              {SET_ASIDE_OPTIONS.map((o) => {
                const on = form.setAsideCerts.includes(o.value)
                return (
                  <button key={o.value} type="button" onClick={() => toggleSetAside(o.value)} className={`text-xs px-2.5 py-1 rounded border transition-colors ${on ? 'bg-blue-950/50 border-blue-700 text-blue-200' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'}`}>
                    {o.label}
                  </button>
                )
              })}
            </div>
          </div>

          <label className="text-xs text-gray-500 block">Notes
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
          </label>

          <div className="flex gap-2">
            <button type="button" disabled={saving} onClick={submit} className="btn-primary text-sm disabled:opacity-60">{saving ? 'Saving…' : 'Save SAM registration'}</button>
            <button type="button" onClick={() => setEditing(false)} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      )}
    </section>
  )
}

function InfoField({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-gray-200 ${mono ? 'font-mono' : ''}`}>{value || <span className="text-gray-600">—</span>}</p>
    </div>
  )
}

function CertForm({ initial, onSubmit, saving, onCancel }: { initial?: Cert; onSubmit: (p: Record<string, unknown>) => void; saving: boolean; onCancel: () => void }) {
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    category: initial?.category ?? 'SET_ASIDE',
    issuingBody: initial?.issuingBody ?? '',
    certNumber: initial?.certNumber ?? '',
    issueDate: initial?.issueDate ? initial.issueDate.slice(0, 10) : '',
    expiryDate: initial?.expiryDate ? initial.expiryDate.slice(0, 10) : '',
    notes: initial?.notes ?? '',
  })
  const toIso = (d: string) => (d ? new Date(d).toISOString() : null)
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit({ name: form.name, category: form.category, issuingBody: form.issuingBody || null, certNumber: form.certNumber || null, issueDate: toIso(form.issueDate), expiryDate: toIso(form.expiryDate), notes: form.notes || null }) }}
      className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4 bg-gray-900/50 border border-gray-800 rounded-lg p-3"
    >
      <input required placeholder="Name (e.g. SDVOSB)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
      <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200">
        {['SET_ASIDE', 'QUALITY', 'SECURITY', 'REGISTRATION', 'OTHER'].map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <input placeholder="Issuing body" value={form.issuingBody} onChange={(e) => setForm({ ...form, issuingBody: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
      <input placeholder="Cert number" value={form.certNumber} onChange={(e) => setForm({ ...form, certNumber: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
      <label className="text-xs text-gray-500">Issue date<input type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200" /></label>
      <label className="text-xs text-gray-500">Expiry date<input type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200" /></label>
      <input placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="md:col-span-2 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
      <div className="md:col-span-4 flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary text-sm disabled:opacity-60">{saving ? 'Saving…' : initial ? 'Save changes' : 'Save certification'}</button>
        <button type="button" onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
      </div>
    </form>
  )
}

function PolicyForm({ initial, onSubmit, saving, onCancel }: { initial?: Policy; onSubmit: (p: Record<string, unknown>) => void; saving: boolean; onCancel: () => void }) {
  const [form, setForm] = useState({
    policyType: initial?.policyType ?? 'GENERAL_LIABILITY',
    carrier: initial?.carrier ?? '',
    policyNumber: initial?.policyNumber ?? '',
    coverageAmount: initial?.coverageAmount != null ? String(initial.coverageAmount) : '',
    effectiveDate: initial?.effectiveDate ? initial.effectiveDate.slice(0, 10) : '',
    expiryDate: initial?.expiryDate ? initial.expiryDate.slice(0, 10) : '',
    notes: initial?.notes ?? '',
  })
  const toIso = (d: string) => (d ? new Date(d).toISOString() : null)
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit({ policyType: form.policyType, carrier: form.carrier || null, policyNumber: form.policyNumber, coverageAmount: form.coverageAmount ? Number(form.coverageAmount) : null, effectiveDate: toIso(form.effectiveDate), expiryDate: toIso(form.expiryDate), notes: form.notes || null }) }}
      className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4 bg-gray-900/50 border border-gray-800 rounded-lg p-3"
    >
      <select value={form.policyType} onChange={(e) => setForm({ ...form, policyType: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200">
        {['GENERAL_LIABILITY', 'PROFESSIONAL', 'WORKERS_COMP', 'CYBER', 'SURETY_BOND', 'BID_BOND', 'PERFORMANCE_BOND', 'PAYMENT_BOND', 'OTHER'].map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
      </select>
      <input placeholder="Carrier" value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
      <input required placeholder="Policy number" value={form.policyNumber} onChange={(e) => setForm({ ...form, policyNumber: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
      <input type="number" min="0" placeholder="Coverage $" value={form.coverageAmount} onChange={(e) => setForm({ ...form, coverageAmount: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
      <label className="text-xs text-gray-500">Effective date<input type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200" /></label>
      <label className="text-xs text-gray-500">Expiry date<input type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200" /></label>
      <input placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="md:col-span-2 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
      <div className="md:col-span-4 flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary text-sm disabled:opacity-60">{saving ? 'Saving…' : initial ? 'Save changes' : 'Save policy'}</button>
        <button type="button" onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
      </div>
    </form>
  )
}

export default RegistrationPage
