import { useState } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  ResponsiveContainer,
} from 'recharts'

const COLORS = ['#5b74ff', '#7b8fff', 'var(--accent-3)', '#e2b660', '#34d399']

interface Stage {
  label: string
  count: number
}

export function PipelineFunnel({ stages }: { stages: Stage[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  return (
    <div className="card">
      <h3 className="font-semibold text-gray-200 mb-4">Opportunity Pipeline</h3>
      {stages.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No pipeline data yet</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={stages} layout="vertical" margin={{ left: 10, right: 20 }}>
            <XAxis type="number" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} stroke="var(--line-strong)" />
            <YAxis
              type="category"
              dataKey="label"
              width={80}
              tick={{ fill: 'var(--text)', fontSize: 12 }}
              stroke="var(--line-strong)"
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--surface-2)',
                border: '1px solid var(--line-strong)',
                borderRadius: '6px',
                color: 'var(--text)',
              }}
              labelStyle={{ color: 'var(--text)' }}
              itemStyle={{ color: 'var(--text)' }}
            />
            <Bar
              dataKey="count"
              radius={[0, 4, 4, 0]}
              onMouseLeave={() => setHoverIndex(null)}
            >
              {stages.map((_, i) => (
                <Cell
                  key={i}
                  fill={hoverIndex === i ? '#7b8fff' : COLORS[i % COLORS.length]}
                  onMouseEnter={() => setHoverIndex(i)}
                  style={{ cursor: 'pointer', transition: 'fill 0.15s ease' }}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
