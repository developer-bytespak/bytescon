import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { formatCurrency } from '../ui'
import { Info } from 'lucide-react'
import { useState } from 'react'
import {
  normalizeForecast,
  hasRenderableForecast,
  formatPeriodLabel,
  type ForecastMonth,
} from '../../lib/forecastChart'

export function RevenueForecast({ data }: { data?: ForecastMonth[] }) {
  // Section 4 #9: sanitize before charting so a malformed/partial payload can
  // never throw out of Recharts and crash the Analytics page.
  const months = normalizeForecast(data)
  const renderable = hasRenderableForecast(months)
  const totalExpected = months.reduce((s, m) => s + m.expected, 0)
  const [showInfo, setShowInfo] = useState(false)

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-gray-200">Revenue Forecast</h3>
          <button
            onClick={() => setShowInfo(v => !v)}
            className="text-gray-600 hover:text-gray-400 transition-colors"
            title="How this forecast works"
          >
            <Info className="w-4 h-4" />
          </button>
        </div>
        <span className="text-xs font-mono text-green-400">
          Expected: {formatCurrency(totalExpected)}
        </span>
      </div>

      {showInfo && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-blue-950/30 border border-blue-800/40 text-xs text-blue-200 space-y-1.5">
          <p className="font-semibold text-blue-300">How revenue is forecasted</p>
          <p>
            The forecast is built from your active bid pipeline. Each opportunity in your pipeline is assessed for its win likelihood based on your firm's NAICS alignment, past performance, set-aside eligibility, agency relationships, and competitive landscape — then combined with the contract's estimated value.
          </p>
          <p>
            The three forecast lines represent a range of outcomes across your entire pipeline:
          </p>
          <ul className="space-y-1 pl-3 border-l border-blue-700">
            <li><span className="text-green-400 font-medium">Optimistic (P90)</span> — if your stronger bids come through at or above historical award averages.</li>
            <li><span className="text-blue-400 font-medium">Expected</span> — the probability-weighted midpoint across all active opportunities. This is the most realistic planning figure.</li>
            <li><span className="text-red-400 font-medium">Conservative (P10)</span> — if only your highest-confidence bids close and at the lower end of value ranges.</li>
          </ul>
          <p className="text-blue-400 font-medium mt-2">Accuracy guidance</p>
          <p>
            Forecasts are most reliable 1–3 months out and become less precise beyond 6 months as market conditions, agency budgets, and competitive dynamics shift. Use the Expected line as your planning baseline and treat the range as your risk corridor. Accuracy improves as you add more awarded contracts to your track record — the model continuously calibrates to your firm's actual win rate.
          </p>
          <p className="text-yellow-400/80 text-[11px] italic">
            ⚠ These are probabilistic projections, not guaranteed revenue. They should inform planning decisions, not replace them.
          </p>
        </div>
      )}

      {months.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No pipeline data for forecasting</p>
      ) : !renderable ? (
        <p className="text-sm text-gray-500 text-center py-8">
          Not enough scored pipeline to project revenue yet. Score active opportunities to build a forecast.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={months} margin={{ left: 10, right: 10 }}>
            <defs>
              <linearGradient id="p90Gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="expectedGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="period"
              tick={{ fill: '#9ca3af', fontSize: 10 }}
              tickFormatter={formatPeriodLabel}
            />
            <YAxis
              tick={{ fill: '#9ca3af', fontSize: 10 }}
              tickFormatter={(v) => formatCurrency(v)}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '6px',
                color: '#f3f4f6',
              }}
              formatter={(val: number, name: string) => [formatCurrency(val), name]}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#9ca3af' }} />
            <Area
              type="monotone"
              dataKey="p90"
              stroke="#22c55e"
              fill="url(#p90Gradient)"
              strokeWidth={1}
              strokeDasharray="3 3"
              name="Optimistic (P90)"
            />
            <Area
              type="monotone"
              dataKey="expected"
              stroke="#3b82f6"
              fill="url(#expectedGradient)"
              strokeWidth={2}
              name="Expected"
            />
            <Area
              type="monotone"
              dataKey="p10"
              stroke="#ef4444"
              fill="none"
              strokeWidth={1}
              strokeDasharray="3 3"
              name="Conservative (P10)"
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
