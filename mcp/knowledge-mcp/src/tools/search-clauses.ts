/**
 * `search_clauses` tool.
 *
 * Keyword search (case-insensitive literal substring, LIKE metacharacters
 * escaped) across code, title, summary, and text on both clause tables,
 * optionally restricted to one source (FAR or DFARS). When both catalogs
 * are searched, up to `limit` rows are fetched from EACH catalog and the
 * merged result interleaves them round-robin (FAR, DFARS, FAR, ...) so
 * neither catalog starves the other on common keywords; ordering within
 * each catalog stays deterministic (code ascending).
 *
 * Downscope note (documented in README): this tool deliberately REPLACES
 * the spec's semantic_search. There is no embedding infrastructure in
 * v0.1, so search is ILIKE-based; semantic retrieval is future work.
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
  knowledgeClient,
  type ClauseWhere,
  type KnowledgePrismaClient,
} from "../lib/knowledge-prisma.js";
import { runTool } from "../lib/run-tool.js";
import { isSummaryLevel } from "./retrieve-far-clause.js";
import { searchClausesInputShape, type SearchClausesInputT } from "../schemas/search-clauses.js";

const TOOL_NAME = "search_clauses";

const TOOL_DESCRIPTION =
  "Keyword search across the FAR and DFARS clause catalogs. Matches the keyword " +
  "case-insensitively and literally (wildcard characters such as % and _ are not " +
  "interpreted) against clause code, title, summary, and text. Optionally restrict " +
  "to source FAR or DFARS. Returns up to 25 results (default 10) with code, title, " +
  "summary excerpt, and tags. When both catalogs are searched, results alternate " +
  "between FAR and DFARS matches, ordered by code within each catalog. " +
  "Note: this is substring search, not semantic search.";

/** Summary excerpt cap keeps list responses inside the 8 KB default cap. */
const SUMMARY_EXCERPT_CHARS = 280;

interface SearchResultRow {
  source: "FAR" | "DFARS";
  code: string;
  title: string;
  summary_excerpt: string;
  tags: string[];
  text_is_summary_level: boolean;
}

function buildWhere(keyword: string): ClauseWhere {
  const pattern = escapeLike(keyword);
  return {
    OR: [
      { code: { contains: pattern, mode: "insensitive" } },
      { title: { contains: pattern, mode: "insensitive" } },
      { summary: { contains: pattern, mode: "insensitive" } },
      { text: { contains: pattern, mode: "insensitive" } },
    ],
  };
}

/**
 * Pure handler for search_clauses; testable without an McpServer.
 *
 * @param input - Validated tool input.
 * @param opts - Shared handler context.
 * @returns HandlerResult with merged FAR/DFARS matches.
 */
export async function handleSearchClauses(
  input: SearchClausesInputT,
  opts: ToolHandlerContext
): Promise<HandlerResult> {
  return runTool(TOOL_NAME, input, opts, async () => {
    const db: KnowledgePrismaClient = knowledgeClient(opts.prisma);
    const keyword = input.keyword.trim();
    const limit = input.limit ?? 10;
    const where = buildWhere(keyword);

    const farMatches: SearchResultRow[] = [];
    if (input.source !== "DFARS") {
      const farRows = await db.farClause.findMany({
        where,
        orderBy: { code: "asc" },
        take: limit,
      });
      for (const r of farRows) {
        farMatches.push({
          source: "FAR",
          code: r.code,
          title: sanitize(r.title),
          summary_excerpt: sanitize(r.summary, SUMMARY_EXCERPT_CHARS),
          tags: r.tags,
          text_is_summary_level: isSummaryLevel(r.text),
        });
      }
    }

    const dfarsMatches: SearchResultRow[] = [];
    if (input.source !== "FAR") {
      const dfarsRows = await db.dfarsClause.findMany({
        where,
        orderBy: { code: "asc" },
        take: limit,
      });
      for (const r of dfarsRows) {
        dfarsMatches.push({
          source: "DFARS",
          code: r.code,
          title: sanitize(r.title),
          summary_excerpt: sanitize(r.summary, SUMMARY_EXCERPT_CHARS),
          tags: r.tags,
          text_is_summary_level: isSummaryLevel(r.text),
        });
      }
    }

    // Round-robin interleave (FAR, DFARS, FAR, ...) up to the limit so
    // both catalogs are represented for common keywords; ordering within
    // each catalog stays deterministic (code ascending).
    const results: SearchResultRow[] = [];
    const longest = Math.max(farMatches.length, dfarsMatches.length);
    for (let i = 0; i < longest && results.length < limit; i++) {
      const far = farMatches[i];
      if (far !== undefined) results.push(far);
      if (results.length >= limit) break;
      const dfars = dfarsMatches[i];
      if (dfars !== undefined) results.push(dfars);
    }

    return {
      keyword,
      source: input.source ?? "ALL",
      count: results.length,
      results,
      note:
        "Substring search over the platform clause catalog. Summary excerpts are " +
        "platform-curated language, not official clause text.",
    };
  });
}

/**
 * Register search_clauses on the server (ToolRegistrar shape for
 * bootstrapStdioServer).
 */
export function registerSearchClauses(server: McpServer, context: ToolHandlerContext): void {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: searchClausesInputShape,
    handler: (input) => handleSearchClauses(input as SearchClausesInputT, context),
  });
}
