import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'

const COLORS = ['#3b82f6', '#8b5cf6', '#22c55e', '#eab308', '#ef4444', '#f97316', '#06b6d4', '#ec4899']

interface ClientData {
  name: string
  totalSubmitted: number
  totalWon: number
}

function MiniPie({
  data,
  tooltipFormatter,
}: {
  data: { name: string; value: number }[]
  tooltipFormatter: (val: number) => string
}) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={40}
          outerRadius={70}
          dataKey="value"
          paddingAngle={2}
          label={({ name, percent }) =>
            percent > 0.05 ? `${name.substring(0, 10)} (${(percent * 100).toFixed(0)}%)` : ''
          }
          labelLine={{ stroke: '#6b7280', strokeWidth: 0.5 }}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: '6px',
            color: '#f3f4f6',
            fontSize: '11px',
          }}
          formatter={(val: number, _: any, props: any) => [
            tooltipFormatter(val),
            props.payload.name,
          ]}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}

export function ClientPortfolioPie({ clients }: { clients?: ClientData[] }) {
  const all = clients || []

  // Pie 1: Client Roster — all clients, sized by max(1, totalSubmitted) so everyone appears
  const rosterData = all.map((c) => ({
    name: c.name,
    value: Math.max(1, c.totalSubmitted),
  }))

  // Pie 2: Submission Activity — only clients with at least one submission
  const activityData = all
    .filter((c) => c.totalSubmitted > 0)
    .map((c) => ({ name: c.name, value: c.totalSubmitted }))

  return (
    <div className="card">
      <h3 className="font-semibold text-gray-200 mb-4">Client Distribution</h3>
      <div className="grid grid-cols-2 gap-4">
        {/* Left: roster */}
        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-wider text-center mb-1">
            Client Roster ({all.length})
          </p>
          {all.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">No clients</p>
          ) : (
            <MiniPie
              data={rosterData}
              tooltipFormatter={(val) =>
                val === 1 ? 'No submissions yet' : `${val} submissions`
              }
            />
          )}
        </div>

        {/* Right: submission activity */}
        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-wider text-center mb-1">
            Submission Activity
          </p>
          {activityData.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">No submissions yet</p>
          ) : (
            <MiniPie
              data={activityData}
              tooltipFormatter={(val) => `${val} submissions`}
            />
          )}
        </div>
      </div>

      {/* Color legend */}
      {all.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
          {all.slice(0, 8).map((c, i) => (
            <div key={c.name} className="flex items-center gap-1">
              <span
                className="w-2 h-2 rounded-sm flex-shrink-0"
                style={{ backgroundColor: COLORS[i % COLORS.length] }}
              />
              <span className="text-[10px] text-gray-400 truncate max-w-[80px]">{c.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
