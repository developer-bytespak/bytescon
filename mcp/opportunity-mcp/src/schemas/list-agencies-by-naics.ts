/**
 * Input schema for `list_agencies_by_naics`.
 *
 * Aggregates the tenant's opportunities for one 6-digit NAICS code by
 * agency (count, open count, average estimated value, set-aside mix)
 * and joins the global AgencyAwardProfile small-business and SDVOSB
 * award rates where a profile exists for the agency name.
 */
import { z } from "zod";

export const listAgenciesByNaicsInputShape = {
  naics: z
    .string()
    .regex(/^\d{6}$/, "naics must be exactly 6 digits")
    .describe("Exact 6-digit NAICS code to aggregate, e.g. 541330."),
  top_n: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Number of agencies to return, sorted by opportunity count descending. 1-50, default 10."),
};

export const ListAgenciesByNaicsInput = z.object(listAgenciesByNaicsInputShape);
export type ListAgenciesByNaicsInputT = z.infer<typeof ListAgenciesByNaicsInput>;

export interface AgencyAwardProfileSummary {
  avg_award_value: number | null;
  small_biz_rate: number;
  sdvosb_rate: number;
}

export interface AgencyNaicsRow {
  agency: string;
  /** All of the tenant's opportunities for this NAICS at this agency, any status. */
  opportunity_count: number;
  /** Subset with status ACTIVE. */
  open_count: number;
  /** Average estimatedValue across opportunities that carry a value; null when none do. */
  avg_estimated_value: number | null;
  /** Stored set-aside values and their counts at this agency for this NAICS. */
  set_aside_mix: Array<{ set_aside: string; count: number }>;
  /** Global agency award profile (small-biz and SDVOSB award rates); null when no profile row exists. */
  award_profile: AgencyAwardProfileSummary | null;
}

export interface ListAgenciesByNaicsPayload {
  naics: string;
  count: number;
  results: AgencyNaicsRow[];
  generated_at: string;
}
