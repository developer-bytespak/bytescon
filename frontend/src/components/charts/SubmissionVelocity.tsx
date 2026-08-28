import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

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
  const directionColor =
    data?.direction === 'up' ? 'text-green-400' : data?.direction === 'down' ? 'text-red-400' : 'text-gray-400'
  const arrow = data?.direction === 'up' ? '↑' : data?.direction === 'down' ? '↓' : '→'

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-200">Submission Velocity</h3>
        {data && (
          <span className={`text-xs font-mono ${directionColor}`}>
            {arrow} {Math.abs(data.changePercent)}%
          </span>
        )}
      </div>
      {!data || data.points.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No submission data yet</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data.points} margin={{ left: 0, right: 10 }}>
            <defs>
              <linearGradient id="submissionGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="period"
              tick={{ fill: '#9ca3af', fontSize: 10 }}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} allowDecimals={false} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '6px',
                color: '#f3f4f6',
              }}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="#3b82f6"
              fill="url(#submissionGradient)"
              strokeWidth={2}
            />
            <Area
              type="monotone"
              dataKey="ema"
              stroke="#60a5fa"
              fill="none"
              strokeWidth={1}
              strokeDasharray="4 2"
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
