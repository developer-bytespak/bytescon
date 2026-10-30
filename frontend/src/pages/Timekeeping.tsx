import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { financeApi, contractMgmtApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { PageHeader, SkeletonRows, StatusPill, EmptyState, ErrorBanner } from '../components/ui'
import { ExportButton } from '../components/ExportButton'
import { isoDate, num, type Column } from '../utils/exportTable'
import { Plus } from 'lucide-react'
import { DcaaReadinessPanel } from '../components/section7/FinanceAgentPanels'

const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')
const iso = (d: string) => (d ? new Date(d).toISOString() : undefined)
const inp = 'input'
const badge = (s: string) => <StatusPill status={s} />

// A DCAA auditor asks for time by contract, by date, by category, with the
// approval trail attached — so the export carries who approved it and when,
// not just the hours. Cost rate is deliberately absent: the row is what the
// person worked, and this table never showed a cost rate to begin with.
const TIME_COLUMNS: ReadonlyArray<Column<any>> = [
  { header: 'Work date', value: (r) => isoDate(r.workDate) },
  { header: 'Contract', value: (r) => r.contract?.contractNumber },
  { header: 'CLIN', value: (r) => r.clin?.clinNumber },
  { header: 'Labour category', value: (r) => r.laborCategory },
  { header: 'Hours', value: (r) => num(r.hours) },
  { header: 'Billing amount (USD)', value: (r) => num(r.billingAmount) },
  { header: 'Status', value: (r) => r.status },
  { header: 'Submitted', value: (r) => isoDate(r.submittedAt) },
  { header: 'Approved', value: (r) => isoDate(r.approvedAt) },
  { header: 'Rejection reason', value: (r) => r.rejectionReason },
]

export function TimekeepingPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const qc = useQueryClient()
  const { toast } = useToast()
  const [show, setShow] = useState(false)
  const [f, setF] = useState({ contractId: '', laborCategory: '', workDate: '', hours: '' })

  const mine = useQuery<{ data: any[] }>({ queryKey: ['my-time'], queryFn: () => financeApi.myTime() })
  const contracts = useQuery<{ data: any[] }>({ queryKey: ['contracts-for-time'], queryFn: () => contractMgmtApi.list({ limit: 100 }) })
  const approvals = useQuery<{ data: any[] }>({ queryKey: ['time-approvals'], queryFn: () => financeApi.approvals(), enabled: isAdmin })

  const refresh = () => { qc.invalidateQueries({ queryKey: ['my-time'] }); qc.invalidateQueries({ queryKey: ['time-approvals'] }) }
  const run = (fn: () => Promise<unknown>, ok: string) => fn().then(() => { refresh(); toast(ok, 'success') }).catch((e: any) => toast(e?.response?.data?.error || 'Action failed', 'error'))

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader title="Timekeeping" subtitle="Designed to support disciplined, auditable timekeeping">
        {isAdmin && <button onClick={() => setShow((v) => !v)} className="btn-primary flex items-center gap-2"><Plus className="w-4 h-4" /> Log time</button>}
      </PageHeader>

      {isAdmin && show && (
        <form
          onSubmit={(e) => { e.preventDefault(); run(() => financeApi.addTime(f.contractId, { laborCategory: f.laborCategory, workDate: iso(f.workDate), hours: Number(f.hours) }), 'Draft time entry created').then(() => { setShow(false); setF({ contractId: '', laborCategory: '', workDate: '', hours: '' }) }) }}
          className="card mb-6 grid grid-cols-1 md:grid-cols-4 gap-3 animate-fade-up"
        >
          <select required value={f.contractId} onChange={(e) => setF({ ...f, contractId: e.target.value })} className={inp}>
            <option value="">Select contract…</option>
            {(contracts.data?.data || []).map((c) => <option key={c.id} value={c.id}>{c.contractNumber} — {c.title}</option>)}
          </select>
          <input required placeholder="Labor category" value={f.laborCategory} onChange={(e) => setF({ ...f, laborCategory: e.target.value })} className={inp} />
          <input required type="date" value={f.workDate} onChange={(e) => setF({ ...f, workDate: e.target.value })} className={inp} />
          <input required type="number" min="0.25" max="24" step="0.25" placeholder="Hours" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} className={inp} />
          {!contracts.isLoading && (contracts.data?.data || []).length === 0 && (
            <p className="md:col-span-4 text-xs text-yellow-400">Time is logged against a contract — create one under Delivery → Contracts first.</p>
          )}
          <div className="md:col-span-4 flex gap-2"><button type="submit" className="btn-primary btn-sm">Create draft</button><button type="button" onClick={() => setShow(false)} className="btn-secondary btn-sm">Cancel</button></div>
        </form>
      )}

      <div className="mb-6">
        <DcaaReadinessPanel />
      </div>

      {/* My time */}
      <section className="card mb-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h2 className="text-sm font-semibold text-gray-200">My time entries</h2>
          <ExportButton rows={mine.data?.data ?? []} columns={TIME_COLUMNS} filename="my-time-entries" what="my time entries" />
        </div>
        {mine.isLoading ? <SkeletonRows rows={4} cols={5} /> : mine.error ? <ErrorBanner message="Could not load time entries." /> : mine.data!.data.length === 0 ? <EmptyState message="No time logged yet." /> : (
          <div className="table-wrap">
          <table className="data-table"><thead><tr><th>Date</th><th>Category</th><th className="!text-right">Hours</th><th className="!text-right">Billing</th><th>Status</th><th></th></tr></thead>
            <tbody>{mine.data!.data.map((t) => (
              <tr key={t.id}>
                <td className="text-gray-300 tabular-nums whitespace-nowrap">{fmtDate(t.workDate)}</td><td className="text-gray-400">{t.laborCategory}</td><td className="text-right tabular-nums text-gray-300">{Number(t.hours)}</td>
                <td className="text-right tabular-nums text-gray-400">{t.billingAmount != null ? `$${Number(t.billingAmount).toLocaleString()}` : '—'}</td><td>{badge(t.status)}</td>
                <td className="text-right">{isAdmin && (t.status === 'DRAFT' || t.status === 'REJECTED') && <button onClick={() => run(() => financeApi.submitTime(t.id), 'Submitted for approval')} className="btn-ghost btn-sm">Submit</button>}</td>
              </tr>
            ))}</tbody></table>
          </div>
        )}
      </section>

      {/* Approval queue (ADMIN) */}
      {isAdmin && (
        <section className="card">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <h2 className="text-sm font-semibold text-gray-200">Approval queue</h2>
            <ExportButton rows={approvals.data?.data ?? []} columns={TIME_COLUMNS} filename="time-awaiting-approval" what="time awaiting approval" />
          </div>
          {approvals.isLoading ? <SkeletonRows rows={3} cols={4} /> : (approvals.data?.data.length ?? 0) === 0 ? <p className="text-sm text-gray-500 py-6 text-center">Nothing awaiting approval.</p> : (
            <div className="table-wrap">
            <table className="data-table"><thead><tr><th>Contract</th><th>Date</th><th>Category</th><th className="!text-right">Hours</th><th></th></tr></thead>
              <tbody>{approvals.data!.data.map((t) => (
                <tr key={t.id}>
                  <td className="text-gray-300 font-medium">{t.contract?.contractNumber}</td><td className="text-gray-400 tabular-nums whitespace-nowrap">{fmtDate(t.workDate)}</td><td className="text-gray-400">{t.laborCategory}</td><td className="text-right tabular-nums text-gray-300">{Number(t.hours)}</td>
                  <td className="text-right"><div className="flex gap-2 justify-end">
                    <button onClick={() => run(() => financeApi.approveTime(t.id), 'Approved')} className="btn-secondary btn-sm text-green-400">Approve</button>
                    <button onClick={() => { const r = window.prompt('Rejection reason:'); if (r) run(() => financeApi.rejectTime(t.id, r), 'Rejected') }} className="btn-ghost btn-sm text-red-400">Reject</button>
                  </div></td>
                </tr>
              ))}</tbody></table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

export default TimekeepingPage
