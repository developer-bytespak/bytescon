/**
 * `list_past_performance` tool handler.
 *
 * Lists the calling tenant's structured past-performance records (prior
 * contracts / CPARS history) most-recent first, with the client company
 * name when the record is tied to one.
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
import {
  listPastPerformanceInputShape,
  type ListPastPerformanceInputT,
  type PastPerformanceListPayload,
  type PastPerformanceSummary,
} from "../schemas/list-past-performance.js";

const TOOL_NAME = "list_past_performance";

const TOOL_DESCRIPTION =
  "List the calling tenant's structured past-performance records (prior contracts the firm can " +
  "cite for proposals). Returns contract number, customer/agency, contract type, total value, " +
  "period of performance, CPARS rating, relevance tags, and the client company name when present. " +
  "Most-recent first. Tenant-scoped. Filter by client_company_id and/or is_current. Use " +
  "get_past_performance_detail for the full record including scope summary and CPARS link.";

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

export async function handleListPastPerformance(
  input: ListPastPerformanceInputT,
  opts: HandlerContext,
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);

  try {
    const where: {
      consultingFirmId: string;
      isCurrent?: boolean;
      clientCompanyId?: string;
    } = {
      consultingFirmId: opts.ctx.consultingFirmId,
    };
    // Only constrain on isCurrent when the caller explicitly passes it
    // (true OR false). Undefined = return the full set (incl. historical).
    if (input.is_current !== undefined) {
      where.isCurrent = input.is_current;
    }
    if (input.client_company_id) {
      where.clientCompanyId = input.client_company_id;
    }

    // Take limit+1 to detect truncation, then trim.
    const rows = await prisma.pastPerformanceRecord.findMany({
      where,
      take: input.limit + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        contractNumber: true,
        customerName: true,
        customerAgency: true,
        contractType: true,
        totalValue: true,
        periodOfPerformanceStart: true,
        periodOfPerformanceEnd: true,
        cparsRating: true,
        isCurrent: true,
        clientCompanyId: true,
        relevanceTags: true,
        createdAt: true,
        clientCompany: {
          select: { name: true },
        },
      },
    });

    const truncated = rows.length > input.limit;
    const page = truncated ? rows.slice(0, input.limit) : rows;

    const results: PastPerformanceSummary[] = page.map((r: (typeof page)[number]) => ({
      id: r.id,
      contract_number: sanitize(r.contractNumber),
      customer_name: sanitize(r.customerName),
      customer_agency: r.customerAgency ? sanitize(r.customerAgency) : null,
      contract_type: r.contractType,
      total_value: r.totalValue ? Number(r.totalValue) : null,
      period_of_performance_start: r.periodOfPerformanceStart
        ? r.periodOfPerformanceStart.toISOString()
        : null,
      period_of_performance_end: r.periodOfPerformanceEnd
        ? r.periodOfPerformanceEnd.toISOString()
        : null,
      cpars_rating: r.cparsRating,
      is_current: r.isCurrent,
      client_company_id: r.clientCompanyId,
      client_company_name: r.clientCompany ? sanitize(r.clientCompany.name) : null,
      relevance_tags: r.relevanceTags.map(sanitize),
      created_at: r.createdAt.toISOString(),
    }));

    const payload: PastPerformanceListPayload = {
      count: results.length,
      truncated,
      results,
    };
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

export function registerListPastPerformance(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    listPastPerformanceInputShape,
    async (input: ListPastPerformanceInputT) => handleListPastPerformance(input, opts),
  );
}
