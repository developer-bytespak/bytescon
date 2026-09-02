/**
 * `list_set_asides` tool handler.
 *
 * Canonical set-aside enum values plus a live count of the tenant's
 * OPEN (status ACTIVE) opportunities per value. One groupBy query.
 * Stored values that do not map back to a canonical enum value are
 * surfaced under `other` (the column is free-text, so unexpected
 * values can appear from ingestion).
 *
 * Tenant-scoped via consultingFirmId from the resolved bearer token.
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditEntry, hashInput } from "../lib/audit.js";
import type { ResolvedTokenContext } from "../lib/auth.js";
import { sanitize } from "./search-opportunities.js";
import { SET_ASIDE_DB_VALUE, type SetAside } from "../schemas/search-opportunities.js";
import {
  listSetAsidesInputShape,
  type ListSetAsidesInputT,
  type ListSetAsidesPayload,
  type SetAsideCountRow,
} from "../schemas/list-set-asides.js";

const TOOL_NAME = "list_set_asides";

const TOOL_DESCRIPTION =
  "Canonical set-aside categories with a live count of the calling tenant's OPEN opportunities in each. " +
  "Returns every value accepted by the search_opportunities set_aside filter (SDVOSB, VOSB, 8A, WOSB, " +
  "HUBZONE, TOTAL_SMALL_BUSINESS, UNRESTRICTED) plus its stored database value, so you can see which " +
  "filters will actually return results before searching.";

const MAX_RESPONSE_BYTES_HARD = 8 * 1024;

interface HandlerContext {
  ctx: ResolvedTokenContext;
  serverName: string;
  serverVersion: string;
}

interface HandlerResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function handleListSetAsides(
  input: ListSetAsidesInputT,
  opts: HandlerContext,
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
    const tenantId = opts.ctx.consultingFirmId;

    const groupsRaw = await prisma.opportunity.groupBy({
      by: ["setAsideType"],
      where: { consultingFirmId: tenantId, status: "ACTIVE" },
      _count: true,
    });
    const groups = groupsRaw as unknown as Array<{ setAsideType: string; _count: number }>;

    const countsByStored = new Map<string, number>();
    for (const g of groups) {
      countsByStored.set(g.setAsideType, g._count);
    }

    const canonicalStoredValues = new Set<string>(Object.values(SET_ASIDE_DB_VALUE));
    const results: SetAsideCountRow[] = (Object.keys(SET_ASIDE_DB_VALUE) as SetAside[]).map(
      (canonical) => {
        const stored = SET_ASIDE_DB_VALUE[canonical];
        return {
          set_aside: canonical,
          stored_value: stored,
          open_count: countsByStored.get(stored) ?? 0,
        };
      },
    );

    const filtered = input.include_zero_counts
      ? results
      : results.filter((r) => r.open_count > 0);

    const other = groups
      .filter((g) => !canonicalStoredValues.has(g.setAsideType))
      .map((g) => ({ stored_value: sanitize(g.setAsideType), open_count: g._count }))
      .sort((a, b) => b.open_count - a.open_count);

    const payload: ListSetAsidesPayload = {
      count: filtered.length,
      results: filtered,
      other,
      generated_at: new Date().toISOString(),
    };

    const text = JSON.stringify(payload, null, 2);
    const outputBytes = Buffer.byteLength(text, "utf8");
    if (outputBytes > MAX_RESPONSE_BYTES_HARD) {
      throw new Error(`response of ${outputBytes} bytes exceeds hard cap ${MAX_RESPONSE_BYTES_HARD}`);
    }

    const durationMs = Date.now() - startedAt;
    await writeAuditEntry({
      serverName: opts.serverName,
      serverVersion: opts.serverVersion,
      toolName: TOOL_NAME,
      tenantId,
      tokenFp: opts.ctx.tokenFp,
      inputHash,
      outputBytes,
      durationMs,
      outcome: "ok",
      correlationId,
    });

    logger.info("tool ok", {
      correlation_id: correlationId,
      tenant_id: tenantId,
      tool_name: TOOL_NAME,
      latency_ms: durationMs,
      categories_returned: filtered.length,
    });

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    logger.error("tool error", {
      correlation_id: correlationId,
      tenant_id: opts.ctx.consultingFirmId,
      tool_name: TOOL_NAME,
      err: message,
    });
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
    }).catch(() => undefined);
    return { isError: true, content: [{ type: "text", text: `Tool error: ${message}` }] };
  }
}

export function registerListSetAsides(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    listSetAsidesInputShape,
    async (input: ListSetAsidesInputT) => handleListSetAsides(input, opts),
  );
}
