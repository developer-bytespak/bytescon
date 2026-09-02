/**
 * Input schema for the `get_bid_decision` tool.
 */
import { z } from "zod";

export const getBidDecisionInputShape = {
  opportunity_id: z
    .string()
    .uuid()
    .describe("Opportunity UUID."),
  client_company_id: z
    .string()
    .uuid()
    .describe("Client company UUID."),
};

export const GetBidDecisionInput = z.object(getBidDecisionInputShape);
export type GetBidDecisionInputT = z.infer<typeof GetBidDecisionInput>;

export interface BidDecisionPayload {
  opportunity_id: string;
  client_company_id: string;
  recommendation: string | null;
  win_probability: number | null;
  win_probability_pct: string | null;
  credible_interval: { low: number; high: number; width_pct: number } | null;
  set_aside_match: string | null;
  fit_score: number | null;
  market_score: number | null;
  compliance_gate: string | null;
  rationale: string | null;
  expected_value: number | null;
  triggered_flags: string[];
  created_at: string;
  updated_at: string;
}
