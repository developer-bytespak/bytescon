/**
 * `search_opportunities` tool handler.
 *
 * Tenant-scoped (CLAUDE.md §6.3 row "Cross-tenant leakage"). The
 * consultingFirmId filter is the first clause in every WHERE.
 *
 * Free-text fields are sanitized before being returned to the host LLM
 * to mitigate prompt injection from upstream content (CLAUDE.md §6.3
 * row "Prompt injection via tool outputs").
 *
 * Every invocation writes exactly one audit row, success or failure.
 * On the failure path the audit write itself is best-effort: the
 * original tool error must surface, audit failures during error
 * handling are logged but do not overwrite the tool error.
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditEntry, hashInput } from "../lib/audit.js";
import type { ResolvedTokenContext } from "../lib/auth.js";
import {
  searchOpportunitiesInputShape,
  SET_ASIDE_DB_VALUE,
  type SearchOpportunitiesInputT,
  type SearchOpportunitiesPayload,
  type SearchOpportunityResult,
} from "../schemas/search-opportunities.js";

const TOOL_NAME = "search_opportunities";

const TOOL_DESCRIPTION =
  "Search public federal opportunity intelligence scoped to your tenant. " +
  "Returns up to 50 opportunities matching keyword, NAICS, set-aside, and posted-after filters. " +
  "Results include score (win probability) and response deadline. " +
  "Use the returned `next_cursor` value as the `cursor` input for the next page.";

const MAX_RESPONSE_BYTES_DEFAULT = 8 * 1024;
const MAX_RESPONSE_BYTES_HARD = 32 * 1024;

/** Keyset cursor: (response_deadline ascending, id ascending tiebreaker). */
interface PageCursor {
  d: string;  // deadline ISO
  i: string;  // id (UUID)
}

function encodeCursor(c: PageCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): PageCursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<PageCursor>;
    if (
      parsed &&
      typeof parsed.d === "string" &&
      typeof parsed.i === "string" &&
      !Number.isNaN(Date.parse(parsed.d))
    ) {
      return { d: parsed.d, i: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

export interface HandlerContext {
  ctx: ResolvedTokenContext;
  serverName: string;
  serverVersion: string;
}

export interface HandlerResult {
  // SDK CallToolResult type carries an open index signature; mirror it
  // so this handler's return type satisfies McpServer.tool()'s callback.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface RegisterOptions extends HandlerContext {}

/**
 * Pure handler, directly testable. The McpServer registration wraps this.
 */
export async function handleSearchOpportunities(
  input: SearchOpportunitiesInputT,
  opts: HandlerContext
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);

  logger.info("tool invoked", {
    correlation_id: correlationId,
    tenant_id: opts.ctx.consultingFirmId,
    tool_name: TOOL_NAME,
    token_fp: opts.ctx.tokenFp,
  });

  try {
    const where: Record<string, unknown> = {
      consultingFirmId: opts.ctx.consultingFirmId,
      status: "ACTIVE",
      OR: [
        { title: { contains: input.keyword, mode: "insensitive" } },
        { description: { contains: input.keyword, mode: "insensitive" } },
        { agency: { contains: input.keyword, mode: "insensitive" } },
      ],
    };
    if (input.naics) where["naicsCode"] = input.naics;
    if (input.set_aside) where["setAsideType"] = SET_ASIDE_DB_VALUE[input.set_aside];
    if (input.posted_after) where["postedDate"] = { gte: new Date(input.posted_after) };

    // Keyset cursor: (responseDeadline asc, id asc). Strict-greater on
    // the (deadline, id) tuple, expressed as the two-clause SQL pattern
    // Prisma understands without raw SQL.
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const cursorDate = new Date(cursor.d);
      where["AND"] = [
        {
          OR: [
            { responseDeadline: { gt: cursorDate } },
            { responseDeadline: cursorDate, id: { gt: cursor.i } },
          ],
        },
      ];
    }

    // Take limit+1 to determine if a next page exists, then trim.
    const rows = await prisma.opportunity.findMany({
      where,
      take: input.limit + 1,
      orderBy: [{ responseDeadline: "asc" }, { id: "asc" }],
      select: {
        id: true,
        title: true,
        agency: true,
        naicsCode: true,
        setAsideType: true,
        postedDate: true,
        responseDeadline: true,
        probabilityScore: true,
        sourceUrl: true,
      },
    });

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;

    const results: SearchOpportunityResult[] = page.map((r: (typeof page)[number]) => ({
      id: r.id,
      title: sanitize(r.title),
      agency: sanitize(r.agency),
      naics: r.naicsCode,
      set_aside: r.setAsideType,
      posted_date: r.postedDate ? r.postedDate.toISOString() : null,
      response_deadline: r.responseDeadline.toISOString(),
      score: r.probabilityScore,
      url: r.sourceUrl,
    }));

    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({ d: lastRow.responseDeadline.toISOString(), i: lastRow.id })
        : null;

    const payload: SearchOpportunitiesPayload = {
      count: results.length,
      results,
      next_cursor: nextCursor,
    };
    const text = JSON.stringify(payload, null, 2);
    const outputBytes = Buffer.byteLength(text, "utf8");

    if (outputBytes > MAX_RESPONSE_BYTES_DEFAULT) {
      logger.warn("response exceeds default cap", {
        correlation_id: correlationId,
        output_bytes: outputBytes,
        cap: MAX_RESPONSE_BYTES_DEFAULT,
      });
    }
    if (outputBytes > MAX_RESPONSE_BYTES_HARD) {
      throw new Error(
        `response of ${outputBytes} bytes exceeds hard cap ${MAX_RESPONSE_BYTES_HARD}; reduce limit or add pagination`
      );
    }

    const durationMs = Date.now() - startedAt;
    await writeAuditEntry({
      serverName: opts.serverName,
      serverVersion: opts.serverVersion,
      toolName: TOOL_NAME,
      tenantId: opts.ctx.consultingFirmId,
      tokenFp: opts.ctx.tokenFp,
      inputHash,
      outputBytes,
      durationMs,
      outcome: "ok",
      correlationId,
    });

    logger.info("tool ok", {
      correlation_id: correlationId,
      tenant_id: opts.ctx.consultingFirmId,
      tool_name: TOOL_NAME,
      latency_ms: durationMs,
      outcome: "ok",
      result_count: results.length,
    });

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);

    logger.error("tool error", {
      correlation_id: correlationId,
      tenant_id: opts.ctx.consultingFirmId,
      tool_name: TOOL_NAME,
      latency_ms: durationMs,
      outcome: "tool_error",
      err: message,
    });

    // Best-effort audit on error path; never overwrite the tool error
    // with an audit-write error.
    await writeAuditEntry({
      serverName: opts.serverName,
      serverVersion: opts.serverVersion,
      toolName: TOOL_NAME,
      tenantId: opts.ctx.consultingFirmId,
      tokenFp: opts.ctx.tokenFp,
      inputHash,
      outputBytes: 0,
      durationMs,
      outcome: "tool_error",
      correlationId,
    }).catch((auditErr: unknown) => {
      logger.error("audit write also failed on error path", {
        correlation_id: correlationId,
        original_err: message,
        audit_err: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    });

    return {
      isError: true,
      content: [{ type: "text", text: `Tool error: ${message}` }],
    };
  }
}

/**
 * Strip control characters and cap length per CLAUDE.md §6.3
 * (prompt-injection mitigation). Tool outputs are untrusted text from
 * the database, treated as data not instructions to the host LLM.
 */
// Built at runtime to avoid embedding literal control bytes in source (git
// classifies files with NUL bytes as binary and refuses to diff them).
const CONTROL_CHARS_RE = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + "]",
  "g"
);

export function sanitize(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(CONTROL_CHARS_RE, " ").slice(0, 2000);
}

export function registerSearchOpportunities(server: McpServer, opts: RegisterOptions): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    searchOpportunitiesInputShape,
    async (input: SearchOpportunitiesInputT) => handleSearchOpportunities(input, opts)
  );
}
