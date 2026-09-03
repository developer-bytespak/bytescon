import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { contractMgmtApi, teamingApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { Spinner, ErrorBanner, EmptyState } from '../components/ui'
import { ArrowLeft, Plus, Check, X, Archive, Play } from 'lucide-react'
import { ContractFinanceTab } from '../components/ContractFinanceTab'
import { ContractHealthPanel } from '../components/contracts/ContractHealthPanels'

const money = (v?: string | null) => (v != null ? `$${Number(v).toLocaleString()}` : '—')
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')
import {
  ContractBudgetTab, ContractFinancialsTab, ContractPurchasingTab, ContractResourcesTab,
} from '../components/erp/ContractErpTabs'
import { useTabParam } from '../hooks/useTabParam'

const iso = (d: string) => (d ? new Date(d).toISOString() : undefined)

type Tab = 'overview' | 'health' | 'clins' | 'budget' | 'resources' | 'purchasing' | 'modifications' | 'options' | 'deliverables' | 'finance' | 'financials' | 'activity'
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'health', label: 'Health' }, { id: 'clins', label: 'CLINs' }, { id: 'modifications', label: 'Modifications' },
  { id: 'budget', label: 'Budget' }, { id: 'resources', label: 'Resources' }, { id: 'purchasing', label: 'Purchasing' },
  { id: 'options', label: 'Option Periods' }, { id: 'deliverables', label: 'Deliverables' }, { id: 'finance', label: 'Finance' },
  { id: 'financials', label: 'Financials' }, { id: 'activity', label: 'Activity' },
]

const badge = (text: string, tone = 'bg-gray-800 border-gray-700 text-gray-300') => <span className={`text-[10px] px-1.5 py-0.5 rounded border ${tone}`}>{text}</span>
const deliverableTone: Record<string, string> = {
  OVERDUE: 'bg-red-950/40 border-red-800 text-red-300', SUBMITTED: 'bg-blue-950/40 border-blue-800 text-blue-300',
  ACCEPTED: 'bg-green-950/40 border-green-800 text-green-300', REJECTED: 'bg-red-950/40 border-red-800 text-red-300',
  IN_PROGRESS: 'bg-yellow-950/40 border-yellow-800 text-yellow-300', NOT_STARTED: 'bg-gray-800 border-gray-700 text-gray-400',
}

export default function ContractDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const qc = useQueryClient()
  const { toast } = useToast()
  const [tab, setTab] = useTabParam(TABS.map((t) => t.id), 'overview')

  const { data, isLoading, error } = useQuery<{ data: any }>({ queryKey: ['contract', id], queryFn: () => contractMgmtApi.get(id!) })
  const refresh = () => qc.invalidateQueries({ queryKey: ['contract', id] })
  const mut = (fn: () => Promise<unknown>, ok: string) =>
    fn().then(() => { refresh(); toast(ok, 'success') }).catch((e: any) => toast(e?.response?.data?.error || 'Action failed', 'error'))

  if (isLoading) return <div className="flex justify-center mt-16"><Spinner size="lg" /></div>
  if (error) return <ErrorBanner message="Could not load this contract." />
  const c = data!.data

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <button onClick={() => navigate('/contracts')} className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-sm"><ArrowLeft className="w-4 h-4" /> Back to Contracts</button>

      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-xl font-bold text-gray-100">{c.title}</h1>
              {badge(c.status)}
            </div>
            <p className="text-sm text-gray-500 font-mono">{c.contractNumber} · {c.agency || 'No agency'}</p>
            {c.opportunityId && <Link to={`/opportunities/${c.opportunityId}`} className="text-xs text-blue-400 hover:text-blue-300">Linked opportunity ↗</Link>}
          </div>
          {isAdmin && !c.isArchived && (
            <button
              onClick={() => { if (window.confirm('Archive this contract? It will be hidden from the default list.')) mut(() => contractMgmtApi.archive(c.id).then(() => navigate('/contracts')), 'Contract archived') }}
              className="bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-700 text-xs px-3 py-1.5 rounded flex items-center gap-1.5"
            ><Archive className="w-3.5 h-3.5" /> Archive</button>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
          <KV label="Award value" value={money(c.awardValue)} />
          <KV label="Funded" value={money(c.fundedValue)} />
          <KV label="Ceiling" value={money(c.ceilingValue)} />
          <KV label="Period" value={`${fmtDate(c.startDate)} → ${fmtDate(c.endDate)}`} />
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-800">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${tab === t.id ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && <Overview c={c} isAdmin={isAdmin} onSave={(p) => mut(() => contractMgmtApi.update(c.id, p), 'Contract updated')} />}
      {tab === 'health' && <ContractHealthPanel contractId={c.id} />}
      {tab === 'clins' && <ClinsTab c={c} isAdmin={isAdmin} mut={mut} />}
      {tab === 'modifications' && <ModsTab c={c} isAdmin={isAdmin} mut={mut} />}
      {tab === 'options' && <OptionsTab c={c} isAdmin={isAdmin} mut={mut} />}
      {tab === 'deliverables' && <DeliverablesTab c={c} isAdmin={isAdmin} mut={mut} />}
      {tab === 'finance' && <ContractFinanceTab contractId={c.id} contractNumber={c.contractNumber} isAdmin={isAdmin} />}
      {tab === 'budget' && <ContractBudgetTab contractId={c.id} isAdmin={isAdmin} />}
      {tab === 'resources' && <ContractResourcesTab contractId={c.id} isAdmin={isAdmin} />}
      {tab === 'purchasing' && <ContractPurchasingTab contractId={c.id} isAdmin={isAdmin} />}
      {tab === 'financials' && <ContractFinancialsTab contractId={c.id} />}
      {tab === 'activity' && <ActivityTab activity={c.activity || []} />}
    </div>
  )
}

const KV = ({ label, value }: { label: string; value: string }) => (
  <div><p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p><p className="text-sm text-gray-200 mt-0.5">{value}</p></div>
)

function Overview({ c, isAdmin, onSave }: { c: any; isAdmin: boolean; onSave: (p: Record<string, unknown>) => void }) {
  const [editing, setEditing] = useState(false)
  const [f, setF] = useState({
    title: c.title ?? '', contractType: c.contractType ?? '', contractingOffice: c.contractingOffice ?? '',
    fundedValue: c.fundedValue != null ? String(c.fundedValue) : '', ceilingValue: c.ceilingValue != null ? String(c.ceilingValue) : '',
    status: c.status ?? 'DRAFT', customerContactName: c.customerContactName ?? '', customerContactEmail: c.customerContactEmail ?? '',
    customerContactPhone: c.customerContactPhone ?? '', description: c.description ?? '', notes: c.notes ?? '',
  })
  const cls = 'bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 w-full'
  if (!editing) {
    return (
      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500 uppercase">Contract details · #{c.contractNumber}</p>
          {isAdmin && <button onClick={() => setEditing(true)} className="btn-secondary text-xs">Edit contract</button>}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <KV label="Type" value={c.contractType || '—'} /><KV label="Contracting office" value={c.contractingOffice || '—'} /><KV label="Status" value={c.status} />
          <KV label="Funded" value={money(c.fundedValue)} /><KV label="Ceiling" value={money(c.ceilingValue)} />
          <KV label="Customer contact" value={c.customerContactName || '—'} />
        </div>
        {c.description && <div><p className="text-xs text-gray-500 uppercase mb-1">Scope</p><p className="text-sm text-gray-300 whitespace-pre-wrap">{c.description}</p></div>}
        {c.notes && <div><p className="text-xs text-gray-500 uppercase mb-1">Notes</p><p className="text-sm text-gray-300 whitespace-pre-wrap">{c.notes}</p></div>}
        {!isAdmin && <p className="text-xs text-gray-600">Read-only access. Ask a firm admin to make changes.</p>}
      </div>
    )
  }
  return (
    <div className="card space-y-3">
      <p className="text-xs text-gray-500 uppercase">Edit contract · #{c.contractNumber} <span className="text-gray-600">(number is immutable)</span></p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-xs text-gray-500">Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} className={`mt-1 ${cls}`} /></label>
        <label className="text-xs text-gray-500">Contract type<select value={f.contractType} onChange={(e) => setF({ ...f, contractType: e.target.value })} className={`mt-1 ${cls}`}><option value="">—</option>{['FFP', 'FPI', 'CPFF', 'CPIF', 'T_AND_M', 'IDIQ', 'BOA', 'OTHER'].map((t) => <option key={t} value={t}>{t.replace(/_/g, '&')}</option>)}</select></label>
        <label className="text-xs text-gray-500">Contracting office<input value={f.contractingOffice} onChange={(e) => setF({ ...f, contractingOffice: e.target.value })} className={`mt-1 ${cls}`} /></label>
        <label className="text-xs text-gray-500">Status<select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className={`mt-1 ${cls}`}>{['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'TERMINATED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <label className="text-xs text-gray-500">Funded value<input type="number" value={f.fundedValue} onChange={(e) => setF({ ...f, fundedValue: e.target.value })} className={`mt-1 ${cls}`} /></label>
        <label className="text-xs text-gray-500">Ceiling value<input type="number" value={f.ceilingValue} onChange={(e) => setF({ ...f, ceilingValue: e.target.value })} className={`mt-1 ${cls}`} /></label>
        <label className="text-xs text-gray-500">Customer contact name<input value={f.customerContactName} onChange={(e) => setF({ ...f, customerContactName: e.target.value })} className={`mt-1 ${cls}`} /></label>
        <label className="text-xs text-gray-500">Customer contact email<input value={f.customerContactEmail} onChange={(e) => setF({ ...f, customerContactEmail: e.target.value })} className={`mt-1 ${cls}`} /></label>
        <label className="text-xs text-gray-500">Customer contact phone<input value={f.customerContactPhone} onChange={(e) => setF({ ...f, customerContactPhone: e.target.value })} className={`mt-1 ${cls}`} /></label>
      </div>
      <label className="text-xs text-gray-500 block">Description<textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={2} className={`mt-1 ${cls}`} /></label>
      <label className="text-xs text-gray-500 block">Notes<textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={2} className={`mt-1 ${cls}`} /></label>
      <div className="flex gap-2">
        <button onClick={() => { onSave({ title: f.title, contractType: f.contractType || null, contractingOffice: f.contractingOffice || null, fundedValue: f.fundedValue ? Number(f.fundedValue) : null, ceilingValue: f.ceilingValue ? Number(f.ceilingValue) : null, status: f.status, customerContactName: f.customerContactName || null, customerContactEmail: f.customerContactEmail || null, customerContactPhone: f.customerContactPhone || null, description: f.description || null, notes: f.notes || null }); setEditing(false) }} className="btn-primary text-sm">Save changes</button>
        <button onClick={() => setEditing(false)} className="btn-secondary text-sm">Cancel</button>
      </div>
    </div>
  )
}

// Must match CLIN_TYPES in routes/contractManagement.ts — anything else is
// rejected at 422, which is what the old list silently did.
const CLIN_TYPES = ['FFP', 'T_AND_M', 'COST_REIMBURSEMENT', 'LABOR_HOUR', 'IDIQ', 'OTHER']
const CLIN_LEVELS = ['TASK_ORDER', 'CLIN', 'SUB_CLIN']
const OPTION_STATUSES = ['PLANNED', 'PENDING_DECISION', 'EXERCISED', 'NOT_EXERCISED', 'EXPIRED']
const LEVEL_LABEL: Record<string, string> = { TASK_ORDER: 'Task order', CLIN: 'CLIN', SUB_CLIN: 'Sub-CLIN' }
const LEVEL_INDENT: Record<string, string> = { TASK_ORDER: '', CLIN: 'pl-4', SUB_CLIN: 'pl-8' }

/**
 * One CLIN, editable in place.
 *
 * Archive rather than delete: a CLIN carries funding, costs, time and invoice
 * lines, and removing it would orphan the money already recorded against it.
 */
function ClinRow({ clin, isAdmin, mut }: { clin: any; isAdmin: boolean; mut: (fn: () => Promise<unknown>, ok: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false)
  const [f, setF] = useState({
    title: clin.title ?? '', clinType: clin.clinType ?? 'FFP',
    fundedAmount: clin.fundedAmount != null ? String(clin.fundedAmount) : '',
    ceilingAmount: clin.ceilingAmount != null ? String(clin.ceilingAmount) : '',
    status: clin.status ?? 'ACTIVE',
  })

  if (editing) {
    return (
      <tr className="border-b border-gray-900 bg-gray-900/40">
        <td className="py-2 font-mono text-xs text-gray-400">{clin.clinNumber}</td>
        <td className="text-gray-500 text-xs">{LEVEL_LABEL[clin.clinLevel] ?? 'CLIN'}</td>
        <td><input aria-label="CLIN title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} className={inp} /></td>
        <td><select aria-label="Edit CLIN type" value={f.clinType} onChange={(e) => setF({ ...f, clinType: e.target.value })} className={inp}>{CLIN_TYPES.map((t) => <option key={t}>{t}</option>)}</select></td>
        <td><input aria-label="Edit funded" type="number" min="0" value={f.fundedAmount} onChange={(e) => setF({ ...f, fundedAmount: e.target.value })} className={inp} /></td>
        <td><input aria-label="Edit ceiling" type="number" min="0" value={f.ceilingAmount} onChange={(e) => setF({ ...f, ceilingAmount: e.target.value })} className={inp} /></td>
        <td><select aria-label="Edit CLIN status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className={inp}>{['ACTIVE', 'COMPLETED', 'CANCELLED'].map((x) => <option key={x}>{x}</option>)}</select></td>
        <td className="text-right">
          <div className="flex gap-2 justify-end text-xs">
            <button onClick={() => mut(() => contractMgmtApi.updateClin(clin.id, {
              title: f.title || null, clinType: f.clinType,
              fundedAmount: f.fundedAmount ? Number(f.fundedAmount) : null,
              ceilingAmount: f.ceilingAmount ? Number(f.ceilingAmount) : null,
              status: f.status,
            }), 'CLIN updated').then(() => setEditing(false))} className="text-green-400 hover:text-green-300">Save</button>
            <button onClick={() => setEditing(false)} className="text-gray-500 hover:text-gray-300">Cancel</button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr className="border-b border-gray-900">
      <td className={`py-2 font-mono text-xs text-gray-200 ${LEVEL_INDENT[clin.clinLevel] ?? ''}`}>{clin.clinNumber}</td>
      <td className="text-gray-500 text-xs">{LEVEL_LABEL[clin.clinLevel] ?? 'CLIN'}</td>
      <td className="text-gray-300">{clin.title || '—'}</td>
      <td className="text-gray-400">{clin.clinType || '—'}</td>
      <td className="text-gray-400">{money(clin.fundedAmount)}</td>
      <td className="text-gray-400">{money(clin.ceilingAmount)}</td>
      <td>{badge(clin.status)}</td>
      <td className="text-right">{isAdmin && (
        <div className="flex gap-2 justify-end text-xs">
          <button onClick={() => setEditing(true)} className="text-blue-400 hover:text-blue-300">Edit</button>
          <button onClick={() => { if (window.confirm(`Archive CLIN ${clin.clinNumber}? Money already recorded against it is kept.`)) mut(() => contractMgmtApi.archiveClin(clin.id), 'CLIN archived') }}
            className="text-red-400 hover:text-red-300">Archive</button>
        </div>
      )}</td>
    </tr>
  )
}

function ClinsTab({ c, isAdmin, mut }: { c: any; isAdmin: boolean; mut: (fn: () => Promise<unknown>, ok: string) => Promise<unknown> }) {
  const [show, setShow] = useState(false)
  const [f, setF] = useState({ clinNumber: '', title: '', clinType: 'FFP', clinLevel: 'CLIN', parentClinId: '', quantity: '', unit: '', unitPrice: '', fundedAmount: '', ceilingAmount: '', startDate: '', endDate: '', status: 'ACTIVE' })
  const clins: any[] = c.clins || []
  const totalFunded = clins.reduce((s: number, x: any) => s + Number(x.fundedAmount || 0), 0)
  // Only a tier above can be a parent, so a sub-CLIN cannot be hung off another sub-CLIN.
  const parentChoices = clins.filter((x) =>
    f.clinLevel === 'CLIN' ? x.clinLevel === 'TASK_ORDER' : f.clinLevel === 'SUB_CLIN' ? x.clinLevel === 'CLIN' : false)
  return (
    <div className="card">
      <SectionHeader title="CLINs" isAdmin={isAdmin} show={show} setShow={setShow} addLabel="Add CLIN" />
      {isAdmin && show && (
        <InlineForm onCancel={() => setShow(false)} onSubmit={() => mut(() => contractMgmtApi.createClin(c.id, { clinNumber: f.clinNumber, title: f.title || undefined, clinType: f.clinType, clinLevel: f.clinLevel, parentClinId: f.parentClinId || undefined, quantity: f.quantity ? Number(f.quantity) : undefined, unit: f.unit || undefined, unitPrice: f.unitPrice ? Number(f.unitPrice) : undefined, fundedAmount: f.fundedAmount ? Number(f.fundedAmount) : undefined, ceilingAmount: f.ceilingAmount ? Number(f.ceilingAmount) : undefined, startDate: iso(f.startDate), endDate: iso(f.endDate), status: f.status }), 'CLIN added').then(() => setShow(false))}>
          <input required placeholder="CLIN # *" value={f.clinNumber} onChange={(e) => setF({ ...f, clinNumber: e.target.value })} className={inp} />
          <input placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} className={inp} />
          <select aria-label="CLIN type" value={f.clinType} onChange={(e) => setF({ ...f, clinType: e.target.value })} className={inp}>{CLIN_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          <select aria-label="Tier" value={f.clinLevel} onChange={(e) => setF({ ...f, clinLevel: e.target.value, parentClinId: '' })} className={inp}>{CLIN_LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}</select>
          <select aria-label="Sits under" value={f.parentClinId} disabled={parentChoices.length === 0} onChange={(e) => setF({ ...f, parentClinId: e.target.value })} className={inp}>
            <option value="">{f.clinLevel === 'TASK_ORDER' ? 'Top level' : parentChoices.length === 0 ? 'No parent available yet' : 'Sits under… (optional)'}</option>
            {parentChoices.map((p) => <option key={p.id} value={p.id}>{p.clinNumber}{p.title ? ` — ${p.title}` : ''}</option>)}
          </select>
          <input type="number" min="0" placeholder="Quantity" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} className={inp} />
          <input placeholder="Unit" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} className={inp} />
          <input type="number" min="0" placeholder="Unit price $" value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} className={inp} />
          <input type="number" min="0" placeholder="Funded $" value={f.fundedAmount} onChange={(e) => setF({ ...f, fundedAmount: e.target.value })} className={inp} />
          <input type="number" min="0" placeholder="Ceiling $" value={f.ceilingAmount} onChange={(e) => setF({ ...f, ceilingAmount: e.target.value })} className={inp} />
          <input type="date" title="Start" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} className={inp} />
          <input type="date" title="End" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} className={inp} />
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className={inp}>{['ACTIVE', 'COMPLETED', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}</select>
        </InlineForm>
      )}
      {(c.clins || []).length === 0 ? <EmptyState message="No CLINs yet." /> : (
        <table className="w-full text-sm"><thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2">CLIN</th><th>Tier</th><th>Title</th><th>Type</th><th>Funded</th><th>Ceiling</th><th>Status</th><th></th></tr></thead>
          <tbody>{clins.map((x: any) => <ClinRow key={x.id} clin={x} isAdmin={isAdmin} mut={mut} />)}
            <tr className="text-gray-300"><td className="py-2 font-semibold" colSpan={4}>Total funded</td><td className="font-semibold">{money(String(totalFunded))}</td><td colSpan={3}></td></tr>
          </tbody></table>
      )}
    </div>
  )
}

function ModsTab({ c, isAdmin, mut }: { c: any; isAdmin: boolean; mut: (fn: () => Promise<unknown>, ok: string) => Promise<unknown> }) {
  const [show, setShow] = useState(false)
  const [f, setF] = useState({ modNumber: '', modType: 'FUNDING', effectiveDate: '', fundingChange: '', ceilingChange: '', endDateChange: '', description: '' })
  return (
    <div className="card">
      <SectionHeader title="Modifications" isAdmin={isAdmin} show={show} setShow={setShow} addLabel="Record modification" />
      {isAdmin && show && (
        <InlineForm onCancel={() => setShow(false)} onSubmit={() => mut(() => contractMgmtApi.createModification(c.id, { modNumber: f.modNumber, modType: f.modType || undefined, effectiveDate: iso(f.effectiveDate), fundingChange: f.fundingChange ? Number(f.fundingChange) : undefined, ceilingChange: f.ceilingChange ? Number(f.ceilingChange) : undefined, endDateChange: iso(f.endDateChange), description: f.description || undefined }), 'Modification recorded').then(() => setShow(false))}>
          <input required placeholder="Mod # *" value={f.modNumber} onChange={(e) => setF({ ...f, modNumber: e.target.value })} className={inp} />
          <select value={f.modType} onChange={(e) => setF({ ...f, modType: e.target.value })} className={inp}>{['FUNDING', 'SCOPE', 'PERIOD', 'PRICING', 'ADMIN', 'OTHER'].map((t) => <option key={t}>{t}</option>)}</select>
          <input type="date" title="Effective date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} className={inp} />
          <input type="number" placeholder="Funding change ±$" value={f.fundingChange} onChange={(e) => setF({ ...f, fundingChange: e.target.value })} className={inp} />
          <input type="number" placeholder="Ceiling change ±$" value={f.ceilingChange} onChange={(e) => setF({ ...f, ceilingChange: e.target.value })} className={inp} />
          <input placeholder="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={inp} />
        </InlineForm>
      )}
      {(c.modifications || []).length === 0 ? <EmptyState message="No modifications recorded." /> : (
        <table className="w-full text-sm"><thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2">Mod</th><th>Type</th><th>Funding Δ</th><th>Ceiling Δ</th><th>Status</th><th></th></tr></thead>
          <tbody>{c.modifications.map((m: any) => (<tr key={m.id} className="border-b border-gray-900"><td className="py-2 font-mono text-xs text-gray-200">{m.modNumber}</td><td className="text-gray-400">{m.modType || '—'}</td><td className="text-gray-400">{m.fundingChange != null ? money(m.fundingChange) : '—'}</td><td className="text-gray-400">{m.ceilingChange != null ? money(m.ceilingChange) : '—'}</td><td>{badge(m.status, m.status === 'APPLIED' ? 'bg-green-950/40 border-green-800 text-green-300' : m.status === 'VOIDED' ? 'bg-red-950/40 border-red-800 text-red-300' : 'bg-gray-800 border-gray-700 text-gray-300')}</td>
            <td className="text-right">{isAdmin && m.status !== 'APPLIED' && m.status !== 'VOIDED' && (
              <div className="flex gap-1 justify-end">
                <button onClick={() => mut(() => contractMgmtApi.applyModification(m.id), 'Modification applied')} className="text-green-400 hover:text-green-300 text-xs flex items-center gap-1"><Play className="w-3 h-3" />Apply</button>
                <button onClick={() => mut(() => contractMgmtApi.voidModification(m.id), 'Modification voided')} className="text-gray-500 hover:text-red-400 text-xs ml-2">Void</button>
              </div>
            )}</td></tr>))}</tbody></table>
      )}
    </div>
  )
}

/** An option period's decision changes as the year progresses, so it is editable. */
function OptionRow({ option, isAdmin, mut }: { option: any; isAdmin: boolean; mut: (fn: () => Promise<unknown>, ok: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false)
  const [f, setF] = useState({
    label: option.label ?? '',
    optionValue: option.optionValue != null ? String(option.optionValue) : '',
    exerciseStatus: option.exerciseStatus ?? 'PLANNED',
  })

  if (editing) {
    return (
      <tr className="border-b border-gray-900 bg-gray-900/40">
        <td className="py-2"><input aria-label="Option label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} className={inp} /></td>
        <td><input aria-label="Option value" type="number" min="0" value={f.optionValue} onChange={(e) => setF({ ...f, optionValue: e.target.value })} className={inp} /></td>
        <td className="text-gray-500 text-xs">{fmtDate(option.exerciseDeadline)}</td>
        <td><select aria-label="Exercise status" value={f.exerciseStatus} onChange={(e) => setF({ ...f, exerciseStatus: e.target.value })} className={inp}>{OPTION_STATUSES.map((x) => <option key={x}>{x}</option>)}</select></td>
        <td className="text-right">
          <div className="flex gap-2 justify-end text-xs">
            <button onClick={() => mut(() => contractMgmtApi.updateOption(option.id, {
              label: f.label,
              optionValue: f.optionValue ? Number(f.optionValue) : null,
              exerciseStatus: f.exerciseStatus,
            }), 'Option period updated').then(() => setEditing(false))} className="text-green-400 hover:text-green-300">Save</button>
            <button onClick={() => setEditing(false)} className="text-gray-500 hover:text-gray-300">Cancel</button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr className="border-b border-gray-900">
      <td className="py-2 text-gray-200">{option.label}</td>
      <td className="text-gray-400">{money(option.optionValue)}</td>
      <td className="text-gray-400">{fmtDate(option.exerciseDeadline)}</td>
      <td>{badge(option.exerciseStatus)}</td>
      <td className="text-right">{isAdmin && (
        <button onClick={() => setEditing(true)} className="text-blue-400 hover:text-blue-300 text-xs">Edit</button>
      )}</td>
    </tr>
  )
}

function OptionsTab({ c, isAdmin, mut }: { c: any; isAdmin: boolean; mut: (fn: () => Promise<unknown>, ok: string) => Promise<unknown> }) {
  const [show, setShow] = useState(false)
  const [f, setF] = useState({ label: '', startDate: '', endDate: '', optionValue: '', exerciseStatus: 'PLANNED', decisionDate: '', exerciseDeadline: '' })
  const dateErr = f.startDate && f.endDate && new Date(f.endDate) <= new Date(f.startDate)
  return (
    <div className="card">
      <SectionHeader title="Option Periods" isAdmin={isAdmin} show={show} setShow={setShow} addLabel="Add option period" />
      {isAdmin && show && (
        <InlineForm onCancel={() => setShow(false)} disabled={!!dateErr} onSubmit={() => mut(() => contractMgmtApi.createOption(c.id, { label: f.label, startDate: iso(f.startDate), endDate: iso(f.endDate), optionValue: f.optionValue ? Number(f.optionValue) : undefined, exerciseStatus: f.exerciseStatus, decisionDate: iso(f.decisionDate), exerciseDeadline: iso(f.exerciseDeadline) }), 'Option period added').then(() => setShow(false))}>
          <input required placeholder="Label (e.g. OY1) *" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} className={inp} />
          <input type="date" title="Start" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} className={inp} />
          <input type="date" title="End" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} className={inp} />
          <input type="number" min="0" placeholder="Option value $" value={f.optionValue} onChange={(e) => setF({ ...f, optionValue: e.target.value })} className={inp} />
          <select value={f.exerciseStatus} onChange={(e) => setF({ ...f, exerciseStatus: e.target.value })} className={inp}>{OPTION_STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
          <input type="date" title="Decision date" value={f.decisionDate} onChange={(e) => setF({ ...f, decisionDate: e.target.value })} className={inp} />
          <input type="date" title="Exercise deadline" value={f.exerciseDeadline} onChange={(e) => setF({ ...f, exerciseDeadline: e.target.value })} className={inp} />
          {dateErr && <p className="text-[11px] text-red-400 col-span-full">End date must be after start date.</p>}
        </InlineForm>
      )}
      {(c.optionPeriods || []).length === 0 ? <EmptyState message="No option periods." /> : (
        <table className="w-full text-sm"><thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2">Label</th><th>Value</th><th>Decision deadline</th><th>Status</th><th></th></tr></thead>
          <tbody>{c.optionPeriods.map((o: any) => <OptionRow key={o.id} option={o} isAdmin={isAdmin} mut={mut} />)}</tbody></table>
      )}
    </div>
  )
}

/**
 * Attribution picker. `ContractDeliverable.partnerId` is the ONLY link that
 * puts a deliverable in a subcontractor's portal and the only thing partner
 * performance counts, so it is set here by a person and never inferred from a
 * subcontract existing.
 */
function PartnerAttribution({ deliverable, mut }: { deliverable: any; mut: (fn: () => Promise<unknown>, ok: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false)
  const { data } = useQuery({
    queryKey: ['teaming-partners-for-attribution'],
    queryFn: () => teamingApi.listPartners({ activeOnly: true }),
    enabled: editing,
  })
  const partners: Array<{ id: string; name: string }> = data?.data ?? []

  const assign = (partnerId: string | null) =>
    mut(() => contractMgmtApi.updateDeliverable(deliverable.id, { partnerId }),
      partnerId ? 'Attributed to partner' : 'Partner attribution cleared').then(() => setEditing(false))

  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} className="text-xs text-gray-400 hover:text-gray-200 underline decoration-dotted">
        {deliverable.partner?.name ?? 'Assign partner'}
      </button>
    )
  }
  return (
    <select value={deliverable.partnerId ?? ''} onBlur={() => setEditing(false)}
      onChange={(e) => assign(e.target.value || null)}
      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 outline-none focus:border-blue-500">
      <option value="">— none (prime's own work) —</option>
      {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  )
}

function DeliverablesTab({ c, isAdmin, mut }: { c: any; isAdmin: boolean; mut: (fn: () => Promise<unknown>, ok: string) => Promise<unknown> }) {
  const [show, setShow] = useState(false)
  const [f, setF] = useState({ name: '', cdrlNumber: '', dueDate: '' })
  return (
    <div className="card">
      <SectionHeader title="Deliverables (CDRLs)" isAdmin={isAdmin} show={show} setShow={setShow} addLabel="Add deliverable" />
      {isAdmin && show && (
        <InlineForm onCancel={() => setShow(false)} onSubmit={() => mut(() => contractMgmtApi.createDeliverable(c.id, { name: f.name, cdrlNumber: f.cdrlNumber || undefined, dueDate: iso(f.dueDate) }), 'Deliverable added').then(() => setShow(false))}>
          <input required placeholder="Name *" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inp} />
          <input placeholder="CDRL #" value={f.cdrlNumber} onChange={(e) => setF({ ...f, cdrlNumber: e.target.value })} className={inp} />
          <input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} className={inp} />
        </InlineForm>
      )}
      {(c.deliverables || []).length === 0 ? <EmptyState message="No deliverables tracked." /> : (
        <table className="w-full text-sm"><thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2">Name</th><th>CDRL</th><th>Due</th><th>Status</th><th>Partner</th><th></th></tr></thead>
          <tbody>{c.deliverables.map((d: any) => (<tr key={d.id} className="border-b border-gray-900"><td className="py-2 text-gray-200">{d.name}</td><td className="text-gray-400 font-mono text-xs">{d.cdrlNumber || '—'}</td><td className="text-gray-400">{fmtDate(d.dueDate)}</td><td>{badge(d.derivedStatus, deliverableTone[d.derivedStatus] || 'bg-gray-800 border-gray-700 text-gray-300')}</td>
            <td>{isAdmin ? <PartnerAttribution deliverable={d} mut={mut} /> : <span className="text-xs text-gray-500">{d.partner?.name ?? '—'}</span>}</td>
            <td className="text-right">{isAdmin && (
              <div className="flex gap-2 justify-end">
                {['NOT_STARTED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'REJECTED', 'OVERDUE'].includes(d.derivedStatus) && <button onClick={() => mut(() => contractMgmtApi.submitDeliverable(d.id), 'Submitted')} className="text-blue-400 hover:text-blue-300 text-xs">Submit</button>}
                {d.status === 'SUBMITTED' && <><button onClick={() => mut(() => contractMgmtApi.acceptDeliverable(d.id), 'Accepted')} className="text-green-400 hover:text-green-300 text-xs flex items-center gap-0.5"><Check className="w-3 h-3" />Accept</button>
                  <button onClick={() => { const r = window.prompt('Rejection reason:'); if (r) mut(() => contractMgmtApi.rejectDeliverable(d.id, r), 'Rejected') }} className="text-red-400 hover:text-red-300 text-xs flex items-center gap-0.5"><X className="w-3 h-3" />Reject</button></>}
                <button onClick={() => { if (window.confirm(`Archive "${d.name}"? It stays on the record and leaves the active list.`)) mut(() => contractMgmtApi.archiveDeliverable(d.id), 'Deliverable archived') }} className="text-gray-500 hover:text-gray-300 text-xs flex items-center gap-0.5"><Archive className="w-3 h-3" />Archive</button>
              </div>
            )}</td></tr>))}</tbody></table>
      )}
    </div>
  )
}

function ActivityTab({ activity }: { activity: any[] }) {
  if (activity.length === 0) return <div className="card"><EmptyState message="No activity yet." /></div>
  return (
    <div className="card">
      <ul className="space-y-2">
        {activity.map((a, i) => (
          <li key={i} className="flex items-center justify-between text-sm border-b border-gray-900 pb-2">
            <span className="text-gray-300">{a.action} · <span className="text-gray-500">{a.entityType}</span>{a.rationale && <span className="text-gray-500"> — {a.rationale}</span>}</span>
            <span className="text-xs text-gray-600">{new Date(a.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const inp = 'bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500'
function SectionHeader({ title, isAdmin, show, setShow, addLabel }: { title: string; isAdmin: boolean; show: boolean; setShow: (v: boolean) => void; addLabel: string }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="font-semibold text-gray-200">{title}</h2>
      {isAdmin && <button onClick={() => setShow(!show)} className="btn-primary text-xs flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" /> {addLabel}</button>}
    </div>
  )
}
function InlineForm({ children, onSubmit, onCancel, disabled }: { children: React.ReactNode; onSubmit: () => void; onCancel: () => void; disabled?: boolean }) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!disabled) onSubmit() }} className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4 bg-gray-900/50 border border-gray-800 rounded-lg p-3">
      {children}
      <div className="md:col-span-3 flex gap-2"><button type="submit" disabled={disabled} className="btn-primary text-sm disabled:opacity-50">Save</button><button type="button" onClick={onCancel} className="btn-secondary text-sm">Cancel</button></div>
    </form>
  )
}
