/**
 * Input schema for the `get_usage_summary` tool.
 *
 * Aggregates the tenant's ApiUsageLog rows (AI provider calls, tokens,
 * estimated cost) over a recent window. Tenant-scoped, read-only.
 */
import { z } from "zod";

export const getUsageSummaryInputShape = {
  window_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .default(30)
    .describe("Aggregation window in days ending now, 1-365, default 30."),
};

export const GetUsageSummaryInput = z.object(getUsageSummaryInputShape);
export type GetUsageSummaryInputT = z.infer<typeof GetUsageSummaryInput>;

export interface ProviderUsage {
  provider: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

export interface GetUsageSummaryPayload {
  window_days: number;
  since: string;
  providers: ProviderUsage[];
  totals: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  };
}
