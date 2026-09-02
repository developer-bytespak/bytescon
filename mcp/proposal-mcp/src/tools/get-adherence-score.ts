/**
 * `get_adherence_score` tool handler.
 *
 * Returns AdherenceScore rows (whole-proposal and per-section) for one
 * opportunity in the calling tenant, newest first. An opportunity with
 * no computed scores returns an empty list with a note, not an error,
 * so hosts can distinguish "not scored yet" from "not accessible".
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerTool,
  type HandlerResult,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";
import { asProposalDb } from "../lib/db.js";
import { sanitizeJsonDeep } from "../lib/sanitize-json.js";
import { runTool } from "../lib/tool-runner.js";
import {
  getAdherenceScoreInputShape,
  type GetAdherenceScoreInputT,
  type GetAdherenceScorePayload,
} from "../schemas/get-adherence-score.js";

const TOOL_NAME = "get_adherence_score";

const TOOL_DESCRIPTION =
  "Retrieve adherence scores for one opportunity in the calling tenant, newest first: overall " +
  "score (0-100), requirement coverage, evaluation alignment, evidence sufficiency, FAR clause " +
  "coverage, readability, consistency, ambiguity, and any structured blockers. Rows with scope " +
  "section apply to one proposal section; scope proposal covers the whole proposal.";

/** Per-string cap inside blockersJson. */
const BLOCKERS_FIELD_CAP = 500;

export async function handleGetAdherenceScore(
  input: GetAdherenceScoreInputT,
  context: ToolHandlerContext
): Promise<HandlerResult> {
  return runTool(TOOL_NAME, input, context, async () => {
    const db = asProposalDb(context.prisma);

    const rows = await db.adherenceScore.findMany({
      where: {
        consultingFirmId: context.ctx.consultingFirmId,
        opportunityId: input.opportunity_id,
      },
      orderBy: { computedAt: "desc" },
      take: input.limit,
    });

    const payload: GetAdherenceScorePayload = {
      opportunity_id: input.opportunity_id,
      count: rows.length,
      scores: rows.map((r) => ({
        id: r.id,
        scope: r.proposalSectionId ? "section" : "proposal",
        proposal_section_id: r.proposalSectionId,
        overall_score: r.overallScore,
        requirement_coverage: r.requirementCoverage,
        evaluation_alignment: r.evaluationAlignment,
        evidence_sufficiency: r.evidenceSufficiency,
        far_clause_coverage: r.farClauseCoverage,
        readability: r.readability,
        consistency: r.consistency,
        ambiguity: r.ambiguity,
        blockers:
          r.blockersJson === null || r.blockersJson === undefined
            ? null
            : sanitizeJsonDeep(r.blockersJson, BLOCKERS_FIELD_CAP),
        computed_at: r.computedAt.toISOString(),
      })),
      note:
        rows.length === 0
          ? "no adherence scores computed for this opportunity in this tenant yet"
          : null,
    };
    return payload;
  });
}

export function registerGetAdherenceScore(server: McpServer, context: ToolHandlerContext): void {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: getAdherenceScoreInputShape,
    handler: async (input) => handleGetAdherenceScore(input, context),
  });
}
