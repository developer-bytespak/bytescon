/**
 * Input schema for the `list_matrix_requirements` tool.
 *
 * sectionType is a plain String column in the schema; the enum below is
 * the canonical value set the backend extraction pipeline writes.
 * status mirrors the MatrixRequirementStatus Prisma enum exactly.
 */
import { z } from "zod";

export const SectionTypeEnum = z.enum(["INSTRUCTION", "EVALUATION", "CLAUSE", "CERTIFICATION"]);

export const RequirementStatusEnum = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "COMPLETED",
  "PENDING_REVIEW",
  "BLOCKED",
]);

export const listMatrixRequirementsInputShape = {
  opportunity_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Optional opportunity ID (UUID); restricts results to that opportunity's matrix."),
  section_type: SectionTypeEnum.optional().describe(
    "Optional requirement section type filter: INSTRUCTION, EVALUATION, CLAUSE, or CERTIFICATION."
  ),
  mandatory_only: z
    .boolean()
    .default(false)
    .describe("When true, return only requirements flagged mandatory. Default false."),
  status: RequirementStatusEnum.optional().describe(
    "Optional status filter: NOT_STARTED, IN_PROGRESS, COMPLETED, PENDING_REVIEW, or BLOCKED."
  ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of rows to skip, for pagination. Default 0."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(25)
    .describe("Maximum rows to return, 1-50, default 25."),
};

export const ListMatrixRequirementsInput = z.object(listMatrixRequirementsInputShape);
export type ListMatrixRequirementsInputT = z.infer<typeof ListMatrixRequirementsInput>;

/** One row in the list_matrix_requirements payload. */
export interface ListedRequirementPayload {
  id: string;
  matrix_id: string;
  opportunity_id: string;
  section: string;
  section_type: string;
  requirement_text: string;
  is_mandatory: boolean;
  status: string;
  far_reference: string | null;
  sort_order: number;
}

/** Payload returned by list_matrix_requirements. */
export interface ListMatrixRequirementsPayload {
  total: number;
  offset: number;
  limit: number;
  count: number;
  requirements: ListedRequirementPayload[];
}
