import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
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

export function SubmissionVelocity({ data }: { data?: TrendSeries }) {
  const trendWord = data?.direction === 'up' ? 'Up' : data?.direction === 'down' ? 'Down' : 'Flat'

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2 mb-4">
        <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>Submission velocity</h3>
        {data && (
          <span className="text-sm tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {trendWord}{data.direction === 'flat' ? '' : ` ${Math.abs(data.changePercent)}%`}
          </span>
        )}
      </div>
      {!data || data.points.length === 0 ? (
        <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No submission data yet</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data.points} margin={{ left: 0, right: 10, top: 8 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="period" {...axisProps} tickFormatter={(v) => v.slice(5)} />
            <YAxis {...axisProps} width={36} allowDecimals={false} />
            <Tooltip {...tooltipProps} cursor={lineCursor} />
            <Legend wrapperStyle={legendStyle} iconType="plainline" formatter={legendFormatter} />
            <Area animationDuration={600} animationEasing="ease-out"
              type="monotone"
              dataKey="value"
              name="Submissions"
              stroke={CHART.blue}
              fill={CHART.blue}
              fillOpacity={0.08}
              strokeWidth={2}
            />
            <Area animationDuration={600} animationEasing="ease-out"
              type="monotone"
              dataKey="ema"
              name="Trend (EMA)"
              stroke={CHART.ink}
              fill="none"
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
