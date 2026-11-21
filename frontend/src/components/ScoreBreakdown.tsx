import { Info, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { CountUp } from './kit'

interface FactorContribution {
  factor: string
  score: number
  weight: number
  contribution: number
  pct: number
}

interface BreakdownData {
  factorContributions?: FactorContribution[]
  formula?: { equation: string; rawZ: number }
  rawScore?: number
  probability?: number
  expectedValue?: number
  /** Who-Wins public-label win prior (present only when the flag is on). */
  marketBasePrior?: {
    pWin: number
    pBase: number
    adjustmentOdds: number
    expectedOffers: number | null
    segmentLevel: string
    segmentAwardCount: number
    modelVersion: string
    heuristicProbability: number
    weight: number
  }
}

interface Props {
  breakdown?: BreakdownData | null
  probability: number
  estimatedValue?: number
  expectedValue?: number
  samUrl?: string
}

const FACTOR_LABELS: Record<string, string> = {
  naicsOverlapScore: 'NAICS industry match',
  setAsideAlignmentScore: 'Set-aside qualification',
  incumbentWeaknessScore: 'Incumbent weakness',
  documentAlignmentScore: 'Document scope alignment',
  agencyAlignmentScore: 'Agency award history',
  awardSizeFitScore: 'Contract size fit',
  competitionDensityScore: 'Competition level',
  agencyHistoryScore: 'Agency set-aside affinity',
  historicalDistribution: 'Historical win rate',
  deadlineUrgencyScore: 'Deadline / prep window',
}

const FACTOR_DESCRIPTIONS: Record<string, string> = {
  naicsOverlapScore: 'How closely your primary NAICS codes align with this contract\'s industry classification.',
  setAsideAlignmentScore: 'Whether your business certifications (SDVOSB, WOSB, HUBZone, SB) qualify for this set-aside.',
  incumbentWeaknessScore: 'Inverse of how dominant the current contract holder is — higher means better opportunity.',
  documentAlignmentScore: 'How well the solicitation\'s scope of work matches keywords from your prior performance documents.',
  agencyAlignmentScore: 'This agency\'s historical rate of awarding to companies with your profile.',
  awardSizeFitScore: 'Whether the contract\'s estimated value is within your company\'s typical performance range.',
  competitionDensityScore: 'Based on historical competition for similar contracts — fewer competitors means higher score.',
  agencyHistoryScore: 'This agency\'s historical affinity for set-asides matching your client\'s certifications.',
  historicalDistribution: 'Base win rate derived from USASpending historical award patterns for this contract type.',
  deadlineUrgencyScore: 'Quality of the proposal prep window — the 2–6 week sweet spot scores highest.',
}

function FactorBar({ factor, index = 0 }: { factor: FactorContribution; index?: number }) {
  const [showInfo, setShowInfo] = useState(false)
  const label = FACTOR_LABELS[factor.factor] ?? factor.factor
  const desc = FACTOR_DESCRIPTIONS[factor.factor] ?? ''
  const pct = factor.pct
  const weightPct = Math.round(factor.weight * 100)

  return (
    <div className="relative">
      <div className="flex items-center gap-3">
        <div className="w-28 sm:w-40 flex-shrink-0 flex items-center gap-1">
          <span className="text-xs text-gray-300 truncate">{label}</span>
          <button
            onClick={() => setShowInfo(!showInfo)}
            className="text-gray-600 hover:text-gray-400 flex-shrink-0"
            aria-label={`About ${label}`}
            aria-expanded={showInfo}
          >
            <Info className="w-3 h-3" />
          </button>
        </div>
        <span className="text-xs text-gray-600 w-8 text-right flex-shrink-0">{weightPct}%</span>
        <div className="v3-bar flex-1 min-w-0">
          <div
            className="block h-full rounded-full bar-grow"
            style={{ width: `${pct}%`, background: 'var(--text)', animationDelay: `${120 + index * 60}ms` }}
          />
        </div>
        <span className="text-xs font-semibold tabular-nums text-gray-300 w-10 text-right flex-shrink-0">{pct}%</span>
        <span className="text-xs tabular-nums text-gray-400 w-12 text-right flex-shrink-0">
          +{(factor.contribution * 100).toFixed(1)}
        </span>
      </div>
      {showInfo && desc && (
        <div className="panel mt-1.5 sm:ml-40 px-3 py-2 text-xs text-gray-400 animate-fade-up">
          {desc}
        </div>
      )}
    </div>
  )
}

export function ScoreBreakdown({ breakdown, probability, estimatedValue, expectedValue, samUrl }: Props) {
  if (!breakdown?.factorContributions?.length) {
    return (
      <div className="card">
        <h2 className="v3-h3 text-gray-100 mb-2">Win probability breakdown</h2>
        <p className="text-sm text-gray-500">
          No score breakdown available. Score this opportunity against a client to see the factor analysis.
        </p>
      </div>
    )
  }

  const factors = [...breakdown.factorContributions].sort((a, b) => b.weight - a.weight)
  const rawZ = breakdown.formula?.rawZ ?? breakdown.rawScore ?? 0
  const probPct = Math.round(probability * 100)
  const probColor = probPct >= 65 ? 'text-green-400' : probPct >= 40 ? 'text-yellow-400' : 'text-gray-400'

  const fmt = (v: number) =>
    v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`

  return (
    <div className="card">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="v3-h3 text-gray-100">Win probability breakdown</h2>
          <p className="text-xs text-gray-500 mt-0.5">9-factor logistic regression model</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-right">
            <p className={`text-3xl font-semibold tabular-nums ${probColor}`} style={{ letterSpacing: '-0.02em' }}><CountUp value={`${probPct}%`} /></p>
            {expectedValue ? (
              <p className="text-xs text-gray-400 tabular-nums">Expected value {fmt(expectedValue)}</p>
            ) : null}
          </div>
          {samUrl && (
            <a
              href={samUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary btn-sm"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              View on SAM.gov
            </a>
          )}
        </div>
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-3 mb-3 pb-2 overline" style={{ borderBottom: '1px solid var(--line)' }}>
        <span className="w-28 sm:w-40 flex-shrink-0">Factor</span>
        <span className="w-8 text-right flex-shrink-0">Weight</span>
        <span className="flex-1" />
        <span className="w-10 text-right flex-shrink-0">Score</span>
        <span className="w-12 text-right flex-shrink-0">Adds</span>
      </div>

      {/* Factor rows */}
      <div className="space-y-3">
        {factors.map((f, i) => (
          <FactorBar key={f.factor} factor={f} index={i} />
        ))}
      </div>

      {/* Total Z */}
      <div className="mt-4 pt-3 flex justify-between text-xs" style={{ borderTop: '1px solid var(--line)' }}>
        <span className="text-gray-500">Total z-score</span>
        <span className="tabular-nums font-semibold text-gray-200">{rawZ.toFixed(4)}</span>
      </div>

      {/* Who-Wins market base rate — grounded in real public award outcomes */}
      {breakdown.marketBasePrior && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-400 font-medium">Market base rate (public awards)</span>
            <span className="tabular-nums font-semibold text-gray-200">{Math.round(breakdown.marketBasePrior.pWin * 100)}%</span>
          </div>
          <p className="text-xs text-gray-500 mt-1 leading-relaxed">
            {breakdown.marketBasePrior.expectedOffers != null
              ? `Similar competed awards drew ~${breakdown.marketBasePrior.expectedOffers} offers on average`
              : 'Based on competed-award outcomes in this market segment'}
            {' '}({breakdown.marketBasePrior.segmentAwardCount.toLocaleString()} awards, {breakdown.marketBasePrior.segmentLevel.replace('NAICS', 'NAICS-')} segment).
            {breakdown.marketBasePrior.adjustmentOdds !== 1 &&
              ` Relative-strength adjustment ×${breakdown.marketBasePrior.adjustmentOdds.toFixed(2)} from public federal history.`}
            {' '}Blended into the score at {Math.round(breakdown.marketBasePrior.weight * 100)}% weight.
          </p>
        </div>
      )}
    </div>
  )
}

export default ScoreBreakdown
