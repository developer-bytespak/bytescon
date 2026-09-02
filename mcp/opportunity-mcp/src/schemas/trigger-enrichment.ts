/**
 * Input schema for `trigger_enrichment` (GB-107).
 *
 * Queues on-demand SAM.gov description enrichment for one opportunity.
 * The backend GB-107 worker polls for QUEUED rows every 60 seconds and
 * fetches the full solicitation description (noticedesc endpoint),
 * extracts FAR/DFARS clauses and requirements into the compliance
 * matrix, and re-scores the opportunity.
 */
import { z } from "zod";

export const triggerEnrichmentInputShape = {
  opportunity_id: z
    .string()
    .uuid()
    .describe("Opportunity UUID to enrich (must belong to the calling tenant)."),
  priority: z
    .enum(["normal", "urgent"])
    .optional()
    .default("normal")
    .describe(
      "Reserved for future prioritization. Both values currently queue for the next worker cycle (~60s) and respect the shared SAM.gov daily rate limit."
    ),
};

export const TriggerEnrichmentInput = z.object(triggerEnrichmentInputShape);
export type TriggerEnrichmentInputT = z.infer<typeof TriggerEnrichmentInput>;

export type TriggerEnrichmentStatus =
  | "QUEUED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "RATE_LIMITED";

export interface TriggerEnrichmentPayload {
  opportunity_id: string;
  status: TriggerEnrichmentStatus;
  message: string;
  /** ISO 8601, or null when no completion estimate applies (already done / terminal failure). */
  estimated_completion: string | null;
}
