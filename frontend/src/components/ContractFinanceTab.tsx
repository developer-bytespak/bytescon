import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { financeApi, contractMgmtApi } from '../services/api'
import { useToast } from './Toast'
import { Spinner, EmptyState } from './ui'
import { ExportButton } from './ExportButton'
import { isoDate, num, type Column } from '../utils/exportTable'
import { Plus, Download, FileDown, Printer, X } from 'lucide-react'

const money = (v?: string | number | null) => (v != null ? `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—')
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')
const iso = (d: string) => (d ? new Date(d).toISOString() : undefined)
const inp = 'bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500'

const COST_CATEGORIES = ['OTHER_DIRECT_COST', 'TRAVEL', 'MATERIAL', 'SUBCONTRACTOR', 'EQUIPMENT', 'ADJUSTMENT', 'OTHER']
const RATE_TYPES = ['BILLING', 'COST', 'CEILING', 'BLENDED', 'OTHER']

const STATE_TONE: Record<string, string> = {
  DRAFT: 'bg-gray-800 border-gray-700 text-gray-400',
  SUBMITTED: 'bg-yellow-950/40 border-yellow-800 text-yellow-300',
  APPROVED: 'bg-green-950/40 border-green-800 text-green-300',
  REJECTED: 'bg-red-950/40 border-red-800 text-red-300',
  VOIDED: 'bg-gray-800 border-gray-700 text-gray-500',
}
const pill = (t: string) =>
  <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${STATE_TONE[t] ?? STATE_TONE.DRAFT}`}>{t}</span>

// Explicit columns per table. An API row carries ids and nested relations that
// mean nothing in a spreadsheet, so each export names what it wants and how to
// read it. Money goes out as a bare number so the sheet can total a column.
const FUNDING_COLUMNS: ReadonlyArray<Column<any>> = [
  { header: 'Type', value: (r) => r.type },
  { header: 'Amount (USD)', value: (r) => num(r.amount) },
  { header: 'Reference', value: (r) => r.referenceNumber },
  { header: 'Voided', value: (r) => (r.isVoided ? 'YES' : 'NO') },
  { header: 'Void reason', value: (r) => r.voidReason },
  { header: 'Recorded', value: (r) => isoDate(r.createdAt) },
]

const RATE_COLUMNS: ReadonlyArray<Column<any>> = [
  { header: 'Labour category', value: (r) => r.categoryName },
  { header: 'Rate type', value: (r) => r.rateType },
  { header: 'Billing rate (USD/hr)', value: (r) => num(r.billingRate) },
  { header: 'Cost rate (USD/hr)', value: (r) => num(r.costRate) },
  { header: 'CLIN', value: (r) => r.clin?.clinNumber },
  { header: 'Effective start', value: (r) => isoDate(r.effectiveStart) },
  { header: 'Effective end', value: (r) => isoDate(r.effectiveEnd) },
]

const COST_COLUMNS: ReadonlyArray<Column<any>> = [
  { header: 'Category', value: (r) => r.category },
  { header: 'Description', value: (r) => r.description },
  { header: 'Amount (USD)', value: (r) => num(r.amount) },
  { header: 'Incurred date', value: (r) => isoDate(r.incurredDate) },
  { header: 'Status', value: (r) => r.status },
  { header: 'CLIN', value: (r) => r.clin?.clinNumber },
]


// Section 5 Module 9 — Contract financial surface: funding ledger, burn summary,
// rates, costs, invoices + payments. All figures come from the backend.
export function ContractFinanceTab({ contractId, contractNumber, isAdmin }: { contractId: string; contractNumber?: string; isAdmin: boolean }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [showFunding, setShowFunding] = useState(false)
  const [showInvoice, setShowInvoice] = useState(false)
  const [fund, setFund] = useState({ type: 'INITIAL_OBLIGATION', amount: '' })
  const [invForm, setInvForm] = useState({ dueDate: '', feeAmount: '' })
  const [showRate, setShowRate] = useState(false)
  const [showCost, setShowCost] = useState(false)
  const [rateForm, setRateForm] = useState({ categoryName: '', billingRate: '', costRate: '', rateType: 'BILLING', effectiveStart: '', effectiveEnd: '', clinId: '' })
  const [costForm, setCostForm] = useState({ category: 'TRAVEL', amount: '', description: '', incurredDate: '', clinId: '' })

  const summary = useQuery<{ data: any }>({ queryKey: ['fin-summary', contractId], queryFn: () => financeApi.summary(contractId) })
  const funding = useQuery<{ data: any[]; meta: { fundedTotal: string } }>({ queryKey: ['fin-funding', contractId], queryFn: () => financeApi.listFunding(contractId) })
  const invoices = useQuery<{ data: any[] }>({ queryKey: ['fin-invoices', contractId], queryFn: () => financeApi.listInvoices(contractId) })
  const rates = useQuery<{ data: any[] }>({ queryKey: ['fin-rates', contractId], queryFn: () => financeApi.listRates(contractId) })
  const costs = useQuery<{ data: any[] }>({ queryKey: ['fin-costs', contractId], queryFn: () => financeApi.listCosts(contractId) })
  const clins = useQuery<{ data: any[] }>({ queryKey: ['fin-clins', contractId], queryFn: () => contractMgmtApi.listClins(contractId) })
  const time = useQuery<{ data: any[] }>({ queryKey: ['fin-time', contractId], queryFn: () => financeApi.listTime(contractId) })
  const variance = useQuery<{ data: any }>({ queryKey: ['fin-variance', contractId], queryFn: () => financeApi.rateVariance(contractId), retry: false })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['fin-summary', contractId] })
    qc.invalidateQueries({ queryKey: ['fin-funding', contractId] })
    qc.invalidateQueries({ queryKey: ['fin-invoices', contractId] })
    qc.invalidateQueries({ queryKey: ['fin-rates', contractId] })
    qc.invalidateQueries({ queryKey: ['fin-costs', contractId] })
    qc.invalidateQueries({ queryKey: ['fin-time', contractId] })
    qc.invalidateQueries({ queryKey: ['contract', contractId] })
  }
  const run = (fn: () => Promise<unknown>, ok: string) => fn().then(() => { refresh(); toast(ok, 'success') }).catch((e: any) => toast(e?.response?.data?.error || 'Action failed', 'error'))

  if (summary.isLoading) return <div className="card flex justify-center py-8"><Spinner size="md" /></div>
  if (summary.error) return <div className="card"><p className="text-red-400 text-sm">Could not load financials.</p></div>
  const s = summary.data!.data

  return (
    <div className="space-y-6">
      {/* Burn summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <FinCard label="Funded" value={money(s.funded)} />
        <FinCard label="Expended" value={money(s.expended)} sub={`${Math.round((s.expendedPct || 0) * 100)}%`} />
        <FinCard label="Remaining funded" value={money(s.remainingFunded)} tone={s.warning !== 'NONE' ? 'red' : 'green'} />
        <FinCard label="Est. depletion" value={s.insufficientData ? 'Insufficient data' : fmtDate(s.estimatedDepletionDate)} sub={s.burnRatePerDay ? `${money(s.burnRatePerDay)}/day` : undefined} />
      </div>
      {s.warning !== 'NONE' && (
        <div className="bg-red-950/30 border border-red-800 rounded-lg px-4 py-2 text-sm text-red-300">
          ⚠ {s.warning === 'DEPLETION_BEFORE_END' ? 'Funding projected to deplete before the period of performance ends.' : s.warning === 'CEILING_LOW' ? 'Nearing contract ceiling.' : 'Funded amount nearing exhaustion.'}
        </div>
      )}

      {/* Funding ledger */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-200">Funding ledger <span className="text-xs text-gray-500 font-mono">({money(funding.data?.meta.fundedTotal)})</span></h3>
          <div className="flex items-center gap-2">
            <ExportButton rows={funding.data?.data ?? []} columns={FUNDING_COLUMNS} filename="funding-ledger" what="the funding ledger" />
            {isAdmin && <button onClick={() => setShowFunding((v) => !v)} className="btn-primary text-xs flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" /> Record funding</button>}
          </div>
        </div>
        {isAdmin && showFunding && (
          <form onSubmit={(e) => { e.preventDefault(); run(() => financeApi.addFunding(contractId, { type: fund.type, amount: Number(fund.amount) }), 'Funding recorded').then(() => { setShowFunding(false); setFund({ type: 'INITIAL_OBLIGATION', amount: '' }) }) }} className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4 bg-gray-900/50 border border-gray-800 rounded-lg p-3">
            <select value={fund.type} onChange={(e) => setFund({ ...fund, type: e.target.value })} className={inp}>{['INITIAL_OBLIGATION', 'INCREMENTAL_FUNDING', 'FUNDING_REDUCTION', 'DEOBLIGATION', 'ADJUSTMENT'].map((t) => <option key={t}>{t}</option>)}</select>
            <input required type="number" min="0" step="0.01" placeholder="Amount $" value={fund.amount} onChange={(e) => setFund({ ...fund, amount: e.target.value })} className={inp} />
            <div className="flex gap-2"><button type="submit" className="btn-primary text-sm">Save</button><button type="button" onClick={() => setShowFunding(false)} className="btn-secondary text-sm">Cancel</button></div>
          </form>
        )}
        {funding.isLoading ? <Spinner size="sm" /> : (funding.data?.data.length ?? 0) === 0 ? <EmptyState message="No funding transactions yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2">Type</th><th>Amount</th><th>Ref</th><th>State</th><th></th></tr></thead>
            <tbody>{funding.data!.data.map((t) => (<tr key={t.id} className="border-b border-gray-900"><td className="py-2 text-gray-300">{t.type}</td><td className={Number(t.amount) < 0 ? 'text-red-400' : 'text-gray-300'}>{money(t.amount)}</td><td className="text-gray-500 font-mono text-xs">{t.referenceNumber || '—'}</td><td>{t.isVoided ? <span className="text-red-400 text-xs">voided</span> : <span className="text-green-400 text-xs">active</span>}</td>
              <td className="text-right">{isAdmin && !t.isVoided && (
                <button onClick={() => { const r = window.prompt('Why is this funding entry being voided?'); if (r) run(() => financeApi.voidFunding(t.id, r), 'Funding voided') }}
                  className="text-red-400 hover:text-red-300 text-xs">Void</button>
              )}</td></tr>))}</tbody></table>
        )}
        <p className="text-[10px] text-gray-600 mt-2">
          A funding entry is never deleted. Voiding keeps the row and removes it from the total, so the ledger still
          shows what was recorded and what was withdrawn.
        </p>
      </div>

      {/* Labour rates — time cannot be costed without these */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-200">Labour rates</h3>
          <div className="flex items-center gap-2">
            <ExportButton rows={rates.data?.data ?? []} columns={RATE_COLUMNS} filename="labour-rates" what="labour rates" />
            {isAdmin && <button onClick={() => setShowRate((v) => !v)} className="btn-primary text-xs flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" /> Add rate</button>}
          </div>
        </div>
        {isAdmin && showRate && (
          <form onSubmit={(e) => {
            e.preventDefault()
            run(() => financeApi.addRate(contractId, {
              categoryName: rateForm.categoryName,
              billingRate: rateForm.billingRate ? Number(rateForm.billingRate) : undefined,
              costRate: rateForm.costRate ? Number(rateForm.costRate) : undefined,
              rateType: rateForm.rateType,
              effectiveStart: iso(rateForm.effectiveStart),
              effectiveEnd: iso(rateForm.effectiveEnd),
              clinId: rateForm.clinId || undefined,
            }), 'Rate added').then(() => { setShowRate(false); setRateForm({ categoryName: '', billingRate: '', costRate: '', rateType: 'BILLING', effectiveStart: '', effectiveEnd: '', clinId: '' }) })
          }} className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4 bg-gray-900/50 border border-gray-800 rounded-lg p-3">
            <input required aria-label="Labour category" placeholder="Labour category *" value={rateForm.categoryName} onChange={(e) => setRateForm({ ...rateForm, categoryName: e.target.value })} className={inp} />
            <input type="number" step="0.0001" aria-label="Billing rate" placeholder="Billing rate $/hr" value={rateForm.billingRate} onChange={(e) => setRateForm({ ...rateForm, billingRate: e.target.value })} className={inp} />
            <input type="number" step="0.0001" aria-label="Cost rate" placeholder="Cost rate $/hr" value={rateForm.costRate} onChange={(e) => setRateForm({ ...rateForm, costRate: e.target.value })} className={inp} />
            <input type="date" aria-label="Effective start" title="Effective start" value={rateForm.effectiveStart} onChange={(e) => setRateForm({ ...rateForm, effectiveStart: e.target.value })} className={inp} />
            <input type="date" aria-label="Effective end" title="Effective end" value={rateForm.effectiveEnd} onChange={(e) => setRateForm({ ...rateForm, effectiveEnd: e.target.value })} className={inp} />
            <select aria-label="CLIN" value={rateForm.clinId} onChange={(e) => setRateForm({ ...rateForm, clinId: e.target.value })} className={inp}>
              <option value="">All CLINs</option>
              {(clins.data?.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.clinNumber}</option>)}
            </select>
            <div className="flex gap-2 md:col-span-3"><button type="submit" className="btn-primary text-sm">Save</button><button type="button" onClick={() => setShowRate(false)} className="btn-secondary text-sm">Cancel</button></div>
          </form>
        )}
        {rates.isLoading ? <Spinner size="sm" /> : (rates.data?.data.length ?? 0) === 0 ? (
          <EmptyState message="No labour rate is recorded. Approved time will cost at zero until one exists." />
        ) : (
          <table className="w-full text-sm"><thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2">Category</th><th>Type</th><th>Billing</th><th>Cost</th><th>Effective</th></tr></thead>
            <tbody>{rates.data!.data.map((r: any) => (
              <tr key={r.id} className="border-b border-gray-900">
                <td className="py-2 text-gray-200">{r.categoryName}</td>
                <td className="text-gray-500 text-xs font-mono">{r.rateType}</td>
                <td className="text-gray-300 font-mono">{money(r.billingRate)}</td>
                <td className="text-gray-300 font-mono">{r.costRate != null ? money(r.costRate) : <span className="text-gray-600">hidden</span>}</td>
                <td className="text-gray-500 text-xs">{fmtDate(r.effectiveStart)} → {fmtDate(r.effectiveEnd)}</td>
              </tr>
            ))}</tbody></table>
        )}
        <p className="text-[10px] text-gray-600 mt-2">
          A timesheet is costed from the rate in force on the WORK DATE, and that amount is frozen at approval. Changing
          a rate later never re-prices work that was already approved.
        </p>
      </div>

      {/* Timesheets on this contract */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-200">Timesheets</h3>
        </div>
        {time.isLoading ? <Spinner size="sm" /> : (time.data?.data.length ?? 0) === 0 ? (
          <EmptyState message="No time has been booked to this contract." />
        ) : (
          <table className="w-full text-sm"><thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2">Date</th><th>Category</th><th>Hours</th><th>Billing</th><th>State</th><th></th></tr></thead>
            <tbody>{time.data!.data.slice(0, 50).map((t: any) => (
              <tr key={t.id} className="border-b border-gray-900">
                <td className="py-2 text-gray-400 text-xs">{fmtDate(t.workDate)}</td>
                <td className="text-gray-300">{t.laborCategory}</td>
                <td className="text-gray-200 font-mono">{t.hours}</td>
                <td className="text-gray-300 font-mono">{t.billingAmount != null ? money(t.billingAmount) : <span className="text-yellow-500/80 text-xs">no rate</span>}</td>
                <td>{pill(t.status)}</td>
                <td className="text-right">{isAdmin && t.status === 'SUBMITTED' && (
                  <div className="flex gap-2 justify-end text-xs">
                    <button onClick={() => run(() => financeApi.approveTime(t.id), 'Approved')} className="text-green-400 hover:text-green-300">Approve</button>
                    <button onClick={() => { const r = window.prompt('Rejection reason:'); if (r) run(() => financeApi.rejectTime(t.id, r), 'Rejected') }} className="text-red-400 hover:text-red-300">Reject</button>
                  </div>
                )}</td>
              </tr>
            ))}</tbody></table>
        )}
        {(time.data?.data.length ?? 0) > 50 && (
          <p className="text-[10px] text-gray-600 mt-2">Showing the 50 most recent of {time.data!.data.length}.</p>
        )}
      </div>

      {/* Rate variance — what was actually billed against what the table says */}
      {isAdmin && variance.data?.data && (
        <div className="card">
          <h3 className="font-semibold text-gray-200 mb-3">Rate variance</h3>
          {(variance.data.data.entries ?? variance.data.data.items ?? []).length === 0 ? (
            <EmptyState message="Every approved timesheet was billed at the rate in force on its work date." />
          ) : (
            <table className="w-full text-sm"><thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2">Category</th><th>Applied</th><th>Expected</th><th>Difference</th></tr></thead>
              <tbody>{(variance.data.data.entries ?? variance.data.data.items ?? []).slice(0, 25).map((v: any, i: number) => (
                <tr key={i} className="border-b border-gray-900">
                  <td className="py-2 text-gray-300">{v.laborCategory ?? v.categoryName ?? '—'}</td>
                  <td className="text-gray-300 font-mono">{money(v.appliedRate ?? v.applied)}</td>
                  <td className="text-gray-300 font-mono">{v.expectedRate != null || v.expected != null ? money(v.expectedRate ?? v.expected) : <span className="text-yellow-500/80 text-xs">none in force</span>}</td>
                  <td className="text-gray-200 font-mono">{v.variance != null ? money(v.variance) : '—'}</td>
                </tr>
              ))}</tbody></table>
          )}
          <p className="text-[10px] text-gray-600 mt-2">
            A difference is not automatically wrong. It usually means the rate table changed after the work was approved,
            and the approved amount was deliberately left alone.
          </p>
        </div>
      )}

      {/* Direct costs */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-200">Direct costs</h3>
          <div className="flex items-center gap-2">
            <ExportButton rows={costs.data?.data ?? []} columns={COST_COLUMNS} filename="direct-costs" what="direct costs" />
            {isAdmin && <button onClick={() => setShowCost((v) => !v)} className="btn-primary text-xs flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" /> Record cost</button>}
          </div>
        </div>
        {isAdmin && showCost && (
          <form onSubmit={(e) => {
            e.preventDefault()
            run(() => financeApi.addCost(contractId, {
              category: costForm.category,
              amount: Number(costForm.amount),
              description: costForm.description || undefined,
              incurredDate: iso(costForm.incurredDate),
              clinId: costForm.clinId || undefined,
            }), 'Cost recorded').then(() => { setShowCost(false); setCostForm({ category: 'TRAVEL', amount: '', description: '', incurredDate: '', clinId: '' }) })
          }} className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4 bg-gray-900/50 border border-gray-800 rounded-lg p-3">
            <select aria-label="Category" value={costForm.category} onChange={(e) => setCostForm({ ...costForm, category: e.target.value })} className={inp}>{COST_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
            <input required type="number" min="0" step="0.01" aria-label="Amount" placeholder="Amount $ *" value={costForm.amount} onChange={(e) => setCostForm({ ...costForm, amount: e.target.value })} className={inp} />
            <input type="date" aria-label="Incurred date" title="Incurred date" value={costForm.incurredDate} onChange={(e) => setCostForm({ ...costForm, incurredDate: e.target.value })} className={inp} />
            <input aria-label="Description" placeholder="Description" value={costForm.description} onChange={(e) => setCostForm({ ...costForm, description: e.target.value })} className={`${inp} md:col-span-2`} />
            <select aria-label="Cost CLIN" value={costForm.clinId} onChange={(e) => setCostForm({ ...costForm, clinId: e.target.value })} className={inp}>
              <option value="">No CLIN</option>
              {(clins.data?.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.clinNumber}</option>)}
            </select>
            <div className="flex gap-2 md:col-span-3"><button type="submit" className="btn-primary text-sm">Save</button><button type="button" onClick={() => setShowCost(false)} className="btn-secondary text-sm">Cancel</button></div>
          </form>
        )}
        {costs.isLoading ? <Spinner size="sm" /> : (costs.data?.data.length ?? 0) === 0 ? <EmptyState message="No direct cost recorded yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2">Category</th><th>Description</th><th>Amount</th><th>Incurred</th><th>State</th><th></th></tr></thead>
            <tbody>{costs.data!.data.map((c: any) => (
              <tr key={c.id} className="border-b border-gray-900">
                <td className="py-2 text-gray-300 text-xs font-mono">{c.category}</td>
                <td className="text-gray-300">{c.description || '—'}</td>
                <td className="text-gray-200 font-mono">{money(c.amount)}</td>
                <td className="text-gray-500 text-xs">{fmtDate(c.incurredDate)}</td>
                <td>{pill(c.status)}</td>
                <td className="text-right">{isAdmin && (
                  <div className="flex gap-2 justify-end text-xs">
                    {c.status === 'DRAFT' && <button onClick={() => run(() => financeApi.costAction(c.id, 'submit'), 'Submitted')} className="text-blue-400 hover:text-blue-300">Submit</button>}
                    {c.status === 'SUBMITTED' && <>
                      <button onClick={() => run(() => financeApi.costAction(c.id, 'approve'), 'Approved')} className="text-green-400 hover:text-green-300">Approve</button>
                      <button onClick={() => { const r = window.prompt('Rejection reason:'); if (r) run(() => financeApi.costAction(c.id, 'reject', { reason: r }), 'Rejected') }} className="text-red-400 hover:text-red-300">Reject</button>
                    </>}
                    {c.status !== 'VOIDED' && <button onClick={() => { const r = window.prompt('Why is this cost being voided?'); if (r) run(() => financeApi.costAction(c.id, 'void', { reason: r }), 'Voided') }} className="text-gray-500 hover:text-gray-300">Void</button>}
                  </div>
                )}</td>
              </tr>
            ))}</tbody></table>
        )}
        <p className="text-[10px] text-gray-600 mt-2">
          Only an APPROVED cost is an incurred cost, and only an approved cost can be invoiced. Voiding keeps the row
          and takes the money back out — a cost is never deleted.
        </p>
      </div>

      {/* Invoices */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-200">Invoices</h3>
          <div className="flex items-center gap-2">
            <InvoiceLedgerExport
              contractId={contractId}
              contractNumber={contractNumber}
              count={invoices.data?.data.length ?? 0}
            />
            {isAdmin && <button onClick={() => setShowInvoice((v) => !v)} className="btn-primary text-xs flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" /> Generate invoice</button>}
          </div>
        </div>
        {isAdmin && showInvoice && (
          <form onSubmit={(e) => { e.preventDefault(); run(() => financeApi.createInvoice(contractId, { dueDate: iso(invForm.dueDate), feeAmount: invForm.feeAmount ? Number(invForm.feeAmount) : undefined }), 'Invoice generated from approved time & costs').then(() => setShowInvoice(false)) }} className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4 bg-gray-900/50 border border-gray-800 rounded-lg p-3">
            <label className="text-xs text-gray-500 flex flex-col gap-1">Due date<input type="date" value={invForm.dueDate} onChange={(e) => setInvForm({ ...invForm, dueDate: e.target.value })} className={inp} /></label>
            <label className="text-xs text-gray-500 flex flex-col gap-1">Fee $ (optional)<input type="number" min="0" value={invForm.feeAmount} onChange={(e) => setInvForm({ ...invForm, feeAmount: e.target.value })} className={inp} /></label>
            <div className="flex gap-2 items-end"><button type="submit" className="btn-primary text-sm">Generate</button><button type="button" onClick={() => setShowInvoice(false)} className="btn-secondary text-sm">Cancel</button></div>
          </form>
        )}
        {invoices.isLoading ? <Spinner size="sm" /> : (invoices.data?.data.length ?? 0) === 0 ? <EmptyState message="No invoices yet. Generate one from approved time & costs." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2">Number</th><th>Total</th><th>Paid</th><th>Due</th><th>Status</th><th></th></tr></thead>
            <tbody>{invoices.data!.data.map((i) => <InvoiceRow key={i.id} inv={i} isAdmin={isAdmin} run={run} />)}</tbody></table>
        )}
      </div>
    </div>
  )
}

/**
 * One invoice, with its lines on demand.
 *
 * The lines carry the CLIN they bill against, which is what a government
 * invoice has to show. It comes down from the time entry or cost behind the
 * line, so what is billed always agrees with what was recorded.
 */
/**
 * A preview of the invoice, as the customer would receive it.
 *
 * The three exports are three different jobs, which is why all three are here
 * rather than one "export" that has to guess. The PDF is the copy you send a
 * person and is rendered on the server so it looks identical whoever produced
 * it. The CSV is for keying into a billing system. Print is for a physical
 * copy, and prints this preview as shown.
 */
function InvoicePreview({ invoice, onClose }: { invoice: any; onClose: () => void }) {
  const [busy, setBusy] = useState<'pdf' | 'csv' | null>(null)
  const { toast } = useToast()
  if (!invoice) return null
  const lines: any[] = invoice.lineItems ?? []

  const download = (kind: 'pdf' | 'csv') => {
    setBusy(kind)
    const run = kind === 'pdf'
      ? financeApi.exportInvoicePdf(invoice.id, invoice.invoiceNumber)
      : financeApi.exportInvoice(invoice.id, invoice.invoiceNumber)
    void run
      .catch(() => toast(`${invoice.invoiceNumber} could not be exported.`, 'error'))
      .finally(() => setBusy(null))
  }

  const toolBtn = 'text-xs px-3 py-1.5 rounded border inline-flex items-center gap-1.5 transition-colors disabled:opacity-50'

  return (
    <div className="fixed inset-0 z-50 bg-black/70 overflow-y-auto p-4 print:static print:bg-white print:p-0"
      role="dialog" aria-label="Invoice preview">
      <div className="max-w-3xl mx-auto bg-white text-gray-900 rounded-lg shadow-2xl p-8 print:shadow-none print:rounded-none print:max-w-none">
        <div className="flex justify-between items-center gap-4 mb-6 -mx-8 -mt-8 px-6 py-3 bg-gray-50 border-b border-gray-200 rounded-t-lg print:hidden">
          <p className="text-xs text-gray-500">
            Export copy — it is not transmitted to any government billing system.
          </p>
          <div className="flex gap-2">
            <button onClick={() => download('pdf')} disabled={busy !== null}
              className={`${toolBtn} bg-gray-900 border-gray-900 text-white hover:bg-gray-700`}>
              <FileDown className="w-3.5 h-3.5" />{busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
            </button>
            <button onClick={() => download('csv')} disabled={busy !== null}
              className={`${toolBtn} border-gray-300 text-gray-700 hover:bg-gray-100`}>
              <Download className="w-3.5 h-3.5" />{busy === 'csv' ? 'Preparing…' : 'Download CSV'}
            </button>
            <button onClick={() => window.print()} className={`${toolBtn} border-gray-300 text-gray-700 hover:bg-gray-100`}>
              <Printer className="w-3.5 h-3.5" />Print
            </button>
            <button onClick={onClose} aria-label="Close preview"
              className={`${toolBtn} border-gray-300 text-gray-500 hover:bg-gray-100`}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex justify-between items-start gap-6 border-b border-gray-300 pb-4">
          <div>
            <h2 className="text-2xl font-bold">INVOICE</h2>
            <p className="text-sm font-mono mt-1">{invoice.invoiceNumber}</p>
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">{invoice.customerName ?? '—'}</p>
            <p className="text-gray-600">Invoice date {fmtDate(invoice.invoiceDate)}</p>
            <p className="text-gray-600">Due {fmtDate(invoice.dueDate)}</p>
            {(invoice.periodStart || invoice.periodEnd) && (
              <p className="text-gray-600">Period {fmtDate(invoice.periodStart)} – {fmtDate(invoice.periodEnd)}</p>
            )}
          </div>
        </div>

        <table className="w-full text-sm mt-6">
          <thead><tr className="text-left border-b border-gray-300">
            <th className="py-2">CLIN</th><th>Type</th><th>Description</th>
            <th className="text-right">Qty</th><th className="text-right">Rate</th><th className="text-right">Amount</th>
          </tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.id} className="border-b border-gray-200">
              <td className="py-1.5 font-mono">{l.clin?.clinNumber ?? '—'}</td>
              <td className="text-gray-600">{l.kind}</td>
              <td>{l.description}</td>
              <td className="text-right font-mono">{l.quantity ?? ''}</td>
              <td className="text-right font-mono">{l.rate ?? ''}</td>
              <td className="text-right font-mono">{money(l.amount)}</td>
            </tr>
          ))}</tbody>
        </table>

        <div className="flex justify-end mt-6">
          <dl className="text-sm w-64 space-y-1">
            <div className="flex justify-between"><dt className="text-gray-600">Subtotal</dt><dd className="font-mono">{money(invoice.subtotal)}</dd></div>
            <div className="flex justify-between border-t border-gray-300 pt-1"><dt className="font-semibold">Total</dt><dd className="font-mono font-semibold">{money(invoice.total)}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-600">Paid</dt><dd className="font-mono">{money(invoice.amountPaid)}</dd></div>
            <div className="flex justify-between"><dt className="font-semibold">Outstanding</dt><dd className="font-mono font-semibold">{money(Number(invoice.total) - Number(invoice.amountPaid))}</dd></div>
          </dl>
        </div>

        <p className="text-[10px] text-gray-500 mt-8 border-t border-gray-200 pt-3">
          Prepared from approved timesheets and approved costs. Each line shows the CLIN it was recorded against.
          This is a printable copy — it is not a filed submission to any government billing system.
        </p>
      </div>
    </div>
  )
}

function InvoiceRow({ inv, isAdmin, run }: { inv: any; isAdmin: boolean; run: (fn: () => Promise<unknown>, ok: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState(false)
  const outstanding = Number(inv.total) - Number(inv.amountPaid)
  const detail = useQuery<{ data: any }>({
    queryKey: ['fin-invoice', inv.id],
    queryFn: () => financeApi.getInvoice(inv.id),
    enabled: open || preview,
  })
  const lines: any[] = detail.data?.data?.lineItems ?? []

  return (
    <>
    {preview && <InvoicePreview invoice={detail.data?.data} onClose={() => setPreview(false)} />}
    <tr className="border-b border-gray-900">
      <td className="py-2 font-mono text-xs text-gray-200">
        <button onClick={() => setOpen((v) => !v)} className="hover:text-blue-300" aria-expanded={open}>
          {open ? '▾' : '▸'} {inv.invoiceNumber}
        </button>
      </td>
      <td className="text-gray-300">{money(inv.total)}</td>
      <td className="text-gray-400">{money(inv.amountPaid)}</td>
      <td className="text-gray-400">{fmtDate(inv.dueDate)}</td>
      <td><span className="text-[10px] px-1.5 py-0.5 rounded border bg-gray-800 border-gray-700 text-gray-300">{inv.status}</span></td>
      <td className="text-right">{(
        <div className="flex gap-2 justify-end text-xs">
          {isAdmin && inv.status === 'DRAFT' && <button onClick={() => run(() => financeApi.invoiceAction(inv.id, 'approve'), 'Approved')} className="text-green-400 hover:text-green-300">Approve</button>}
          {isAdmin && inv.status === 'APPROVED' && <button onClick={() => run(() => financeApi.invoiceAction(inv.id, 'submit'), 'Marked submitted')} className="text-blue-400 hover:text-blue-300">Mark submitted</button>}
          <button onClick={() => setPreview(true)} className="text-gray-400 hover:text-gray-200">Preview</button>
          {isAdmin && ['SUBMITTED', 'PARTIALLY_PAID', 'APPROVED'].includes(inv.status) && outstanding > 0 && (
            <button onClick={() => { const a = window.prompt(`Payment amount (outstanding ${outstanding.toFixed(2)}):`); if (a && Number(a) > 0) run(() => financeApi.addPayment(inv.id, { amount: Number(a) }), 'Payment recorded') }} className="text-emerald-400 hover:text-emerald-300">Record payment</button>
          )}
        </div>
      )}</td>
    </tr>
    {open && (
      <tr className="border-b border-gray-900">
        <td colSpan={6} className="bg-gray-950/50 px-3 py-3">
          {detail.isLoading ? <Spinner size="sm" /> : lines.length === 0 ? (
            <p className="text-xs text-gray-500">This invoice has no lines.</p>
          ) : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-gray-600 border-b border-gray-800">
                <th className="py-1.5">CLIN</th><th>Kind</th><th>Description</th><th className="text-right">Amount</th>
              </tr></thead>
              <tbody>{lines.map((l) => (
                <tr key={l.id} className="border-b border-gray-900/60">
                  <td className="py-1.5 font-mono text-gray-300">{l.clin?.clinNumber ?? '—'}</td>
                  <td className="text-gray-500">{l.kind}</td>
                  <td className="text-gray-400">{l.description}</td>
                  <td className="text-right text-gray-300">{money(l.amount)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          <p className="text-[10px] text-gray-600 mt-2">
            The CLIN comes from the time entry or cost behind each line, so the bill always matches the record.
            A fee spans the invoice and carries no CLIN.
          </p>
        </td>
      </tr>
    )}
    </>
  )
}

/**
 * The invoice ledger export.
 *
 * Its own component rather than an `ExportButton` because the rows it exports
 * are not the rows this page holds — the lines live behind a per-invoice fetch,
 * so the file is assembled on the server and arrives as a download.
 */
function InvoiceLedgerExport({ contractId, contractNumber, count }: { contractId: string; contractNumber?: string; count: number }) {
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  const empty = count === 0
  return (
    <button
      type="button"
      disabled={empty || busy}
      aria-label="Export the invoice ledger as CSV"
      title={empty ? 'Nothing to export yet' : `Export ${count} invoice(s) and every line item as CSV`}
      onClick={() => {
        setBusy(true)
        void financeApi.exportInvoiceLedger(contractId, contractNumber ?? 'contract')
          .catch(() => toast('The invoice ledger could not be exported.', 'error'))
          .finally(() => setBusy(false))
      }}
      className="text-[11px] px-2 py-1 rounded border border-gray-700 text-gray-400 inline-flex items-center gap-1.5
                 hover:text-gray-200 hover:border-gray-600 transition-colors
                 disabled:opacity-40 disabled:cursor-not-allowed">
      <Download className="w-3 h-3" />
      {busy ? 'Preparing…' : 'CSV'}
      {!empty && !busy && <span className="text-gray-600 font-mono">{count}</span>}
    </button>
  )
}

function FinCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'red' | 'green' }) {
  const vc = tone === 'red' ? 'text-red-300' : tone === 'green' ? 'text-green-300' : 'text-gray-100'
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-bold mt-0.5 ${vc}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}
