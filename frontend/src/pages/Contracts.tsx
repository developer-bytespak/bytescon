import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { contractMgmtApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { PageHeader, Spinner, EmptyState, ErrorBanner, StatusPill } from '../components/ui'
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
// Display tone only; the label shown is always the raw status.
const pillStatus = (s: string) => (s === 'TERMINATED' ? 'CANCELLED' : s)

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
      <div className="stagger grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <DeliverablePanel title="Overdue deliverables" icon={AlertTriangle} tone="red" query={overdue} emptyMsg="No overdue deliverables." />
        <DeliverablePanel title="Due within 14 days" icon={CalendarClock} tone="yellow" query={upcoming} emptyMsg="Nothing due in the next 14 days." />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-0 sm:min-w-[220px] basis-full sm:basis-auto">
          <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number, title, agency" className="input w-full !pl-9" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="input !w-auto">
          <option value="">All statuses</option>
          {['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'TERMINATED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {isAdmin && showCreate && <CreateContractForm onSubmit={(p) => create.mutate(p)} saving={create.isPending} onCancel={() => setShowCreate(false)} />}

      {contracts.isLoading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : contracts.error ? (
        <ErrorBanner message="Could not load contracts. Please retry." />
      ) : contracts.data!.data.length === 0 ? (
        <EmptyState message="No contracts yet. Create one, or link an awarded opportunity." />
      ) : (
        <div className="table-wrap max-h animate-fade-in">
          <table className="data-table">
            <thead><tr><th>Number</th><th>Title</th><th>Agency</th><th className="!text-right">Award</th><th className="!text-right">Funded</th><th>End date</th><th>Status</th></tr></thead>
            <tbody>
              {contracts.data!.data.map((c) => (
                <tr key={c.id}>
                  <td className="font-mono text-xs whitespace-nowrap"><Link to={`/contracts/${c.id}`} className="text-blue-400 hover:text-blue-300">{c.contractNumber}</Link></td>
                  <td className="text-gray-200 font-medium min-w-[12rem]">{c.title}</td>
                  <td className="text-gray-400">{c.agency || '—'}</td>
                  <td className="text-right tabular-nums text-gray-300 whitespace-nowrap">{money(c.awardValue)}</td>
                  <td className="text-right tabular-nums text-gray-400 whitespace-nowrap">{money(c.fundedValue)}</td>
                  <td className="text-gray-400 tabular-nums whitespace-nowrap">{fmtDate(c.endDate)}</td>
                  <td><StatusPill status={pillStatus(c.status)}>{c.status}</StatusPill></td>
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
  const toneCls = tone === 'red' ? 'tile-danger' : 'tile-gold'
  return (
    <div className="card">
      <div className="flex items-center gap-2.5 mb-4"><span className={`tile tile-sm ${toneCls}`}><Icon className="w-4 h-4" /></span><h2 className="font-semibold text-gray-200 text-sm">{title}</h2></div>
      {query.isLoading ? <Spinner size="sm" /> : query.error ? <p className="text-xs text-red-400">Failed to load.</p> : query.data!.data.length === 0 ? (
        <p className="text-sm text-gray-500 py-2">{emptyMsg}</p>
      ) : (
        <ul className="divide-y divide-gray-800">
          {query.data!.data.slice(0, 6).map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 text-sm py-2 first:pt-0 last:pb-0">
              <Link to={`/contracts/${d.contract?.id}`} className="text-gray-300 hover:text-blue-300 truncate min-w-0">{d.name}</Link>
              <span className="text-xs text-gray-500 tabular-nums flex-shrink-0 ml-2">{fmtDate(d.dueDate)}</span>
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
      className="card mb-6 grid grid-cols-1 md:grid-cols-3 gap-3 animate-fade-up"
    >
      <input required placeholder="Contract number *" value={f.contractNumber} onChange={(e) => setF({ ...f, contractNumber: e.target.value })} className="input" />
      <input required placeholder="Title *" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} className="input md:col-span-2" />
      <input placeholder="Agency" value={f.agency} onChange={(e) => setF({ ...f, agency: e.target.value })} className="input" />
      <input type="number" min="0" placeholder="Award value $" value={f.awardValue} onChange={(e) => setF({ ...f, awardValue: e.target.value })} className="input" />
      <div className="grid grid-cols-2 gap-3">
        <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} className="input" />
        <input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} className="input" />
      </div>
      <div className="md:col-span-3 flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary btn-sm disabled:opacity-60">{saving ? 'Creating…' : 'Create contract'}</button>
        <button type="button" onClick={onCancel} className="btn-secondary btn-sm">Cancel</button>
      </div>
    </form>
  )
}

export default ContractsPage
