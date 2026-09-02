/**
 * `get_pipeline_summary` tool handler.
 *
 * Aggregate KPIs over the calling tenant's opportunities, decisions,
 * and submissions. Tenant-scoped via consultingFirmId from the
 * resolved bearer token. Read-only; no mutation.
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditEntry, hashInput } from "../lib/audit.js";
import type { ResolvedTokenContext } from "../lib/auth.js";
import {
  getPipelineSummaryInputShape,
  type GetPipelineSummaryInputT,
  type PipelineSummaryPayload,
} from "../schemas/get-pipeline-summary.js";

const TOOL_NAME = "get_pipeline_summary";

const TOOL_DESCRIPTION =
  "Aggregate KPIs for the calling tenant's pipeline: stage counts (ingested / scored / decided / submitted / won / lost), " +
  "conversion ratios, won dollar amount, open expected revenue, and active opportunities by urgency. " +
  "Use this for at-a-glance pipeline health without enumerating individual records.";

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

export async function handleGetPipelineSummary(
  input: GetPipelineSummaryInputT,
  opts: HandlerContext,
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);

  try {
    const tenantId = opts.ctx.consultingFirmId;
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Single-query bursts for each count. Cheaper than one giant aggregate
    // and keeps the SQL plans straightforward.
    const [
      ingested,
      scored,
      decidedGo,
      decidedNoGo,
      submitted,
      won,
      lost,
      activeOpen,
      closingSoon,
      overdue,
      wonAggregate,
      openOpps,
    ] = await Promise.all([
      prisma.opportunity.count({ where: { consultingFirmId: tenantId } }),
      prisma.opportunity.count({ where: { consultingFirmId: tenantId, isScored: true } }),
      prisma.bidDecision.count({ where: { consultingFirmId: tenantId, recommendation: "GO" } }),
      prisma.bidDecision.count({ where: { consultingFirmId: tenantId, recommendation: "NO_GO" } }),
      prisma.submissionRecord.count({ where: { consultingFirmId: tenantId } }),
      prisma.submissionRecord.count({ where: { consultingFirmId: tenantId, outcome: "WON" } }),
      prisma.submissionRecord.count({ where: { consultingFirmId: tenantId, outcome: "LOST" } }),
      prisma.opportunity.count({
        where: { consultingFirmId: tenantId, status: "ACTIVE", responseDeadline: { gte: now } },
      }),
      prisma.opportunity.count({
        where: {
          consultingFirmId: tenantId,
          status: "ACTIVE",
          responseDeadline: { gte: now, lte: in7Days },
        },
      }),
      prisma.opportunity.count({
        where: { consultingFirmId: tenantId, status: "ACTIVE", responseDeadline: { lt: now } },
      }),
      // SubmissionRecord has no monetary field; pull each WON submission's
      // opportunity.estimatedValue and sum in memory.
      prisma.submissionRecord.findMany({
        where: { consultingFirmId: tenantId, outcome: "WON" },
        select: { opportunity: { select: { estimatedValue: true } } },
      }),
      prisma.bidDecision.findMany({
        where: {
          consultingFirmId: tenantId,
          recommendation: "GO",
          opportunity: { status: "ACTIVE" },
        },
        select: { winProbability: true, expectedRevenue: true },
      }),
    ]);

    // Open expected revenue: sum of expectedRevenue across active GO decisions
    // when present, otherwise fall back to winProbability × bidDecision's
    // estimatedValue (which we don't have here; treat null as zero).
    const openExpectedRevenue = openOpps.reduce(
      (sum: number, d: { winProbability: number | null; expectedRevenue: { toNumber: () => number } | null }) => {
        const er = d.expectedRevenue ? d.expectedRevenue.toNumber() : 0;
        return sum + er;
      },
      0,
    );

    const wonAmount = wonAggregate.reduce((sum: number, r: { opportunity: { estimatedValue: { toNumber: () => number } | null } }) => {
      const v = r.opportunity?.estimatedValue;
      return sum + (v ? v.toNumber() : 0);
    }, 0);

    function ratio(num: number, denom: number): number {
      if (denom <= 0) return 0;
      return Number((num / denom).toFixed(4));
    }

    const payload: PipelineSummaryPayload = {
      stages: {
        ingested,
        scored,
        decided_go: decidedGo,
        decided_no_go: decidedNoGo,
        submitted,
        won,
        lost,
      },
      conversion_rates: {
        scored_per_ingested: ratio(scored, ingested),
        decided_per_scored: ratio(decidedGo + decidedNoGo, scored),
        submitted_per_decided_go: ratio(submitted, decidedGo),
        won_per_submitted: ratio(won, submitted),
      },
      totals: {
        won_award_amount: wonAmount,
        open_expected_revenue: Number(openExpectedRevenue.toFixed(2)),
      },
      active: {
        open: activeOpen,
        closing_within_7_days: closingSoon,
        overdue,
      },
      generated_at: now.toISOString(),
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
      ingested,
      submitted,
      won,
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

export function registerGetPipelineSummary(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    getPipelineSummaryInputShape,
    async (input: GetPipelineSummaryInputT) => handleGetPipelineSummary(input, opts),
  );
}
