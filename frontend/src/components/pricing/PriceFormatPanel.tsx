// =============================================================
// The price in the format the solicitation asks for (backend
// services/priceFormat.ts), so the Pricing page asks only for that:
//   LINE_ITEMS      the schedule of items, read from the solicitation; you
//                   enter a unit price per item; amounts and totals follow.
//   LABOR_RATES     a fully loaded hourly rate per labor category, worked out
//                   from the cost build-up below.
//   COST_BREAKDOWN  the full cost build-up below.
//   NONE            no price (Sources Sought / RFI).
// The format the solicitation calls for is chosen automatically and marked
// "Required" with why; it can be switched while the price is a draft.
// =============================================================
import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, Loader, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { pricingApi } from '../../services/api'
import { useToast } from '../Toast'

export interface LineItem { id: string; itemNumber: string; description: string; quantity: string | number; unit: string; unitPrice: string | number | null; periodLabel: string | null; source: string }
export interface PriceWorkspace {
  id: string; status: string; priceFormat: string
  lineItems?: LineItem[]; itemsStatus?: string | null; itemsNote?: string | null
  quoteValidityDays?: number | null; promptPayDiscount?: string | null
}
export interface LaborScenario {
  laborLines: Array<{ id: string; categoryName: string; hours: string; baseRate: string | null }>
  totalDirectLabor: string | null; subtotalBeforeFee: string | null; totalFee: string | null; totalOdc: string | null; totalSubcontractor: string | null
  sensitiveRedacted?: boolean
}
interface FormatInfo { key: string; name: string; asks: string }

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const errorText = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not save'

/** Fringe, overhead, G&A and fee over direct labor: what turns a direct rate into a fully loaded one. */
export function wrapFactor(s: LaborScenario): number {
  const direct = Number(s.totalDirectLabor ?? 0)
  if (!direct) return 1
  const loaded = Number(s.subtotalBeforeFee ?? 0) + Number(s.totalFee ?? 0) - Number(s.totalOdc ?? 0) - Number(s.totalSubcontractor ?? 0)
  return loaded > 0 ? loaded / direct : 1
}

export function PriceFormatPanel({ ws, scenario, isAdmin, onChanged }: { ws: PriceWorkspace; scenario: LaborScenario | null; isAdmin: boolean; onChanged: () => void }) {
  const { toast } = useToast()
  const editable = isAdmin && ws.status === 'DRAFT'
  const matchesQuery = useQuery({ queryKey: ['price-format', ws.id], queryFn: () => pricingApi.formatMatches(ws.id) })
  const matches: Array<{ format: string; reason: string }> = matchesQuery.data?.data?.matches ?? []
  const formats: FormatInfo[] = matchesQuery.data?.data?.formats ?? []
  const [showOthers, setShowOthers] = useState(false)
  const setFormat = useMutation({
    mutationFn: (f: string) => pricingApi.setFormat(ws.id, f),
    onSuccess: () => { onChanged(); void matchesQuery.refetch() },
    onError: (e) => toast(errorText(e), 'error'),
  })
  const format = ws.priceFormat
  const current = formats.find((f) => f.key === format)
  const required = matches.find((m) => m.format === format)
  const others = formats.filter((f) => f.key !== format)

  return (
    <section className="card space-y-4" aria-labelledby="price-format-heading">
      <div>
        <h2 id="price-format-heading" className="text-sm font-semibold text-gray-100">What the solicitation asks you to price</h2>
        {current && (
          <div className="mt-2 rounded-lg p-3" style={{ border: '2px solid var(--accent)', background: 'var(--surface-2)' }}>
            {required && <span className="chip chip-success !text-[10px] mb-1.5">{matches.length > 1 ? 'Accepted by this solicitation' : 'Required by this solicitation'}</span>}
            <p className="text-sm font-medium text-gray-100">{current.name}</p>
            <p className="text-xs text-gray-400 mt-0.5">{required?.reason ?? current.asks}</p>
            {!required && matches.length > 0 && (
              <p className="text-xs mt-1" style={{ color: 'var(--warning, #f59e0b)' }}>The solicitation asks for {formats.find((f) => f.key === matches[0].format)?.name.toLowerCase()}: {matches[0].reason}</p>
            )}
          </div>
        )}
        {editable && (
          <div className="mt-2">
            <button type="button" onClick={() => setShowOthers((v) => !v)} aria-expanded={showOthers} className="text-xs font-medium" style={{ color: 'var(--accent)' }}>
              {showOthers ? 'Keep this format' : 'Use a different format'}
            </button>
            {showOthers && (
              <div className="grid gap-2 sm:grid-cols-3 mt-2">
                {others.map((f) => (
                  <button key={f.key} type="button" onClick={() => { setFormat.mutate(f.key); setShowOthers(false) }} disabled={setFormat.isPending}
                    className="text-left rounded-lg p-2.5 text-xs" style={{ border: '1px solid var(--line)' }}>
                    <span className="block font-medium text-gray-200">{f.name}</span>
                    <span className="block text-gray-500 mt-0.5">{f.asks}</span>
                    {matches.some((m) => m.format === f.key) && <span className="chip chip-success !text-[10px] mt-1">Accepted by this solicitation</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {format === 'LINE_ITEMS' && <LineItems ws={ws} editable={editable} onChanged={onChanged} />}
      {format === 'LABOR_RATES' && <LaborRates scenario={scenario} />}
      {format === 'COST_BREAKDOWN' && <p className="text-xs text-gray-400">Build every cost element below: labor, indirect rates (fringe, overhead, G&A), other direct costs and the fee. The proposal shows this breakdown.</p>}
      {format === 'NONE' && <p className="text-sm text-gray-300">This solicitation asks for no price. Approve the price to move on; the proposal will carry none.</p>}
      {(format === 'LINE_ITEMS' || format === 'LABOR_RATES') && <QuoteDetails ws={ws} editable={editable} onChanged={onChanged} />}
    </section>
  )
}

function LineItems({ ws, editable, onChanged }: { ws: PriceWorkspace; editable: boolean; onChanged: () => void }) {
  const { toast } = useToast()
  const items = ws.lineItems ?? []
  const preparing = ws.itemsStatus === 'PREPARING'
  const [form, setForm] = useState({ itemNumber: '', description: '', quantity: '1', unit: 'EA', periodLabel: '' })
  const add = useMutation({
    mutationFn: () => pricingApi.addLineItem(ws.id, { itemNumber: form.itemNumber.trim(), description: form.description.trim(), quantity: Number(form.quantity), unit: form.unit.trim() || 'EA', periodLabel: form.periodLabel.trim() || null }),
    onSuccess: () => { setForm({ itemNumber: '', description: '', quantity: '1', unit: form.unit, periodLabel: form.periodLabel }); onChanged() },
    onError: (e) => toast(errorText(e), 'error'),
  })
  const remove = useMutation({ mutationFn: (id: string) => pricingApi.deleteLineItem(id), onSuccess: onChanged, onError: (e) => toast(errorText(e), 'error') })
  const read = useMutation({ mutationFn: () => pricingApi.readLineItems(ws.id), onSuccess: onChanged, onError: (e) => toast(errorText(e), 'error') })

  const periods = [...new Set(items.map((i) => i.periodLabel ?? ''))]
  const amount = (i: LineItem) => (i.unitPrice === null || i.unitPrice === '' ? null : Number(i.unitPrice) * Number(i.quantity))
  const total = items.reduce((n, i) => n + (amount(i) ?? 0), 0)
  const unpriced = items.filter((i) => amount(i) === null).length

  return (
    <div className="space-y-3">
      {preparing ? (
        <p className="text-sm text-gray-300 flex items-center gap-2" role="status"><Loader className="w-4 h-4 animate-spin" /> Reading the items to price from the solicitation…</p>
      ) : ws.itemsNote ? <p className="text-xs text-gray-400">{ws.itemsNote}</p> : null}

      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="data-table text-sm">
            <thead><tr><th className="text-left">Item</th><th className="text-left">Description</th><th className="text-right">Qty</th><th className="text-left">Unit</th><th className="text-right">Unit price</th><th className="text-right">Amount</th>{editable && <th />}</tr></thead>
            <tbody>
              {periods.map((p) => (
                <PeriodRows key={p} period={p} rows={items.filter((i) => (i.periodLabel ?? '') === p)} showHeading={periods.length > 1 || !!p} editable={editable} amount={amount} onChanged={onChanged} onDelete={(id) => remove.mutate(id)} />
              ))}
              <tr><td colSpan={5} className="text-right font-semibold">Total price</td><td className="text-right font-semibold tabular-nums">{money(total)}</td>{editable && <td />}</tr>
            </tbody>
          </table>
        </div>
      )}
      {items.length > 0 && unpriced > 0 && <p className="text-xs" style={{ color: 'var(--warning, #f59e0b)' }}>{unpriced} of {items.length} item{items.length === 1 ? '' : 's'} still need a unit price.</p>}

      {editable && !preparing && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <input aria-label="Item number" value={form.itemNumber} onChange={(e) => setForm({ ...form, itemNumber: e.target.value })} placeholder="Item (e.g. 0001)" className="input !py-1.5 !text-xs w-24" />
            <input aria-label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Description" className="input !py-1.5 !text-xs flex-1 min-w-[10rem]" />
            <input aria-label="Quantity" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} inputMode="decimal" className="input !py-1.5 !text-xs w-16" />
            <input aria-label="Unit" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} className="input !py-1.5 !text-xs w-16" />
            <input aria-label="Period" value={form.periodLabel} onChange={(e) => setForm({ ...form, periodLabel: e.target.value })} placeholder="Period (optional)" className="input !py-1.5 !text-xs w-32" />
            <button type="button" onClick={() => add.mutate()} disabled={add.isPending || !form.itemNumber.trim() || !form.description.trim() || !(Number(form.quantity) > 0)} className="btn-secondary btn-sm flex items-center gap-1 disabled:opacity-50"><Plus className="w-3.5 h-3.5" /> Add item</button>
          </div>
          {items.length === 0 && (
            <button type="button" onClick={() => read.mutate()} disabled={read.isPending} className="btn-secondary btn-sm flex items-center gap-1.5 disabled:opacity-50">
              <RefreshCw className="w-3.5 h-3.5" /> Read the items from the solicitation (1 token)
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function PeriodRows({ period, rows, showHeading, editable, amount, onChanged, onDelete }: {
  period: string; rows: LineItem[]; showHeading: boolean; editable: boolean
  amount: (i: LineItem) => number | null; onChanged: () => void; onDelete: (id: string) => void
}) {
  return (
    <>
      {showHeading && <tr><td colSpan={editable ? 7 : 6} className="text-xs font-semibold pt-3" style={{ color: 'var(--text-2)' }}>{period || 'Items'}</td></tr>}
      {rows.map((i) => {
        const a = amount(i)
        return (
          <tr key={i.id}>
            <td className="tabular-nums whitespace-nowrap">{i.itemNumber}</td>
            <td>{i.description}{i.source === 'SOLICITATION' && <span className="text-[10px] ml-1.5" style={{ color: 'var(--text-muted)' }}>from the solicitation</span>}</td>
            <td className="text-right tabular-nums">{Number(i.quantity).toLocaleString('en-US')}</td>
            <td>{i.unit}</td>
            <td className="text-right">{editable ? <UnitPrice item={i} onChanged={onChanged} /> : (i.unitPrice === null ? '—' : money(Number(i.unitPrice)))}</td>
            <td className="text-right tabular-nums">{a === null ? '—' : money(a)}</td>
            {editable && <td><button type="button" onClick={() => onDelete(i.id)} aria-label={`Delete item ${i.itemNumber}`} className="btn-ghost btn-sm"><Trash2 className="w-3.5 h-3.5" /></button></td>}
          </tr>
        )
      })}
    </>
  )
}

/** The unit price, saved when the field is left. */
function UnitPrice({ item, onChanged }: { item: LineItem; onChanged: () => void }) {
  const { toast } = useToast()
  const saved = item.unitPrice === null ? '' : String(Number(item.unitPrice))
  const [v, setV] = useState(saved)
  useEffect(() => setV(saved), [saved])
  const save = useMutation({
    mutationFn: () => pricingApi.updateLineItem(item.id, { unitPrice: v.trim() === '' ? null : Number(v) }),
    onSuccess: onChanged,
    onError: (e) => { toast(errorText(e), 'error'); setV(saved) },
  })
  const commit = () => { if (v !== saved && (v.trim() === '' || Number(v) >= 0)) save.mutate() }
  return (
    <input aria-label={`Unit price for item ${item.itemNumber}`} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
      inputMode="decimal" placeholder="0.00" className="input !py-1 !text-xs w-28 text-right tabular-nums" />
  )
}

function LaborRates({ scenario }: { scenario: LaborScenario | null }) {
  if (!scenario || scenario.laborLines.length === 0) return <p className="text-xs text-gray-400">Add the labor categories, hours and direct rates in the cost build-up below; their fully loaded rates appear here.</p>
  if (scenario.sensitiveRedacted) return <p className="text-xs text-gray-400">Labor rates are visible to admins only.</p>
  const wrap = wrapFactor(scenario)
  let total = 0
  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto">
        <table className="data-table text-sm">
          <thead><tr><th className="text-left">Labor category</th><th className="text-right">Est. hours</th><th className="text-right">Direct rate</th><th className="text-right">Fully loaded rate</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {scenario.laborLines.map((l) => {
              const loaded = Math.round(Number(l.baseRate ?? 0) * wrap * 100) / 100
              const amount = loaded * Number(l.hours)
              total += amount
              return <tr key={l.id}><td>{l.categoryName}</td><td className="text-right tabular-nums">{Number(l.hours).toLocaleString('en-US')}</td><td className="text-right tabular-nums">{money(Number(l.baseRate ?? 0))}</td><td className="text-right tabular-nums font-medium">{money(loaded)}</td><td className="text-right tabular-nums">{money(amount)}</td></tr>
            })}
            <tr><td colSpan={4} className="text-right font-semibold">Total</td><td className="text-right font-semibold tabular-nums">{money(total)}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500"><Check className="w-3 h-3 inline mr-1" />Fully loaded rate = direct rate × {wrap.toFixed(3)} (your fringe, overhead, G&A and fee from the build-up below). The proposal shows only the loaded rates (FAR 16.601).</p>
    </div>
  )
}

function QuoteDetails({ ws, editable, onChanged }: { ws: PriceWorkspace; editable: boolean; onChanged: () => void }) {
  const { toast } = useToast()
  const [days, setDays] = useState(ws.quoteValidityDays ? String(ws.quoteValidityDays) : '')
  const [discount, setDiscount] = useState(ws.promptPayDiscount ?? '')
  useEffect(() => { setDays(ws.quoteValidityDays ? String(ws.quoteValidityDays) : ''); setDiscount(ws.promptPayDiscount ?? '') }, [ws.quoteValidityDays, ws.promptPayDiscount])
  const save = useMutation({
    mutationFn: () => pricingApi.setQuote(ws.id, { quoteValidityDays: days.trim() ? Number(days) : null, promptPayDiscount: discount.trim() || null }),
    onSuccess: onChanged,
    onError: (e) => toast(errorText(e), 'error'),
  })
  if (!editable) {
    return (ws.quoteValidityDays || ws.promptPayDiscount)
      ? <p className="text-xs text-gray-400">{ws.quoteValidityDays ? `Prices valid for ${ws.quoteValidityDays} days. ` : ''}{ws.promptPayDiscount ? `Prompt payment discount: ${ws.promptPayDiscount}.` : ''}</p>
      : null
  }
  const changed = days !== (ws.quoteValidityDays ? String(ws.quoteValidityDays) : '') || discount !== (ws.promptPayDiscount ?? '')
  return (
    <div className="flex flex-wrap items-end gap-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
      <label className="text-xs text-gray-400">Prices valid for (days)
        <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" placeholder="e.g. 90" className="input !py-1.5 !text-xs w-24 block mt-1" />
      </label>
      <label className="text-xs text-gray-400">Prompt payment discount (optional)
        <input value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="e.g. 2% 10 days" className="input !py-1.5 !text-xs w-40 block mt-1" />
      </label>
      {changed && <button type="button" onClick={() => save.mutate()} disabled={save.isPending || (!!days.trim() && !(Number(days) >= 1))} className="btn-secondary btn-sm disabled:opacity-50">Save quote details</button>}
    </div>
  )
}
