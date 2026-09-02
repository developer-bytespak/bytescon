/**
 * `list_deliverables` tool handler.
 *
 * DocumentRequirement rows for the calling tenant: title, due date,
 * status, penalty fields. Tenant filter (consultingFirmId from the
 * resolved token, never from tool args) is the first WHERE clause.
 * Free-text fields are sanitized before returning to the host LLM.
 */
import { registerTool, sanitize, type HandlerResult, type ToolHandlerContext, type ToolRegistrar } from "@bytescon/mcp-shared";
import { coreDb, toNumber } from "../lib/db.js";
import { runTool } from "../lib/run-tool.js";
import {
  listDeliverablesInputShape,
  type DeliverableSummary,
  type ListDeliverablesInputT,
  type ListDeliverablesPayload,
} from "../schemas/list-deliverables.js";

const TOOL_NAME = "list_deliverables";

const TOOL_DESCRIPTION =
  "List your tenant's client deliverable document requirements, including due date, status, and penalty amount. " +
  "Filter by status, due_before, or client_company_id. Paginated with offset and limit; total carries the full match count.";

/**
 * Pure handler, directly testable. The McpServer registration wraps this.
 */
export async function handleListDeliverables(
  input: ListDeliverablesInputT,
  context: ToolHandlerContext
): Promise<HandlerResult> {
  return runTool(TOOL_NAME, input, context, async () => {
    const db = coreDb(context.prisma);

    const where: Record<string, unknown> = {
      consultingFirmId: context.ctx.consultingFirmId,
    };
    if (input.status) where["status"] = input.status;
    if (input.due_before) where["dueDate"] = { lt: new Date(input.due_before) };
    if (input.client_company_id) where["clientCompanyId"] = input.client_company_id;

    const [total, rows] = await Promise.all([
      db.documentRequirement.count({ where }),
      db.documentRequirement.findMany({
        where,
        orderBy: [{ dueDate: "asc" }, { id: "asc" }],
        skip: input.offset,
        take: input.limit,
        select: {
          id: true,
          clientCompanyId: true,
          opportunityId: true,
          title: true,
          description: true,
          dueDate: true,
          isPenaltyEnabled: true,
          penaltyAmount: true,
          penaltyPercent: true,
          status: true,
          submittedAt: true,
        },
      }),
    ]);

    const results: DeliverableSummary[] = rows.map((r) => ({
      id: r.id,
      client_company_id: r.clientCompanyId,
      opportunity_id: r.opportunityId,
      title: sanitize(r.title),
      description: r.description === null ? null : sanitize(r.description),
      due_date: r.dueDate.toISOString(),
      status: r.status,
      is_penalty_enabled: r.isPenaltyEnabled,
      penalty_amount: toNumber(r.penaltyAmount),
      penalty_percent: toNumber(r.penaltyPercent),
      submitted_at: r.submittedAt ? r.submittedAt.toISOString() : null,
    }));

    const payload: ListDeliverablesPayload = {
      count: results.length,
      total,
      offset: input.offset,
      limit: input.limit,
      results,
    };
    return payload;
  });
}

export const registerListDeliverables: ToolRegistrar = (server, context) => {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: listDeliverablesInputShape,
    handler: async (input) =>
      handleListDeliverables(input as unknown as ListDeliverablesInputT, context),
  });
};
