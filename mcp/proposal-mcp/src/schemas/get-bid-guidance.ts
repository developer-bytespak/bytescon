/**
 * Input schema for the `get_bid_guidance` tool.
 */
import { z } from "zod";

export const getBidGuidanceInputShape = {
  opportunity_id: z
    .string()
    .min(1)
    .max(128)
    .describe("Opportunity ID (UUID) whose compliance matrix bid guidance to retrieve."),
};

export const GetBidGuidanceInput = z.object(getBidGuidanceInputShape);
export type GetBidGuidanceInputT = z.infer<typeof GetBidGuidanceInput>;

/** Payload returned by get_bid_guidance. */
export interface BidGuidancePayload {
  opportunity_id: string;
  matrix_id: string;
  has_guidance: boolean;
  generated_at: string | null;
  bid_guidance: unknown;
  note: string | null;
}
