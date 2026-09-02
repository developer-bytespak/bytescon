/**
 * Input schema for the `list_deliverables` tool.
 *
 * Lists the tenant's DocumentRequirement rows (client deliverables with
 * due dates and optional penalties). Tenant-scoped, read-only, paginated.
 */
import { z } from "zod";

/** Mirrors enum DocumentRequirementStatus in backend/prisma/schema.prisma. */
export const DeliverableStatusEnum = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
]);

export const listDeliverablesInputShape = {
  status: DeliverableStatusEnum.optional().describe(
    "Filter by deliverable status. One of PENDING, IN_PROGRESS, SUBMITTED, APPROVED, REJECTED."
  ),
  due_before: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      "ISO 8601 datetime with offset; returns only deliverables due strictly before this instant."
    ),
  client_company_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Filter to deliverables for one client company id."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe("Maximum rows to return, 1-100, default 25."),
  offset: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .default(0)
    .describe("Rows to skip for pagination, default 0."),
};

export const ListDeliverablesInput = z.object(listDeliverablesInputShape);
export type ListDeliverablesInputT = z.infer<typeof ListDeliverablesInput>;

export interface DeliverableSummary {
  id: string;
  client_company_id: string;
  opportunity_id: string | null;
  title: string;
  description: string | null;
  due_date: string;
  status: string;
  is_penalty_enabled: boolean;
  penalty_amount: number | null;
  penalty_percent: number | null;
  submitted_at: string | null;
}

export interface ListDeliverablesPayload {
  count: number;
  total: number;
  offset: number;
  limit: number;
  results: DeliverableSummary[];
}
