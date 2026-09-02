/**
 * `get_bid_guidance` tool handler.
 *
 * Returns the structured bid guidance JSON (evaluation criteria, win
 * strategy, red flags) stored on the tenant's compliance matrix for one
 * opportunity. The JSON is deep-sanitized before returning: it
 * originates from an LLM pipeline over solicitation text and is treated
 * as untrusted data, never as instructions.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  McpToolError,
  registerTool,
  type HandlerResult,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";
import { asProposalDb } from "../lib/db.js";
import { sanitizeJsonDeep } from "../lib/sanitize-json.js";
import { runTool } from "../lib/tool-runner.js";
import {
  getBidGuidanceInputShape,
  type BidGuidancePayload,
  type GetBidGuidanceInputT,
} from "../schemas/get-bid-guidance.js";

const TOOL_NAME = "get_bid_guidance";

const TOOL_DESCRIPTION =
  "Retrieve the stored bid guidance (evaluation criteria, win strategy, red flags) from the " +
  "calling tenant's compliance matrix for one opportunity. Returns has_guidance false with a " +
  "note when the matrix exists but guidance has not been generated yet.";

/** Per-string cap inside the guidance JSON. */
const GUIDANCE_FIELD_CAP = 1000;

export async function handleGetBidGuidance(
  input: GetBidGuidanceInputT,
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

    const hasGuidance = matrix.bidGuidanceJson !== null && matrix.bidGuidanceJson !== undefined;
    const payload: BidGuidancePayload = {
      opportunity_id: matrix.opportunityId,
      matrix_id: matrix.id,
      has_guidance: hasGuidance,
      generated_at: matrix.bidGuidanceAt ? matrix.bidGuidanceAt.toISOString() : null,
      bid_guidance: hasGuidance ? sanitizeJsonDeep(matrix.bidGuidanceJson, GUIDANCE_FIELD_CAP) : null,
      note: hasGuidance
        ? null
        : "bid guidance has not been generated for this matrix yet; generate it from the platform UI or backend worker",
    };
    return payload;
  });
}

export function registerGetBidGuidance(server: McpServer, context: ToolHandlerContext): void {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: getBidGuidanceInputShape,
    handler: async (input) => handleGetBidGuidance(input, context),
  });
}
