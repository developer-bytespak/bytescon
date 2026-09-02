/**
 * Input schema for the `list_compliance_gaps` tool.
 *
 * Returns unfulfilled MatrixRequirements for the opportunity — i.e.,
 * the open compliance work the consultant still needs to address before
 * submission. Mandatory items appear first.
 */
import { z } from "zod";

export const listComplianceGapsInputShape = {
  opportunity_id: z
    .string()
    .uuid()
    .describe("Opportunity UUID to list outstanding compliance requirements for."),
  mandatory_only: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, return only mandatory requirements. Default false (all open items)."),
};

export const ListComplianceGapsInput = z.object(listComplianceGapsInputShape);
export type ListComplianceGapsInputT = z.infer<typeof ListComplianceGapsInput>;

export interface ComplianceGapRow {
  id: string;
  section: string;
  section_type: string;
  far_reference: string | null;
  is_mandatory: boolean;
  status: string;
  requirement_text: string;
  proposal_section: string | null;
}

export interface ListComplianceGapsPayload {
  opportunity_id: string;
  has_matrix: boolean;
  count: number;
  mandatory_open: number;
  gaps: ComplianceGapRow[];
}
