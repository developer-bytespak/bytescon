/**
 * `list_matrix_requirements` tool handler.
 *
 * Cross-matrix requirement listing for the calling tenant with optional
 * filters (opportunity, section type, mandatory flag, status) and
 * pagination. Tenant scoped through the parent matrix relation: the
 * consultingFirmId from the resolved token is always present in the
 * relation filter, so rows from other tenants can never match.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerTool,
  sanitize,
  type HandlerResult,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";
import { asProposalDb, type MatrixRequirementWhere } from "../lib/db.js";
import { runTool } from "../lib/tool-runner.js";
import {
  listMatrixRequirementsInputShape,
  type ListMatrixRequirementsInputT,
  type ListMatrixRequirementsPayload,
} from "../schemas/list-matrix-requirements.js";

const TOOL_NAME = "list_matrix_requirements";

const TOOL_DESCRIPTION =
  "List compliance matrix requirements across the calling tenant's matrices, with optional " +
  "filters: opportunity_id, section_type (INSTRUCTION, EVALUATION, CLAUSE, CERTIFICATION), " +
  "mandatory_only, and status. Paginated via offset and limit; the response includes the " +
  "total matching count.";

const REQUIREMENT_TEXT_CAP = 300;

export async function handleListMatrixRequirements(
  input: ListMatrixRequirementsInputT,
  context: ToolHandlerContext
): Promise<HandlerResult> {
  return runTool(TOOL_NAME, input, context, async () => {
    const db = asProposalDb(context.prisma);

    const where: MatrixRequirementWhere = {
      matrix: {
        is: {
          consultingFirmId: context.ctx.consultingFirmId,
          ...(input.opportunity_id ? { opportunityId: input.opportunity_id } : {}),
        },
      },
      ...(input.section_type ? { sectionType: input.section_type } : {}),
      ...(input.mandatory_only ? { isMandatory: true } : {}),
      ...(input.status ? { status: input.status } : {}),
    };

    const total = await db.matrixRequirement.count({ where });
    const rows = await db.matrixRequirement.findMany({
      where,
      orderBy: [{ matrixId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
      skip: input.offset,
      take: input.limit,
      include: { matrix: { select: { opportunityId: true } } },
    });

    const payload: ListMatrixRequirementsPayload = {
      total,
      offset: input.offset,
      limit: input.limit,
      count: rows.length,
      requirements: rows.map((r) => ({
        id: r.id,
        matrix_id: r.matrixId,
        opportunity_id: r.matrix.opportunityId,
        section: sanitize(r.section, 120),
        section_type: sanitize(r.sectionType, 40),
        requirement_text: sanitize(r.requirementText, REQUIREMENT_TEXT_CAP),
        is_mandatory: r.isMandatory,
        status: r.status,
        far_reference: r.farReference === null ? null : sanitize(r.farReference, 60),
        sort_order: r.sortOrder,
      })),
    };
    return payload;
  });
}

export function registerListMatrixRequirements(
  server: McpServer,
  context: ToolHandlerContext
): void {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: listMatrixRequirementsInputShape,
    handler: async (input) => handleListMatrixRequirements(input, context),
  });
}
