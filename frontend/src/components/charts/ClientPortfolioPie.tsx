import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { CHART, seriesColor, tooltipProps } from './chartTheme'

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
        <Pie animationDuration={600} animationEasing="ease-out"
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={48}
          outerRadius={72}
          dataKey="value"
          stroke={CHART.surface}
          strokeWidth={2}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={seriesColor(i)} />
          ))}
        </Pie>
        <Tooltip
          {...tooltipProps}
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
      <h3 className="text-base font-semibold mb-4" style={{ color: 'var(--text)' }}>Client distribution</h3>
      <div className="grid grid-cols-2 gap-4">
        {/* Left: roster */}
        <div>
          <p className="text-[13px] text-center mb-1" style={{ color: 'var(--text-muted)' }}>
            Client roster ({all.length})
          </p>
          {all.length === 0 ? (
            <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No clients</p>
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
          <p className="text-[13px] text-center mb-1" style={{ color: 'var(--text-muted)' }}>
            Submission activity
          </p>
          {activityData.length === 0 ? (
            <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No submissions yet</p>
          ) : (
            <MiniPie
              data={activityData}
              tooltipFormatter={(val) => `${val} submissions`}
            />
          )}
        </div>
      </div>

      {/* Colour key: the first four clients get their own colour, the rest share the light grey. */}
      {all.length > 0 && (
        <div className="mt-4 pt-4 flex flex-wrap gap-x-4 gap-y-1.5" style={{ borderTop: '1px solid var(--line)' }}>
          {all.slice(0, 8).map((c, i) => (
            <div key={c.name} className="flex items-center gap-1.5 min-w-0">
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: seriesColor(i) }}
              />
              <span className="text-xs truncate max-w-[140px]" style={{ color: 'var(--text-2)' }}>{c.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
