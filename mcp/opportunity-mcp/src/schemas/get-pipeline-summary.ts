/**
 * Input schema for `get_pipeline_summary`.
 *
 * Tenant-scoped aggregate KPIs over the calling firm's opportunities
 * and submissions. Reads from `opportunities` + `bid_decisions` +
 * `submission_records`.
 */
import { z } from "zod";

export const getPipelineSummaryInputShape = {
  // Reserved for future scoping (per-client filter, date range, etc.).
  // Empty for v0.3 — Zod accepts {} as valid input.
};

import type {} from "zod";

export const GetPipelineSummaryInput = z.object({});
export type GetPipelineSummaryInputT = z.infer<typeof GetPipelineSummaryInput>;

export interface PipelineSummaryPayload {
  /** Counts at each pipeline stage for the calling tenant. */
  stages: {
    ingested: number;
    scored: number;
    decided_go: number;
    decided_no_go: number;
    submitted: number;
    won: number;
    lost: number;
  };
  /** Empirical conversion ratios (stage / prior stage). */
  conversion_rates: {
    scored_per_ingested: number;
    decided_per_scored: number;
    submitted_per_decided_go: number;
    won_per_submitted: number;
  };
  /** Top-line dollar totals (won + open expected). */
  totals: {
    won_award_amount: number;
    open_expected_revenue: number;
  };
  /** Active opportunities split by status for convenience. */
  active: {
    open: number;
    closing_within_7_days: number;
    overdue: number;
  };
  generated_at: string;
}
