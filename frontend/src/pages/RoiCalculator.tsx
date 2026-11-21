import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Calculator, TrendingUp, DollarSign, AlertTriangle, CheckCircle, Info } from 'lucide-react'
import { PageHeader } from '../components/ui'

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
  { label: 'Small IT contract', contractValue: 250000, bidType: 'PRIME' as const, winProbability: 0.35, timeToAwardMonths: 6 },
  { label: 'Mid-size IDIQ task order', contractValue: 1500000, bidType: 'PRIME' as const, winProbability: 0.25, timeToAwardMonths: 9 },
  { label: 'Large prime contract', contractValue: 8000000, bidType: 'PRIME' as const, winProbability: 0.15, timeToAwardMonths: 12 },
  { label: 'Subcontractor role', contractValue: 3000000, bidType: 'SUB' as const, winProbability: 0.45, timeToAwardMonths: 8 },
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

  // Only a losing ratio is coloured; a good result reads in plain ink.
  const roiColor = !result ? 'text-slate-400'
    : result.roiRatio >= 1 ? 'text-slate-100'
    : 'text-[color:var(--danger-text)]'

  return (
    <div className="space-y-6 w-full">
      {/* Header */}
      <PageHeader title="ROI calculator" subtitle="Evaluate bid economics before committing proposal resources" icon={<Calculator className="w-5 h-5" />}>
        <Link to="/opportunities" className="btn-secondary btn-sm">
          View opportunities
        </Link>
      </PageHeader>

      {/* Preset Scenarios */}
      <div>
        <p className="overline mb-2.5">Quick scenarios</p>
        <div className="flex flex-wrap gap-2">
          {PRESET_SCENARIOS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p)}
              className="btn-secondary btn-sm"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Inputs */}
        <div className="card space-y-5">
          <h2 className="text-base font-semibold flex items-center gap-2.5" style={{ color: 'var(--text)' }}>
            <span className="tile tile-sm"><DollarSign className="w-3.5 h-3.5" /></span>
            Contract parameters
          </h2>

          {/* Contract Value */}
          <div>
            <label className="label">
              Contract value (total estimated)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
              <input
                type="text"
                value={contractValueStr}
                onChange={(e) => handleContractValueChange(e.target.value)}
                className="input pl-7 tabular-nums"
                placeholder="1,000,000"
              />
            </div>
          </div>

          {/* Bid Type */}
          <div>
            <label className="label">Bid role</label>
            <div className="segmented grid grid-cols-3 w-full">
              {(['PRIME', 'SUB', 'GOVERNMENT'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setBidType(t)}
                  data-active={bidType === t}
                >
                  {bidType === t && <motion.span layoutId="roi-bid-type" className="segmented-thumb" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                  {t === 'PRIME' ? 'Prime contractor' : t === 'SUB' ? 'Subcontractor' : 'Gov advisory'}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500 mt-1.5">
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
              <label className="label mb-0">Win probability</label>
              <span className="text-sm font-semibold tabular-nums text-slate-100">{winProbPct}%</span>
            </div>
            <input
              type="range"
              min={1}
              max={95}
              value={winProbPct}
              onChange={(e) => setWinProbPct(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-slate-500 mt-1">
              <span>1% (long shot)</span>
              <span>50% (even odds)</span>
              <span>95% (incumbent)</span>
            </div>
          </div>

          {/* Time to Award */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="label mb-0">Time to award</label>
              <span className="text-sm font-semibold tabular-nums text-slate-300">{timeToAwardMonths} mo</span>
            </div>
            <input
              type="range"
              min={1}
              max={36}
              value={timeToAwardMonths}
              onChange={(e) => setTimeToAwardMonths(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-slate-500 mt-1">
              <span>1 month</span>
              <span>18 months</span>
              <span>3 years</span>
            </div>
          </div>

          {/* Overhead Rate */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="label mb-0 flex items-center gap-1">
                Overhead rate
                <span title="Applied to effective revenue if you win: fringe, indirect, G&A" className="cursor-help">
                  <Info className="w-3 h-3 text-slate-600" />
                </span>
              </label>
              <span className="text-sm font-semibold tabular-nums text-slate-300">{overheadRatePct}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={50}
              value={overheadRatePct}
              onChange={(e) => setOverheadRatePct(Number(e.target.value))}
              className="w-full"
            />
          </div>

          {/* Proposal Cost Override */}
          <div>
            <label className="label">
              Proposal cost override{' '}
              <span className="text-slate-500 font-normal">
                (optional; default: {bidType === 'SUB' ? '3%' : '5%'} of contract value)
              </span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
              <input
                type="text"
                value={proposalCostOverrideStr}
                onChange={(e) => setProposalCostOverrideStr(e.target.value.replace(/[^0-9,]/g, ''))}
                className="input pl-7 tabular-nums"
                placeholder={result ? result.proposalCost.toLocaleString() : '50,000'}
              />
            </div>
          </div>
        </div>

        {/* Results */}
        <div className="space-y-4">
          {/* Recommendation Banner */}
          {result && (
            <div className="card animate-fade-up">
              <div className="flex items-center gap-3">
                {result.recommendation === 'BID' ? (
                  <CheckCircle className="w-6 h-6 text-[color:var(--success-text)] flex-shrink-0" />
                ) : result.recommendation === 'PASS' ? (
                  <AlertTriangle className="w-6 h-6 text-[color:var(--danger-text)] flex-shrink-0" />
                ) : (
                  <Info className="w-6 h-6 text-[color:var(--warning)] flex-shrink-0" />
                )}
                <div>
                  <p className="font-semibold text-xl text-slate-100">
                    {result.recommendation === 'BID' ? 'Recommend: bid'
                    : result.recommendation === 'PASS' ? 'Recommend: pass'
                    : 'Consider carefully'}
                  </p>
                  <p className="text-[13px] text-slate-400 mt-0.5">
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
            <div className="stagger grid grid-cols-2 gap-3">
              <div className="card min-w-0">
                <p className="overline mb-3">ROI ratio</p>
                <p className={`kpi-value ${roiColor}`}>{result.roiRatio.toFixed(1)}x</p>
                <p className="text-[13px] text-slate-500 mt-2.5">Net EV / proposal cost</p>
              </div>
              <div className="card min-w-0">
                <p className="overline mb-3">Expected value</p>
                <p className="text-2xl font-semibold tabular-nums truncate text-slate-100">{fmt(result.expectedValue)}</p>
                <p className="text-[13px] text-slate-500 mt-2.5">Probability × effective value × NPV</p>
              </div>
              <div className="card min-w-0">
                <p className="overline mb-3">Net expected value</p>
                <p className={`text-2xl font-semibold tabular-nums truncate ${result.netExpectedValue >= 0 ? 'text-slate-100' : 'text-[color:var(--danger-text)]'}`}>
                  {fmt(result.netExpectedValue)}
                </p>
                <p className="text-[13px] text-slate-500 mt-2.5">EV minus proposal cost</p>
              </div>
              <div className="card min-w-0">
                <p className="overline mb-3">Break-even win %</p>
                <p className="text-2xl font-semibold tabular-nums truncate text-slate-100">{pct(result.breakEvenWinProb)}</p>
                <p className="text-[13px] text-slate-500 mt-2.5">Min win prob to profit</p>
              </div>
            </div>
          )}

          {/* Detailed Breakdown */}
          {result && (
            <div className="card">
              <h3 className="text-base font-semibold text-slate-100 mb-4 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-slate-500" />
                Full breakdown
              </h3>
              <div className="space-y-2.5">
                {[
                  { label: 'Contract value', value: fmt(contractValue) },
                  { label: `Effective revenue (${bidType === 'PRIME' ? 'prime' : bidType === 'SUB' ? 'sub' : 'advisory'})`, value: fmt(result.effectiveValue), indent: true },
                  { label: 'NPV discount factor', value: `${(result.timeDiscountFactor * 100).toFixed(1)}%`, indent: true },
                  { label: 'Win probability', value: pct(winProbPct / 100) },
                  { label: 'Expected value', value: fmt(result.expectedValue), bold: true },
                  { label: 'Proposal cost', value: fmt(result.proposalCost), negative: true },
                  { label: 'Overhead cost (if won)', value: fmt(result.overheadCost), negative: true, note: true },
                  { label: 'Net expected value', value: fmt(result.netExpectedValue), bold: true, colored: true },
                  { label: 'Est. lifetime value (multi-year)', value: fmt(result.lifetimeValue), muted: true },
                ].map((row) => (
                  <div key={row.label} className={`flex items-center justify-between text-sm ${row.indent ? 'pl-4' : ''}`}>
                    <span className={`${row.muted ? 'text-slate-500' : 'text-slate-400'} text-[13px]`}>{row.label}</span>
                    <span className={`tabular-nums text-[13px] font-medium ${
                      row.colored ? (result.netExpectedValue >= 0 ? 'text-slate-100' : 'text-[color:var(--danger-text)]')
                      : row.negative ? 'text-slate-300'
                      : row.bold ? 'text-slate-100'
                      : row.muted ? 'text-slate-600'
                      : 'text-slate-300'
                    }`}>
                      {row.negative ? '-' : ''}{row.value}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-4 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                NPV uses {Math.round(DISCOUNT_RATE_ANNUAL * 100)}% annual discount rate over {timeToAwardMonths} months to award.
                Lifetime value assumes {OPTION_YEAR_FACTOR}x option-year multiplier.
                This is an estimate, not a guarantee of outcome.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
