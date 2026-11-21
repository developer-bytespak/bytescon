import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  LabelList,
  ResponsiveContainer,
} from 'recharts'
import { CHART, axisProps, gridProps, tooltipProps, barCursor } from './chartTheme'

interface ProbBucket {
  range: string
  count: number
}

export function WinProbabilityDistribution({ data }: { data?: ProbBucket[] }) {
  // Strong buckets in blue, middling in ink, weak ones in grey.
  const getColor = (range: string) => {
    const start = parseInt(range)
    if (start >= 60) return CHART.blue
    if (start >= 35) return CHART.ink
    return CHART.grey
  }

  return (
    <div className="card">
      <h3 className="text-base font-semibold mb-4" style={{ color: 'var(--text)' }}>Win probability distribution</h3>
      {!data || data.every((d) => d.count === 0) ? (
        <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No scored opportunities yet</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} margin={{ left: 0, right: 10, top: 16 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="range" {...axisProps} interval={0} angle={-30} dy={8} height={44} />
            <YAxis {...axisProps} width={36} allowDecimals={false} />
            <Tooltip {...tooltipProps} cursor={barCursor} />
            <Bar animationDuration={600} animationEasing="ease-out" dataKey="count" radius={[6, 6, 0, 0]}>
              {data.map((entry, i) => (
                <Cell key={i} fill={getColor(entry.range)} />
              ))}
              <LabelList
                dataKey="count"
                position="top"
                fill="var(--text-2)"
                fontSize={12}
                fontWeight={600}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
