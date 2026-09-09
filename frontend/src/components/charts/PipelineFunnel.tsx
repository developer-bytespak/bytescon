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

const COLORS = ['#5b74ff', '#7b8fff', '#a3b1ff', '#e2b660', '#34d399']

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
            <XAxis type="number" tick={{ fill: '#8f8a99', fontSize: 12 }} stroke="#2b2933" />
            <YAxis
              type="category"
              dataKey="label"
              width={80}
              tick={{ fill: '#ece8df', fontSize: 12 }}
              stroke="#2b2933"
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1a1a20',
                border: '1px solid #2b2933',
                borderRadius: '6px',
                color: '#ece8df',
              }}
              labelStyle={{ color: '#ece8df' }}
              itemStyle={{ color: '#ece8df' }}
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
