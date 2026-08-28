// =============================================================
// §8.2 — Indirect rate pools: fringe, overhead and G&A.
//
// Two sides that must never be confused. The PROVISIONAL rate is what the firm
// priced with; the ACTUAL rate is what the year really cost. The platform never
// derives one from the other — an actual rate exists only because a person
// recorded it, and the variance is only meaningful once someone has verified
// that the actual is right.
//
// That is why "recorded" and "verified" are separate states on screen.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Plus, TrendingUp } from 'lucide-react'
import { PageHeader, Spinner } from '../components/ui'
import { ExportButton } from '../components/ExportButton'
import { isoDate, num, type Column } from '../utils/exportTable'
import { Badge, EmptyPanel, ErrorPanel } from '../components/section6/Section6Ui'
import { useAuth } from '../hooks/useAuth'
import { useTabParam } from '../hooks/useTabParam'
import { useToast } from '../components/Toast'
import {
  financeAgentApi,
  type ActualRateRow, type RateVariance, type VarianceState,
} from '../services/financeAgentApi'

const RATE_TYPES = ['FRINGE', 'OVERHEAD', 'GA', 'MATERIAL_HANDLING', 'SUBCONTRACT_HANDLING', 'OTHER'] as const
type RateType = (typeof RATE_TYPES)[number]

const RATE_LABEL: Record<RateType, string> = {
  FRINGE: 'Fringe',
  OVERHEAD: 'Overhead',
  GA: 'G&A',
  MATERIAL_HANDLING: 'Material handling',
  SUBCONTRACT_HANDLING: 'Subcontract handling',
  OTHER: 'Other',
}

// Verified state travels with the rate. An incurred-cost submission built on a
// rate nobody checked is a finding, so the column that says so has to survive
// the export — it is the whole reason the two states are separate on screen.
const ACTUAL_RATE_COLUMNS: ReadonlyArray<Column<ActualRateRow>> = [
  { header: 'Pool', value: (r) => RATE_LABEL[r.rateType as RateType] ?? r.rateType },
  { header: 'Pool name', value: (r) => r.poolName },
  { header: 'Fiscal year', value: (r) => r.fiscalYear },
  { header: 'Period start', value: (r) => isoDate(r.periodStart) },
  { header: 'Period end', value: (r) => isoDate(r.periodEnd) },
  { header: 'Actual rate %', value: (r) => num(r.actualRate) },
  { header: 'Source', value: (r) => r.source },
  { header: 'Source reference', value: (r) => r.sourceReference },
  { header: 'Human verified', value: (r) => (r.isHumanVerified ? 'YES' : 'NO') },
  { header: 'Verified at', value: (r) => isoDate(r.verifiedAt) },
  { header: 'Notes', value: (r) => r.notes },
]

// A missing side stays empty rather than becoming a zero. Zero is a rate; blank
// is "we do not have this", and the difference is the point of the screen.
const VARIANCE_COLUMNS: ReadonlyArray<Column<RateVariance>> = [
  { header: 'Pool', value: (r) => RATE_LABEL[r.rateType as RateType] ?? r.rateType },
  { header: 'Pool name', value: (r) => r.poolName },
  { header: 'Fiscal year', value: (r) => r.period.fiscalYear },
  { header: 'Period start', value: (r) => isoDate(r.period.start) },
  { header: 'Period end', value: (r) => isoDate(r.period.end) },
  { header: 'Provisional rate %', value: (r) => num(r.provisionalRate) },
  { header: 'Actual rate %', value: (r) => num(r.actualRate) },
  { header: 'Absolute variance', value: (r) => num(r.absoluteVariance) },
  { header: 'Relative variance %', value: (r) => (r.relativeVariancePct === null ? '' : r.relativeVariancePct) },
  { header: 'State', value: (r) => r.state },
  { header: 'Provisional source', value: (r) => r.provisionalSource },
  { header: 'Actual human verified', value: (r) => (r.actualIsHumanVerified ? 'YES' : 'NO') },
  { header: 'Limitations', value: (r) => r.limitations.join(' | ') },
]

const VARIANCE_TONE: Record<VarianceState, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  WITHIN_MONITORING_RANGE: 'success',
  REVIEW_RECOMMENDED: 'warning',
  MATERIAL_VARIANCE: 'danger',
  INSUFFICIENT_DATA: 'neutral',
}

const TABS = [
  { key: 'variance', label: 'Provisional vs actual' },
  { key: 'actuals', label: 'Recorded actuals' },
] as const

const pct = (v: string | null) => (v == null ? '—' : `${Number(v).toFixed(4)}%`)
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

const PANEL = 'bg-gray-900 border border-gray-800 rounded-xl p-4'
const INPUT = 'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500'

/** One pool's provisional baseline against what actually happened. */
function VarianceCard({ v }: { v: RateVariance }) {
  return (
    <div className={PANEL}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-gray-100">
          {RATE_LABEL[v.rateType as RateType] ?? v.rateType}
        </span>
        {v.poolName && <span className="text-[12px] text-gray-500">{v.poolName}</span>}
        <Badge tone={VARIANCE_TONE[v.state]}>{v.state.replace(/_/g, ' ')}</Badge>
        {!v.actualIsHumanVerified && v.actualRate != null && (
          <Badge tone="warning">NOT YET VERIFIED</Badge>
        )}
        <span className="ml-auto text-[11px] text-gray-500 font-mono">
          FY{v.period.fiscalYear} · {fmtDate(v.period.start)} – {fmtDate(v.period.end)}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-gray-500">Provisional</p>
          <p className="text-base font-mono text-gray-200 mt-0.5">{pct(v.provisionalRate)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-gray-500">Actual</p>
          <p className="text-base font-mono text-gray-200 mt-0.5">{pct(v.actualRate)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-gray-500">Difference</p>
          <p className="text-base font-mono text-gray-200 mt-0.5">{pct(v.absoluteVariance)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-gray-500">Relative</p>
          <p className="text-base font-mono text-gray-200 mt-0.5">
            {v.relativeVariancePct == null ? '—' : `${v.relativeVariancePct.toFixed(1)}%`}
          </p>
        </div>
      </div>

      <p className="text-[11px] text-gray-500 mt-3">Baseline: {v.provisionalSource}</p>

      {v.semanticMapping === 'PROPOSAL_PRICING_TO_ACTUAL' && (
        <p className="text-[11px] text-gray-500 mt-1">
          The provisional side is the rate the firm priced with. It is not a negotiated billing rate, so this
          difference is an indicator, not a billing adjustment.
        </p>
      )}

      {v.evidence.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {v.evidence.map((e, i) => <li key={i} className="text-[11px] text-gray-400">· {e}</li>)}
        </ul>
      )}
      {v.limitations.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {v.limitations.map((l, i) => (
            <li key={i} className="text-[11px] text-amber-500/80 flex gap-1.5">
              <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />{l}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Record a closed period's real rate. Never computed — a person enters it. */
function RecordRateForm({ onDone }: { onDone: () => Promise<void> | void }) {
  const { toast } = useToast()
  const thisYear = new Date().getFullYear()
  const [saving, setSaving] = useState(false)
  const [f, setF] = useState({
    rateType: 'FRINGE' as RateType,
    poolName: '',
    fiscalYear: String(thisYear - 1),
    periodStart: `${thisYear - 1}-01-01`,
    periodEnd: `${thisYear - 1}-12-31`,
    actualRate: '',
    poolCostAmount: '',
    allocationBaseAmount: '',
    sourceReference: '',
    notes: '',
  })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await financeAgentApi.recordActualRate({
        rateType: f.rateType,
        poolName: f.poolName || null,
        fiscalYear: Number(f.fiscalYear),
        periodStart: new Date(f.periodStart).toISOString(),
        periodEnd: new Date(f.periodEnd).toISOString(),
        actualRate: f.actualRate,
        poolCostAmount: f.poolCostAmount || null,
        allocationBaseAmount: f.allocationBaseAmount || null,
        sourceReference: f.sourceReference || null,
        notes: f.notes || null,
        source: 'MANUAL_ENTRY',
        status: 'FINAL',
      })
      toast('Actual rate recorded. It still needs verifying.', 'success')
      setF({ ...f, actualRate: '', poolCostAmount: '', allocationBaseAmount: '', sourceReference: '', notes: '' })
      await onDone()
    } catch (err) {
      toast(readError(err, 'Could not record that rate.'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className={`${PANEL} space-y-3`}>
      <p className="text-sm font-semibold text-gray-200">Record an actual rate</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block">
          <span className="text-[11px] text-gray-500">Pool</span>
          <select aria-label="Pool" value={f.rateType} onChange={(e) => setF({ ...f, rateType: e.target.value as RateType })} className={INPUT}>
            {RATE_TYPES.map((t) => <option key={t} value={t}>{RATE_LABEL[t]}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] text-gray-500">Pool name (optional)</span>
          <input aria-label="Pool name" value={f.poolName} onChange={(e) => setF({ ...f, poolName: e.target.value })} className={INPUT} placeholder="e.g. Engineering overhead" />
        </label>
        <label className="block">
          <span className="text-[11px] text-gray-500">Fiscal year</span>
          <input aria-label="Fiscal year" type="number" required value={f.fiscalYear} onChange={(e) => setF({ ...f, fiscalYear: e.target.value })} className={INPUT} />
        </label>
        <label className="block">
          <span className="text-[11px] text-gray-500">Period start</span>
          <input aria-label="Period start" type="date" required value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} className={INPUT} />
        </label>
        <label className="block">
          <span className="text-[11px] text-gray-500">Period end</span>
          <input aria-label="Period end" type="date" required value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} className={INPUT} />
        </label>
        <label className="block">
          <span className="text-[11px] text-gray-500">Actual rate %</span>
          <input aria-label="Actual rate" type="number" step="0.0001" required value={f.actualRate} onChange={(e) => setF({ ...f, actualRate: e.target.value })} className={INPUT} placeholder="e.g. 31.4200" />
        </label>
        <label className="block">
          <span className="text-[11px] text-gray-500">Pool cost $ (optional)</span>
          <input aria-label="Pool cost" type="number" step="0.01" value={f.poolCostAmount} onChange={(e) => setF({ ...f, poolCostAmount: e.target.value })} className={INPUT} />
        </label>
        <label className="block">
          <span className="text-[11px] text-gray-500">Allocation base $ (optional)</span>
          <input aria-label="Allocation base" type="number" step="0.01" value={f.allocationBaseAmount} onChange={(e) => setF({ ...f, allocationBaseAmount: e.target.value })} className={INPUT} />
        </label>
        <label className="block">
          <span className="text-[11px] text-gray-500">Source reference</span>
          <input aria-label="Source reference" value={f.sourceReference} onChange={(e) => setF({ ...f, sourceReference: e.target.value })} className={INPUT} placeholder="e.g. FY25 trial balance" />
        </label>
      </div>
      <input aria-label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} className={INPUT} placeholder="Notes (optional)" />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving}
          className="text-xs px-4 py-2 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-50 flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5" /> {saving ? 'Recording…' : 'Record rate'}
        </button>
        <p className="text-[11px] text-gray-600">
          Pool cost and allocation base are optional and are never back-solved from the rate.
        </p>
      </div>
    </form>
  )
}

export default function IndirectRates() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const { toast } = useToast()
  const [tab, setTab] = useTabParam(TABS.map((t) => t.key), 'variance')

  const [rates, setRates] = useState<ActualRateRow[]>([])
  const [variances, setVariances] = useState<RateVariance[]>([])
  const [limitations, setLimitations] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [actuals, status] = await Promise.all([
        financeAgentApi.actualRates(),
        // The variance comes from the Finance Agent's last run rather than
        // being recomputed here, so this screen and the agent can never
        // disagree about the same number.
        financeAgentApi.status().catch(() => null),
      ])
      setRates(actuals.rates)
      setVariances(status?.status?.indirectRates?.variances ?? [])
      setLimitations(status?.status?.dataLimitations ?? [])
    } catch (err) {
      setError(readError(err, 'Could not load indirect rates.'))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const verify = async (id: string) => {
    try {
      await financeAgentApi.verifyActualRate(id)
      toast('Rate verified.', 'success')
      await load()
    } catch (err) {
      toast(readError(err, 'Could not verify that rate.'), 'error')
    }
  }

  const rateLimitations = limitations.filter((l) => /rate/i.test(l))

  return (
    <div className="max-w-6xl mx-auto px-6 py-6 space-y-5">
      <PageHeader
        title="Indirect rates"
        subtitle="Fringe, overhead and G&A. What the firm priced with, against what the year actually cost."
      />

      <div className="flex gap-1 border-b border-gray-800">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? <Spinner /> : error ? <ErrorPanel message={error} onRetry={load} /> : (
        <>
          {tab === 'variance' && (
            <div className="space-y-3">
              {rateLimitations.length > 0 && (
                <div className="bg-amber-950/20 border border-amber-900/60 rounded-xl p-4 space-y-1">
                  {rateLimitations.map((l, i) => (
                    <p key={i} className="text-[12px] text-amber-500/90 flex gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />{l}
                    </p>
                  ))}
                </div>
              )}
              {variances.length === 0 ? (
                <EmptyPanel
                  message="No rate variance yet."
                  hint="A variance needs both sides: an active pricing template for the provisional rate, and at least one recorded actual rate."
                />
              ) : (
                <>
                  <div className="flex justify-end">
                    <ExportButton rows={variances} columns={VARIANCE_COLUMNS} filename="rate-variance" what="rate variance" />
                  </div>
                  {variances.map((v, i) => <VarianceCard key={`${v.rateType}-${v.period.start}-${i}`} v={v} />)}
                </>
              )}

              <p className="text-[10px] text-gray-600">
                An actual rate is never derived from a provisional one. If one side is missing, the variance says so
                rather than filling the gap.
              </p>
            </div>
          )}

          {tab === 'actuals' && (
            <div className="space-y-3">
              {isAdmin && <RecordRateForm onDone={load} />}

              {rates.length === 0 ? (
                <EmptyPanel message="No actual rate has been recorded yet." hint="Record a closed period's real rate to start monitoring variance." />
              ) : (
                <div className={`${PANEL} overflow-x-auto`}>
                  <div className="flex justify-end mb-2">
                    <ExportButton rows={rates} columns={ACTUAL_RATE_COLUMNS} filename="actual-indirect-rates" what="actual indirect rates" />
                  </div>
                  <table className="w-full text-[12px]">
                    <thead><tr className="text-left text-gray-500 border-b border-gray-800">
                      <th className="py-2">Pool</th><th>Fiscal year</th><th>Period</th>
                      <th className="text-right">Rate</th><th>Source</th><th>State</th><th></th>
                    </tr></thead>
                    <tbody>{rates.map((r) => (
                      <tr key={r.id} className="border-b border-gray-900">
                        <td className="py-2 text-gray-200">
                          {RATE_LABEL[r.rateType as RateType] ?? r.rateType}
                          {r.poolName && <span className="text-gray-500"> · {r.poolName}</span>}
                        </td>
                        <td className="text-gray-400 font-mono">FY{r.fiscalYear}</td>
                        <td className="text-gray-500">{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}</td>
                        <td className="text-right font-mono text-gray-200">{Number(r.actualRate).toFixed(4)}%</td>
                        <td className="text-gray-500">{r.source.replace(/_/g, ' ')}</td>
                        <td>
                          {r.isHumanVerified
                            ? <Badge tone="success">VERIFIED</Badge>
                            : <Badge tone="warning">RECORDED ONLY</Badge>}
                        </td>
                        <td className="text-right">
                          {isAdmin && !r.isHumanVerified && (
                            <button onClick={() => void verify(r.id)}
                              className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 flex items-center gap-1 ml-auto">
                              <Check className="w-3 h-3" /> Verify
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                  <p className="text-[10px] text-gray-600 mt-3 flex items-start gap-1.5">
                    <TrendingUp className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    Recording and verifying are separate on purpose. An imported rate nobody has checked still produces
                    a variance — the variance just says it is unverified.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
