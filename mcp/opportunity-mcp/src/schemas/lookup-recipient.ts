/**
 * Input schema for the `lookup_recipient` tool.
 *
 * Federal recipient (UEI) data is public-domain SAM.gov + USAspending
 * data, NOT tenant-scoped. The tool still requires a valid tenant token
 * so all access is audited, but results are not filtered by tenant.
 */
import { z } from "zod";

export const lookupRecipientInputShape = {
  uei: z
    .string()
    .regex(/^[A-Z0-9]{12}$/i, "uei must be 12 alphanumeric characters")
    .describe("12-character SAM.gov Unique Entity Identifier."),
};

export const LookupRecipientInput = z.object(lookupRecipientInputShape);
export type LookupRecipientInputT = z.infer<typeof LookupRecipientInput>;

export interface RecipientLookupPayload {
  uei: string;
  legal_name: string | null;
  cage_code: string | null;
  sam_reg_status: string | null;
  sam_reg_expiry: string | null;
  website: string | null;
  naics_codes: string[];
  certifications: {
    sdvosb: boolean;
    wosb: boolean;
    hubzone: boolean;
    small_business: boolean;
    va_osdbu_verified: boolean | null;
  };
  recent_award_count: number;
}
