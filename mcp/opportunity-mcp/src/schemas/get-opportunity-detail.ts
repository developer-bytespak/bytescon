/**
 * Input schema for the `get_opportunity_detail` tool.
 */
import { z } from "zod";

export const getOpportunityDetailInputShape = {
  opportunity_id: z
    .string()
    .min(1)
    .max(128)
    .describe("Internal opportunity ID (UUID) or SAM notice ID returned by search_opportunities."),
};

export const GetOpportunityDetailInput = z.object(getOpportunityDetailInputShape);
export type GetOpportunityDetailInputT = z.infer<typeof GetOpportunityDetailInput>;

export interface OpportunityDetailPayload {
  id: string;
  sam_notice_id: string | null;
  title: string;
  agency: string;
  naics: string;
  set_aside: string;
  notice_type: string | null;
  description: string;
  posted_date: string | null;
  response_deadline: string;
  estimated_value: number | null;
  place_of_performance: string | null;
  source_url: string | null;
  is_enriched: boolean;
  historical_winner: string | null;
  competition_count: number | null;
  incumbent_probability: number | null;
  recompete_flag: boolean | null;
  agency_sdvosb_rate: number | null;
  agency_small_biz_rate: number | null;
  latest_decision: {
    client_company_id: string;
    recommendation: string | null;
    win_probability: number | null;
    fit_score: number | null;
    market_score: number | null;
    credible_interval: { low: number; high: number } | null;
    set_aside_match: string | null;
    created_at: string;
  } | null;
}
