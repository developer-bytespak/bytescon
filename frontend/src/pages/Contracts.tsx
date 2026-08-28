import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { contractMgmtApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { PageHeader, Spinner, EmptyState, ErrorBanner } from '../components/ui'
import { FileSignature, Plus, AlertTriangle, CalendarClock, Search } from 'lucide-react'
import { ContractPortfolioHealth } from '../components/contracts/ContractHealthPanels'

interface Contract {
  id: string
  contractNumber: string
  title: string
  agency?: string | null
  status: string
  awardValue?: string | null
  fundedValue?: string | null
  endDate?: string | null
}
interface DeliverableFeedItem {
  id: string
  name: string
  dueDate: string | null
  derivedStatus: string
  contract?: { id: string; contractNumber: string; title: string }
}

const money = (v?: string | null) => (v != null ? `$${Number(v).toLocaleString()}` : '—')
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')
const statusTone: Record<string, string> = {
  DRAFT: 'bg-gray-800 border-gray-700 text-gray-300',
  ACTIVE: 'bg-green-950/40 border-green-800 text-green-300',
  ON_HOLD: 'bg-yellow-950/40 border-yellow-800 text-yellow-300',
  COMPLETED: 'bg-blue-950/40 border-blue-800 text-blue-300',
  TERMINATED: 'bg-red-950/40 border-red-800 text-red-300',
  CANCELLED: 'bg-red-950/40 border-red-800 text-red-300',
  ARCHIVED: 'bg-gray-800 border-gray-700 text-gray-500',
}

export function ContractsPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const qc = useQueryClient()
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const contracts = useQuery<{ data: Contract[]; meta: { total: number } }>({
    queryKey: ['contracts', search, status],
    queryFn: () => contractMgmtApi.list({ search: search || undefined, status: status || undefined, sortBy: 'updated', sortOrder: 'desc' }),
  })
  const overdue = useQuery<{ data: DeliverableFeedItem[] }>({ queryKey: ['deliverables-overdue'], queryFn: () => contractMgmtApi.overdueDeliverables() })
  const upcoming = useQuery<{ data: DeliverableFeedItem[] }>({ queryKey: ['deliverables-upcoming'], queryFn: () => contractMgmtApi.upcomingDeliverables(14) })

  const create = useMutation({
    mutationFn: (p: Record<string, unknown>) => contractMgmtApi.create(p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['contracts'] }); setShowCreate(false); toast('Contract created', 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Failed to create contract', 'error'),
  })

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader title="Contracts" subtitle="Post-award administration — CLINs, modifications, option periods & deliverables">
        {isAdmin && (
          <button onClick={() => setShowCreate((v) => !v)} className="btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" /> New Contract
          </button>
        )}
      </PageHeader>

      {/* §7.1 — Contract Administration Agent portfolio health. Backend-authoritative. */}
      <div className="mb-6">
        <ContractPortfolioHealth />
      </div>

      {/* Global deliverables panel */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <DeliverablePanel title="Overdue deliverables" icon={AlertTriangle} tone="red" query={overdue} emptyMsg="No overdue deliverables." />
        <DeliverablePanel title="Due within 14 days" icon={CalendarClock} tone="yellow" query={upcoming} emptyMsg="Nothing due in the next 14 days." />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-gray-500 absolute left-3 top-2.5" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number, title, agency" className="w-full bg-gray-800 border border-gray-700 rounded pl-9 pr-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200">
          <option value="">All statuses</option>
          {['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'TERMINATED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {isAdmin && showCreate && <CreateContractForm onSubmit={(p) => create.mutate(p)} saving={create.isPending} onCancel={() => setShowCreate(false)} />}

      {contracts.isLoading ? (
        <div className="flex justify-center mt-12"><Spinner size="lg" /></div>
      ) : contracts.error ? (
        <ErrorBanner message="Could not load contracts. Please retry." />
      ) : contracts.data!.data.length === 0 ? (
        <EmptyState message="No contracts yet. Create one, or link an awarded opportunity." />
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2.5 px-4">Number</th><th>Title</th><th>Agency</th><th>Award</th><th>Funded</th><th>End date</th><th>Status</th></tr></thead>
            <tbody>
              {contracts.data!.data.map((c) => (
                <tr key={c.id} className="border-b border-gray-900 hover:bg-gray-900/40">
                  <td className="py-2.5 px-4 font-mono text-xs"><Link to={`/contracts/${c.id}`} className="text-blue-400 hover:text-blue-300">{c.contractNumber}</Link></td>
                  <td className="text-gray-200">{c.title}</td>
                  <td className="text-gray-400">{c.agency || '—'}</td>
                  <td className="text-gray-400">{money(c.awardValue)}</td>
                  <td className="text-gray-400">{money(c.fundedValue)}</td>
                  <td className="text-gray-400">{fmtDate(c.endDate)}</td>
                  <td><span className={`text-[10px] px-1.5 py-0.5 rounded border ${statusTone[c.status] || 'bg-gray-800 border-gray-700 text-gray-300'}`}>{c.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function DeliverablePanel({ title, icon: Icon, tone, query, emptyMsg }: { title: string; icon: typeof AlertTriangle; tone: 'red' | 'yellow'; query: { isLoading: boolean; error: unknown; data?: { data: DeliverableFeedItem[] } }; emptyMsg: string }) {
  const toneCls = tone === 'red' ? 'text-red-400' : 'text-yellow-400'
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-3"><Icon className={`w-4 h-4 ${toneCls}`} /><h2 className="font-semibold text-gray-200 text-sm">{title}</h2></div>
      {query.isLoading ? <Spinner size="sm" /> : query.error ? <p className="text-xs text-red-400">Failed to load.</p> : query.data!.data.length === 0 ? (
        <p className="text-sm text-gray-500">{emptyMsg}</p>
      ) : (
        <ul className="space-y-1.5">
          {query.data!.data.slice(0, 6).map((d) => (
            <li key={d.id} className="flex items-center justify-between text-sm">
              <Link to={`/contracts/${d.contract?.id}`} className="text-gray-300 hover:text-blue-300 truncate">{d.name}</Link>
              <span className="text-xs text-gray-500 flex-shrink-0 ml-2">{fmtDate(d.dueDate)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CreateContractForm({ onSubmit, saving, onCancel }: { onSubmit: (p: Record<string, unknown>) => void; saving: boolean; onCancel: () => void }) {
  const [f, setF] = useState({ contractNumber: '', title: '', agency: '', awardValue: '', startDate: '', endDate: '' })
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit({ contractNumber: f.contractNumber, title: f.title, agency: f.agency || undefined, awardValue: f.awardValue ? Number(f.awardValue) : undefined, startDate: f.startDate ? new Date(f.startDate).toISOString() : undefined, endDate: f.endDate ? new Date(f.endDate).toISOString() : undefined }) }}
      className="card mb-6 grid grid-cols-1 md:grid-cols-3 gap-3"
    >
      <input required placeholder="Contract number *" value={f.contractNumber} onChange={(e) => setF({ ...f, contractNumber: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
      <input required placeholder="Title *" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 md:col-span-2" />
      <input placeholder="Agency" value={f.agency} onChange={(e) => setF({ ...f, agency: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
      <input type="number" min="0" placeholder="Award value $" value={f.awardValue} onChange={(e) => setF({ ...f, awardValue: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
      <div className="grid grid-cols-2 gap-3">
        <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200" />
        <input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200" />
      </div>
      <div className="md:col-span-3 flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary text-sm disabled:opacity-60">{saving ? 'Creating…' : 'Create contract'}</button>
        <button type="button" onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
      </div>
    </form>
  )
}

export default ContractsPage
