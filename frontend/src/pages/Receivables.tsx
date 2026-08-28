// =============================================================
// §7.8 — Receivables.
//
// Enhanced in place rather than replaced by a second finance application.
//
// A DRAFT invoice is never shown here. Nobody owes money on a document that has
// not been sent, and counting one would overstate what the firm is owed — the
// single most misleading thing a receivables page can do. The Finance Agent's
// draft count is surfaced separately, as work awaiting review.
//
// Every amount is a backend-computed Decimal string, formatted not calculated.
// =============================================================
import { Link } from 'react-router-dom'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Bot, FileText, Info } from 'lucide-react'
import { financeApi } from '../services/api'
import { financeAgentApi, formatMoney, type AgedReceivable } from '../services/financeAgentApi'
import { PageHeader, Spinner, ErrorBanner } from '../components/ui'
import { ExportButton } from '../components/ExportButton'
import { isoDate, num, type Column } from '../utils/exportTable'
import { useToast } from '../components/Toast'

// The ageing bucket travels with the row, because "what is 90+ days late" is
// the question this export exists to answer and recomputing it from a due date
// in a spreadsheet would use a different clock than the server did.
const RECEIVABLE_COLUMNS: ReadonlyArray<Column<AgedReceivable>> = [
  { header: 'Invoice number', value: (r) => r.invoiceNumber },
  { header: 'Customer', value: (r) => r.customerName },
  { header: 'Status', value: (r) => r.status },
  { header: 'Due date', value: (r) => isoDate(r.dueDate) },
  { header: 'Due date recorded', value: (r) => (r.dueDateUnknown ? 'NO' : 'YES') },
  { header: 'Days overdue', value: (r) => r.overdueDays },
  { header: 'Ageing bucket', value: (r) => r.bucketLabel },
  { header: 'Invoice total (USD)', value: (r) => num(r.total) },
  { header: 'Paid (USD)', value: (r) => num(r.amountPaid) },
  { header: 'Outstanding (USD)', value: (r) => num(r.outstanding) },
]

const BUCKET_TONE: Record<string, string> = {
  CURRENT: 'text-gray-100',
  D1_30: 'text-gray-100',
  D31_60: 'text-yellow-300',
  D61_90: 'text-orange-300',
  D91_120: 'text-red-300',
  D120_PLUS: 'text-red-300',
}

/**
 * What was actually done about a late invoice.
 *
 * Recording a chase never changes the invoice status. An ageing report that
 * improved because somebody sent an email would be worse than no report — the
 * money is still outstanding until a payment is recorded on the invoice.
 */
function InvoiceChasing({ invoiceId, invoiceNumber }: { invoiceId: string; invoiceNumber: string }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ method: 'EMAIL', contactName: '', note: '', nextActionAt: '' })

  const list = useQuery<{ data: any[] }>({
    queryKey: ['invoice-follow-ups', invoiceId],
    queryFn: () => financeApi.listFollowUps(invoiceId),
    enabled: open,
  })

  const add = useMutation({
    mutationFn: () => financeApi.addFollowUp(invoiceId, {
      method: form.method,
      contactName: form.contactName || null,
      note: form.note,
      nextActionAt: form.nextActionAt ? new Date(form.nextActionAt).toISOString() : null,
    }),
    onSuccess: () => {
      toast('Follow-up recorded.', 'success')
      setForm({ ...form, note: '', nextActionAt: '' })
      void qc.invalidateQueries({ queryKey: ['invoice-follow-ups', invoiceId] })
    },
    onError: (err: any) => toast(err?.response?.data?.error || 'Could not record that follow-up.', 'error'),
  })

  const resolve = useMutation({
    mutationFn: (id: string) => financeApi.resolveFollowUp(id),
    onSuccess: () => {
      toast('Follow-up closed.', 'success')
      void qc.invalidateQueries({ queryKey: ['invoice-follow-ups', invoiceId] })
    },
    onError: (err: any) => toast(err?.response?.data?.error || 'Could not close that follow-up.', 'error'),
  })

  const rows = list.data?.data ?? []
  const input = 'bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 outline-none focus:border-blue-500'

  return (
    <div className="mt-2 pt-2 border-t border-gray-800">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">
          {open ? 'Hide follow-ups' : 'Follow-ups'}
        </button>
        <button onClick={() => void financeApi.exportInvoicePdf(invoiceId, invoiceNumber)}
          className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">
          Invoice PDF
        </button>
        <button onClick={() => void financeApi.exportInvoice(invoiceId, invoiceNumber)}
          className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">
          Invoice CSV
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          {list.isLoading ? <Spinner size="sm" /> : rows.length === 0 ? (
            <p className="text-[11px] text-gray-500">Nobody has chased this invoice yet.</p>
          ) : (
            <ul className="space-y-1">
              {rows.map((f) => (
                <li key={f.id} className="text-[11px] text-gray-400">
                  <span className="font-mono text-gray-300">{new Date(f.contactedAt).toLocaleDateString()}</span>
                  {' · '}{f.method}{f.contactName ? ` · ${f.contactName}` : ''} — {f.note}
                  {f.nextActionAt && <span className="text-gray-500"> · next {new Date(f.nextActionAt).toLocaleDateString()}</span>}
                  {f.resolvedAt ? (
                    <span className="text-green-500/80"> · closed</span>
                  ) : (
                    <button onClick={() => resolve.mutate(f.id)} className="ml-1 text-blue-400 hover:text-blue-300">close</button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <form className="flex gap-2 flex-wrap items-center"
            onSubmit={(e) => { e.preventDefault(); if (form.note.trim()) add.mutate() }}>
            <select aria-label="Method" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className={input}>
              {['EMAIL', 'PHONE', 'PORTAL', 'LETTER', 'OTHER'].map((m) => <option key={m}>{m}</option>)}
            </select>
            <input aria-label="Who you contacted" placeholder="Who you contacted" value={form.contactName}
              onChange={(e) => setForm({ ...form, contactName: e.target.value })} className={input} />
            <input aria-label="What was said" required placeholder="What was said" value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })} className={`${input} flex-1 min-w-[180px]`} />
            <input aria-label="Next action date" type="date" value={form.nextActionAt}
              onChange={(e) => setForm({ ...form, nextActionAt: e.target.value })} className={input} />
            <button type="submit" disabled={add.isPending}
              className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-50">
              {add.isPending ? 'Saving…' : 'Record'}
            </button>
          </form>
          <p className="text-[10px] text-gray-600">
            Recording a chase does not change the invoice status. It stays outstanding until a payment is recorded.
          </p>
        </div>
      )}
    </div>
  )
}

export function ReceivablesPage() {
  const aging = useQuery<{ data: any }>({ queryKey: ['receivables'], queryFn: () => financeApi.receivables() })
  const alerts = useQuery<{ data: any[] }>({ queryKey: ['fin-alerts'], queryFn: () => financeApi.alerts() })
  const agent = useQuery({ queryKey: ['finance-agent-status'], queryFn: () => financeAgentApi.status() })

  const status = agent.data?.status ?? null
  const receivables: AgedReceivable[] = status?.receivables.overdueInvoices ?? []

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader title="Receivables & Financial Alerts" subtitle="Outstanding invoice balances by age, and contract financial warnings" />

      {/* --- Finance Agent status ---------------------------------------- */}
      <section className="card mb-6" data-testid="finance-agent-summary">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-gray-400" />
            <div>
              <h2 className="font-semibold text-gray-200">Finance Agent</h2>
              <p className="text-xs text-gray-500">
                Prepares draft invoices and ages receivables. It never approves, submits or marks an invoice paid.
              </p>
            </div>
          </div>
          {agent.data?.schedule?.isEnabled
            ? <span className="text-[10px] px-1.5 py-0.5 rounded border bg-green-950/30 border-green-800 text-green-300">ENABLED</span>
            : <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-400">DISABLED</span>}
        </div>
        {agent.isLoading ? <Spinner size="md" /> : agent.error ? (
          <ErrorBanner message="Could not load the Finance Agent status." />
        ) : (
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>
              <dt className="text-gray-500">Last run</dt>
              <dd className="text-gray-300" data-testid="finance-last-run">
                {agent.data?.lastRun ? `${agent.data.lastRun.status} · ${new Date(agent.data.lastRun.createdAt).toLocaleDateString()}` : 'Never run'}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Drafts awaiting review</dt>
              <dd className="text-gray-300" data-testid="finance-drafts">
                {status ? status.invoices.draftsReadyForReview : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Open escalations</dt>
              <dd className="text-gray-300" data-testid="finance-escalations-count">{agent.data?.escalations.length ?? 0}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Autonomy</dt>
              <dd className="text-gray-300 font-mono">{agent.data?.schedule?.autonomyLevel ?? 'PROPOSE'}</dd>
            </div>
          </dl>
        )}
        <p className="flex items-start gap-1.5 text-[11px] text-gray-500 mt-3" data-testid="draft-not-receivable-note">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>A draft invoice is not a receivable. Drafts are counted above as work awaiting review, never as money owed.</span>
        </p>
      </section>

      {/* --- ageing buckets ------------------------------------------------ */}
      <section className="card mb-6">
        <h2 className="font-semibold text-gray-200 mb-3">Receivables ageing</h2>
        {aging.isLoading ? <Spinner size="md" /> : aging.error ? <ErrorBanner message="Could not load receivables." /> : (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <Bucket label="Current" value={aging.data!.data.current} />
            <Bucket label="1–30 days" value={aging.data!.data.d1_30} />
            <Bucket label="31–60 days" value={aging.data!.data.d31_60} tone="text-yellow-300" />
            <Bucket label="61–90 days" value={aging.data!.data.d61_90} tone="text-orange-300" />
            <Bucket label="91–120 days" value={aging.data!.data.d91_120} tone="text-red-300" />
            <Bucket label="120+ days" value={aging.data!.data.d120plus} tone="text-red-300" />
            <Bucket label="Total outstanding" value={aging.data!.data.totalOutstanding} tone="text-blue-300" />
          </div>
        )}
      </section>

      {/* --- invoice detail ------------------------------------------------ */}
      <section className="card mb-6" data-testid="receivable-detail">
        <div className="flex items-center gap-2 mb-3">
          <FileText className="w-4 h-4 text-gray-400" />
          <h2 className="font-semibold text-gray-200">Outstanding invoices</h2>
          <div className="ml-auto">
            <ExportButton rows={receivables} columns={RECEIVABLE_COLUMNS} filename="receivables-ageing" what="receivables ageing" />
          </div>
        </div>
        {receivables.length === 0 ? (
          <p className="text-sm text-gray-500">
            No overdue receivable is outstanding. Only submitted and partially paid invoices appear here.
          </p>
        ) : (
          <ul className="space-y-2">
            {receivables.map((r) => (
              <li key={r.invoiceId} className="border border-gray-800 rounded-lg p-3 text-xs" data-testid={`receivable-${r.invoiceId}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="text-gray-200 font-medium">{r.invoiceNumber}</span>
                    {r.customerName && <span className="text-gray-500"> · {r.customerName}</span>}
                    <p className="text-gray-500">
                      Due {r.dueDate ? new Date(r.dueDate).toLocaleDateString() : 'not recorded'}
                      {r.overdueDays > 0 && ` · ${r.overdueDays} days overdue`}
                    </p>
                  </div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border border-gray-700 font-mono ${BUCKET_TONE[r.bucket]}`}>
                    {r.bucketLabel}
                  </span>
                </div>
                <dl className="grid grid-cols-3 gap-2 mt-2">
                  <div><dt className="text-gray-500">Invoice total</dt><dd className="text-gray-300 font-mono">{formatMoney(r.total)}</dd></div>
                  <div><dt className="text-gray-500">Paid</dt><dd className="text-gray-300 font-mono">{formatMoney(r.amountPaid)}</dd></div>
                  <div><dt className="text-gray-500">Outstanding</dt><dd className="text-gray-100 font-mono font-semibold">{formatMoney(r.outstanding)}</dd></div>
                </dl>
                {r.dueDateUnknown && (
                  <p className="text-yellow-400 mt-1" data-testid={`no-due-date-${r.invoiceId}`}>
                    No due date is recorded, so this invoice cannot be called overdue.
                  </p>
                )}
                <InvoiceChasing invoiceId={r.invoiceId} invoiceNumber={r.invoiceNumber} />
              </li>
            ))}
          </ul>
        )}
        {status && status.receivables.invoicesWithoutDueDate > 0 && (
          <p className="text-[11px] text-yellow-400 mt-2" data-testid="receivables-limitation">
            {status.receivables.invoicesWithoutDueDate} outstanding invoice(s) have no due date recorded and are reported as current.
          </p>
        )}
      </section>

      {/* --- agent escalations --------------------------------------------- */}
      {(agent.data?.escalations.length ?? 0) > 0 && (
        <section className="card mb-6" data-testid="finance-escalations">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-yellow-400" />
            <h2 className="font-semibold text-gray-200">Finance Agent escalations</h2>
          </div>
          <ul className="space-y-2">
            {agent.data!.escalations.map((e) => (
              <li key={e.id} className="border border-gray-800 rounded-lg p-2 text-xs">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-gray-300">{e.title}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${e.severity === 'HIGH' ? 'bg-red-950/40 border-red-800 text-red-300' : 'bg-yellow-950/40 border-yellow-800 text-yellow-300'}`}>{e.severity}</span>
                </div>
                <p className="text-gray-500">{e.reason}</p>
                {e.recommendedAction && <p className="text-gray-400 mt-1">{e.recommendedAction}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* --- existing financial alerts -------------------------------------- */}
      <section className="card">
        <div className="flex items-center gap-2 mb-3"><AlertTriangle className="w-4 h-4 text-yellow-400" /><h2 className="font-semibold text-gray-200">Financial alerts</h2></div>
        {alerts.isLoading ? <Spinner size="md" /> : alerts.error ? <ErrorBanner message="Could not load alerts." /> : alerts.data!.data.length === 0 ? (
          <p className="text-sm text-gray-500">No financial alerts. Funding, ceilings, invoices and approvals are all healthy.</p>
        ) : (
          <ul className="space-y-2">
            {alerts.data!.data.map((a, i) => (
              <li key={i} className="flex items-center justify-between border border-gray-800 rounded-lg px-3 py-2">
                <span className="text-sm text-gray-300">{a.message}</span>
                <div className="flex items-center gap-3">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${a.severity === 'HIGH' ? 'bg-red-950/40 border-red-800 text-red-300' : a.severity === 'MEDIUM' ? 'bg-yellow-950/40 border-yellow-800 text-yellow-300' : 'bg-gray-800 border-gray-700 text-gray-400'}`}>{a.severity}</span>
                  {a.link && <Link to={a.link} className="text-xs text-blue-400 hover:text-blue-300">Open →</Link>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Bucket({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <p className="text-[11px] text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-base font-bold mt-0.5 ${tone ?? 'text-gray-100'}`}>{formatMoney(value)}</p>
    </div>
  )
}

export default ReceivablesPage
