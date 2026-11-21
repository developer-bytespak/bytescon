// Shared Recharts styling for the v3 look: ink and electric blue carry the
// data, the light surface-3 is "the rest", red only marks something bad.
// Colours are CSS variables so light and dark mode follow automatically.
import type { CSSProperties } from 'react'

export const CHART = {
  ink: 'var(--text)',
  blue: 'var(--v3-blue)',
  grey: 'var(--text-dim)',
  blueSoft: 'var(--accent-line)',
  rest: 'var(--surface-3)',
  urgent: 'var(--danger)',
  grid: 'var(--line)',
  surface: 'var(--surface)',
}

/** Categorical order: ink, blue, grey, soft blue, then everything else as "rest". */
export const SERIES = [CHART.ink, CHART.blue, CHART.grey, CHART.blueSoft]
export const seriesColor = (i: number) => SERIES[i] ?? CHART.rest

/** Axis props: quiet, 12px warm grey, no axis or tick lines. */
export const axisProps = {
  tick: { fill: 'var(--text-muted)', fontSize: 12 },
  axisLine: false,
  tickLine: false,
} as const

/** Horizontal grid lines only, in the hairline colour. */
export const gridProps = { stroke: CHART.grid, vertical: false } as const

export const tooltipProps = {
  contentStyle: {
    backgroundColor: 'var(--surface)',
    border: 0,
    borderRadius: 12,
    boxShadow: 'var(--shadow-2)',
    color: 'var(--text)',
    fontSize: 13,
    padding: '8px 12px',
  } as CSSProperties,
  labelStyle: { color: 'var(--text)', fontWeight: 600, marginBottom: 2 } as CSSProperties,
  itemStyle: { color: 'var(--text-2)', padding: 0 } as CSSProperties,
}
export const lineCursor = { stroke: 'var(--line-strong)' }
export const barCursor = { fill: 'var(--hover)' }

export const legendStyle: CSSProperties = { fontSize: 13, color: 'var(--text-muted)', paddingTop: 8 }

/** Legend labels stay in the text colour; only the key swatch carries the series colour. */
export const legendFormatter = (value: string) => <span style={{ color: 'var(--text-2)' }}>{value}</span>
