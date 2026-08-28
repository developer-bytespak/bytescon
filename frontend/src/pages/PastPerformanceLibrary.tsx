import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader, Plus, Search, Award, Sparkles, CheckCircle2, Archive, AlertTriangle, X } from 'lucide-react'
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
      <div className="flex items-start justify-between gap-4">
        <div><p className="text-[10px] tracking-widest uppercase text-gray-500">Past Performance Library</p><h1 className="text-2xl font-bold text-gray-100">Completed Contracts & References</h1></div>
        {isAdmin && <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700"><Plus className="w-4 h-4" /> New record</button>}
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative"><Search className="w-4 h-4 absolute left-2.5 top-2 text-gray-500" /><input value={filters.search} onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1) }} placeholder="Search contract/customer/scope" className="bg-gray-800 border border-gray-700 rounded pl-8 pr-3 py-1.5 text-sm text-gray-200 w-64" /></div>
        <input value={filters.agency} onChange={(e) => { setFilters({ ...filters, agency: e.target.value }); setPage(1) }} placeholder="Agency" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 w-40" />
        <input value={filters.naicsCode} onChange={(e) => { setFilters({ ...filters, naicsCode: e.target.value }); setPage(1) }} placeholder="NAICS" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 w-28" />
        <input value={filters.valueMin} onChange={(e) => { setFilters({ ...filters, valueMin: e.target.value }); setPage(1) }} placeholder="Min $" type="number" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 w-28" />
        <select value={filters.verificationStatus} onChange={(e) => { setFilters({ ...filters, verificationStatus: e.target.value }); setPage(1) }} className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200"><option value="">Any status</option><option value="DRAFT">Draft</option><option value="VERIFIED">Verified</option><option value="APPROVED">Approved</option></select>
        <select value={filters.archived} onChange={(e) => { setFilters({ ...filters, archived: e.target.value }); setPage(1) }} className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200"><option value="false">Active</option><option value="true">Archived</option><option value="all">All</option></select>
      </div>

      {isLoading ? <div className="py-12 flex justify-center"><Loader className="w-5 h-5 animate-spin text-gray-500" /></div>
        : isError ? <div className="bg-red-950/30 border border-red-900 rounded-lg p-4 text-sm text-red-300 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> Could not load. <button onClick={() => refetch()} className="underline">Retry</button></div>
        : records.length === 0 ? <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center"><Award className="w-10 h-10 mx-auto text-gray-600 mb-2" /><p className="text-sm text-gray-500">No records match. Create one or adjust filters.</p></div>
        : (
          <div className="overflow-x-auto border border-gray-800 rounded-xl">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[10px] tracking-widest uppercase text-gray-500 border-b border-gray-800"><th className="p-3">Contract</th><th className="p-3">Agency</th><th className="p-3">NAICS</th><th className="p-3">Value</th><th className="p-3">CPARS</th><th className="p-3">Status</th></tr></thead>
              <tbody>{records.map((r) => (
                <tr key={r.id} onClick={() => setDetailId(r.id)} className="border-b border-gray-800/60 last:border-0 hover:bg-gray-900/40 cursor-pointer">
                  <td className="p-3 text-gray-200">{r.contractTitle || r.contractNumber}<span className="block text-[10px] text-gray-600 font-mono">{r.contractNumber}</span></td>
                  <td className="p-3 text-gray-400">{r.customerAgency || '—'}</td>
                  <td className="p-3 text-gray-400 font-mono">{r.naicsCode || '—'}</td>
                  <td className="p-3 text-gray-400 font-mono">{money(r.totalValue)}</td>
                  <td className="p-3 text-gray-400">{r.cparsRating || <span className="text-gray-600">not entered</span>}</td>
                  <td className="p-3"><span className="text-[10px] px-2 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-300 font-mono">{r.verificationStatus}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}

      {totalPages > 1 && (
        <div className="flex items-center gap-2 justify-center text-sm">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-3 py-1 rounded bg-gray-800 border border-gray-700 text-gray-300 disabled:opacity-40">Prev</button>
          <span className="text-gray-500">Page {page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="px-3 py-1 rounded bg-gray-800 border border-gray-700 text-gray-300 disabled:opacity-40">Next</button>
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
        <div className="bg-gray-800/40 border border-gray-800 rounded-lg p-3">
          <p className="text-[10px] tracking-widest uppercase text-gray-500 mb-1.5">Create from completed contract</p>
          <div className="flex gap-2"><input value={contractId} onChange={(e) => setContractId(e.target.value)} placeholder="Contract ID" className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200" /><button onClick={fromContract} disabled={!contractId.trim()} className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-40">Prefill</button></div>
          <p className="text-[10px] text-gray-600 mt-1">Prefills reliable contract data only — results/metrics/CPARS require human entry.</p>
        </div>
        <p className="text-[10px] tracking-widest uppercase text-gray-500">Or enter manually</p>
        {([['contractNumber', 'Contract number *'], ['customerName', 'Customer name *'], ['customerAgency', 'Agency'], ['naicsCode', 'NAICS'], ['totalValue', 'Total value ($)']] as const).map(([k, label]) => (
          <input key={k} value={(f as any)[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={label} className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200" />
        ))}
        <select value={f.performerRole} onChange={(e) => setF({ ...f, performerRole: e.target.value })} className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200"><option value="PRIME">PRIME</option><option value="SUB">SUB</option></select>
        <select value={f.cparsRating} onChange={(e) => setF({ ...f, cparsRating: e.target.value })} className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200"><option value="">CPARS rating (user-entered, optional)</option>{['EXCEPTIONAL', 'VERY_GOOD', 'SATISFACTORY', 'MARGINAL', 'UNSATISFACTORY'].map((c) => <option key={c}>{c}</option>)}</select>
        <textarea value={f.scopeSummary} onChange={(e) => setF({ ...f, scopeSummary: e.target.value })} placeholder="Scope summary" rows={3} className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200" />
        <button onClick={submit} disabled={!f.contractNumber.trim() || !f.customerName.trim()} className="w-full text-sm px-4 py-2 rounded-lg bg-blue-900/40 hover:bg-blue-900/60 text-blue-200 border border-blue-700 disabled:opacity-40">Create record</button>
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
      {isLoading || !r ? <div className="py-8 flex justify-center"><Loader className="w-5 h-5 animate-spin text-gray-500" /></div> : (
        <div className="space-y-3 text-sm">
          <h3 className="text-lg font-semibold text-gray-100">{r.contractTitle || r.contractNumber}</h3>
          <Field label="Contract number" value={r.contractNumber} />
          <Field label="Customer / Agency" value={r.customerAgency || r.customerName} />
          <Field label="NAICS" value={r.naicsCode} />
          <Field label="Value" value={money(r.totalValue)} />
          <Field label="Role" value={r.performerRole} />
          <Field label="CPARS (user-entered)" value={r.cparsRating || 'Not entered — manual'} />
          <Field label="Verification" value={r.verificationStatus} />
          <div><p className="text-[10px] tracking-widest uppercase text-gray-500">Scope</p><p className="text-gray-300 text-sm">{r.scopeSummary || '—'}</p></div>
          <div className="border-t border-gray-800 pt-3">
            <p className="text-[10px] tracking-widest uppercase text-gray-500 mb-1">Reference {r.referenceRedacted && <span className="text-gray-600">(protected)</span>}</p>
            {r.referenceRedacted ? <p className="text-xs text-gray-600">Private reference details are restricted to authorized roles.</p> : (
              <div className="text-xs text-gray-400 space-y-0.5"><p>Name: {r.referenceName || '—'}</p><p>Email: {r.referenceEmail || '—'}</p><p>Permission to contact: {r.permissionToContact ? 'Yes' : 'No'}</p><p>Availability: {r.referenceAvailability || '—'}</p></div>
            )}
          </div>
          {isAdmin && (
            <div className="space-y-3 border-t border-gray-800 pt-3">
              <div className="flex flex-wrap gap-2">
                {r.verificationStatus !== 'VERIFIED' && <button onClick={act(() => pastPerformanceLibraryApi.verify(r.id), 'Verified')} className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-green-900/40 text-green-200 border border-green-700"><CheckCircle2 className="w-3.5 h-3.5" /> Verify</button>}
                {r.verificationStatus === 'APPROVED'
                  ? <button onClick={act(() => pastPerformanceLibraryApi.reopen(r.id), 'Reopened for editing')} className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-300 border border-gray-700">Reopen to edit</button>
                  : <button onClick={() => setEditing((v) => !v)} className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-300 border border-gray-700">{editing ? 'Cancel edit' : 'Edit'}</button>}
                {!r.isArchived ? <button onClick={act(() => pastPerformanceLibraryApi.archive(r.id), 'Archived')} className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-red-900/40 text-red-300 border border-red-700"><Archive className="w-3.5 h-3.5" /> Archive</button>
                  : <button onClick={act(() => pastPerformanceLibraryApi.restore(r.id), 'Restored')} className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-300 border border-gray-700">Restore</button>}
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
                  <button type="submit" className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-200 border border-gray-700 justify-self-start">Save changes</button>
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
      <button onClick={() => navigate(`/opportunities/${opportunityId}`)} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-300"><ArrowLeft className="w-4 h-4" /> Back to opportunity</button>
      <div className="flex items-start justify-between gap-4">
        <div><p className="text-[10px] tracking-widest uppercase text-gray-500">Past Performance Matrix</p><h1 className="text-2xl font-bold text-gray-100">{opp?.title ?? 'Opportunity'}</h1></div>
        {isAdmin && <button onClick={act(() => pastPerformanceLibraryApi.score(opportunityId), 'Relevance scored (deterministic)')} className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-purple-900/40 hover:bg-purple-900/60 text-purple-200 border border-purple-700"><Sparkles className="w-4 h-4" /> Score relevance</button>}
      </div>

      {matrixQuery.isLoading ? <div className="py-12 flex justify-center"><Loader className="w-5 h-5 animate-spin text-gray-500" /></div>
        : rows.length === 0 ? <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center"><Award className="w-10 h-10 mx-auto text-gray-600 mb-2" /><p className="text-sm text-gray-500">No past-performance records yet. Add records in the library first.</p></div>
        : (
          <div className="space-y-2">{sorted.map(({ record, selection }) => (
            <div key={record.id} className={`bg-gray-900 border rounded-lg p-3 ${selection?.isSelected ? 'border-blue-700' : 'border-gray-800'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-gray-200">{record.contractTitle || record.contractNumber}</span>
                    {selection?.relevanceScore != null && <span className="text-xs font-mono text-gray-300">score {selection.relevanceScore}</span>}
                    {selection?.confidence && <span className={`text-[10px] font-mono ${CONF_STYLES[selection.confidence]}`}>{selection.confidence}</span>}
                    {selection?.isSelected && <span className="text-[9px] px-1.5 py-0.5 rounded border border-blue-800 bg-blue-950/40 text-blue-300 font-mono">SELECTED</span>}
                  </div>
                  <p className="text-[11px] text-gray-500 mt-0.5">{record.customerAgency || '—'} · {record.naicsCode || 'no NAICS'} · {money(record.totalValue)}</p>
                  {selection?.relevanceExplanation && <p className="text-[11px] text-gray-500 mt-1">{selection.relevanceExplanation}</p>}
                  {selection && selection.matchingFactors.length > 0 && <p className="text-[10px] text-green-500/70 mt-0.5">✓ {selection.matchingFactors.join(' · ')}</p>}
                </div>
                {isAdmin && (
                  <div className="flex flex-col gap-1.5">
                    {selection?.isSelected ? <button onClick={act(() => pastPerformanceLibraryApi.deselect(opportunityId, record.id), 'Deselected')} className="text-[10px] px-2 py-1 rounded bg-gray-800 text-gray-300 border border-gray-700">Deselect</button>
                      : <button onClick={act(() => pastPerformanceLibraryApi.select(opportunityId, record.id), 'Selected for proposal')} className="text-[10px] px-2 py-1 rounded bg-blue-900/40 text-blue-200 border border-blue-700">Select</button>}
                    <button onClick={() => adapt(record.id)} className="text-[10px] px-2 py-1 rounded bg-purple-900/30 text-purple-300 border border-purple-800">Adapt</button>
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
          <pre className="text-xs text-gray-300 whitespace-pre-wrap font-sans bg-gray-950/50 border border-gray-800 rounded-lg p-3 max-h-[70vh] overflow-auto">{adaptDraft}</pre>
        </Drawer>
      )}
    </div>
  )
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="w-full max-w-md h-full bg-gray-950 border-l border-gray-800 p-5 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4"><h2 className="text-sm font-semibold text-gray-200">{title}</h2><button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X className="w-4 h-4" /></button></div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null }) {
  return <div className="flex justify-between text-sm"><span className="text-gray-500">{label}</span><span className="text-gray-300">{value || '—'}</span></div>
}
