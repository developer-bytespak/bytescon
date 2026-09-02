/**
 * `get_past_performance_detail` tool handler.
 *
 * Returns the full detail of one past-performance record scoped to the
 * caller's tenant, including scope summary, CPARS link, and the client
 * company name when present.
 *
 * Tenant-scoped — consultingFirmId filter is the first WHERE clause.
 * Audit-logged on every invocation, success or failure.
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditEntry, hashInput } from "../lib/audit.js";
import type { ResolvedTokenContext } from "../lib/auth.js";
import { sanitize } from "./search-opportunities.js";
import {
  getPastPerformanceDetailInputShape,
  type GetPastPerformanceDetailInputT,
  type PastPerformanceDetailPayload,
} from "../schemas/get-past-performance-detail.js";

const TOOL_NAME = "get_past_performance_detail";

const TOOL_DESCRIPTION =
  "Retrieve full detail for one past-performance record (by ID from list_past_performance) " +
  "including contract number, customer/agency, contract type, total value, period of " +
  "performance, CPARS rating and link, scope summary, relevance tags, and the client company " +
  "name when present. Tenant-scoped — only returns the record if it belongs to the calling firm.";

const MAX_RESPONSE_BYTES_HARD = 24 * 1024;

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

export async function handleGetPastPerformanceDetail(
  input: GetPastPerformanceDetailInputT,
  opts: HandlerContext,
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);

  try {
    const record = await prisma.pastPerformanceRecord.findFirst({
      where: {
        consultingFirmId: opts.ctx.consultingFirmId,
        id: input.id,
      },
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
        cparsLink: true,
        scopeSummary: true,
        relevanceTags: true,
        isCurrent: true,
        clientCompanyId: true,
        sourceSubmissionRecordId: true,
        createdAt: true,
        updatedAt: true,
        clientCompany: {
          select: { name: true },
        },
      },
    });

    if (!record) {
      throw new Error(`past-performance record not found or not accessible in this tenant: ${input.id}`);
    }

    const payload: PastPerformanceDetailPayload = {
      id: record.id,
      contract_number: sanitize(record.contractNumber),
      customer_name: sanitize(record.customerName),
      customer_agency: record.customerAgency ? sanitize(record.customerAgency) : null,
      contract_type: record.contractType,
      total_value: record.totalValue ? Number(record.totalValue) : null,
      period_of_performance_start: record.periodOfPerformanceStart
        ? record.periodOfPerformanceStart.toISOString()
        : null,
      period_of_performance_end: record.periodOfPerformanceEnd
        ? record.periodOfPerformanceEnd.toISOString()
        : null,
      cpars_rating: record.cparsRating,
      cpars_link: record.cparsLink,
      scope_summary: sanitize(record.scopeSummary),
      relevance_tags: record.relevanceTags.map(sanitize),
      is_current: record.isCurrent,
      client_company_id: record.clientCompanyId,
      client_company_name: record.clientCompany ? sanitize(record.clientCompany.name) : null,
      source_submission_record_id: record.sourceSubmissionRecordId,
      created_at: record.createdAt.toISOString(),
      updated_at: record.updatedAt.toISOString(),
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

export function registerGetPastPerformanceDetail(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    getPastPerformanceDetailInputShape,
    async (input: GetPastPerformanceDetailInputT) => handleGetPastPerformanceDetail(input, opts),
  );
}
