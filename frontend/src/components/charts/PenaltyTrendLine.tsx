import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
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

export function PenaltyTrendLine({ data }: { data?: TrendSeries }) {
  const directionColor =
    data?.direction === 'up' ? 'text-red-400' : data?.direction === 'down' ? 'text-green-400' : 'text-gray-400'
  const arrow = data?.direction === 'up' ? '↑' : data?.direction === 'down' ? '↓' : '→'

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-200">Penalty Trend (12mo)</h3>
        {data && (
          <span className={`text-xs font-mono ${directionColor}`}>
            {arrow} {Math.abs(data.changePercent)}%
          </span>
        )}
      </div>
      {!data || data.points.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No penalty data yet</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data.points} margin={{ left: 0, right: 10 }}>
            <XAxis
              dataKey="period"
              tick={{ fill: '#9ca3af', fontSize: 10 }}
              tickFormatter={(v) => v.slice(5)} // "MM" only
            />
            <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '6px',
                color: '#f3f4f6',
              }}
              formatter={(val: number) => [`$${val.toLocaleString()}`, '']}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, color: '#9ca3af' }}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="#ef4444"
              name="Monthly"
              strokeWidth={1}
              dot={{ r: 2 }}
            />
            <Line
              type="monotone"
              dataKey="ema"
              stroke="#f97316"
              name="3-mo EMA"
              strokeWidth={2}
              dot={false}
              strokeDasharray="4 2"
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
