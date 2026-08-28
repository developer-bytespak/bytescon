import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  LabelList,
  ResponsiveContainer,
} from 'recharts'

interface ProbBucket {
  range: string
  count: number
}

export function WinProbabilityDistribution({ data }: { data?: ProbBucket[] }) {
  const getColor = (range: string) => {
    const start = parseInt(range)
    if (start >= 60) return '#22c55e'
    if (start >= 35) return '#eab308'
    return '#ef4444'
  }

  return (
    <div className="card">
      <h3 className="font-semibold text-gray-200 mb-4">Win Probability Distribution</h3>
      {!data || data.every((d) => d.count === 0) ? (
        <p className="text-sm text-gray-500 text-center py-8">No scored opportunities yet</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} margin={{ left: 0, right: 10 }}>
            <XAxis
              dataKey="range"
              tick={{ fill: '#e5e7eb', fontSize: 9 }}
              interval={0}
              angle={-30}
              dy={8}
            />
            <YAxis tick={{ fill: '#e5e7eb', fontSize: 10 }} allowDecimals={false} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '6px',
                color: '#f3f4f6',
              }}
            />
            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
              {data.map((entry, i) => (
                <Cell key={i} fill={getColor(entry.range)} />
              ))}
              <LabelList
                dataKey="count"
                position="top"
                fill="#ffffff"
                fontSize={11}
                fontWeight={600}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
