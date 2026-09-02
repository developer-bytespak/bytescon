/**
 * `get_bid_decision` tool handler.
 *
 * Returns the latest BidDecision for an (opportunity, client) pair in
 * the caller's tenant. Exposes the v2 layer outputs (credible interval,
 * set-aside match) so MCP clients can reason about uncertainty, not
 * just point estimates.
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditEntry, hashInput } from "../lib/audit.js";
import type { ResolvedTokenContext } from "../lib/auth.js";
import { sanitize } from "./search-opportunities.js";
import {
  getBidDecisionInputShape,
  type GetBidDecisionInputT,
  type BidDecisionPayload,
} from "../schemas/get-bid-decision.js";

const TOOL_NAME = "get_bid_decision";

const TOOL_DESCRIPTION =
  "Retrieve the latest bid-decision record for an (opportunity, client) pair: " +
  "recommendation (BID_PRIME / BID_SUB / NO_BID), win probability, 95% credible " +
  "interval, fit & market scores, compliance gate, rationale, and triggered flags.";

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

export async function handleGetBidDecision(
  input: GetBidDecisionInputT,
  opts: HandlerContext,
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);

  try {
    const decision = await prisma.bidDecision.findFirst({
      where: {
        consultingFirmId: opts.ctx.consultingFirmId,
        opportunityId: input.opportunity_id,
        clientCompanyId: input.client_company_id,
      },
      orderBy: { updatedAt: "desc" },
    });

    if (!decision) {
      throw new Error(
        `no bid decision found for opportunity=${input.opportunity_id} client=${input.client_company_id} in this tenant`,
      );
    }

    let credibleInterval: BidDecisionPayload["credible_interval"] = null;
    let setAsideMatch: string | null = null;
    const triggeredFlags: string[] = [];
    if (decision.explanationJson && typeof decision.explanationJson === "object") {
      const exp = decision.explanationJson as Record<string, unknown>;
      const ci = exp["credibleInterval"];
      if (ci && typeof ci === "object") {
        const low = (ci as Record<string, unknown>)["low"];
        const high = (ci as Record<string, unknown>)["high"];
        const width = (ci as Record<string, unknown>)["widthPct"];
        if (typeof low === "number" && typeof high === "number" && typeof width === "number") {
          credibleInterval = { low, high, width_pct: width };
        }
      }
      const match = exp["setAsideMatch"];
      if (typeof match === "string") setAsideMatch = match;
      const flags = exp["triggeredFlags"];
      if (Array.isArray(flags)) {
        for (const f of flags) {
          if (typeof f === "string") triggeredFlags.push(sanitize(f));
        }
      }
    }

    const winProb = decision.winProbability;
    const payload: BidDecisionPayload = {
      opportunity_id: decision.opportunityId,
      client_company_id: decision.clientCompanyId,
      recommendation: decision.recommendation,
      win_probability: winProb,
      win_probability_pct: winProb !== null ? `${(winProb * 100).toFixed(1)}%` : null,
      credible_interval: credibleInterval,
      set_aside_match: setAsideMatch,
      fit_score: decision.fitScore,
      market_score: decision.marketScore,
      compliance_gate: decision.complianceGate,
      rationale: decision.rationale ? sanitize(decision.rationale) : null,
      expected_value: decision.expectedValue ? Number(decision.expectedValue) : null,
      triggered_flags: triggeredFlags,
      created_at: decision.createdAt.toISOString(),
      updated_at: decision.updatedAt.toISOString(),
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

export function registerGetBidDecision(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    getBidDecisionInputShape,
    async (input: GetBidDecisionInputT) => handleGetBidDecision(input, opts),
  );
}
