/**
 * Input schema for `forecast_revenue`.
 *
 * Monte Carlo revenue forecast over the tenant's ACTIVE pipeline,
 * ported from backend/src/services/revenueForecaster.ts. The forecast
 * math is reimplemented locally (not imported) because the backend
 * service module pulls in the backend logger and database config,
 * which live outside this package's tsconfig rootDir and write to
 * stdout, which would corrupt the stdio MCP transport.
 */
import { z } from "zod";

export const forecastRevenueInputShape = {
  months_ahead: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .default(6)
    .describe("Forecast horizon in months, 1-24, default 6."),
  include_portfolio_health: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, also returns a portfolio health summary: diversification " +
      "(NAICS and agency concentration, set-aside distribution) and risk indicators " +
      "(single-client dependency, overdue submission rate, pipeline coverage). Default false."
    ),
};

export const ForecastRevenueInput = z.object(forecastRevenueInputShape);
export type ForecastRevenueInputT = z.infer<typeof ForecastRevenueInput>;

export interface ForecastMonthRow {
  /** Calendar month in UTC, formatted "YYYY-MM". */
  period: string;
  /** Mean simulated revenue for the month (rounded dollars). */
  expected: number;
  /** 10th percentile (pessimistic). */
  p10: number;
  /** Median. */
  p50: number;
  /** 90th percentile (optimistic). */
  p90: number;
  /** Number of pipeline opportunities whose deadline falls in this month. */
  opportunity_count: number;
}

export interface SetAsideDistributionRow {
  type: string;
  count: number;
  percent: number;
}

export interface PortfolioHealthSummary {
  diversification: {
    /** Herfindahl-Hirschman Index over 2-digit NAICS sectors, 0-1, lower = more diverse. */
    naics_concentration: number;
    /** HHI over agencies, 0-1. */
    agency_concentration: number;
    /** Share of active pipeline in the top-3 NAICS sectors, 0-1. */
    naics_top_three_share: number;
    /** Share of active pipeline in the top-3 agencies, 0-1. */
    agency_top_three_share: number;
    set_aside_distribution: SetAsideDistributionRow[];
  };
  risk_indicators: {
    /** Percent of bid-decision pipeline value attributable to the top client, 0-100. */
    single_client_dependency_pct: number;
    /** Percent of submissions recorded as late, 0-100. */
    overdue_submission_rate_pct: number;
    /** Average days between submission and the response deadline. */
    avg_days_to_deadline_at_submission: number;
    /** Total bid-decision pipeline value / total expected forecast revenue. */
    pipeline_coverage: number;
  };
}

export interface ForecastRevenuePayload {
  months_ahead: number;
  /** Monte Carlo simulation count used server-side (capped for latency). */
  simulations: number;
  generated_at: string;
  forecast: ForecastMonthRow[];
  /** Sum of `expected` across all forecast months. */
  total_expected_revenue: number;
  portfolio_health: PortfolioHealthSummary | null;
}
