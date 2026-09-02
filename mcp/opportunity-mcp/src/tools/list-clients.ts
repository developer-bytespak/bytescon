/**
 * `list_clients` tool handler.
 *
 * Lists the calling tenant's client companies with performance summary.
 * Tenant-scoped via consultingFirmId from the resolved bearer token.
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditEntry, hashInput } from "../lib/audit.js";
import type { ResolvedTokenContext } from "../lib/auth.js";
import { sanitize } from "./search-opportunities.js";
import {
  listClientsInputShape,
  type ListClientsInputT,
  type ClientListPayload,
  type ClientSummary,
} from "../schemas/list-clients.js";

const TOOL_NAME = "list_clients";

const TOOL_DESCRIPTION =
  "List the calling tenant's client companies (federal contractors represented by the firm). " +
  "Returns name, UEI/CAGE, NAICS codes, certifications, and performance stats (submissions, " +
  "win/loss counts, completion rate). Tenant-scoped. Use this to discover which clients exist " +
  "before calling tools that operate on a specific client.";

const MAX_RESPONSE_BYTES_HARD = 16 * 1024;

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

export async function handleListClients(
  input: ListClientsInputT,
  opts: HandlerContext,
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);

  try {
    const where: { consultingFirmId: string; isActive?: boolean } = {
      consultingFirmId: opts.ctx.consultingFirmId,
    };
    if (!input.include_inactive) {
      where.isActive = true;
    }

    const rows = await prisma.clientCompany.findMany({
      where,
      take: input.limit,
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        uei: true,
        cage: true,
        naicsCodes: true,
        sdvosb: true,
        wosb: true,
        hubzone: true,
        smallBusiness: true,
        isActive: true,
        performanceStats: {
          select: {
            totalOpportunities: true,
            totalSubmitted: true,
            totalWon: true,
            totalLost: true,
            completionRate: true,
          },
        },
      },
    });

    const results: ClientSummary[] = rows.map((c: (typeof rows)[number]) => ({
      id: c.id,
      name: sanitize(c.name),
      uei: c.uei,
      cage: c.cage,
      naics_codes: c.naicsCodes,
      certifications: {
        sdvosb: c.sdvosb,
        wosb: c.wosb,
        hubzone: c.hubzone,
        small_business: c.smallBusiness,
      },
      is_active: c.isActive,
      performance: c.performanceStats
        ? {
            total_opportunities: c.performanceStats.totalOpportunities,
            total_submitted: c.performanceStats.totalSubmitted,
            total_won: c.performanceStats.totalWon,
            total_lost: c.performanceStats.totalLost,
            completion_rate: c.performanceStats.completionRate,
          }
        : null,
    }));

    const payload: ClientListPayload = { count: results.length, results };
    const text = JSON.stringify(payload, null, 2);
    const outputBytes = Buffer.byteLength(text, "utf8");
    if (outputBytes > MAX_RESPONSE_BYTES_HARD) {
      throw new Error(`response of ${outputBytes} bytes exceeds hard cap ${MAX_RESPONSE_BYTES_HARD} — reduce limit`);
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

export function registerListClients(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    listClientsInputShape,
    async (input: ListClientsInputT) => handleListClients(input, opts),
  );
}
