/**
 * `retrieve_dfars_clause` tool.
 *
 * Exact-match lookup of one DFARS clause from the global dfars_clauses
 * catalog, with up to 5 prefix/ILIKE suggestions when absent. Same
 * contract as retrieve_far_clause; the DFARS table carries a narrower
 * column set (no set-aside triggers, prohibited codes, or commercial
 * item exception per backend/prisma/schema.prisma).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerTool,
  sanitize,
  type HandlerResult,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";
import {
  decimalToNumber,
  knowledgeClient,
  type DfarsClauseRow,
  type KnowledgePrismaClient,
} from "../lib/knowledge-prisma.js";
import { runTool } from "../lib/run-tool.js";
import { isSummaryLevel, suggestCodes } from "./retrieve-far-clause.js";
import {
  normalizeDfarsCode,
  retrieveDfarsClauseInputShape,
  type RetrieveDfarsClauseInputT,
} from "../schemas/retrieve-dfars-clause.js";

const TOOL_NAME = "retrieve_dfars_clause";

const TOOL_DESCRIPTION =
  "Retrieve one DFARS clause from the platform catalog by code, for example 252.204-7012. " +
  "Returns the full catalog row (title, prescribing section, contract types, agency " +
  "triggers, flow-down rules, prerequisite clauses, summary, text). If the code is not " +
  "found, returns up to 5 suggested codes by prefix or substring match. Includes a " +
  "data_completeness note when the stored text is summary-level.";

const DATA_COMPLETENESS_NOTE =
  "Summary-level entry, full clause text not yet ingested. The summary field carries " +
  "platform-curated language, not the official clause text. Consult acquisition.gov for " +
  "the authoritative clause wording.";

function toClausePayload(row: DfarsClauseRow): Record<string, unknown> {
  return {
    code: row.code,
    title: sanitize(row.title),
    part_number: row.partNumber,
    prescribed_at: row.prescribedAt,
    applicable_contract_types: row.applicableContractTypes,
    agency_triggers: row.agencyTriggers,
    flow_down_required: row.flowDownRequired,
    flow_down_threshold: decimalToNumber(row.flowDownThreshold),
    prerequisite_clause_codes: row.prerequisiteClauseCodes,
    is_blocking: row.isBlocking,
    effective_date: row.effectiveDate ? row.effectiveDate.toISOString() : null,
    last_revised_date: row.lastRevisedDate ? row.lastRevisedDate.toISOString() : null,
    summary: sanitize(row.summary),
    text: sanitize(row.text),
    tags: row.tags,
  };
}

/**
 * Pure handler for retrieve_dfars_clause; testable without an McpServer.
 *
 * @param input - Validated tool input.
 * @param opts - Shared handler context.
 * @returns HandlerResult with the clause row or suggestions.
 */
export async function handleRetrieveDfarsClause(
  input: RetrieveDfarsClauseInputT,
  opts: ToolHandlerContext
): Promise<HandlerResult> {
  return runTool(TOOL_NAME, input, opts, async () => {
    const db: KnowledgePrismaClient = knowledgeClient(opts.prisma);
    const code = normalizeDfarsCode(input.code);

    const row = await db.dfarsClause.findUnique({ where: { code } });
    if (row) {
      const summaryLevel = isSummaryLevel(row.text);
      return {
        found: true,
        source: "DFARS",
        clause: toClausePayload(row),
        ...(summaryLevel ? { data_completeness: DATA_COMPLETENESS_NOTE } : {}),
      };
    }

    const suggestions = await suggestCodes(db.dfarsClause, code, 5);
    return {
      found: false,
      source: "DFARS",
      query: code,
      message: `no DFARS clause with code ${code} in the catalog`,
      suggestions,
    };
  });
}

/**
 * Register retrieve_dfars_clause on the server (ToolRegistrar shape for
 * bootstrapStdioServer).
 */
export function registerRetrieveDfarsClause(server: McpServer, context: ToolHandlerContext): void {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: retrieveDfarsClauseInputShape,
    handler: (input) => handleRetrieveDfarsClause(input as RetrieveDfarsClauseInputT, context),
  });
}
