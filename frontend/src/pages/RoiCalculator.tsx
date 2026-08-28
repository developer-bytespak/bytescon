import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Calculator, TrendingUp, DollarSign, AlertTriangle, CheckCircle, Info, ArrowRight } from 'lucide-react'

// Mirror the formula from backend/src/services/decisionEngine.ts
const OPTION_YEAR_FACTOR = 2.5
const SUB_REVENUE_SHARE = 0.30
const DISCOUNT_RATE_ANNUAL = 0.08

function calcRoi(inputs: {
  contractValue: number
  bidType: 'PRIME' | 'SUB' | 'GOVERNMENT'
  winProbability: number // 0-1
  timeToAwardMonths: number
  proposalCostOverride: number | null
  overheadRate: number // 0-1
}) {
  const { contractValue, bidType, winProbability, timeToAwardMonths, proposalCostOverride, overheadRate } = inputs
  if (contractValue <= 0) return null

  const effectiveValue =
    bidType === 'SUB' ? contractValue * SUB_REVENUE_SHARE
    : bidType === 'GOVERNMENT' ? contractValue * 0.15  // advisory fee on gov prime
    : contractValue

  const defaultProposalCost = bidType === 'SUB'
    ? contractValue * 0.03
    : contractValue * 0.05

  const proposalCost = proposalCostOverride ?? defaultProposalCost
  const overheadCost = effectiveValue * overheadRate
  const totalCost = proposalCost + overheadCost

  // NPV discount: 8% annual rate over time-to-award
  const timeDiscountFactor = 1 / Math.pow(1 + DISCOUNT_RATE_ANNUAL, timeToAwardMonths / 12)
  const expectedValue = winProbability * effectiveValue * timeDiscountFactor
  const netExpectedValue = expectedValue - proposalCost
  const roiRatio = proposalCost > 0 ? netExpectedValue / proposalCost : 0

  const lifetimeValue = winProbability * effectiveValue * OPTION_YEAR_FACTOR * timeDiscountFactor
  const breakEvenWinProb =
    effectiveValue > 0 ? proposalCost / (effectiveValue * timeDiscountFactor) : 0

  // Determine recommendation
  let recommendation: 'BID' | 'PASS' | 'CONSIDER'
  if (roiRatio >= 2 && winProbability >= 0.25) recommendation = 'BID'
  else if (roiRatio < 0 || winProbability < 0.05) recommendation = 'PASS'
  else recommendation = 'CONSIDER'

  return {
    effectiveValue,
    proposalCost,
    overheadCost,
    totalCost,
    timeDiscountFactor,
    expectedValue,
    netExpectedValue,
    roiRatio,
    lifetimeValue,
    breakEvenWinProb: Math.min(breakEvenWinProb, 1),
    recommendation,
  }
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function pct(n: number) {
  return (n * 100).toFixed(1) + '%'
}

const PRESET_SCENARIOS = [
  { label: 'Small IT Contract', contractValue: 250000, bidType: 'PRIME' as const, winProbability: 0.35, timeToAwardMonths: 6 },
  { label: 'Mid-Size IDIQ Task Order', contractValue: 1500000, bidType: 'PRIME' as const, winProbability: 0.25, timeToAwardMonths: 9 },
  { label: 'Large Prime Contract', contractValue: 8000000, bidType: 'PRIME' as const, winProbability: 0.15, timeToAwardMonths: 12 },
  { label: 'Subcontractor Role', contractValue: 3000000, bidType: 'SUB' as const, winProbability: 0.45, timeToAwardMonths: 8 },
]

export default function RoiCalculatorPage() {
  const [contractValue, setContractValue] = useState(1000000)
  const [bidType, setBidType] = useState<'PRIME' | 'SUB' | 'GOVERNMENT'>('PRIME')
  const [winProbPct, setWinProbPct] = useState(25) // displayed as percent
  const [timeToAwardMonths, setTimeToAwardMonths] = useState(9)
  const [overheadRatePct, setOverheadRatePct] = useState(15) // displayed as percent
  const [proposalCostOverrideStr, setProposalCostOverrideStr] = useState('')
  const [contractValueStr, setContractValueStr] = useState('1,000,000')

  const proposalCostOverride = proposalCostOverrideStr.trim()
    ? Number(proposalCostOverrideStr.replace(/,/g, ''))
    : null

  const result = useMemo(() => calcRoi({
    contractValue,
    bidType,
    winProbability: winProbPct / 100,
    timeToAwardMonths,
    proposalCostOverride,
    overheadRate: overheadRatePct / 100,
  }), [contractValue, bidType, winProbPct, timeToAwardMonths, proposalCostOverride, overheadRatePct])

  function applyPreset(p: typeof PRESET_SCENARIOS[0]) {
    setContractValue(p.contractValue)
    setContractValueStr(p.contractValue.toLocaleString())
    setBidType(p.bidType)
    setWinProbPct(Math.round(p.winProbability * 100))
    setTimeToAwardMonths(p.timeToAwardMonths)
  }

  function handleContractValueChange(raw: string) {
    const digits = raw.replace(/[^0-9]/g, '')
    const num = Number(digits)
    setContractValue(num)
    setContractValueStr(num > 0 ? num.toLocaleString() : '')
  }

  const roiColor = !result ? 'text-slate-400'
    : result.roiRatio >= 3 ? 'text-emerald-400'
    : result.roiRatio >= 1 ? 'text-amber-400'
    : 'text-red-400'

  const recColor = !result ? ''
    : result.recommendation === 'BID' ? 'border-emerald-500/40 bg-emerald-500/8'
    : result.recommendation === 'PASS' ? 'border-red-500/40 bg-red-500/8'
    : 'border-amber-500/40 bg-amber-500/8'

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg" style={{ background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.2)' }}>
              <Calculator className="w-5 h-5 text-amber-400" />
            </div>
            <h1 className="text-2xl font-bold text-slate-100">ROI Calculator</h1>
          </div>
          <p className="text-sm text-slate-500 ml-14">
            Evaluate bid economics before committing proposal resources
          </p>
        </div>
        <Link
          to="/opportunities"
          className="flex items-center gap-2 text-xs text-slate-500 hover:text-amber-400 transition-colors px-3 py-1.5 rounded-lg hover:bg-white/5"
        >
          View Opportunities <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      {/* Preset Scenarios */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-600 mb-2">Quick Scenarios</p>
        <div className="flex flex-wrap gap-2">
          {PRESET_SCENARIOS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p)}
              className="text-xs px-3 py-1.5 rounded-lg border transition-all hover:border-amber-500/40 hover:text-amber-300"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8' }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Inputs */}
        <div className="space-y-5 rounded-xl p-6" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-amber-400" />
            Contract Parameters
          </h2>

          {/* Contract Value */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Contract Value (Total Estimated)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
              <input
                type="text"
                value={contractValueStr}
                onChange={(e) => handleContractValueChange(e.target.value)}
                className="w-full pl-7 pr-3 py-2.5 rounded-lg text-slate-100 text-sm"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                placeholder="1,000,000"
              />
            </div>
          </div>

          {/* Bid Type */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Bid Role</label>
            <div className="grid grid-cols-3 gap-2">
              {(['PRIME', 'SUB', 'GOVERNMENT'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setBidType(t)}
                  className={`py-2 text-xs font-medium rounded-lg transition-all ${
                    bidType === t
                      ? 'text-amber-300'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                  style={bidType === t
                    ? { background: 'rgba(6,182,212,0.15)', border: '1px solid rgba(6,182,212,0.35)' }
                    : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }
                  }
                >
                  {t === 'PRIME' ? 'Prime Contractor' : t === 'SUB' ? 'Subcontractor' : 'Gov Advisory'}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-600 mt-1.5">
              {bidType === 'SUB'
                ? `Revenue modeled at ${Math.round(SUB_REVENUE_SHARE * 100)}% of contract value (subcontractor share)`
                : bidType === 'GOVERNMENT'
                ? 'Revenue modeled at 15% advisory/management fee'
                : 'Revenue modeled at 100% of contract value'}
            </p>
          </div>

          {/* Win Probability */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-400">Win Probability</label>
              <span className="text-sm font-bold text-amber-400">{winProbPct}%</span>
            </div>
            <input
              type="range"
              min={1}
              max={95}
              value={winProbPct}
              onChange={(e) => setWinProbPct(Number(e.target.value))}
              className="w-full accent-amber-400"
            />
            <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
              <span>1% (Long Shot)</span>
              <span>50% (Even Odds)</span>
              <span>95% (Incumbent)</span>
            </div>
          </div>

          {/* Time to Award */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-400">Time to Award</label>
              <span className="text-sm font-bold text-slate-300">{timeToAwardMonths} mo</span>
            </div>
            <input
              type="range"
              min={1}
              max={36}
              value={timeToAwardMonths}
              onChange={(e) => setTimeToAwardMonths(Number(e.target.value))}
              className="w-full accent-amber-400"
            />
            <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
              <span>1 month</span>
              <span>18 months</span>
              <span>3 years</span>
            </div>
          </div>

          {/* Overhead Rate */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-400 flex items-center gap-1">
                Overhead Rate
                <span title="Applied to effective revenue if you win — fringe, indirect, G&A" className="cursor-help">
                  <Info className="w-3 h-3 text-slate-600" />
                </span>
              </label>
              <span className="text-sm font-bold text-slate-300">{overheadRatePct}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={50}
              value={overheadRatePct}
              onChange={(e) => setOverheadRatePct(Number(e.target.value))}
              className="w-full accent-amber-400"
            />
          </div>

          {/* Proposal Cost Override */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Proposal Cost Override{' '}
              <span className="text-slate-600 font-normal">
                (optional — default: {bidType === 'SUB' ? '3%' : '5%'} of contract value)
              </span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
              <input
                type="text"
                value={proposalCostOverrideStr}
                onChange={(e) => setProposalCostOverrideStr(e.target.value.replace(/[^0-9,]/g, ''))}
                className="w-full pl-7 pr-3 py-2.5 rounded-lg text-slate-100 text-sm"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                placeholder={result ? result.proposalCost.toLocaleString() : '50,000'}
              />
            </div>
          </div>
        </div>

        {/* Results */}
        <div className="space-y-4">
          {/* Recommendation Banner */}
          {result && (
            <div className={`rounded-xl p-4 border ${recColor}`}>
              <div className="flex items-center gap-3">
                {result.recommendation === 'BID' ? (
                  <CheckCircle className="w-6 h-6 text-emerald-400 flex-shrink-0" />
                ) : result.recommendation === 'PASS' ? (
                  <AlertTriangle className="w-6 h-6 text-red-400 flex-shrink-0" />
                ) : (
                  <Info className="w-6 h-6 text-amber-400 flex-shrink-0" />
                )}
                <div>
                  <p className={`font-bold text-lg ${
                    result.recommendation === 'BID' ? 'text-emerald-300'
                    : result.recommendation === 'PASS' ? 'text-red-300'
                    : 'text-amber-300'
                  }`}>
                    {result.recommendation === 'BID' ? 'Recommend: BID'
                    : result.recommendation === 'PASS' ? 'Recommend: PASS'
                    : 'Consider Carefully'}
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {result.recommendation === 'BID'
                      ? `Strong ROI at ${result.roiRatio.toFixed(1)}x with ${pct(winProbPct / 100)} win probability`
                      : result.recommendation === 'PASS'
                      ? `Negative or marginal expected value at current win probability`
                      : `ROI is acceptable but win probability warrants scrutiny`}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Key Metrics */}
          {result && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-1">ROI Ratio</p>
                <p className={`text-3xl font-black ${roiColor}`}>{result.roiRatio.toFixed(1)}x</p>
                <p className="text-[11px] text-slate-600 mt-1">Net EV / Proposal Cost</p>
              </div>
              <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-1">Expected Value</p>
                <p className="text-xl font-bold text-slate-100">{fmt(result.expectedValue)}</p>
                <p className="text-[11px] text-slate-600 mt-1">Prob × Effective Value × NPV</p>
              </div>
              <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-1">Net Expected Value</p>
                <p className={`text-xl font-bold ${result.netExpectedValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {fmt(result.netExpectedValue)}
                </p>
                <p className="text-[11px] text-slate-600 mt-1">EV minus Proposal Cost</p>
              </div>
              <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-1">Break-Even Win%</p>
                <p className="text-xl font-bold text-slate-100">{pct(result.breakEvenWinProb)}</p>
                <p className="text-[11px] text-slate-600 mt-1">Min win prob to profit</p>
              </div>
            </div>
          )}

          {/* Detailed Breakdown */}
          {result && (
            <div className="rounded-xl p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-4 flex items-center gap-2">
                <TrendingUp className="w-3.5 h-3.5" />
                Full Breakdown
              </h3>
              <div className="space-y-2.5">
                {[
                  { label: 'Contract Value', value: fmt(contractValue) },
                  { label: `Effective Revenue (${bidType})`, value: fmt(result.effectiveValue), indent: true },
                  { label: 'NPV Discount Factor', value: `${(result.timeDiscountFactor * 100).toFixed(1)}%`, indent: true },
                  { label: 'Win Probability', value: pct(winProbPct / 100) },
                  { label: 'Expected Value', value: fmt(result.expectedValue), bold: true },
                  { label: 'Proposal Cost', value: fmt(result.proposalCost), negative: true },
                  { label: 'Overhead Cost (if won)', value: fmt(result.overheadCost), negative: true, note: true },
                  { label: 'Net Expected Value', value: fmt(result.netExpectedValue), bold: true, colored: true },
                  { label: 'Est. Lifetime Value (multi-year)', value: fmt(result.lifetimeValue), muted: true },
                ].map((row) => (
                  <div key={row.label} className={`flex items-center justify-between text-sm ${row.indent ? 'pl-4' : ''}`}>
                    <span className={`${row.muted ? 'text-slate-600' : 'text-slate-400'} text-xs`}>{row.label}</span>
                    <span className={`font-mono text-xs font-medium ${
                      row.colored ? (result.netExpectedValue >= 0 ? 'text-emerald-400' : 'text-red-400')
                      : row.negative ? 'text-red-400'
                      : row.bold ? 'text-slate-100'
                      : row.muted ? 'text-slate-600'
                      : 'text-slate-300'
                    }`}>
                      {row.negative ? '-' : ''}{row.value}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-slate-700 mt-4 pt-3 border-t border-white/5">
                NPV uses {Math.round(DISCOUNT_RATE_ANNUAL * 100)}% annual discount rate over {timeToAwardMonths} months to award.
                Lifetime value assumes {OPTION_YEAR_FACTOR}x option-year multiplier.
                This is an estimate — not a guarantee of outcome.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
