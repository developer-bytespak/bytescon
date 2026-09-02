/**
 * Input schema for the `get_past_performance_detail` tool.
 */
import { z } from "zod";

export const getPastPerformanceDetailInputShape = {
  id: z
    .string()
    .min(1)
    .max(64)
    .describe("Past-performance record ID (from list_past_performance)."),
};

export const GetPastPerformanceDetailInput = z.object(getPastPerformanceDetailInputShape);
export type GetPastPerformanceDetailInputT = z.infer<typeof GetPastPerformanceDetailInput>;

export interface PastPerformanceDetailPayload {
  id: string;
  contract_number: string;
  customer_name: string;
  customer_agency: string | null;
  contract_type: string | null;
  total_value: number | null;
  period_of_performance_start: string | null;
  period_of_performance_end: string | null;
  cpars_rating: string | null;
  cpars_link: string | null;
  scope_summary: string;
  relevance_tags: string[];
  is_current: boolean;
  client_company_id: string | null;
  client_company_name: string | null;
  source_submission_record_id: string | null;
  created_at: string;
  updated_at: string;
}
