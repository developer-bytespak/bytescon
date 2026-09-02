/**
 * Input schema for the `get_adherence_score` tool.
 */
import { z } from "zod";

export const getAdherenceScoreInputShape = {
  opportunity_id: z
    .string()
    .min(1)
    .max(128)
    .describe("Opportunity ID (UUID) whose adherence scores to retrieve."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Maximum score rows to return, newest first, 1-20, default 5."),
};

export const GetAdherenceScoreInput = z.object(getAdherenceScoreInputShape);
export type GetAdherenceScoreInputT = z.infer<typeof GetAdherenceScoreInput>;

/** One adherence score row in the tool payload. */
export interface AdherenceScorePayload {
  id: string;
  scope: "proposal" | "section";
  proposal_section_id: string | null;
  overall_score: number;
  requirement_coverage: number | null;
  evaluation_alignment: number | null;
  evidence_sufficiency: number | null;
  far_clause_coverage: number | null;
  readability: number | null;
  consistency: number | null;
  ambiguity: number | null;
  blockers: unknown;
  computed_at: string;
}

/** Payload returned by get_adherence_score. */
export interface GetAdherenceScorePayload {
  opportunity_id: string;
  count: number;
  scores: AdherenceScorePayload[];
  note: string | null;
}
