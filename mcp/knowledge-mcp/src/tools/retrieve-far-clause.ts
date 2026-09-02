/**
 * `retrieve_far_clause` tool.
 *
 * Exact-match lookup of one FAR clause from the global far_clauses
 * catalog. When the code is absent, returns up to 5 prefix/ILIKE
 * suggestions instead. Emits a data_completeness note when the stored
 * text is summary-level (full clause text not yet ingested).
 *
 * Global read, but still requires a valid resolved token (guardAuth) and
 * writes exactly one mcp_audit_log row per invocation.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerTool,
  sanitize,
  type HandlerResult,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";
import { escapeLike } from "../lib/escape-like.js";
import {
  decimalToNumber,
  knowledgeClient,
  type FarClauseRow,
  type KnowledgePrismaClient,
} from "../lib/knowledge-prisma.js";
import { runTool } from "../lib/run-tool.js";
import {
  normalizeFarCode,
  retrieveFarClauseInputShape,
  type RetrieveFarClauseInputT,
} from "../schemas/retrieve-far-clause.js";

const TOOL_NAME = "retrieve_far_clause";

const TOOL_DESCRIPTION =
  "Retrieve one FAR clause from the platform catalog by code, for example 52.219-14. " +
  "Returns the full catalog row (title, prescribing section, contract types, set-aside " +
  "triggers, flow-down rules, prerequisite and prohibited clauses, summary, text). " +
  "If the code is not found, returns up to 5 suggested codes by prefix or substring match. " +
  "Includes a data_completeness note when the stored text is summary-level.";

/** Marker written by scripts/seed-clause-catalog.sql for non-ingested text. */
export const SUMMARY_LEVEL_MARKER = "[Summary-level entry";

const DATA_COMPLETENESS_NOTE =
  "Summary-level entry, full clause text not yet ingested. The summary field carries " +
  "platform-curated language, not the official clause text. Consult acquisition.gov for " +
  "the authoritative clause wording.";

/** Whether a stored clause text is empty or the seed's summary-level marker. */
export function isSummaryLevel(text: string): boolean {
  return text.trim() === "" || text.startsWith(SUMMARY_LEVEL_MARKER);
}

/**
 * Find up to `max` suggestion rows for a code that had no exact match:
 * prefix match first, then case-insensitive substring. The code is
 * matched literally; LIKE metacharacters are escaped.
 */
export async function suggestCodes(
  delegate: {
    findMany(args: {
      where: { code: { startsWith?: string; contains?: string; mode?: "insensitive" | "default" } };
      orderBy?: { code: "asc" | "desc" };
      take?: number;
    }): Promise<Array<{ code: string; title: string }>>;
  },
  code: string,
  max: number
): Promise<Array<{ code: string; title: string }>> {
  const pattern = escapeLike(code);
  const byPrefix = await delegate.findMany({
    where: { code: { startsWith: pattern } },
    orderBy: { code: "asc" },
    take: max,
  });
  if (byPrefix.length > 0) {
    return byPrefix.map((r) => ({ code: r.code, title: sanitize(r.title) }));
  }
  const bySubstring = await delegate.findMany({
    where: { code: { contains: pattern, mode: "insensitive" } },
    orderBy: { code: "asc" },
    take: max,
  });
  return bySubstring.map((r) => ({ code: r.code, title: sanitize(r.title) }));
}

function toClausePayload(row: FarClauseRow): Record<string, unknown> {
  return {
    code: row.code,
    title: sanitize(row.title),
    part_number: row.partNumber,
    subpart_number: row.subpartNumber,
    prescribed_at: row.prescribedAt,
    applicable_contract_types: row.applicableContractTypes,
    set_aside_triggers: row.setAsideTriggers,
    agency_triggers: row.agencyTriggers,
    flow_down_required: row.flowDownRequired,
    flow_down_threshold: decimalToNumber(row.flowDownThreshold),
    prerequisite_clause_codes: row.prerequisiteClauseCodes,
    prohibited_clause_codes: row.prohibitedClauseCodes,
    commercial_item_exception: row.commercialItemException,
    is_blocking: row.isBlocking,
    effective_date: row.effectiveDate ? row.effectiveDate.toISOString() : null,
    last_revised_date: row.lastRevisedDate ? row.lastRevisedDate.toISOString() : null,
    summary: sanitize(row.summary),
    text: sanitize(row.text),
    tags: row.tags,
  };
}

/**
 * Pure handler for retrieve_far_clause; testable without an McpServer.
 *
 * @param input - Validated tool input.
 * @param opts - Shared handler context.
 * @returns HandlerResult with the clause row or suggestions.
 */
export async function handleRetrieveFarClause(
  input: RetrieveFarClauseInputT,
  opts: ToolHandlerContext
): Promise<HandlerResult> {
  return runTool(TOOL_NAME, input, opts, async () => {
    const db: KnowledgePrismaClient = knowledgeClient(opts.prisma);
    const code = normalizeFarCode(input.code);

    const row = await db.farClause.findUnique({ where: { code } });
    if (row) {
      const summaryLevel = isSummaryLevel(row.text);
      return {
        found: true,
        source: "FAR",
        clause: toClausePayload(row),
        ...(summaryLevel ? { data_completeness: DATA_COMPLETENESS_NOTE } : {}),
      };
    }

    const suggestions = await suggestCodes(db.farClause, code, 5);
    return {
      found: false,
      source: "FAR",
      query: code,
      message: `no FAR clause with code ${code} in the catalog`,
      suggestions,
    };
  });
}

/**
 * Register retrieve_far_clause on the server (ToolRegistrar shape for
 * bootstrapStdioServer).
 */
export function registerRetrieveFarClause(server: McpServer, context: ToolHandlerContext): void {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: retrieveFarClauseInputShape,
    handler: (input) => handleRetrieveFarClause(input as RetrieveFarClauseInputT, context),
  });
}
