// =============================================================
// §8.2 — ERP panels on the contract workspace: Budget, Resources,
// Purchasing and Financials.
//
// Every figure is rendered exactly as the server sent it. No money arithmetic
// happens in this file — budget, actual, committed, remaining, backlog and
// capacity each have one owner on the backend, and duplicating any of them here
// is how two screens start disagreeing about the same contract.
//
// Timekeeping and Receivables keep their own pages; nothing here duplicates them.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, EmptyPanel, ErrorPanel, LoadingPanel } from '../section6/Section6Ui'
import { useToast } from '../Toast'
import { firmApi } from '../../services/api'
import {
  erpApi, BUDGET_CATEGORIES,
  type BudgetCategory, type BudgetLineComparison, type BudgetVsActual, type CapacitySnapshot,
  type ContractBudget, type FinancialSummary, type FlowDownState,
  type PurchaseOrder, type SubcontractInvoiceStatus,
} from '../../services/erpApi'
import { ExportButton } from '../ExportButton'
import { isoDate, num, type Column } from '../../utils/exportTable'

// A budget line and a purchase order both read as one row per line in a sheet.
// The percentages stay as the server computed them — a spreadsheet recomputing
// a variance from rounded columns is exactly the disagreement this file's
// header warns about.
const BUDGET_LINE_COLUMNS: ReadonlyArray<Column<BudgetLineComparison>> = [
  { header: 'Category', value: (r) => r.category },
  { header: 'CLIN', value: (r) => r.clinNumber },
  { header: 'Budget (USD)', value: (r) => num(r.budget) },
  { header: 'Actual (USD)', value: (r) => num(r.actual) },
  { header: 'Committed (USD)', value: (r) => num(r.committed) },
  { header: 'Remaining (USD)', value: (r) => num(r.remaining) },
  { header: 'Variance (USD)', value: (r) => num(r.variance) },
  { header: 'Variance %', value: (r) => (r.variancePercent === null ? '' : r.variancePercent) },
  { header: 'Over budget', value: (r) => (r.overBudget ? 'YES' : 'NO') },
]

/**
 * One row per PO LINE, with the order's own figures repeated alongside.
 *
 * A row per order looked complete and was not: an order's money is spread over
 * its lines, by category and by CLIN, and that breakdown is the reason anyone
 * opens the file. Order-level figures are prefixed "PO " so the column a reader
 * sums is `Line amount`, not a ceiling repeated once per line.
 */
interface PoLineRow {
  po: PurchaseOrder
  line: PurchaseOrder['lines'][number] | null
}

const PO_COLUMNS: ReadonlyArray<Column<PoLineRow>> = [
  { header: 'PO number', value: (r) => r.po.poNumber },
  { header: 'Vendor', value: (r) => r.po.vendorName },
  { header: 'Status', value: (r) => r.po.status },
  { header: 'Subcontract', value: (r) => (r.po.isSubcontract ? 'YES' : 'NO') },
  { header: 'Line description', value: (r) => r.line?.description },
  { header: 'Line category', value: (r) => r.line?.category },
  { header: 'Line CLIN', value: (r) => r.line?.clin?.clinNumber },
  { header: 'Quantity', value: (r) => num(r.line?.quantity) },
  { header: 'Unit', value: (r) => r.line?.unit },
  { header: 'Unit price (USD)', value: (r) => num(r.line?.unitPrice) },
  { header: 'Line amount (USD)', value: (r) => num(r.line?.amount) },
  { header: 'PO ceiling (USD)', value: (r) => num(r.po.ceilingAmount) },
  { header: 'PO invoiced (USD)', value: (r) => num(r.po.balance?.invoicedTotal) },
  { header: 'PO posted to cost (USD)', value: (r) => num(r.po.balance?.postedTotal) },
  { header: 'PO remaining (USD)', value: (r) => num(r.po.balance?.remaining) },
  { header: 'PO over invoiced', value: (r) => (r.po.balance?.overInvoiced ? 'YES' : 'NO') },
  { header: 'PO vendor invoices', value: (r) => r.po._count?.invoices },
  { header: 'PO flow-downs', value: (r) => r.po._count?.flowDowns },
  { header: 'PO description', value: (r) => r.po.description },
]

/** An order with no lines still gets a row, or the file would report fewer orders than the screen. */
function poLineRows(orders: readonly PurchaseOrder[]): PoLineRow[] {
  return orders.flatMap((po): PoLineRow[] =>
    po.lines.length === 0 ? [{ po, line: null }] : po.lines.map((line) => ({ po, line })),
  )
}

/** One row per person per allocation: a person on three contracts is three rows. */
interface AllocationRow {
  name: string
  allocatedPercent: number
  remainingPercent: number
  conflict: boolean
  contractNumber: string | null
  laborCategory: string | null
  allocationPercent: number
  startDate: string
  endDate: string | null
  status: string
}

const ALLOCATION_COLUMNS: ReadonlyArray<Column<AllocationRow>> = [
  { header: 'Person', value: (r) => r.name },
  { header: 'Total allocated %', value: (r) => r.allocatedPercent },
  { header: 'Remaining %', value: (r) => r.remainingPercent },
  { header: 'Over-allocated', value: (r) => (r.conflict ? 'YES' : 'NO') },
  { header: 'Contract', value: (r) => r.contractNumber },
  { header: 'Labour category', value: (r) => r.laborCategory },
  { header: 'Allocation %', value: (r) => r.allocationPercent },
  { header: 'Start', value: (r) => isoDate(r.startDate) },
  { header: 'End', value: (r) => isoDate(r.endDate) },
  { header: 'Status', value: (r) => r.status },
]

function allocationRows(cap: CapacitySnapshot | null): AllocationRow[] {
  if (!cap) return []
  return cap.people.flatMap((p) =>
    p.allocations.map((a) => ({
      name: p.name,
      allocatedPercent: p.allocatedPercent,
      remainingPercent: p.remainingPercent,
      conflict: p.conflict,
      contractNumber: a.contractNumber,
      laborCategory: a.laborCategory,
      allocationPercent: a.allocationPercent,
      startDate: a.startDate,
      endDate: a.endDate,
      status: a.status,
    })),
  )
}

const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

/** Money arrives as an exact decimal string; only grouping is applied. */
const usd = (v: string | null) =>
  v === null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const Metric = ({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) => (
  <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
    <p className="text-[10px] text-gray-500 uppercase tracking-widest">{label}</p>
    <p className={`text-lg font-mono mt-0.5 ${tone ?? 'text-gray-100'}`}>{value}</p>
    {hint && <p className="text-[10px] text-gray-600 mt-0.5">{hint}</p>}
  </div>
)

// -------------------------------------------------------------
// Budget
// -------------------------------------------------------------

export function ContractBudgetTab({ contractId, isAdmin }: { contractId: string; isAdmin: boolean }) {
  const { toast } = useToast()
  const [bva, setBva] = useState<BudgetVsActual | null>(null)
  const [budgets, setBudgets] = useState<ContractBudget[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Array<{ category: BudgetCategory; plannedAmount: string }>>([
    { category: 'LABOR', plannedAmount: '' },
  ])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [a, b] = await Promise.all([erpApi.budgetVsActual(contractId), erpApi.listBudgets(contractId)])
      setBva(a); setBudgets(b)
    } catch (err) { setError(readError(err, 'Could not load the budget.')) }
    finally { setLoading(false) }
  }, [contractId])
  useEffect(() => { void load() }, [load])

  const createDraft = async () => {
    const lines = draft.filter((l) => l.plannedAmount.trim() !== '')
    if (lines.length === 0) return
    setSaving(true)
    try {
      await erpApi.createBudget({ contractId, lines: lines.map((l) => ({ category: l.category, plannedAmount: l.plannedAmount })) })
      setDraft([{ category: 'LABOR', plannedAmount: '' }])
      toast('Draft budget created. It does not take effect until you activate it.', 'success')
      await load()
    } catch (err) { toast(readError(err, 'Could not create the budget.'), 'error') }
    finally { setSaving(false) }
  }

  const activate = async (id: string) => {
    try {
      await erpApi.activateBudget(id)
      toast('Budget activated. The previous version is kept as superseded.', 'success')
      await load()
    } catch (err) { toast(readError(err, 'Could not activate the budget.'), 'error') }
  }

  if (loading) return <LoadingPanel label="Loading budget…" />
  if (error || !bva) return <ErrorPanel message={error ?? 'No budget data.'} onRetry={load} />

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Budget" value={usd(bva.totals.budget)} hint={bva.hasBudget ? `v${bva.budgetVersion} active` : 'No active budget'} />
        <Metric label="Actual" value={usd(bva.totals.actual)} hint="Approved time + approved cost" />
        <Metric label="Committed" value={usd(bva.totals.committed)} hint="Approved purchase orders" />
        <Metric
          label="Remaining"
          value={usd(bva.totals.remaining)}
          tone={bva.totals.overBudget ? 'text-red-400' : 'text-green-400'}
          hint="Budget − actual − committed"
        />
      </div>

      {bva.threshold && (
        <div className="border border-yellow-800 bg-yellow-950/20 rounded-lg p-3">
          <p className="text-[12px] text-yellow-300">
            {bva.threshold.label} — {bva.threshold.consumedPct}% of budget consumed once commitments are counted.
          </p>
        </div>
      )}

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-gray-500 flex-1 min-w-[16rem]">{bva.dataNote}</p>
        <div className="flex items-center gap-2">
          <ExportButton rows={bva.byCategory} columns={BUDGET_LINE_COLUMNS} filename="budget-by-category" what="the budget by category" label="By category" />
          <ExportButton rows={bva.byClin} columns={BUDGET_LINE_COLUMNS} filename="budget-by-clin" what="the budget by CLIN" label="By CLIN" />
        </div>
      </div>

      {bva.byCategory.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-gray-500 border-b border-gray-800">
                <th className="p-3">Category</th><th className="p-3">Budget</th><th className="p-3">Actual</th>
                <th className="p-3">Committed</th><th className="p-3">Remaining</th><th className="p-3">Variance</th>
              </tr>
            </thead>
            <tbody>
              {bva.byCategory.map((r) => (
                <tr key={r.category} className="border-b border-gray-800/60">
                  <td className="p-3 text-gray-200">{r.category}</td>
                  <td className="p-3 font-mono text-gray-300">{usd(r.budget)}</td>
                  <td className="p-3 font-mono text-gray-300">{usd(r.actual)}</td>
                  <td className="p-3 font-mono text-gray-300">{usd(r.committed)}</td>
                  <td className={`p-3 font-mono ${r.overBudget ? 'text-red-400' : 'text-gray-300'}`}>{usd(r.remaining)}</td>
                  <td className="p-3 font-mono text-gray-400">{r.variancePercent === null ? '—' : `${r.variancePercent}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h4 className="text-sm font-semibold text-gray-300 mb-2">Budget versions</h4>
        {budgets.length === 0 ? (
          <p className="text-[12px] text-gray-500">No budget has been created for this contract yet.</p>
        ) : (
          <div className="space-y-1.5">
            {budgets.map((b) => (
              <div key={b.id} className="flex items-center gap-2 flex-wrap text-[12px]">
                <span className="font-mono text-gray-400">v{b.versionNumber}</span>
                <Badge tone={b.status === 'ACTIVE' ? 'success' : b.status === 'DRAFT' ? 'info' : 'neutral'}>{b.status}</Badge>
                <span className="text-gray-500">{b.lines.length} line(s)</span>
                {isAdmin && b.status === 'DRAFT' && (
                  <button onClick={() => activate(b.id)}
                    className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">
                    Activate
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] text-gray-600 mt-2">
          An approved budget is never edited in place. A revision supersedes it, and both stay on the record.
        </p>
      </div>

      {isAdmin && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h4 className="text-sm font-semibold text-gray-300 mb-2">New draft budget</h4>
          <div className="space-y-2">
            {draft.map((l, i) => (
              <div key={i} className="flex gap-2 flex-wrap">
                <select aria-label="Budget category" className="input" value={l.category}
                  onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, category: e.target.value as BudgetCategory } : x)))}>
                  {BUDGET_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <input aria-label="Planned amount" className="input flex-1 min-w-[140px]" placeholder="Planned amount"
                  value={l.plannedAmount}
                  onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, plannedAmount: e.target.value } : x)))} />
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-2">
            <button onClick={() => setDraft([...draft, { category: 'ODC', plannedAmount: '' }])}
              className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">Add line</button>
            <button onClick={createDraft} disabled={saving}
              className="text-xs px-4 py-1.5 rounded text-gray-950 font-medium disabled:opacity-50"
              style={{ background: 'linear-gradient(90deg,#7b8fff,#5b74ff)' }}>
              {saving ? 'Creating…' : 'Create draft'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// -------------------------------------------------------------
// Resources
// -------------------------------------------------------------

export function ContractResourcesTab({ contractId, isAdmin = false }: { contractId: string; isAdmin?: boolean }) {
  const { toast } = useToast()
  const [cap, setCap] = useState<CapacitySnapshot | null>(null)
  const [allocations, setAllocations] = useState<Array<Record<string, unknown>>>([])
  const [people, setPeople] = useState<Array<{ id: string; firstName?: string; lastName?: string; email: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [show, setShow] = useState(false)
  const [f, setF] = useState({ userId: '', laborCategory: '', allocationPercent: '', plannedHoursPerWeek: '', startDate: '', endDate: '' })

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [snapshot, rows] = await Promise.all([
        erpApi.capacity(),
        // This contract's own plan. Capacity is firm-wide; this is the slice
        // that belongs to the contract being looked at.
        erpApi.listAllocations({ contractId }).catch(() => []),
      ])
      setCap(snapshot)
      setAllocations(rows as Array<Record<string, unknown>>)
    } catch (err) { setError(readError(err, 'Could not load capacity.')) }
    finally { setLoading(false) }
  }, [contractId])
  useEffect(() => { void load() }, [load])

  // Only needed to fill the picker, and only for someone who can allocate.
  useEffect(() => {
    if (!isAdmin || !show || people.length > 0) return
    void firmApi.users().then((r) => setPeople(r.data ?? r ?? [])).catch(() => setPeople([]))
  }, [isAdmin, show, people.length])

  const addAllocation = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await erpApi.createAllocation({
        userId: f.userId, contractId,
        laborCategory: f.laborCategory || null,
        allocationPercent: Number(f.allocationPercent),
        plannedHoursPerWeek: f.plannedHoursPerWeek ? Number(f.plannedHoursPerWeek) : null,
        startDate: new Date(f.startDate || Date.now()).toISOString(),
        endDate: f.endDate ? new Date(f.endDate).toISOString() : null,
        status: 'ACTIVE',
      })
      toast('Person allocated to this contract.', 'success')
      setShow(false)
      setF({ userId: '', laborCategory: '', allocationPercent: '', plannedHoursPerWeek: '', startDate: '', endDate: '' })
      await load()
    } catch (err) {
      toast(readError(err, 'Could not allocate that person.'), 'error')
    }
  }

  const field = 'bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] text-gray-200 outline-none focus:border-blue-500'
  const allocationPanel = (
    <div className="space-y-2">
      {isAdmin && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-[11px] text-gray-500">
            Allocation is a plan. Actual hours come from approved timesheets and are never derived from it.
          </p>
          <button onClick={() => setShow((v) => !v)}
            className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700">
            {show ? 'Cancel' : 'Allocate someone'}
          </button>
        </div>
      )}
      {isAdmin && show && (
        <form onSubmit={addAllocation} className="bg-gray-900 border border-gray-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-3 gap-2">
          <select required aria-label="Person" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} className={field}>
            <option value="">Person *</option>
            {people.map((u) => <option key={u.id} value={u.id}>{[u.firstName, u.lastName].filter(Boolean).join(' ') || u.email}</option>)}
          </select>
          <input aria-label="Labour category" placeholder="Labour category" value={f.laborCategory} onChange={(e) => setF({ ...f, laborCategory: e.target.value })} className={field} />
          <input required aria-label="Allocation percent" type="number" min="0.01" max="100" step="0.01" placeholder="% of their time *" value={f.allocationPercent} onChange={(e) => setF({ ...f, allocationPercent: e.target.value })} className={field} />
          <input aria-label="Planned hours per week" type="number" min="0" max="168" placeholder="Planned hrs/week" value={f.plannedHoursPerWeek} onChange={(e) => setF({ ...f, plannedHoursPerWeek: e.target.value })} className={field} />
          <input required aria-label="Allocation start" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} className={field} />
          <input aria-label="Allocation end" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} className={field} />
          <button type="submit" className="text-[11px] px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 md:col-span-3 justify-self-start">
            Allocate
          </button>
        </form>
      )}
      {allocations.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 overflow-x-auto">
          <p className="text-[11px] uppercase tracking-widest text-gray-500 mb-2">On this contract</p>
          <table className="w-full text-[12px]">
            <thead><tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="py-1.5">Labour category</th><th className="text-right">Allocation</th><th className="text-right">Hrs/week</th><th>Status</th>
            </tr></thead>
            <tbody>{allocations.map((a) => (
              <tr key={String(a.id)} className="border-b border-gray-900">
                <td className="py-1.5 text-gray-300">{String(a.laborCategory ?? '—')}</td>
                <td className="text-right font-mono text-gray-200">{String(a.allocationPercent)}%</td>
                <td className="text-right font-mono text-gray-400">{a.plannedHoursPerWeek ? String(a.plannedHoursPerWeek) : '—'}</td>
                <td><Badge tone={a.status === 'ACTIVE' ? 'success' : 'neutral'}>{String(a.status)}</Badge></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  )

  if (loading) return <LoadingPanel label="Loading resource plan…" />
  if (error || !cap) return <ErrorPanel message={error ?? 'No capacity data.'} onRetry={load} />

  if (cap.state === 'INSUFFICIENT_DATA') {
    return (
      <div className="space-y-2">
        {allocationPanel}
        <EmptyPanel message="No resource plan" hint={cap.dataNote} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {allocationPanel}
      <div className="flex justify-end">
        <ExportButton rows={allocationRows(cap)} columns={ALLOCATION_COLUMNS} filename="staff-allocations" what="staff allocations" label="Allocations" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Metric label="People planned" value={String(cap.peopleWithPlans)} />
        <Metric label="Conflicts" value={String(cap.conflicts.length)} tone={cap.conflicts.length ? 'text-red-400' : 'text-gray-100'} />
        <Metric label="Recent actual hours" value={cap.recentActualHours ?? '—'} hint="Approved time, trailing 30 days" />
      </div>

      <p className="text-[11px] text-gray-500">{cap.dataNote}</p>

      <div className="space-y-2">
        {cap.people.map((p) => (
          <div key={p.userId} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-gray-100">{p.name}</span>
              <Badge tone={p.conflict ? 'danger' : p.state === 'NEAR_CAPACITY' ? 'warning' : 'success'}>
                {p.conflict ? 'CAPACITY CONFLICT' : p.state}
              </Badge>
              <span className="text-[11px] font-mono text-gray-400">{p.allocatedPercent}% allocated · {p.remainingPercent}% free</span>
            </div>
            <div className="mt-2 space-y-1">
              {p.allocations.map((a) => (
                <div key={a.id} className="text-[11px] text-gray-500 flex gap-3 flex-wrap">
                  <span className="font-mono">{a.allocationPercent}%</span>
                  <span>{a.contractNumber ?? a.contractId}</span>
                  {a.laborCategory && <span>{a.laborCategory}</span>}
                  <span>{new Date(a.startDate).toLocaleDateString()} → {a.endDate ? new Date(a.endDate).toLocaleDateString() : 'open'}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// Purchasing and subcontracts
// -------------------------------------------------------------


const FLOW_DOWN_TONE: Record<FlowDownState, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  INCLUDED: 'success',
  APPLICABLE_CONFIRMED: 'info',
  NOT_APPLICABLE_CONFIRMED: 'neutral',
  NOT_INCLUDED: 'danger',
  REVIEW_REQUIRED: 'warning',
  INSUFFICIENT_DATA: 'neutral',
}

const SUB_INVOICE_TONE: Record<SubcontractInvoiceStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  PAID: 'success',
  APPROVED: 'info',
  UNDER_REVIEW: 'warning',
  RECEIVED: 'warning',
  REJECTED: 'danger',
}

/**
 * Everything on one purchase order: what was ordered, what has been billed
 * against it, and which clauses flow down.
 *
 * Loaded only when opened. The list view already carries the counts, and a
 * contract can hold many orders — fetching every order's lines and invoices up
 * front would spend most of that work on rows nobody looks at.
 */
function PurchaseOrderDetail({ poId, isAdmin, onChanged }: {
  poId: string
  isAdmin: boolean
  onChanged: () => Promise<void> | void
}) {
  const { toast } = useToast()
  const [po, setPo] = useState<PurchaseOrder | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [invForm, setInvForm] = useState({ invoiceNumber: '', amount: '', invoiceDate: '' })

  const load = useCallback(async () => {
    setError(null)
    try { setPo(await erpApi.getPurchaseOrder(poId)) }
    catch (err) { setError(readError(err, 'Could not load this purchase order.')) }
  }, [poId])
  useEffect(() => { void load() }, [load])

  const reviewClause = async (id: string, state: FlowDownState) => {
    setBusy(true)
    try {
      const evidence = window.prompt('Why is this the state? This is recorded as the audit evidence.') ?? undefined
      await erpApi.reviewFlowDown(id, state, evidence)
      toast('Flow-down reviewed.', 'success')
      await load()
    } catch (err) {
      toast(readError(err, 'Could not review that clause.'), 'error')
    } finally { setBusy(false) }
  }

  const addVendorInvoice = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await erpApi.createSubcontractInvoice({
        purchaseOrderId: poId,
        invoiceNumber: invForm.invoiceNumber,
        amount: Number(invForm.amount),
        invoiceDate: new Date(invForm.invoiceDate || Date.now()).toISOString(),
      })
      toast('Vendor invoice recorded. It still needs approving.', 'success')
      setInvForm({ invoiceNumber: '', amount: '', invoiceDate: '' })
      await load()
      await onChanged()
    } catch (err) {
      toast(readError(err, 'Could not record that invoice.'), 'error')
    } finally { setBusy(false) }
  }

  const moveInvoice = async (id: string, status: SubcontractInvoiceStatus) => {
    setBusy(true)
    try {
      await erpApi.transitionSubcontractInvoice(id, status)
      toast(`Vendor invoice ${status.toLowerCase().replace('_', ' ')}.`, 'success')
      await load()
      await onChanged()
    } catch (err) {
      toast(readError(err, 'Could not update the vendor invoice.'), 'error')
    } finally { setBusy(false) }
  }

  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (!po) return <LoadingPanel label="Loading order…" />

  return (
    <div className="mt-3 pt-3 border-t border-gray-800 space-y-4">
      {po.description && <p className="text-[12px] text-gray-400">{po.description}</p>}

      {po.balance && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Metric label="Ceiling" value={usd(po.balance.ceiling)} />
          <Metric label="Invoiced" value={usd(po.balance.invoicedTotal)} />
          <Metric label="Posted as cost" value={usd(po.balance.postedTotal)} hint="Only an approved invoice becomes an actual cost." />
          <Metric label="Remaining" value={usd(po.balance.remaining)} tone={po.balance.overInvoiced ? 'text-red-300' : undefined} />
        </div>
      )}

      <div>
        <p className="text-[11px] uppercase tracking-widest text-gray-500 mb-1.5">Lines</p>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead><tr className="text-left text-gray-600 border-b border-gray-800">
              <th className="py-1.5">CLIN</th><th>Description</th><th>Category</th><th className="text-right">Amount</th>
            </tr></thead>
            <tbody>{po.lines.map((l) => (
              <tr key={l.id} className="border-b border-gray-900">
                <td className="py-1.5 font-mono text-gray-300">{l.clin?.clinNumber ?? '—'}</td>
                <td className="text-gray-300">{l.description}</td>
                <td className="text-gray-500">{l.category}</td>
                <td className="text-right font-mono text-gray-200">{usd(l.amount)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-widest text-gray-500 mb-1.5">
          Vendor invoices ({po.invoices?.length ?? 0})
        </p>
        {(po.invoices?.length ?? 0) === 0 ? (
          <p className="text-[12px] text-gray-500">This vendor has not billed against the order yet.</p>
        ) : (
          <div className="space-y-1.5">{po.invoices!.map((inv) => (
            <div key={inv.id} className="flex items-center gap-2 flex-wrap bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">
              <span className="font-mono text-[12px] text-gray-200">{inv.invoiceNumber}</span>
              <Badge tone={SUB_INVOICE_TONE[inv.status]}>{inv.status.replace('_', ' ')}</Badge>
              {inv.postedAt && <Badge tone="neutral">POSTED AS COST</Badge>}
              <span className="text-[11px] text-gray-500">{new Date(inv.invoiceDate).toLocaleDateString()}</span>
              <span className="ml-auto font-mono text-[12px] text-gray-200">{usd(inv.amount)}</span>
              {isAdmin && (inv.status === 'RECEIVED' || inv.status === 'UNDER_REVIEW') && (
                <>
                  <button disabled={busy} onClick={() => void moveInvoice(inv.id, 'APPROVED')}
                    className="text-[11px] px-2 py-1 rounded bg-green-900/40 hover:bg-green-900/60 text-green-300 border border-green-800 disabled:opacity-50">Approve</button>
                  <button disabled={busy} onClick={() => void moveInvoice(inv.id, 'REJECTED')}
                    className="text-[11px] px-2 py-1 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-800 disabled:opacity-50">Reject</button>
                </>
              )}
              {isAdmin && inv.status === 'APPROVED' && (
                <button disabled={busy} onClick={() => void moveInvoice(inv.id, 'PAID')}
                  className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-50">Record payment</button>
              )}
            </div>
          ))}</div>
        )}
        {isAdmin && (
          <form onSubmit={addVendorInvoice} className="flex gap-2 flex-wrap items-center mt-2">
            <input required aria-label="Vendor invoice number" placeholder="Invoice number" value={invForm.invoiceNumber}
              onChange={(e) => setInvForm({ ...invForm, invoiceNumber: e.target.value })}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 outline-none focus:border-blue-500" />
            <input required aria-label="Vendor invoice amount" type="number" step="0.01" min="0" placeholder="Amount $" value={invForm.amount}
              onChange={(e) => setInvForm({ ...invForm, amount: e.target.value })}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 outline-none focus:border-blue-500" />
            <input aria-label="Vendor invoice date" type="date" value={invForm.invoiceDate}
              onChange={(e) => setInvForm({ ...invForm, invoiceDate: e.target.value })}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 outline-none focus:border-blue-500" />
            <button type="submit" disabled={busy}
              className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-50">
              Record invoice
            </button>
          </form>
        )}
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-widest text-gray-500 mb-1.5">
          Flow-downs ({po.flowDowns?.length ?? 0})
        </p>
        {(po.flowDowns?.length ?? 0) === 0 ? (
          <div className="space-y-2">
            <p className="text-[12px] text-gray-500">No clauses recorded against this order.</p>
            {isAdmin && (
              <button disabled={busy} onClick={async () => {
                setBusy(true)
                try {
                  const r = await erpApi.seedFlowDowns(poId)
                  toast(r.created > 0
                    ? `${r.created} clause(s) brought across from the contract's reviewed obligations.`
                    : r.note ?? 'Nothing to bring across — the contract has no reviewed clause obligations yet.', 'success')
                  await load()
                } catch (err) {
                  toast(readError(err, 'Could not seed flow-downs.'), 'error')
                } finally { setBusy(false) }
              }} className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-50">
                Bring across from the contract
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">{po.flowDowns!.map((fd) => (
            <div key={fd.id} className="bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-[12px] text-gray-200">{fd.clauseNumber}</span>
                <Badge tone={FLOW_DOWN_TONE[fd.state]}>{fd.state.replace(/_/g, ' ')}</Badge>
                <span className="text-[12px] text-gray-400">{fd.clauseTitle}</span>
              </div>
              {fd.evidence && <p className="text-[11px] text-gray-500 mt-1">{fd.evidence}</p>}
              {isAdmin && (
                <div className="flex gap-2 flex-wrap mt-1.5">
                  {(['INCLUDED', 'APPLICABLE_CONFIRMED', 'NOT_APPLICABLE_CONFIRMED', 'NOT_INCLUDED'] as FlowDownState[])
                    .filter((st) => st !== fd.state)
                    .map((st) => (
                      <button key={st} disabled={busy} onClick={() => void reviewClause(fd.id, st)}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 border border-gray-700 disabled:opacity-50">
                        {st.replace(/_/g, ' ')}
                      </button>
                    ))}
                </div>
              )}
            </div>
          ))}</div>
        )}
        <p className="text-[10px] text-gray-600 mt-2">
          A flow-down state is set by a reviewer, never inferred. Sharing a clause with the subcontractor is a
          separate decision from its legal state, which stays with the prime.
        </p>
      </div>
    </div>
  )
}

export function ContractPurchasingTab({ contractId, isAdmin }: { contractId: string; isAdmin: boolean }) {
  const { toast } = useToast()
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [poForm, setPoForm] = useState({ poNumber: '', vendorName: '', ceilingAmount: '', description: '', isSubcontract: true })

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setOrders(await erpApi.listPurchaseOrders({ contractId })) }
    catch (err) { setError(readError(err, 'Could not load purchase orders.')) }
    finally { setLoading(false) }
  }, [contractId])
  useEffect(() => { void load() }, [load])

  const transition = async (po: PurchaseOrder, status: Parameters<typeof erpApi.transitionPurchaseOrder>[1]) => {
    try {
      await erpApi.transitionPurchaseOrder(po.id, status)
      toast(`Purchase order ${status.toLowerCase().replace('_', ' ')}.`, 'success')
      await load()
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { allowedNextStates?: string[]; error?: string } } }
      toast(e?.response?.status === 422
        ? `${e.response.data?.error} Allowed: ${(e.response.data?.allowedNextStates ?? []).join(', ') || 'none'}`
        : readError(err, 'Could not update the purchase order.'), 'error')
    }
  }

  const createOrder = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await erpApi.createPurchaseOrder({
        contractId,
        poNumber: poForm.poNumber,
        vendorName: poForm.vendorName,
        ceilingAmount: Number(poForm.ceilingAmount),
        description: poForm.description || null,
        isSubcontract: poForm.isSubcontract,
      })
      toast('Purchase order created as a draft.', 'success')
      setShowNew(false)
      setPoForm({ poNumber: '', vendorName: '', ceilingAmount: '', description: '', isSubcontract: true })
      await load()
    } catch (err) {
      toast(readError(err, 'Could not create the purchase order.'), 'error')
    }
  }

  const field = 'bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] text-gray-200 outline-none focus:border-blue-500'
  // The bar itself is not admin-gated: someone who may read purchase orders may
  // export them, and hiding the whole bar hid the export from every reader.
  const newOrderForm = (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <p className="text-[11px] text-gray-500">
        {isAdmin ? 'An order starts as a draft. Approving it is a separate, human act.' : 'Purchase orders on this contract.'}
      </p>
      <div className="flex items-center gap-2">
        <ExportButton rows={poLineRows(orders)} columns={PO_COLUMNS} filename="purchase-orders" what="purchase orders" />
        {isAdmin && (
          <button onClick={() => setShowNew((v) => !v)}
            className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700">
            {showNew ? 'Cancel' : 'New purchase order'}
          </button>
        )}
      </div>
    </div>
  )

  const newOrderPanel = isAdmin && showNew && (
    <form onSubmit={createOrder} className="bg-gray-900 border border-gray-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-3 gap-2">
      <input required aria-label="PO number" placeholder="PO number *" value={poForm.poNumber} onChange={(e) => setPoForm({ ...poForm, poNumber: e.target.value })} className={field} />
      <input required aria-label="Vendor name" placeholder="Vendor *" value={poForm.vendorName} onChange={(e) => setPoForm({ ...poForm, vendorName: e.target.value })} className={field} />
      <input required aria-label="Ceiling amount" type="number" min="0" step="0.01" placeholder="Ceiling $ *" value={poForm.ceilingAmount} onChange={(e) => setPoForm({ ...poForm, ceilingAmount: e.target.value })} className={field} />
      <input aria-label="PO description" placeholder="Description" value={poForm.description} onChange={(e) => setPoForm({ ...poForm, description: e.target.value })} className={`${field} md:col-span-2`} />
      <label className="flex items-center gap-2 text-[12px] text-gray-400">
        <input type="checkbox" checked={poForm.isSubcontract} onChange={(e) => setPoForm({ ...poForm, isSubcontract: e.target.checked })} />
        Subcontract
      </label>
      <button type="submit" className="text-[11px] px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 md:col-span-3 justify-self-start">
        Create draft order
      </button>
    </form>
  )

  if (loading) return <LoadingPanel label="Loading purchase orders…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (orders.length === 0) {
    return (
      <div className="space-y-2">
        {newOrderForm}
        {newOrderPanel}
        <EmptyPanel message="No purchase orders on this contract." hint="An approved order becomes a commitment against the budget without being an incurred cost." />
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {newOrderForm}
      {newOrderPanel}
      {orders.map((po) => (
        <div key={po.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setOpenId((v) => (v === po.id ? null : po.id))}
              aria-expanded={openId === po.id}
              className="text-sm font-medium text-gray-100 hover:text-blue-300">
              {openId === po.id ? '▾' : '▸'} {po.poNumber}
            </button>
            <Badge tone={po.status === 'APPROVED' ? 'success' : po.status === 'CANCELLED' ? 'neutral' : 'info'}>{po.status}</Badge>
            {po.isSubcontract && <Badge tone="brand">SUBCONTRACT</Badge>}
            <span className="text-[12px] text-gray-400">{po.vendorName}</span>
            <span className="ml-auto font-mono text-sm text-gray-200">{usd(po.ceilingAmount)}</span>
          </div>
          <div className="flex gap-4 text-[11px] text-gray-500 mt-1 font-mono">
            <span>{po.lines.length} line(s)</span>
            <span>{po._count?.invoices ?? 0} invoice(s)</span>
            <span>{po._count?.flowDowns ?? 0} flow-down(s)</span>
          </div>
          {isAdmin && po.status !== 'COMPLETE' && po.status !== 'CANCELLED' && (
            <div className="flex gap-2 mt-2">
              {po.status === 'DRAFT' && (
                <button onClick={() => transition(po, 'PENDING_APPROVAL')}
                  className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">Submit for approval</button>
              )}
              {po.status === 'PENDING_APPROVAL' && (
                <button onClick={() => transition(po, 'APPROVED')}
                  className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">Approve</button>
              )}
              <button onClick={() => transition(po, 'CANCELLED')}
                className="text-[11px] px-2 py-1 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-800">Cancel</button>
            </div>
          )}
          {openId === po.id && <PurchaseOrderDetail poId={po.id} isAdmin={isAdmin} onChanged={load} />}
        </div>
      ))}
      <p className="text-[10px] text-gray-600">
        Approving an order, and approving or paying a vendor invoice, are human actions. No agent can perform any of them.
      </p>
    </div>
  )
}

// -------------------------------------------------------------
// Financials
// -------------------------------------------------------------

export function ContractFinancialsTab({ contractId }: { contractId: string }) {
  const [s, setS] = useState<FinancialSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setS(await erpApi.financialSummary(contractId)) }
    catch (err) { setError(readError(err, 'Could not load the financial summary.')) }
    finally { setLoading(false) }
  }, [contractId])
  useEffect(() => { void load() }, [load])

  if (loading) return <LoadingPanel label="Loading financials…" />
  if (error || !s) return <ErrorPanel message={error ?? 'No financial data.'} onRetry={load} />

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Contract value" value={usd(s.contractValue)} hint={s.contractValueSource ?? 'Not recorded'} />
        <Metric label="Funded" value={usd(s.funded)} />
        <Metric label="Unfunded" value={usd(s.unfunded)} />
        <Metric label="Funded remaining" value={usd(s.fundedRemaining)} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Budget" value={usd(s.budget)} />
        <Metric label="Actual" value={usd(s.actual)} />
        <Metric label="Committed" value={usd(s.committed)} />
        <Metric label="Backlog" value={usd(s.backlog)} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h4 className="text-sm font-semibold text-gray-300 mb-2">Subcontract commitments</h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[12px]">
          <div><p className="text-gray-500">Orders</p><p className="font-mono text-gray-200">{s.subcontractCommitments.orderCount}</p></div>
          <div><p className="text-gray-500">Committed</p><p className="font-mono text-gray-200">{usd(s.subcontractCommitments.committed)}</p></div>
          <div><p className="text-gray-500">Invoiced</p><p className="font-mono text-gray-200">{usd(s.subcontractCommitments.invoiced)}</p></div>
          <div><p className="text-gray-500">Posted to cost</p><p className="font-mono text-gray-200">{usd(s.subcontractCommitments.posted)}</p></div>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h4 className="text-sm font-semibold text-gray-300 mb-2">Receivables on this contract</h4>
        <div className="grid grid-cols-3 gap-3 text-[12px]">
          <div><p className="text-gray-500">Billed</p><p className="font-mono text-gray-200">{usd(s.receivables.billed)}</p></div>
          <div><p className="text-gray-500">Collected</p><p className="font-mono text-gray-200">{usd(s.receivables.collected)}</p></div>
          <div><p className="text-gray-500">Outstanding</p><p className="font-mono text-gray-200">{usd(s.receivables.outstanding)}</p></div>
        </div>
        <p className="text-[10px] text-gray-600 mt-2">
          Firm-wide ageing and collection live on <Link to="/finance/receivables" className="text-gray-400 hover:text-gray-200">Receivables</Link>.
        </p>
      </div>

      <p className="text-[11px] text-gray-500">{s.backlogBasis}</p>

      {s.limitations.length > 0 && (
        <div className="border border-gray-800 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Limitations</p>
          <ul className="text-[11px] text-gray-400 list-disc pl-4 space-y-0.5">
            {s.limitations.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}
