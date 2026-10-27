import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { backtestApi } from '../services/api'
import { StatusPill, SkeletonRows, EmptyState } from '../components/ui'
import { motion } from 'framer-motion'
import {
  Loader, BarChart3, Play, AlertCircle, CheckCircle2, FileText, RefreshCw, HelpCircle,
} from 'lucide-react'

type MethodVersion = 'v1-synthetic' | 'v2-permutation'

interface RunRow {
  id: string
  status: 'RUNNING' | 'COMPLETE' | 'FAILED'
  sampleSize: number
  yearsBack: number
  startedAt: string
  completedAt: string | null
  predictionCount: number | null
  brierScore: number | null
  meanProbability: number | null
  errorMessage: string | null
  methodVersion?: MethodVersion
  cutoffDate?: string | null
  logLoss?: number | null
  rocAuc?: number | null
  ece?: number | null
  brierReliability?: number | null
  brierResolution?: number | null
  brierUncertainty?: number | null
}

function BacktestTooltip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span className="relative inline-flex items-center group">
      <HelpCircle
        className="w-3 h-3 text-gray-600 group-hover:text-amber-400 ml-1 cursor-help flex-shrink-0"
        aria-label={title ?? 'More info'}
      />
      <span
        className="invisible group-hover:visible group-focus-within:visible absolute z-40 left-full ml-2 top-1/2 -translate-y-1/2 w-72 p-2.5 rounded-md text-[11px] leading-relaxed text-gray-200 shadow-xl pointer-events-none"
        style={{ background: 'var(--surface-2)', border: '1px solid rgb(var(--ink) / 0.1)' }}
        role="tooltip"
      >
        {children}
      </span>
    </span>
  )
}

/** Tiny inline sparkline of recent Brier scores across runs. */
function BrierSparkline({ values, width = 90, height = 22 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (width - 2) + 1
      const y = height - 1 - ((v - min) / range) * (height - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  // Lower Brier is better → green if trending down (latest < first)
  const trendDown = values[values.length - 1] < values[0]
  return (
    <svg width={width} height={height} className="flex-shrink-0" aria-label="Brier trend">
      <polyline points={pts} fill="none" stroke={trendDown ? '#34d399' : '#f87171'} strokeWidth={1.5} />
    </svg>
  )
}

interface CalibrationBin {
  binMin: number
  binMax: number
  count: number
  meanPred: number
  observedRate: number
}

export default function AdminBacktestPage() {
  const qc = useQueryClient()
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [sampleSize, setSampleSize] = useState(1000)
  const [yearsBack, setYearsBack] = useState(5)
  const [methodVersion, setMethodVersion] = useState<MethodVersion>('v2-permutation')
  const [cutoffDate, setCutoffDate] = useState<string>('')
  const [methodFilter, setMethodFilter] = useState<'all' | MethodVersion>('all')

  const runsQuery = useQuery<{ data: RunRow[] }>({
    queryKey: ['backtest-runs'],
    queryFn: () => backtestApi.listRuns(),
    refetchInterval: 30_000,
  })

  const detailQuery = useQuery<any>({
    queryKey: ['backtest-run', selectedRunId],
    queryFn: () => backtestApi.getRun(selectedRunId!),
    enabled: !!selectedRunId,
  })

  const startMut = useMutation({
    mutationFn: () => backtestApi.startRun({ sampleSize, yearsBack, methodVersion, cutoffDate: cutoffDate || undefined }),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['backtest-runs'] })
      if (res?.data?.runId) setSelectedRunId(res.data.runId)
    },
  })

  const calibrationStatusQuery = useQuery<{ data: any }>({
    queryKey: ['calibration-status'],
    queryFn: () => backtestApi.calibrationStatus(),
    refetchInterval: 60_000,
  })

  const refreshCalibrationMut = useMutation({
    mutationFn: () => backtestApi.refreshCalibration(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calibration-status'] }),
  })

  // Auto-select the most recent COMPLETE run on first load if nothing selected
  const runs = runsQuery.data?.data ?? []
  useEffect(() => {
    if (!selectedRunId) {
      const latestComplete = runs.find((r) => r.status === 'COMPLETE')
      if (latestComplete) setSelectedRunId(latestComplete.id)
    }
  }, [runs, selectedRunId])

  const detail = detailQuery.data?.data
  const run: any = detail?.run
  const bins: CalibrationBin[] = run?.calibrationBins ?? []
  const factorMeans: Record<string, number> = run?.factorMeans ?? {}

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <span className="tile tile-accent mt-0.5"><BarChart3 className="w-5 h-5" /></span>
        <div className="min-w-0">
          <h1 className="page-title">
            Probability Engine Backtest
          </h1>
          <p className="page-subtitle max-w-3xl">
            Score historical federal contract winners with the production probability
            engine. Calibrates how well predicted win probabilities match observed
            outcomes. Read-only — does not change scoring weights.
          </p>
        </div>
      </div>

      {/* Run controls */}
      <div className="card space-y-4">
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label className="label flex items-center">
              Method
              <BacktestTooltip title="Methodology">
                <strong>v2-permutation</strong>: each award's positive = winner profile × own opportunity; K-1 negatives = winner profile × OTHER random sampled awards. Realistic distribution. Auto-fits an isotonic calibration curve on completion.<br/><br/>
                <strong>v1-synthetic</strong> (legacy): negatives built by mutating winner profile (wrong NAICS, inverted set-aside). Kept for back-compat; tends to overstate accuracy.
              </BacktestTooltip>
            </label>
            <select
              value={methodVersion}
              onChange={(e) => setMethodVersion(e.target.value as MethodVersion)}
              className="input w-auto"
            >
              <option value="v2-permutation">v2 — permutation negatives (recommended)</option>
              <option value="v1-synthetic">v1 — synthetic mutated profiles</option>
            </select>
          </div>
          <div>
            <label className="label">Sample size</label>
            <input
              type="number"
              min={50}
              max={2000}
              value={sampleSize}
              onChange={(e) => setSampleSize(parseInt(e.target.value) || 1000)}
              className="input tabular-nums w-28"
            />
          </div>
          <div>
            <label className="label">Years back</label>
            <input
              type="number"
              min={1}
              max={10}
              value={yearsBack}
              onChange={(e) => setYearsBack(parseInt(e.target.value) || 5)}
              className="input tabular-nums w-20"
            />
          </div>
          <div>
            <label className="label flex items-center">
              Cutoff date (opt.)
              <BacktestTooltip title="Time-split holdout">
                When set, only awards on/after this date count toward metrics. Earlier awards still get sampled (and may be used as permutation partners) but don't feed the calibration curve. Use for time-window comparison or to reserve a clean holdout.
              </BacktestTooltip>
            </label>
            <input
              type="date"
              value={cutoffDate}
              onChange={(e) => setCutoffDate(e.target.value)}
              className="input w-auto"
            />
          </div>
          <button
            onClick={() => startMut.mutate()}
            disabled={startMut.isPending}
            className="btn-primary disabled:opacity-50"
          >
            {startMut.isPending ? <Loader className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {startMut.isPending ? 'Running… (5–15 min)' : 'Run new backtest'}
          </button>
        </div>
        {startMut.isError && !startMut.isPending && (
          <div className="flex items-center gap-2">
            <p className="text-xs text-red-400 flex items-center gap-1 flex-1">
              <AlertCircle className="w-3 h-3" /> {(startMut.error as any)?.response?.data?.error ?? 'Run failed'}
            </p>
            <button
              onClick={() => startMut.reset()}
              className="btn-ghost btn-sm"
            >
              dismiss
            </button>
          </div>
        )}
        <p className="text-[11px] text-slate-600">
          The run is synchronous and will hold this page for several minutes. USAspending API
          is rate-limited; large samples take longer. Calibration metrics appear in the run
          detail panel below once the run completes.
        </p>
      </div>

      {/* Calibration cache panel */}
      <div className="rounded-xl p-4 flex items-center gap-4 flex-wrap"
        style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)' }}>
        {(() => {
          const cal = calibrationStatusQuery.data?.data
          const fitted = cal?.fitted ?? false
          const applied = cal?.applied ?? false
          const heading = applied
            ? 'Calibration Curve — Applied to Scores'
            : fitted
              ? 'Calibration Curve — Fitted (Not Applied)'
              : 'Calibration Curve — None Fitted'
          const headingColor = applied ? 'text-emerald-400' : fitted ? 'text-amber-400' : 'text-gray-400'
          return (
            <div className="flex-1 min-w-0">
              <p className={`text-[11px] ${headingColor} uppercase tracking-wide font-semibold flex items-center`}>
                {heading}
                <BacktestTooltip title="Calibration">
                  A fitted curve only adjusts win-probabilities when the env flag <code className="text-amber-300">ENABLE_PROBABILITY_CALIBRATION=1</code> is set — until then it is computed and cached but does not affect scores. Re-fits automatically on each v2-permutation run; click "Refresh" after a fresh run to load it.
                </BacktestTooltip>
              </p>
              {fitted ? (
                <div className="mt-1 text-xs text-slate-300 flex flex-wrap gap-x-4 gap-y-1">
                  <span className="tabular-nums">Run: <span className="font-mono text-slate-200">{cal.runId?.slice(0, 8)}…</span></span>
                  <span>Fitted: {cal.fittedAt ? new Date(cal.fittedAt).toLocaleString() : '—'}</span>
                  <span>n = {cal.sampleSize ?? '—'}</span>
                  <span>
                    Brier:{' '}
                    <span className="font-mono">
                      {cal.preBrier?.toFixed(4) ?? '—'} → {cal.postBrier?.toFixed(4) ?? '—'}
                    </span>
                  </span>
                  {applied ? (
                    <span className="text-emerald-400">Applied as the final scoring step</span>
                  ) : (
                    <span className="text-amber-400">Flag OFF — fitted but not applied in scoring</span>
                  )}
                </div>
              ) : (
                <p className="text-xs text-gray-500 mt-1">
                  No curve fitted. Run a v2-permutation backtest to fit one, then click Refresh.
                </p>
              )}
            </div>
          )
        })()}
        <button
          onClick={() => refreshCalibrationMut.mutate()}
          disabled={refreshCalibrationMut.isPending}
          className="btn-secondary btn-sm disabled:opacity-50"
        >
          {refreshCalibrationMut.isPending ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh cache
        </button>
      </div>

      {/* Runs table */}
      <div className="card p-0">
        <div className="px-5 py-3.5 border-b border-slate-700/50 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Recent runs</h2>
            {(() => {
              const brierTrend = runs
                .filter((r) => r.status === 'COMPLETE' && r.brierScore != null && (methodFilter === 'all' || r.methodVersion === methodFilter))
                .slice(0, 12)
                .reverse()
                .map((r) => r.brierScore!)
              return brierTrend.length >= 2 ? (
                <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
                  Brier trend (oldest → newest)
                  <BrierSparkline values={brierTrend} />
                </span>
              ) : null
            })()}
          </div>
          <div className="segmented">
            {(['all', 'v2-permutation', 'v1-synthetic'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setMethodFilter(f)}
                data-active={methodFilter === f}
              >
                {methodFilter === f && <motion.span layoutId="backtest-method" className="segmented-thumb" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                {f === 'all' ? 'all' : f === 'v2-permutation' ? 'v2' : 'v1'}
              </button>
            ))}
          </div>
        </div>
        {runsQuery.isLoading ? (
          <div className="px-5">
            <span className="sr-only">Loading runs...</span>
            <SkeletonRows rows={4} cols={6} />
          </div>
        ) : runs.length === 0 ? (
          <EmptyState message="No backtest runs yet." icon={<BarChart3 className="w-5 h-5" />} hint={null} />
        ) : (
          <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                {['Started', 'Method', 'Status', 'Sample', 'Years', 'Predictions', 'Brier', 'AUC', 'ECE', ''].map((h) => (
                  <th key={h} className={['Sample', 'Years', 'Predictions', 'Brier', 'AUC', 'ECE'].includes(h) ? 'text-right' : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs
                .filter((r) => methodFilter === 'all' || r.methodVersion === methodFilter)
                .map((r) => (
                <tr key={r.id}
                  className={`cursor-pointer ${selectedRunId === r.id ? 'bg-amber-900/10' : ''}`}
                  onClick={() => setSelectedRunId(r.id)}>
                  <td className="text-slate-400 text-xs whitespace-nowrap tabular-nums">{new Date(r.startedAt).toLocaleString()}</td>
                  <td>
                    <span className={`chip font-mono ${
                      r.methodVersion === 'v2-permutation'
                        ? 'chip-success'
                        : 'chip-neutral'
                    }`}>
                      {r.methodVersion === 'v2-permutation' ? 'v2' : r.methodVersion === 'v1-synthetic' ? 'v1' : '—'}
                    </span>
                  </td>
                  <td>
                    {r.status === 'COMPLETE' ? (
                      <StatusPill status="complete">COMPLETE</StatusPill>
                    ) : r.status === 'RUNNING' ? (
                      <StatusPill status="running">RUNNING</StatusPill>
                    ) : (
                      <StatusPill status="failed">FAILED</StatusPill>
                    )}
                  </td>
                  <td className="text-slate-300 tabular-nums text-xs text-right">{r.sampleSize}</td>
                  <td className="text-slate-400 text-xs text-right tabular-nums">{r.yearsBack}y</td>
                  <td className="text-slate-300 tabular-nums text-xs text-right">{r.predictionCount ?? '—'}</td>
                  <td className="text-slate-300 tabular-nums text-xs text-right">{r.brierScore != null ? r.brierScore.toFixed(4) : '—'}</td>
                  <td className="text-slate-300 tabular-nums text-xs text-right">{r.rocAuc != null ? r.rocAuc.toFixed(3) : '—'}</td>
                  <td className="text-slate-300 tabular-nums text-xs text-right">{r.ece != null ? r.ece.toFixed(4) : '—'}</td>
                  <td className="text-[11px] text-amber-400 whitespace-nowrap">View →</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selectedRunId && run && run.status === 'COMPLETE' && (
        <div className="space-y-5">
          <div className="stagger grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat
              label="Brier"
              value={run.brierScore != null ? run.brierScore.toFixed(4) : '—'}
              hint="0=perfect, 0.25=random. Lower is better."
            />
            <Stat
              label="Log-loss"
              value={run.logLoss != null ? run.logLoss.toFixed(4) : '—'}
              hint="Cross-entropy. ~0.69 = random. Penalizes confident wrong predictions more than Brier."
            />
            <Stat
              label="ROC AUC"
              value={run.rocAuc != null ? run.rocAuc.toFixed(3) : '—'}
              hint="Ranking quality. 0.5=random, 1.0=perfect. Independent of calibration."
            />
            <Stat
              label="ECE"
              value={run.ece != null ? run.ece.toFixed(4) : '—'}
              hint="Expected Calibration Error (10-bin). 0=perfectly calibrated."
            />
            <Stat
              label="Reliability"
              value={run.brierReliability != null ? run.brierReliability.toFixed(4) : '—'}
              hint="Brier decomposition piece. Lower=better calibrated."
            />
            <Stat
              label="Resolution"
              value={run.brierResolution != null ? run.brierResolution.toFixed(4) : '—'}
              hint="Brier decomposition piece. Higher=more signal."
            />
          </div>
          <div className="stagger grid grid-cols-1 md:grid-cols-3 gap-4">
            <Stat
              label="Mean predicted probability"
              value={run.meanProbability != null ? (run.meanProbability * 100).toFixed(1) + '%' : '—'}
              hint="Across all in-scope predictions"
            />
            <Stat
              label="Predictions evaluated"
              value={String(run.predictionCount ?? '—')}
              hint={`${run.yearsBack} years · ${run.methodVersion ?? '—'}`}
            />
            <Stat
              label="Calibration curve fit?"
              value={run.calibrationCurve ? 'Yes' : 'No'}
              hint={run.calibrationCurve ? `Brier ${run.calibrationCurve.preBrier?.toFixed(4)} → ${run.calibrationCurve.postBrier?.toFixed(4)}` : 'Only v2-permutation runs auto-fit'}
            />
          </div>

          {/* Calibration plot — bar chart of predicted bins */}
          {bins.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold mb-1.5" style={{ color: 'var(--text)' }}>Predicted-probability distribution</h3>
              <p className="text-[11px] text-slate-500 mb-4">
                Count of winners by predicted-probability bin. Healthy calibration concentrates winners
                in higher bins; mass in low bins means the engine systematically underestimates winners.
              </p>
              <div className="space-y-1.5">
                {bins.map((b, i) => {
                  const total = bins.reduce((a, x) => a + x.count, 0) || 1
                  const pct = (b.count / total) * 100
                  return (
                    <div key={i} className="flex items-center gap-3 text-xs">
                      <span className="w-20 text-slate-500 tabular-nums">
                        {(b.binMin * 100).toFixed(0)}–{(b.binMax * 100).toFixed(0)}%
                      </span>
                      <div className="flex-1 progress-track relative" style={{ height: 20, borderRadius: 6 }}>
                        <div
                          className="h-full bar-grow"
                          style={{ width: `${pct}%`, background: 'var(--accent)', opacity: 0.55, borderRadius: 6 }}
                        />
                        <span className="absolute left-2 top-0.5 text-[11px] text-slate-200 tabular-nums">
                          {b.count}
                        </span>
                      </div>
                      <span className="w-14 text-slate-500 tabular-nums text-right">{pct.toFixed(1)}%</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Calibration curve — predicted vs observed win rate per decile */}
          {bins.some((b) => b.count > 0) && (
            <div
              className="card"
            >
              <h3 className="text-sm font-semibold mb-1.5" style={{ color: 'var(--text)' }}>
                Calibration curve (predicted vs observed win rate)
              </h3>
              <p className="text-[11px] text-slate-500 mb-4">
                Each point plots one predicted-probability decile: x = mean predicted probability of bids in
                that bucket, y = observed win rate. Perfect calibration follows the dashed diagonal.
                Points above = engine <span className="text-blue-400">underestimates</span>; below = engine{' '}
                <span className="text-red-400">overestimates</span>. Sample includes synthetic negatives —
                bids deliberately constructed to NOT match (wrong NAICS / wrong size / wrong set-aside)
                alongside actual award winners.
              </p>
              <CalibrationCurve bins={bins} />
            </div>
          )}

          {/* Per-factor mean values */}
          {Object.keys(factorMeans).length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold mb-1.5" style={{ color: 'var(--text)' }}>Mean factor values across winners</h3>
              <p className="text-[11px] text-slate-500 mb-4">
                For each of the 8 factors, the average value across all sampled winners. Factors clustered near 0.5 are essentially noise; factors that diverge from 0.5 carry signal.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2.5">
                {Object.entries(factorMeans).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-3 text-xs min-w-0">
                    <span className="w-48 shrink-0 truncate text-slate-400">{key}</span>
                    <div className="flex-1 progress-track" style={{ height: 8 }}>
                      <div className="h-full rounded-full bar-grow" style={{ width: `${value * 100}%`, background: 'var(--accent)' }} />
                    </div>
                    <span className="w-12 text-slate-500 tabular-nums text-right">{(value * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top mispredictions */}
          {detail?.mispredictions?.length > 0 && (
            <div className="card p-0">
              <div className="px-5 py-4 border-b border-slate-700/50">
                <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text)' }}>
                  <FileText className="w-4 h-4" /> Top 20 mispredictions (winners we'd have told a firm not to bid)
                </h3>
                <p className="text-[11px] text-slate-500 mt-1">
                  Lowest predicted probabilities among confirmed winners — these are the most informative
                  cases to understand what features the engine is missing.
                </p>
              </div>
              <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    {['Predicted', 'Agency', 'NAICS', 'Award', 'Recipient'].map((h) => (
                      <th key={h} className={h === 'Predicted' || h === 'Award' ? 'text-right' : undefined}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.mispredictions.map((m: any, i: number) => (
                    <tr key={i}>
                      <td className="tabular-nums text-xs text-red-400 text-right">{(m.predictedProbability * 100).toFixed(1)}%</td>
                      <td className="text-slate-400 text-xs truncate max-w-xs">{m.agency}</td>
                      <td className="font-mono text-xs text-slate-500">{m.naicsCode}</td>
                      <td className="tabular-nums text-xs text-slate-300 text-right">${Math.round(m.awardAmount).toLocaleString()}</td>
                      <td className="text-slate-400 text-xs truncate max-w-sm">{m.recipientName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          )}
        </div>
      )}

      {selectedRunId && run?.status === 'FAILED' && (
        <div className="rounded-xl p-5 text-sm text-red-300 animate-fade-up"
          style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
          <p className="font-semibold mb-1">Run failed</p>
          <p className="text-[11px] text-red-400/80">{run.errorMessage ?? 'Unknown error'}</p>
        </div>
      )}

      {selectedRunId && detailQuery.isLoading && !run && (
        <div className="card">
          <span className="sr-only">Loading run details…</span>
          <SkeletonRows rows={3} cols={6} />
        </div>
      )}

      {selectedRunId && run?.status === 'RUNNING' && (
        <div className="rounded-xl p-5 text-sm text-blue-300 flex items-center gap-3"
          style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}>
          <Loader className="w-4 h-4 animate-spin" />
          Run in progress. Refreshes every 30s.
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card min-w-0">
      <p className="overline">{label}</p>
      <p className="kpi-value mt-3 flex items-center gap-2 text-2xl">
        <CheckCircle2 className="w-4 h-4 text-amber-400 flex-shrink-0" /> {value}
      </p>
      {hint && <p className="text-[11px] text-slate-600 mt-2">{hint}</p>}
    </div>
  )
}

/**
 * Calibration curve — pure SVG so the page stays Recharts-free.
 * x-axis = mean predicted probability per decile bin
 * y-axis = observed win rate per bin
 * Dashed diagonal = perfect calibration reference.
 */
function CalibrationCurve({ bins }: { bins: CalibrationBin[] }) {
  const W = 560
  const H = 320
  const PAD = { top: 16, right: 24, bottom: 36, left: 44 }
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom

  const x = (v: number) => PAD.left + v * innerW
  const y = (v: number) => PAD.top + (1 - v) * innerH

  const populated = bins.filter((b) => b.count > 0)
  const polyline = populated.map((b) => `${x(b.meanPred).toFixed(1)},${y(b.observedRate).toFixed(1)}`).join(' ')

  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Calibration curve">
      {/* Plot frame */}
      <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} fill="rgb(var(--ink) / 0.02)" stroke="rgb(var(--ink) / 0.08)" />

      {/* Gridlines + axis labels */}
      {ticks.map((t) => (
        <g key={`gx-${t}`}>
          <line x1={x(t)} x2={x(t)} y1={PAD.top} y2={PAD.top + innerH} stroke="rgb(var(--ink) / 0.05)" />
          <text x={x(t)} y={PAD.top + innerH + 18} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{(t * 100).toFixed(0)}%</text>
        </g>
      ))}
      {ticks.map((t) => (
        <g key={`gy-${t}`}>
          <line x1={PAD.left} x2={PAD.left + innerW} y1={y(t)} y2={y(t)} stroke="rgb(var(--ink) / 0.05)" />
          <text x={PAD.left - 8} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">{(t * 100).toFixed(0)}%</text>
        </g>
      ))}

      {/* Axis titles */}
      <text x={PAD.left + innerW / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--text-2)">
        Mean predicted probability
      </text>
      <text x={12} y={PAD.top + innerH / 2} textAnchor="middle" fontSize="11" fill="var(--text-2)" transform={`rotate(-90 12 ${PAD.top + innerH / 2})`}>
        Observed win rate
      </text>

      {/* Perfect-calibration diagonal */}
      <line
        x1={x(0)} y1={y(0)}
        x2={x(1)} y2={y(1)}
        stroke="var(--text-faint)"
        strokeWidth={1}
        strokeDasharray="5 4"
      />

      {/* Connector polyline */}
      {populated.length > 1 && (
        <polyline points={polyline} fill="none" stroke="#7b8fff" strokeWidth={2} />
      )}

      {/* Data points — radius scales with bin count */}
      {populated.map((b, i) => {
        const total = populated.reduce((a, x) => a + x.count, 0)
        const r = Math.max(3, Math.min(10, Math.sqrt(b.count / total) * 26))
        return (
          <g key={i}>
            <circle cx={x(b.meanPred)} cy={y(b.observedRate)} r={r} fill="#5b74ff" fillOpacity={0.85} stroke="var(--surface)" strokeWidth={1.5}>
              <title>
                {`Bin ${(b.binMin * 100).toFixed(0)}–${(b.binMax * 100).toFixed(0)}% · n=${b.count}`}
                {`\nmean predicted = ${(b.meanPred * 100).toFixed(1)}%`}
                {`\nobserved win rate = ${(b.observedRate * 100).toFixed(1)}%`}
              </title>
            </circle>
          </g>
        )
      })}
    </svg>
  )
}
