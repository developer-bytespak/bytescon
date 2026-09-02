/**
 * Input schema for the `list_past_performance` tool.
 *
 * Returns the calling tenant's structured past-performance records
 * (prior contracts / CPARS history the firm can cite for proposals).
 * Tenant-scoped via consultingFirmId from the resolved bearer token.
 */
import { z } from "zod";

export const listPastPerformanceInputShape = {
  client_company_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Optional client company ID (from list_clients). If set, only return past-performance " +
        "records tied to that client. Omit to return all of the firm's records.",
    ),
  is_current: z
    .boolean()
    .optional()
    .describe(
      "Optional filter on the current/active flag. Omit (default) to return ALL records — " +
        "including completed/expired contracts, which are usually the ones cited in proposals. " +
        "Pass true for only current records, or false for only historical/expired ones.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe("Maximum number of records to return. 1-100, default 25."),
};

export const ListPastPerformanceInput = z.object(listPastPerformanceInputShape);
export type ListPastPerformanceInputT = z.infer<typeof ListPastPerformanceInput>;

export interface PastPerformanceSummary {
  id: string;
  contract_number: string;
  customer_name: string;
  customer_agency: string | null;
  contract_type: string | null;
  total_value: number | null;
  period_of_performance_start: string | null;
  period_of_performance_end: string | null;
  cpars_rating: string | null;
  is_current: boolean;
  client_company_id: string | null;
  client_company_name: string | null;
  relevance_tags: string[];
  created_at: string;
}

export interface PastPerformanceListPayload {
  count: number;
  truncated: boolean;
  results: PastPerformanceSummary[];
}
