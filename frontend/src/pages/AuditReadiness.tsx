// =============================================================
// §8.2 — Audit readiness: the incurred-cost evidence for one fiscal year.
//
// The gaps are shown FIRST, above the numbers. A package that leads with a
// clean-looking total and buries "47 timesheets were never approved" further
// down is the failure mode this screen exists to prevent — the reader has to
// meet the holes before they meet the figures.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, FileSpreadsheet, Info } from 'lucide-react'
import { PageHeader, Spinner } from '../components/ui'
import { Badge, EmptyPanel, ErrorPanel } from '../components/section6/Section6Ui'
import { useToast } from '../components/Toast'
import { financeApi } from '../services/api'

interface Gap { severity: 'BLOCKING' | 'REVIEW'; area: string; detail: string; count: number }
interface ClinRow { clinNumber: string | null; clinLevel: string | null; directLabour: string; directCosts: string; total: string }
interface ContractRow {
  contractId: string; contractNumber: string; title: string; agency: string | null
  directLabour: string; directCosts: string; subcontract: string
  totalIncurred: string; billed: string; collected: string; byClin: ClinRow[]
}
interface RateRow {
  rateType: string; poolName: string | null; actualRate: string
  status: string; isHumanVerified: boolean; periodStart: string; periodEnd: string
}
interface Pkg {
  fiscalYear: number; periodStart: string; periodEnd: string; generatedAt: string
  contracts: ContractRow[]
  totals: { directLabour: string; directCosts: string; subcontract: string; totalIncurred: string; billed: string; collected: string }
  indirectRates: RateRow[]
  gaps: Gap[]
  notes: string[]
}

const usd = (v: string) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const day = (iso: string) => iso.slice(0, 10)
const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

const PANEL = 'bg-gray-900 border border-gray-800 rounded-xl p-4'

function Total({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={PANEL}>
      <p className="text-[10px] uppercase tracking-widest text-gray-500">{label}</p>
      <p className="text-lg font-mono text-gray-100 mt-0.5">{value}</p>
      {hint && <p className="text-[11px] text-gray-500 mt-1">{hint}</p>}
    </div>
  )
}

export default function AuditReadiness() {
  const { toast } = useToast()
  const thisYear = new Date().getFullYear()
  const [fiscalYear, setFiscalYear] = useState(thisYear)
  const [pkg, setPkg] = useState<Pkg | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await financeApi.auditPackage({ fiscalYear })
      setPkg(res.data as Pkg)
    } catch (err) {
      setError(readError(err, 'Could not assemble the evidence package.'))
    } finally {
      setLoading(false)
    }
  }, [fiscalYear])
  useEffect(() => { void load() }, [load])

  const download = async () => {
    setExporting(true)
    try {
      await financeApi.exportAuditPackage(fiscalYear)
      toast('Evidence package exported.', 'success')
    } catch (err) {
      toast(readError(err, 'Could not export the package.'), 'error')
    } finally { setExporting(false) }
  }

  const blocking = pkg?.gaps.filter((g) => g.severity === 'BLOCKING') ?? []
  const review = pkg?.gaps.filter((g) => g.severity === 'REVIEW') ?? []
  const withActivity = pkg?.contracts.filter((c) => c.totalIncurred !== '0.00') ?? []

  return (
    <div className="max-w-6xl mx-auto px-6 py-6 space-y-5">
      <PageHeader
        title="Audit readiness"
        subtitle="The incurred-cost evidence for one fiscal year, assembled from the firm's own records."
      />

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2">
          <span className="text-[11px] text-gray-500">Fiscal year</span>
          <input aria-label="Fiscal year" type="number" value={fiscalYear}
            onChange={(e) => setFiscalYear(Number(e.target.value))}
            className="w-28 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500" />
        </label>
        <button onClick={() => void download()} disabled={exporting || !pkg}
          className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-50 flex items-center gap-1.5">
          <Download className="w-3.5 h-3.5" /> {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
        {pkg && (
          <span className="text-[11px] text-gray-500 font-mono">
            {day(pkg.periodStart)} – {day(pkg.periodEnd)}
          </span>
        )}
      </div>

      {loading ? <Spinner /> : error ? <ErrorPanel message={error} onRetry={load} /> : !pkg ? null : (
        <>
          {/* Gaps first, deliberately. */}
          {pkg.gaps.length === 0 ? (
            <div className="bg-green-950/20 border border-green-900/60 rounded-xl p-4">
              <p className="text-sm text-green-300">Nothing is missing or unverified for this period.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {blocking.map((g, i) => (
                <div key={`b${i}`} className="bg-red-950/25 border border-red-900/60 rounded-xl p-3 flex gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge tone="danger">BLOCKING</Badge>
                      <span className="text-[12px] text-gray-300">{g.area}</span>
                    </div>
                    <p className="text-[12px] text-gray-300 mt-1">{g.detail}</p>
                  </div>
                </div>
              ))}
              {review.map((g, i) => (
                <div key={`r${i}`} className="bg-amber-950/20 border border-amber-900/60 rounded-xl p-3 flex gap-2.5">
                  <Info className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge tone="warning">REVIEW</Badge>
                      <span className="text-[12px] text-gray-300">{g.area}</span>
                    </div>
                    <p className="text-[12px] text-gray-300 mt-1">{g.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Total label="Direct labour" value={usd(pkg.totals.directLabour)} hint="At cost, not billing rate." />
            <Total label="Direct costs" value={usd(pkg.totals.directCosts)} />
            <Total label="Subcontract" value={usd(pkg.totals.subcontract)} />
            <Total label="Total incurred" value={usd(pkg.totals.totalIncurred)} hint="Approved records only." />
            <Total label="Billed" value={usd(pkg.totals.billed)} />
            <Total label="Collected" value={usd(pkg.totals.collected)} />
          </div>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-200">Schedule A — incurred cost by contract</h2>
            {withActivity.length === 0 ? (
              <EmptyPanel message="No contract incurred cost in this period." hint="Approved time and costs are what count." />
            ) : (
              <div className={`${PANEL} overflow-x-auto`}>
                <table className="w-full text-[12px]">
                  <thead><tr className="text-left text-gray-500 border-b border-gray-800">
                    <th className="py-2">Contract</th><th>Agency</th>
                    <th className="text-right">Labour</th><th className="text-right">Costs</th>
                    <th className="text-right">Subcontract</th><th className="text-right">Incurred</th>
                    <th className="text-right">Billed</th>
                  </tr></thead>
                  <tbody>{withActivity.map((c) => (
                    <tr key={c.contractId} className="border-b border-gray-900">
                      <td className="py-2">
                        <span className="font-mono text-gray-200">{c.contractNumber}</span>
                        <span className="block text-gray-500">{c.title}</span>
                      </td>
                      <td className="text-gray-500">{c.agency ?? '—'}</td>
                      <td className="text-right font-mono text-gray-300">{usd(c.directLabour)}</td>
                      <td className="text-right font-mono text-gray-300">{usd(c.directCosts)}</td>
                      <td className="text-right font-mono text-gray-300">{usd(c.subcontract)}</td>
                      <td className="text-right font-mono text-gray-100">{usd(c.totalIncurred)}</td>
                      <td className="text-right font-mono text-gray-300">{usd(c.billed)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>

          {withActivity.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-gray-200">Schedule B — incurred cost by CLIN</h2>
              {withActivity.map((c) => (
                <div key={c.contractId} className={`${PANEL} overflow-x-auto`}>
                  <p className="text-[12px] font-mono text-gray-300 mb-2">{c.contractNumber}</p>
                  <table className="w-full text-[12px]">
                    <thead><tr className="text-left text-gray-500 border-b border-gray-800">
                      <th className="py-1.5">CLIN</th><th>Tier</th>
                      <th className="text-right">Labour</th><th className="text-right">Costs</th><th className="text-right">Total</th>
                    </tr></thead>
                    <tbody>{c.byClin.map((k, i) => (
                      <tr key={`${c.contractId}-${k.clinNumber ?? 'none'}-${i}`} className="border-b border-gray-900">
                        <td className="py-1.5 font-mono text-gray-300">
                          {k.clinNumber ?? <span className="text-amber-500/80">(unattributed)</span>}
                        </td>
                        <td className="text-gray-500">{k.clinLevel ?? '—'}</td>
                        <td className="text-right font-mono text-gray-300">{usd(k.directLabour)}</td>
                        <td className="text-right font-mono text-gray-300">{usd(k.directCosts)}</td>
                        <td className="text-right font-mono text-gray-100">{usd(k.total)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ))}
            </section>
          )}

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-200">Schedule C — actual indirect rates</h2>
            {pkg.indirectRates.length === 0 ? (
              <EmptyPanel
                message={`No actual rate recorded for FY${pkg.fiscalYear}.`}
                hint="Record the pools that were actually experienced on the Indirect Rates page."
              />
            ) : (
              <div className={`${PANEL} overflow-x-auto`}>
                <table className="w-full text-[12px]">
                  <thead><tr className="text-left text-gray-500 border-b border-gray-800">
                    <th className="py-2">Pool</th><th>Period</th><th className="text-right">Rate</th><th>State</th>
                  </tr></thead>
                  <tbody>{pkg.indirectRates.map((r, i) => (
                    <tr key={i} className="border-b border-gray-900">
                      <td className="py-2 text-gray-200">
                        {r.rateType}{r.poolName && <span className="text-gray-500"> · {r.poolName}</span>}
                      </td>
                      <td className="text-gray-500">{day(r.periodStart)} – {day(r.periodEnd)}</td>
                      <td className="text-right font-mono text-gray-200">{Number(r.actualRate).toFixed(4)}%</td>
                      <td>{r.isHumanVerified ? <Badge tone="success">VERIFIED</Badge> : <Badge tone="warning">RECORDED ONLY</Badge>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>

          <div className={PANEL}>
            <p className="text-[11px] uppercase tracking-widest text-gray-500 mb-2 flex items-center gap-1.5">
              <FileSpreadsheet className="w-3.5 h-3.5" /> What this package is
            </p>
            <ul className="space-y-1.5">
              {pkg.notes.map((n, i) => <li key={i} className="text-[12px] text-gray-400">· {n}</li>)}
            </ul>
            <p className="text-[10px] text-gray-600 mt-3 font-mono">Generated {pkg.generatedAt}</p>
          </div>
        </>
      )}
    </div>
  )
}
