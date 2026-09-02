/**
 * Input schema for the `get_compliance_matrix` tool.
 */
import { z } from "zod";

export const getComplianceMatrixInputShape = {
  opportunity_id: z
    .string()
    .min(1)
    .max(128)
    .describe("Opportunity ID (UUID) whose compliance matrix to retrieve."),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of requirement rows to skip, for pagination. Default 0."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(25)
    .describe("Maximum requirement rows to return, 1-50, default 25."),
};

export const GetComplianceMatrixInput = z.object(getComplianceMatrixInputShape);
export type GetComplianceMatrixInputT = z.infer<typeof GetComplianceMatrixInput>;

/** One requirement row in the tool payload. */
export interface RequirementPayload {
  id: string;
  section: string;
  section_type: string;
  requirement_text: string;
  is_mandatory: boolean;
  status: string;
  far_reference: string | null;
  sort_order: number;
}

/** Payload returned by get_compliance_matrix. */
export interface ComplianceMatrixPayload {
  matrix_id: string;
  opportunity_id: string;
  generated_at: string;
  updated_at: string;
  has_bid_guidance: boolean;
  requirement_total: number;
  offset: number;
  limit: number;
  requirements: RequirementPayload[];
}
