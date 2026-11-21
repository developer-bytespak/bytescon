import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
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
import { CHART, axisProps, gridProps, tooltipProps, lineCursor, legendStyle, legendFormatter } from './chartTheme'

export function RevenueForecast({ data }: { data?: ForecastMonth[] }) {
  // Section 4 #9: sanitize before charting so a malformed/partial payload can
  // never throw out of Recharts and crash the Analytics page.
  const months = normalizeForecast(data)
  const renderable = hasRenderableForecast(months)
  const totalExpected = months.reduce((s, m) => s + m.expected, 0)
  const [showInfo, setShowInfo] = useState(false)

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>Revenue forecast</h3>
          <button
            onClick={() => setShowInfo(v => !v)}
            className="transition-colors"
            style={{ color: 'var(--text-muted)' }}
            title="How this forecast works"
            aria-expanded={showInfo}
          >
            <Info className="w-4 h-4" />
          </button>
        </div>
        <span className="text-sm tabular-nums" style={{ color: 'var(--text-muted)' }}>
          Expected: <b className="font-semibold" style={{ color: 'var(--text)' }}>{formatCurrency(totalExpected)}</b>
        </span>
      </div>

      {showInfo && (
        <div className="panel mb-4 px-4 py-3 text-[13px] leading-relaxed space-y-2" style={{ color: 'var(--text-2)' }}>
          <p className="font-semibold" style={{ color: 'var(--text)' }}>How revenue is forecasted</p>
          <p>
            The forecast is built from your active bid pipeline. Each opportunity in your pipeline is assessed for its win likelihood based on your firm's NAICS alignment, past performance, set-aside eligibility, agency relationships, and competitive landscape, then combined with the contract's estimated value.
          </p>
          <p>
            The three forecast lines represent a range of outcomes across your entire pipeline:
          </p>
          <ul className="space-y-1 pl-4 list-disc">
            <li><span className="font-medium" style={{ color: 'var(--text)' }}>Optimistic (P90):</span> if your stronger bids come through at or above historical award averages.</li>
            <li><span className="font-medium" style={{ color: 'var(--text)' }}>Expected:</span> the probability-weighted midpoint across all active opportunities. This is the most realistic planning figure.</li>
            <li><span className="font-medium" style={{ color: 'var(--text)' }}>Conservative (P10):</span> if only your highest-confidence bids close and at the lower end of value ranges.</li>
          </ul>
          <p className="font-semibold pt-1" style={{ color: 'var(--text)' }}>Accuracy guidance</p>
          <p>
            Forecasts are most reliable 1–3 months out and become less precise beyond 6 months as market conditions, agency budgets, and competitive dynamics shift. Use the Expected line as your planning baseline and treat the range as your risk corridor. Accuracy improves as you add more awarded contracts to your track record; the model continuously calibrates to your firm's actual win rate.
          </p>
          <p className="text-xs" style={{ color: 'var(--warning)' }}>
            These are probabilistic projections, not guaranteed revenue. They should inform planning decisions, not replace them.
          </p>
        </div>
      )}

      {months.length === 0 ? (
        <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No pipeline data for forecasting</p>
      ) : !renderable ? (
        <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
          Not enough scored pipeline to project revenue yet. Score active opportunities to build a forecast.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={months} margin={{ left: 4, right: 10, top: 8 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="period" {...axisProps} tickFormatter={formatPeriodLabel} />
            <YAxis {...axisProps} width={64} tickFormatter={(v) => formatCurrency(v)} />
            <Tooltip
              {...tooltipProps}
              cursor={lineCursor}
              formatter={(val: number, name: string) => [formatCurrency(val), name]}
            />
            <Legend wrapperStyle={legendStyle} iconType="plainline" formatter={legendFormatter} />
            <Area animationDuration={600} animationEasing="ease-out"
              type="monotone"
              dataKey="p90"
              stroke={CHART.ink}
              fill="none"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              name="Optimistic (P90)"
            />
            <Area animationDuration={600} animationEasing="ease-out"
              type="monotone"
              dataKey="expected"
              stroke={CHART.blue}
              fill={CHART.blue}
              fillOpacity={0.08}
              strokeWidth={2}
              name="Expected"
            />
            <Area animationDuration={600} animationEasing="ease-out"
              type="monotone"
              dataKey="p10"
              stroke={CHART.grey}
              fill="none"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              name="Conservative (P10)"
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
