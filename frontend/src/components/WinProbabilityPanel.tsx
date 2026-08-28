import { useQuery } from '@tanstack/react-query'
import { opportunitiesApi } from '../services/api'
import { Spinner } from './ui'
import { Target, Info } from 'lucide-react'

// §5.1 Stage 3 — the single displayed win probability + honest calibration
// label (RAW / CALIBRATED / FALLBACK). Never shows a "calibrated" badge when the
// raw score is actually being used.

interface WinProb {
  scored: boolean
  rawScore: number | null
  finalScore: number | null
  scoreType: 'RAW' | 'CALIBRATED' | 'FALLBACK' | null
  changed?: boolean
  method?: string | null
  methodVersion?: string | null
  sampleSize?: number | null
  lastFittedAt?: string | null
  reason?: string | null
  dataSufficiency?: string
}

const typeTone: Record<string, string> = {
  RAW: 'bg-gray-800 border-gray-700 text-gray-300',
  CALIBRATED: 'bg-green-950/40 border-green-800 text-green-300',
  FALLBACK: 'bg-yellow-950/40 border-yellow-800 text-yellow-300',
}
const REASON_TEXT: Record<string, string> = {
  CALIBRATION_DISABLED: 'A calibration curve is fitted but not enabled — showing the raw model score.',
  NO_CALIBRATION: 'No calibration curve has been fitted yet — showing the raw model score.',
  INCOMPATIBLE_VERSION: 'The fitted calibration uses an incompatible method version — falling back to the raw score.',
  INVALID_PARAMS: 'The calibration parameters are invalid — falling back to the raw score.',
  INSUFFICIENT_SAMPLE: 'Not enough historical outcomes to calibrate reliably — falling back to the raw score.',
  STALE: 'The calibration curve is too old to trust — falling back to the raw score.',
  NO_BRIER_IMPROVEMENT: 'Calibration did not improve accuracy on its backtest — falling back to the raw score.',
}
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')

export function WinProbabilityPanel({ opportunityId }: { opportunityId: string }) {
  const q = useQuery<{ data: WinProb }>({ queryKey: ['win-probability', opportunityId], queryFn: () => opportunitiesApi.winProbability(opportunityId) })

  if (q.isLoading) return <div className="card flex justify-center py-4"><Spinner size="sm" /></div>
  if (q.error) return <div className="card"><p className="text-xs text-red-400">Could not load the win probability. Please retry.</p></div>

  const d = q.data!.data
  if (!d.scored) {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-1"><Target className="w-4 h-4 text-blue-400" /><h2 className="font-semibold text-gray-200 text-sm">Win probability</h2></div>
        <p className="text-sm text-gray-500">Not scored yet — no win probability available for this opportunity.</p>
      </div>
    )
  }

  const type = d.scoreType ?? 'RAW'
  const isCalibrated = type === 'CALIBRATED'
  const reason = d.reason ? REASON_TEXT[d.reason] ?? d.reason : null

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-2">
        <Target className="w-4 h-4 text-blue-400" />
        <h2 className="font-semibold text-gray-200 text-sm">Win probability</h2>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ml-auto ${typeTone[type]}`}>{type}</span>
      </div>

      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-bold text-gray-100 font-mono">{d.finalScore}%</span>
        {/* Only surface the raw score when calibration actually changed the result. */}
        {isCalibrated && d.changed && d.rawScore != null && (
          <span className="text-xs text-gray-500">raw {d.rawScore}% → calibrated {d.finalScore}%</span>
        )}
      </div>

      {isCalibrated ? (
        <p className="text-[11px] text-gray-500 mt-2">
          Calibrated via {d.method} ({d.methodVersion}) · sample {d.sampleSize ?? '—'} · last calibrated {fmtDate(d.lastFittedAt)}
        </p>
      ) : (
        <p className="text-[11px] text-gray-500 mt-2 flex items-start gap-1">
          <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>{reason ?? 'Showing the raw model score.'}{d.lastFittedAt && type === 'FALLBACK' ? ` (curve fitted ${fmtDate(d.lastFittedAt)})` : ''}</span>
        </p>
      )}
      {d.dataSufficiency && d.dataSufficiency !== 'SUFFICIENT' && (
        <p className="text-[10px] text-gray-600 mt-1">Data sufficiency: {d.dataSufficiency.toLowerCase()}</p>
      )}
    </div>
  )
}

export default WinProbabilityPanel
