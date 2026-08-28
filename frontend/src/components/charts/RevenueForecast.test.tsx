// =============================================================
// Section 4 #9 — the forecast chart must render for valid data and degrade
// gracefully (never crash) for empty / all-zero / malformed inputs.
// =============================================================
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

// Recharts' ResponsiveContainer needs a sized parent that jsdom doesn't provide;
// stub it to a plain box so children render measurably in tests.
vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts')
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div style={{ width: 800, height: 260 }}>{children}</div> }
})

import { RevenueForecast } from './RevenueForecast'
import type { ForecastMonth } from '../../lib/forecastChart'

const month = (over: Partial<ForecastMonth>): ForecastMonth => ({
  period: '2026-08', expected: 0, p10: 0, p50: 0, p90: 0, opportunityCount: 0, ...over,
})

describe('RevenueForecast (Section 4 #9)', () => {
  it('shows the no-data state when data is undefined', () => {
    render(<RevenueForecast data={undefined} />)
    expect(screen.getByText(/no pipeline data/i)).toBeInTheDocument()
  })

  it('shows the all-zero explanatory state instead of a flat empty chart', () => {
    render(<RevenueForecast data={[month({}), month({ period: '2026-09' })]} />)
    expect(screen.getByText(/not enough scored pipeline/i)).toBeInTheDocument()
  })

  it('renders without crashing for valid data (headline total shown)', () => {
    render(
      <RevenueForecast
        data={[
          month({ period: '2026-08', expected: 1_000_000, p10: 500_000, p50: 900_000, p90: 1_500_000, opportunityCount: 3 }),
          month({ period: '2026-09', expected: 250_000, p10: 100_000, p50: 220_000, p90: 400_000, opportunityCount: 1 }),
        ]}
      />,
    )
    expect(screen.getByText(/Revenue Forecast/i)).toBeInTheDocument()
    expect(screen.getByText(/Expected:/i)).toBeInTheDocument()
  })

  it('does NOT crash when a period is malformed (the original page-breaking bug)', () => {
    expect(() =>
      render(
        <RevenueForecast
          data={[
            month({ period: 'not-a-date', expected: 100 } as Partial<ForecastMonth>),
            month({ period: '2026-08', expected: 1_000_000, p90: 1_500_000 }),
          ]}
        />,
      ),
    ).not.toThrow()
    expect(screen.getByText(/Revenue Forecast/i)).toBeInTheDocument()
  })
})
