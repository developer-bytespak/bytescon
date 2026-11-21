import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { CHART, axisProps, tooltipProps, barCursor } from './chartTheme'

interface Stage {
  label: string
  count: number
}

export function PipelineFunnel({ stages }: { stages: Stage[] }) {
  return (
    <div className="card">
      <h3 className="text-base font-semibold mb-4" style={{ color: 'var(--text)' }}>Opportunity pipeline</h3>
      {stages.length === 0 ? (
        <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No pipeline data yet</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={stages} layout="vertical" margin={{ left: 10, right: 20 }}>
            <XAxis type="number" {...axisProps} />
            <YAxis
              type="category"
              dataKey="label"
              width={80}
              {...axisProps}
              tick={{ fill: 'var(--text-2)', fontSize: 13 }}
            />
            <Tooltip {...tooltipProps} cursor={barCursor} />
            <Bar animationDuration={600} animationEasing="ease-out"
              dataKey="count"
              radius={[0, 6, 6, 0]}
              fill={CHART.ink}
              activeBar={{ fill: CHART.blue }}
              style={{ cursor: 'pointer' }}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
