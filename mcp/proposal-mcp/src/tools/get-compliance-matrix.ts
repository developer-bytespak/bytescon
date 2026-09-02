/**
 * `get_compliance_matrix` tool handler.
 *
 * Returns the tenant's compliance matrix for one opportunity plus a
 * paginated slice of its requirement rows. Tenant scoped: the
 * consultingFirmId from the resolved token is the first WHERE clause;
 * the opportunity id is never trusted as a tenancy signal.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  McpToolError,
  registerTool,
  sanitize,
  type HandlerResult,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";
import { asProposalDb } from "../lib/db.js";
import { runTool } from "../lib/tool-runner.js";
import {
  getComplianceMatrixInputShape,
  type ComplianceMatrixPayload,
  type GetComplianceMatrixInputT,
} from "../schemas/get-compliance-matrix.js";

const TOOL_NAME = "get_compliance_matrix";

const TOOL_DESCRIPTION =
  "Retrieve the compliance matrix for one opportunity in the calling tenant, including a " +
  "paginated list of its requirements (section, section type, requirement text, mandatory " +
  "flag, status, FAR reference). Use offset and limit to page through large matrices.";

/** Character cap for requirement text in list output, keeps 25 rows under the caps. */
const REQUIREMENT_TEXT_CAP = 300;

export async function handleGetComplianceMatrix(
  input: GetComplianceMatrixInputT,
  context: ToolHandlerContext
): Promise<HandlerResult> {
  return runTool(TOOL_NAME, input, context, async () => {
    const db = asProposalDb(context.prisma);

    const matrix = await db.complianceMatrix.findFirst({
      where: {
        consultingFirmId: context.ctx.consultingFirmId,
        opportunityId: input.opportunity_id,
      },
    });
    if (!matrix) {
      throw new McpToolError(
        "TOOL_ERROR",
        `no compliance matrix found for opportunity ${input.opportunity_id} in this tenant`
      );
    }

    const tenantScopedWhere = {
      matrix: {
        is: {
          consultingFirmId: context.ctx.consultingFirmId,
          opportunityId: input.opportunity_id,
        },
      },
    };
    const total = await db.matrixRequirement.count({ where: tenantScopedWhere });
    const rows = await db.matrixRequirement.findMany({
      where: tenantScopedWhere,
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      skip: input.offset,
      take: input.limit,
      include: { matrix: { select: { opportunityId: true } } },
    });

    const payload: ComplianceMatrixPayload = {
      matrix_id: matrix.id,
      opportunity_id: matrix.opportunityId,
      generated_at: matrix.generatedAt.toISOString(),
      updated_at: matrix.updatedAt.toISOString(),
      has_bid_guidance: matrix.bidGuidanceJson !== null && matrix.bidGuidanceJson !== undefined,
      requirement_total: total,
      offset: input.offset,
      limit: input.limit,
      requirements: rows.map((r) => ({
        id: r.id,
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

export function registerGetComplianceMatrix(server: McpServer, context: ToolHandlerContext): void {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: getComplianceMatrixInputShape,
    handler: async (input) => handleGetComplianceMatrix(input, context),
  });
}
