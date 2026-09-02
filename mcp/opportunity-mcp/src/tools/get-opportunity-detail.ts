/**
 * `get_opportunity_detail` tool handler.
 *
 * Returns a deep-detail view of one opportunity scoped to the caller's
 * tenant, plus the latest BidDecision (if any) including the v2 layer
 * outputs (credible interval, set-aside match).
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
  getOpportunityDetailInputShape,
  type GetOpportunityDetailInputT,
  type OpportunityDetailPayload,
} from "../schemas/get-opportunity-detail.js";

const TOOL_NAME = "get_opportunity_detail";

const TOOL_DESCRIPTION =
  "Retrieve full detail for one opportunity (by UUID or sourceId) including agency, " +
  "NAICS, set-aside, deadline, description, USAspending enrichment fields, and the " +
  "latest BidDecision for the calling tenant (win probability with credible interval, " +
  "fit & market scores, recommendation).";

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

export async function handleGetOpportunityDetail(
  input: GetOpportunityDetailInputT,
  opts: HandlerContext,
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);

  try {
    const opp = await prisma.opportunity.findFirst({
      where: {
        consultingFirmId: opts.ctx.consultingFirmId,
        OR: [{ id: input.opportunity_id }, { samNoticeId: input.opportunity_id }],
      },
      select: {
        id: true,
        samNoticeId: true,
        title: true,
        agency: true,
        naicsCode: true,
        setAsideType: true,
        noticeType: true,
        description: true,
        postedDate: true,
        responseDeadline: true,
        estimatedValue: true,
        placeOfPerformance: true,
        sourceUrl: true,
        isEnriched: true,
        historicalWinner: true,
        competitionCount: true,
        incumbentProbability: true,
        recompeteFlag: true,
        agencySdvosbRate: true,
        agencySmallBizRate: true,
        bidDecisions: {
          orderBy: { updatedAt: "desc" },
          take: 1,
          select: {
            clientCompanyId: true,
            recommendation: true,
            winProbability: true,
            fitScore: true,
            marketScore: true,
            explanationJson: true,
            createdAt: true,
          },
        },
      },
    });

    if (!opp) {
      throw new Error(`opportunity not found or not accessible in this tenant: ${input.opportunity_id}`);
    }

    const decision = opp.bidDecisions[0] ?? null;
    let credibleInterval: { low: number; high: number } | null = null;
    let setAsideMatch: string | null = null;
    if (decision?.explanationJson && typeof decision.explanationJson === "object") {
      const exp = decision.explanationJson as Record<string, unknown>;
      const ci = exp["credibleInterval"];
      if (ci && typeof ci === "object") {
        const low = (ci as Record<string, unknown>)["low"];
        const high = (ci as Record<string, unknown>)["high"];
        if (typeof low === "number" && typeof high === "number") {
          credibleInterval = { low, high };
        }
      }
      const match = exp["setAsideMatch"];
      if (typeof match === "string") setAsideMatch = match;
    }

    const payload: OpportunityDetailPayload = {
      id: opp.id,
      sam_notice_id: opp.samNoticeId,
      title: sanitize(opp.title),
      agency: sanitize(opp.agency),
      naics: opp.naicsCode,
      set_aside: opp.setAsideType,
      notice_type: opp.noticeType,
      description: sanitize(opp.description),
      posted_date: opp.postedDate ? opp.postedDate.toISOString() : null,
      response_deadline: opp.responseDeadline.toISOString(),
      estimated_value: opp.estimatedValue ? Number(opp.estimatedValue) : null,
      place_of_performance: opp.placeOfPerformance,
      source_url: opp.sourceUrl,
      is_enriched: opp.isEnriched ?? false,
      historical_winner: opp.historicalWinner,
      competition_count: opp.competitionCount,
      incumbent_probability: opp.incumbentProbability,
      recompete_flag: opp.recompeteFlag,
      agency_sdvosb_rate: opp.agencySdvosbRate,
      agency_small_biz_rate: opp.agencySmallBizRate,
      latest_decision: decision
        ? {
            client_company_id: decision.clientCompanyId,
            recommendation: decision.recommendation,
            win_probability: decision.winProbability,
            fit_score: decision.fitScore,
            market_score: decision.marketScore,
            credible_interval: credibleInterval,
            set_aside_match: setAsideMatch,
            created_at: decision.createdAt.toISOString(),
          }
        : null,
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

export function registerGetOpportunityDetail(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    getOpportunityDetailInputShape,
    async (input: GetOpportunityDetailInputT) => handleGetOpportunityDetail(input, opts),
  );
}
