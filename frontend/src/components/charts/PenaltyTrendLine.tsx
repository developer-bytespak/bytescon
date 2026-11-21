import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { CHART, axisProps, gridProps, tooltipProps, lineCursor, legendStyle, legendFormatter } from './chartTheme'

interface TrendPoint {
  period: string
  value: number
  ema: number
}

interface TrendSeries {
  label: string
  points: TrendPoint[]
  direction: 'up' | 'down' | 'flat'
  changePercent: number
}

export function PenaltyTrendLine({ data }: { data?: TrendSeries }) {
  // Rising penalties are bad news, so only "up" gets the urgent colour.
  const trendWord = data?.direction === 'up' ? 'Up' : data?.direction === 'down' ? 'Down' : 'Flat'
  const trendColor = data?.direction === 'up' ? 'var(--danger-text)' : 'var(--text-muted)'

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2 mb-4">
        <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>Penalty trend (12 months)</h3>
        {data && (
          <span className="text-sm tabular-nums" style={{ color: trendColor }}>
            {trendWord}{data.direction === 'flat' ? '' : ` ${Math.abs(data.changePercent)}%`}
          </span>
        )}
      </div>
      {!data || data.points.length === 0 ? (
        <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No penalty data yet</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data.points} margin={{ left: 0, right: 10, top: 8 }}>
            <CartesianGrid {...gridProps} />
            {/* "YYYY-MM" periods show as the month number only. */}
            <XAxis dataKey="period" {...axisProps} tickFormatter={(v) => v.slice(5)} />
            <YAxis {...axisProps} width={52} />
            <Tooltip
              {...tooltipProps}
              cursor={lineCursor}
              formatter={(val: number, name: string) => [`$${val.toLocaleString()}`, name]}
            />
            <Legend wrapperStyle={legendStyle} iconType="plainline" formatter={legendFormatter} />
            <Line animationDuration={600} animationEasing="ease-out"
              type="monotone"
              dataKey="value"
              stroke={CHART.ink}
              name="Monthly"
              strokeWidth={1.5}
              dot={{ r: 2.5, fill: CHART.ink, strokeWidth: 0 }}
            />
            <Line animationDuration={600} animationEasing="ease-out"
              type="monotone"
              dataKey="ema"
              stroke={CHART.blue}
              name="3-month average"
              strokeWidth={2}
              dot={false}
              strokeDasharray="4 4"
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
