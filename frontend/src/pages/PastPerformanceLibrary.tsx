import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader, Plus, Search, Award, Sparkles, CheckCircle2, Archive, AlertTriangle, X } from 'lucide-react'
import { EmptyState, StatusPill } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { opportunitiesApi, pastPerformanceLibraryApi } from '../services/api'

interface Record_ {
  id: string; contractNumber: string; contractTitle: string | null; customerName: string; customerAgency: string | null
  naicsCode: string | null; totalValue: string | null; performerRole: string | null; cparsRating: string | null
  verificationStatus: string; isArchived: boolean; scopeSummary: string; referenceEmail: string | null; referenceRedacted?: boolean
  referenceName: string | null; permissionToContact: boolean; referenceAvailability: string | null; updatedAt: string
}
interface Selection { id: string; relevanceScore: number | null; confidence: string | null; matchingFactors: string[]; missingFactors: string[]; relevanceExplanation: string | null; isSelected: boolean }

const money = (v: string | null) => v == null ? '—' : `$${Number(v).toLocaleString()}`
const CONF_STYLES: Record<string, string> = { HIGH: 'text-green-400', MEDIUM: 'text-yellow-400', LOW: 'text-gray-400', INSUFFICIENT_DATA: 'text-gray-600' }

export default function PastPerformanceLibrary() {
  const { id: opportunityId } = useParams<{ id?: string }>()
  if (opportunityId) return <MatrixMode opportunityId={opportunityId} />
  return <LibraryMode />
}

function LibraryMode() {
  const { user } = useAuth()
  const { toast } = useToast()
  const qc = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'
  const [filters, setFilters] = useState({ search: '', agency: '', naicsCode: '', valueMin: '', verificationStatus: '', archived: 'false' })
  const [page, setPage] = useState(1)
  const [showCreate, setShowCreate] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const params = { ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '')), page }
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['pp-library', params], queryFn: () => pastPerformanceLibraryApi.list(params) })
  const records: Record_[] = data?.data?.records ?? []
  const totalPages = data?.data?.totalPages ?? 1
  const invalidate = () => qc.invalidateQueries({ queryKey: ['pp-library'] })

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0"><p className="overline">Past Performance Library</p><h1 className="page-title mt-1">Completed Contracts & References</h1></div>
        {isAdmin && <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-1.5"><Plus className="w-4 h-4" /> New record</button>}
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative w-full sm:w-64"><Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" /><input value={filters.search} onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1) }} placeholder="Search contract/customer/scope" className="input !py-1.5 !pl-8 w-full" /></div>
        <input value={filters.agency} onChange={(e) => { setFilters({ ...filters, agency: e.target.value }); setPage(1) }} placeholder="Agency" className="input !py-1.5 sm:!w-40" />
        <input value={filters.naicsCode} onChange={(e) => { setFilters({ ...filters, naicsCode: e.target.value }); setPage(1) }} placeholder="NAICS" className="input !py-1.5 sm:!w-28" />
        <input value={filters.valueMin} onChange={(e) => { setFilters({ ...filters, valueMin: e.target.value }); setPage(1) }} placeholder="Min $" type="number" className="input !py-1.5 sm:!w-28" />
        <select value={filters.verificationStatus} onChange={(e) => { setFilters({ ...filters, verificationStatus: e.target.value }); setPage(1) }} className="input !py-1.5 !w-auto"><option value="">Any status</option><option value="DRAFT">Draft</option><option value="VERIFIED">Verified</option><option value="APPROVED">Approved</option></select>
        <select value={filters.archived} onChange={(e) => { setFilters({ ...filters, archived: e.target.value }); setPage(1) }} className="input !py-1.5 !w-auto"><option value="false">Active</option><option value="true">Archived</option><option value="all">All</option></select>
      </div>

      {isLoading ? <div className="py-16 flex justify-center"><Loader className="w-5 h-5 animate-spin text-gray-500" /></div>
        : isError ? <div className="rounded-xl p-4 text-sm flex items-center gap-2" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger-text)' }}><AlertTriangle className="w-4 h-4" /> Could not load. <button onClick={() => refetch()} className="underline underline-offset-2 font-medium">Retry</button></div>
        : records.length === 0 ? <div className="card"><EmptyState icon={<Award />} message="No records match. Create one or adjust filters." hint={null} /></div>
        : (
          <div className="table-wrap max-h animate-fade-in">
            <table className="data-table">
              <thead><tr><th>Contract</th><th>Agency</th><th>NAICS</th><th className="!text-right">Value</th><th>CPARS</th><th>Status</th></tr></thead>
              <tbody>{records.map((r) => (
                <tr key={r.id} onClick={() => setDetailId(r.id)} className="cursor-pointer">
                  <td className="text-gray-200 font-medium min-w-[12rem]">{r.contractTitle || r.contractNumber}<span className="block text-[10px] text-gray-600 font-mono font-normal">{r.contractNumber}</span></td>
                  <td className="text-gray-400">{r.customerAgency || '—'}</td>
                  <td className="text-gray-400 font-mono tabular-nums">{r.naicsCode || '—'}</td>
                  <td className="text-right text-gray-300 tabular-nums whitespace-nowrap">{money(r.totalValue)}</td>
                  <td className="text-gray-400">{r.cparsRating || <span className="text-gray-600">not entered</span>}</td>
                  <td><StatusPill status={r.verificationStatus} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}

      {totalPages > 1 && (
        <div className="flex items-center gap-2 justify-center text-sm">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="btn-secondary btn-sm disabled:opacity-40">Prev</button>
          <span className="text-gray-500 tabular-nums px-2">Page {page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="btn-secondary btn-sm disabled:opacity-40">Next</button>
        </div>
      )}

      {showCreate && <CreateDrawer onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); invalidate() }} />}
      {detailId && <DetailDrawer id={detailId} isAdmin={isAdmin} onClose={() => setDetailId(null)} onChanged={invalidate} />}
    </div>
  )
}

function CreateDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast()
  const [f, setF] = useState({ contractNumber: '', customerName: '', customerAgency: '', naicsCode: '', totalValue: '', scopeSummary: '', performerRole: 'PRIME', cparsRating: '' })
  const [contractId, setContractId] = useState('')
  const submit = async () => {
    try { await pastPerformanceLibraryApi.create({ ...f, totalValue: f.totalValue ? Number(f.totalValue) : undefined, cparsRating: f.cparsRating || undefined }); onCreated(); toast('Record created', 'success') } catch (e: any) { toast(e?.response?.data?.error || 'Failed', 'error') }
  }
  const fromContract = async () => { try { await pastPerformanceLibraryApi.fromContract(contractId.trim()); onCreated(); toast('Draft created from contract', 'success') } catch (e: any) { toast(e?.response?.data?.error || 'Failed', 'error') } }
  return (
    <Drawer title="New past-performance record" onClose={onClose}>
      <div className="space-y-3">
        <div className="panel p-3.5">
          <p className="overline mb-2">Create from completed contract</p>
          <div className="flex gap-2"><input value={contractId} onChange={(e) => setContractId(e.target.value)} placeholder="Contract ID" className="input flex-1 min-w-0 !py-1.5" /><button onClick={fromContract} disabled={!contractId.trim()} className="btn-secondary btn-sm disabled:opacity-40">Prefill</button></div>
          <p className="text-[10px] text-gray-600 mt-2">Prefills reliable contract data only — results/metrics/CPARS require human entry.</p>
        </div>
        <p className="overline">Or enter manually</p>
        {([['contractNumber', 'Contract number *'], ['customerName', 'Customer name *'], ['customerAgency', 'Agency'], ['naicsCode', 'NAICS'], ['totalValue', 'Total value ($)']] as const).map(([k, label]) => (
          <input key={k} value={(f as any)[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={label} className="input w-full" />
        ))}
        <select value={f.performerRole} onChange={(e) => setF({ ...f, performerRole: e.target.value })} className="input w-full"><option value="PRIME">PRIME</option><option value="SUB">SUB</option></select>
        <select value={f.cparsRating} onChange={(e) => setF({ ...f, cparsRating: e.target.value })} className="input w-full"><option value="">CPARS rating (user-entered, optional)</option>{['EXCEPTIONAL', 'VERY_GOOD', 'SATISFACTORY', 'MARGINAL', 'UNSATISFACTORY'].map((c) => <option key={c}>{c}</option>)}</select>
        <textarea value={f.scopeSummary} onChange={(e) => setF({ ...f, scopeSummary: e.target.value })} placeholder="Scope summary" rows={3} className="input w-full" />
        <button onClick={submit} disabled={!f.contractNumber.trim() || !f.customerName.trim()} className="btn-primary w-full justify-center disabled:opacity-40">Create record</button>
      </div>
    </Drawer>
  )
}

function DetailDrawer({ id, isAdmin, onClose, onChanged }: { id: string; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast()
  const { data, isLoading, refetch } = useQuery({ queryKey: ['pp-record', id], queryFn: () => pastPerformanceLibraryApi.get(id) })
  const r: Record_ | undefined = data?.data?.record
  const [editing, setEditing] = useState(false)
  const [edit, setEdit] = useState({ customerName: '', customerAgency: '', naicsCode: '', totalValue: '', scopeSummary: '', cparsRating: '' })

  // Seed the edit form from the record once it has loaded, and again whenever a
  // save or a reopen brings back different values.
  useEffect(() => {
    if (!r) return
    setEdit({
      customerName: r.customerName ?? '', customerAgency: r.customerAgency ?? '',
      naicsCode: r.naicsCode ?? '', totalValue: r.totalValue != null ? String(r.totalValue) : '',
      scopeSummary: r.scopeSummary ?? '', cparsRating: r.cparsRating ?? '',
    })
  }, [r?.id, r?.verificationStatus, r?.updatedAt])

  const act = (fn: () => Promise<any>, msg: string) => async () => { try { await fn(); await refetch(); onChanged(); toast(msg, 'success') } catch (e: any) { toast(e?.response?.data?.error || 'Failed', 'error') } }
  return (
    <Drawer title="Past-performance detail" onClose={onClose}>
      {isLoading || !r ? <div className="py-12 flex justify-center"><Loader className="w-5 h-5 animate-spin text-gray-500" /></div> : (
        <div className="space-y-3 text-sm">
          <h3 className="text-lg font-semibold text-gray-100 mb-1">{r.contractTitle || r.contractNumber}</h3>
          <Field label="Contract number" value={r.contractNumber} />
          <Field label="Customer / Agency" value={r.customerAgency || r.customerName} />
          <Field label="NAICS" value={r.naicsCode} />
          <Field label="Value" value={money(r.totalValue)} />
          <Field label="Role" value={r.performerRole} />
          <Field label="CPARS (user-entered)" value={r.cparsRating || 'Not entered — manual'} />
          <Field label="Verification" value={r.verificationStatus} />
          <div><p className="overline mb-1">Scope</p><p className="text-gray-300 text-sm leading-relaxed">{r.scopeSummary || '—'}</p></div>
          <div className="border-t border-gray-800 pt-3">
            <p className="overline mb-1.5">Reference {r.referenceRedacted && <span className="text-gray-600">(protected)</span>}</p>
            {r.referenceRedacted ? <p className="text-xs text-gray-600">Private reference details are restricted to authorized roles.</p> : (
              <div className="text-xs text-gray-400 space-y-0.5"><p>Name: {r.referenceName || '—'}</p><p>Email: {r.referenceEmail || '—'}</p><p>Permission to contact: {r.permissionToContact ? 'Yes' : 'No'}</p><p>Availability: {r.referenceAvailability || '—'}</p></div>
            )}
          </div>
          {isAdmin && (
            <div className="space-y-3 border-t border-gray-800 pt-3">
              <div className="flex flex-wrap gap-2">
                {r.verificationStatus !== 'VERIFIED' && <button onClick={act(() => pastPerformanceLibraryApi.verify(r.id), 'Verified')} className="btn-secondary btn-sm text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Verify</button>}
                {r.verificationStatus === 'APPROVED'
                  ? <button onClick={act(() => pastPerformanceLibraryApi.reopen(r.id), 'Reopened for editing')} className="btn-secondary btn-sm">Reopen to edit</button>
                  : <button onClick={() => setEditing((v) => !v)} className="btn-secondary btn-sm">{editing ? 'Cancel edit' : 'Edit'}</button>}
                {!r.isArchived ? <button onClick={act(() => pastPerformanceLibraryApi.archive(r.id), 'Archived')} className="btn-danger btn-sm flex items-center gap-1"><Archive className="w-3.5 h-3.5" /> Archive</button>
                  : <button onClick={act(() => pastPerformanceLibraryApi.restore(r.id), 'Restored')} className="btn-secondary btn-sm">Restore</button>}
              </div>

              {r.verificationStatus === 'APPROVED' && (
                <p className="text-[11px] text-gray-500">
                  An approved record is immutable — a proposal may already cite it. Reopen it first, and the approval
                  is withdrawn along with it.
                </p>
              )}

              {editing && r.verificationStatus !== 'APPROVED' && (
                <form className="grid grid-cols-1 md:grid-cols-2 gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void act(() => pastPerformanceLibraryApi.update(r.id, {
                      customerName: edit.customerName, customerAgency: edit.customerAgency,
                      naicsCode: edit.naicsCode || undefined,
                      totalValue: edit.totalValue ? Number(edit.totalValue) : undefined,
                      scopeSummary: edit.scopeSummary,
                      cparsRating: edit.cparsRating || undefined,
                    }), 'Record updated')()
                    setEditing(false)
                  }}>
                  <input aria-label="Customer name" className="input" placeholder="Customer" value={edit.customerName} onChange={(e) => setEdit({ ...edit, customerName: e.target.value })} />
                  <input aria-label="Customer agency" className="input" placeholder="Agency" value={edit.customerAgency} onChange={(e) => setEdit({ ...edit, customerAgency: e.target.value })} />
                  <input aria-label="NAICS code" className="input" placeholder="NAICS" value={edit.naicsCode} onChange={(e) => setEdit({ ...edit, naicsCode: e.target.value })} />
                  <input aria-label="Total value" className="input" type="number" min="0" placeholder="Total value $" value={edit.totalValue} onChange={(e) => setEdit({ ...edit, totalValue: e.target.value })} />
                  <input aria-label="CPARS rating" className="input" placeholder="CPARS rating" value={edit.cparsRating} onChange={(e) => setEdit({ ...edit, cparsRating: e.target.value })} />
                  <textarea aria-label="Scope summary" className="input md:col-span-2" rows={3} placeholder="Scope summary" value={edit.scopeSummary} onChange={(e) => setEdit({ ...edit, scopeSummary: e.target.value })} />
                  <button type="submit" className="btn-primary btn-sm justify-self-start">Save changes</button>
                </form>
              )}
            </div>
          )}
        </div>
      )}
    </Drawer>
  )
}

function MatrixMode({ opportunityId }: { opportunityId: string }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { toast } = useToast()
  const qc = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'
  const [adaptDraft, setAdaptDraft] = useState<string | null>(null)

  const oppQuery = useQuery({ queryKey: ['opportunity', opportunityId], queryFn: () => opportunitiesApi.getById(opportunityId) })
  const matrixQuery = useQuery({ queryKey: ['pp-matrix', opportunityId], queryFn: () => pastPerformanceLibraryApi.matrix(opportunityId) })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['pp-matrix', opportunityId] })
  const rows: { record: Record_; selection: Selection | null }[] = matrixQuery.data?.data?.rows ?? []
  const opp = oppQuery.data?.data ?? oppQuery.data
  const act = (fn: () => Promise<any>, msg: string) => async () => { try { await fn(); invalidate(); toast(msg, 'success') } catch (e: any) { toast(e?.response?.data?.error || 'Failed', 'error') } }
  const adapt = async (recordId: string) => { try { const r = await pastPerformanceLibraryApi.adapt(recordId, { opportunityId }); setAdaptDraft(r?.data?.content ?? '') } catch (e: any) { toast(e?.response?.data?.error || 'Failed', 'error') } }

  const sorted = [...rows].sort((a, b) => (b.selection?.relevanceScore ?? -1) - (a.selection?.relevanceScore ?? -1))

  return (
    <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
      <button onClick={() => navigate(`/opportunities/${opportunityId}`)} className="btn-ghost btn-sm -ml-2 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Back to opportunity</button>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0"><p className="overline">Past Performance Matrix</p><h1 className="page-title mt-1">{opp?.title ?? 'Opportunity'}</h1></div>
        {isAdmin && <button onClick={act(() => pastPerformanceLibraryApi.score(opportunityId), 'Relevance scored (deterministic)')} className="btn-primary flex items-center gap-1.5"><Sparkles className="w-4 h-4" /> Score relevance</button>}
      </div>

      {matrixQuery.isLoading ? <div className="py-16 flex justify-center"><Loader className="w-5 h-5 animate-spin text-gray-500" /></div>
        : rows.length === 0 ? <div className="card"><EmptyState icon={<Award />} message="No past-performance records yet. Add records in the library first." hint={null} /></div>
        : (
          <div className="stagger space-y-2">{sorted.map(({ record, selection }) => (
            <div key={record.id} className={`card !py-4 ${selection?.isSelected ? 'card-accent' : ''}`}>
              <div className="flex flex-wrap sm:flex-nowrap items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-200">{record.contractTitle || record.contractNumber}</span>
                    {selection?.relevanceScore != null && <span className="chip chip-neutral font-mono tabular-nums">score {selection.relevanceScore}</span>}
                    {selection?.confidence && <span className={`text-[10px] font-mono ${CONF_STYLES[selection.confidence]}`}>{selection.confidence}</span>}
                    {selection?.isSelected && <span className="chip chip-accent font-mono">SELECTED</span>}
                  </div>
                  <p className="text-[11px] text-gray-500 mt-1 tabular-nums">{record.customerAgency || '—'} · {record.naicsCode || 'no NAICS'} · {money(record.totalValue)}</p>
                  {selection?.relevanceExplanation && <p className="text-[11px] text-gray-500 mt-1">{selection.relevanceExplanation}</p>}
                  {selection && selection.matchingFactors.length > 0 && <p className="text-[10px] text-green-500/70 mt-0.5">✓ {selection.matchingFactors.join(' · ')}</p>}
                </div>
                {isAdmin && (
                  <div className="flex sm:flex-col gap-1.5 flex-shrink-0">
                    {selection?.isSelected ? <button onClick={act(() => pastPerformanceLibraryApi.deselect(opportunityId, record.id), 'Deselected')} className="btn-secondary btn-sm">Deselect</button>
                      : <button onClick={act(() => pastPerformanceLibraryApi.select(opportunityId, record.id), 'Selected for proposal')} className="btn-primary btn-sm">Select</button>}
                    <button onClick={() => adapt(record.id)} className="btn-ghost btn-sm">Adapt</button>
                  </div>
                )}
              </div>
            </div>
          ))}</div>
        )}
      <p className="text-[10px] text-gray-600">Relevance is deterministic + explainable. Human selection is preserved separately from the automated score. Selection does not guarantee evaluation credit or award.</p>

      {adaptDraft !== null && (
        <Drawer title="AI adaptation draft" onClose={() => setAdaptDraft(null)}>
          <p className="text-[11px] text-purple-300/80 mb-2">Draft only — the master record is unchanged. Review before use.</p>
          <pre className="panel text-xs leading-relaxed text-gray-300 whitespace-pre-wrap font-sans p-3.5 max-h-[70vh] overflow-auto">{adaptDraft}</pre>
        </Drawer>
      )}
    </div>
  )
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="drawer-panel w-full max-w-md h-full bg-gray-950 border-l border-gray-800 p-5 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4"><h2 className="text-sm font-semibold text-gray-200">{title}</h2><button onClick={onClose} aria-label="Close" className="btn-ghost btn-sm !px-1.5"><X className="w-4 h-4" /></button></div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null }) {
  return <div className="flex justify-between gap-3 text-sm py-1.5 border-b border-gray-800/60"><span className="text-gray-500 flex-shrink-0">{label}</span><span className="text-gray-300 text-right tabular-nums break-words min-w-0">{value || '—'}</span></div>
}
