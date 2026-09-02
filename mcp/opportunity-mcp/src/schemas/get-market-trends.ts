/**
 * Input schema for `get_market_trends`.
 *
 * Returns NAICS sector volume trends scoped to the tenant's recently-
 * ingested opportunities. Computed empirically (no LLM/model) from
 * opportunity counts grouped by NAICS over the trailing window.
 */
import { z } from "zod";

export const getMarketTrendsInputShape = {
  window_days: z
    .number()
    .int()
    .min(30)
    .max(365)
    .optional()
    .default(180)
    .describe("Trailing window for trend computation, in days. 30-365, default 180."),
  top_n: z
    .number()
    .int()
    .min(3)
    .max(50)
    .optional()
    .default(20)
    .describe("Number of NAICS rows to return (sorted by opportunity count desc). 3-50, default 20."),
};

export const GetMarketTrendsInput = z.object(getMarketTrendsInputShape);
export type GetMarketTrendsInputT = z.infer<typeof GetMarketTrendsInput>;

export interface NaicsTrendRow {
  naics_code: string;
  opportunity_count: number;
  avg_estimated_value: number | null;
  median_estimated_value: number | null;
  avg_competition_count: number | null;
  trend: "growing" | "declining" | "flat" | "insufficient_data";
  /** Slope of monthly opp count over the window. Positive = growing.
   * Null when fewer than 3 months of data within window. */
  monthly_slope: number | null;
}

export interface MarketTrendsPayload {
  window_days: number;
  computed_at: string;
  count: number;
  results: NaicsTrendRow[];
}
