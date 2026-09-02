/**
 * `get_market_trends` tool handler.
 *
 * Empirically computes per-NAICS opportunity volume, average pricing,
 * competition density, and a simple linear slope of monthly counts so
 * the LLM can spot growing / declining sectors without invoking a
 * separate analytics endpoint.
 *
 * Tenant-scoped via consultingFirmId from the resolved bearer token.
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditEntry, hashInput } from "../lib/audit.js";
import type { ResolvedTokenContext } from "../lib/auth.js";
import {
  getMarketTrendsInputShape,
  type GetMarketTrendsInputT,
  type MarketTrendsPayload,
  type NaicsTrendRow,
} from "../schemas/get-market-trends.js";

const TOOL_NAME = "get_market_trends";

const TOOL_DESCRIPTION =
  "Per-NAICS volume, pricing, and trend signal across the calling tenant's ingested opportunities " +
  "over a trailing window (default 180 days). Returns opportunity count, avg/median estimated value, " +
  "avg competition count, and a 'growing'/'declining'/'flat' label backed by the linear slope of " +
  "monthly opportunity counts. Use this to identify sector momentum without enumerating opps.";

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

interface OppRow {
  naicsCode: string;
  estimatedValue: { toNumber: () => number } | null;
  competitionCount: number | null;
  postedDate: Date | null;
}

/** Median of a numeric array (returns null when empty). */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/** Simple OLS slope of count-per-month. Needs ≥3 monthly buckets. */
function monthlySlope(postedDates: Array<Date | null>, windowStart: Date): number | null {
  const buckets = new Map<number, number>();
  for (const d of postedDates) {
    if (!d) continue;
    if (d < windowStart) continue;
    const key = d.getUTCFullYear() * 12 + d.getUTCMonth();
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  if (buckets.size < 3) return null;

  const points = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const xMin = points[0]![0];
  const xs = points.map((p) => p[0] - xMin);
  const ys = points.map((p) => p[1]);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i]!, 0);
  const sumXX = xs.reduce((acc, x) => acc + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  return Number(((n * sumXY - sumX * sumY) / denom).toFixed(3));
}

function labelTrend(slope: number | null, count: number): NaicsTrendRow["trend"] {
  if (slope == null || count < 5) return "insufficient_data";
  if (slope > 0.5) return "growing";
  if (slope < -0.5) return "declining";
  return "flat";
}

export async function handleGetMarketTrends(
  input: GetMarketTrendsInputT,
  opts: HandlerContext,
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);

  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() - input.window_days * 24 * 60 * 60 * 1000);

    // Pull all in-window opps for this tenant once; group in memory.
    // For tenants with >50k opps this would want a SQL aggregate; v0.3
    // ships the simple path since real tenants are <5k opps in window.
    const opps = (await prisma.opportunity.findMany({
      where: {
        consultingFirmId: opts.ctx.consultingFirmId,
        naicsCode: { not: "" },
        postedDate: { gte: windowStart },
      },
      select: {
        naicsCode: true,
        estimatedValue: true,
        competitionCount: true,
        postedDate: true,
      },
    })) as unknown as OppRow[];

    const byNaics = new Map<string, OppRow[]>();
    for (const o of opps) {
      const list = byNaics.get(o.naicsCode);
      if (list) list.push(o);
      else byNaics.set(o.naicsCode, [o]);
    }

    const rows: NaicsTrendRow[] = [];
    for (const [naics, group] of byNaics.entries()) {
      const values: number[] = [];
      const competitions: number[] = [];
      const dates: Array<Date | null> = [];
      for (const r of group) {
        if (r.estimatedValue) values.push(r.estimatedValue.toNumber());
        if (r.competitionCount != null) competitions.push(r.competitionCount);
        dates.push(r.postedDate);
      }
      const avgVal = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      const avgComp = competitions.length
        ? competitions.reduce((a, b) => a + b, 0) / competitions.length
        : null;
      const slope = monthlySlope(dates, windowStart);
      rows.push({
        naics_code: naics,
        opportunity_count: group.length,
        avg_estimated_value: avgVal != null ? Number(avgVal.toFixed(2)) : null,
        median_estimated_value: median(values) != null ? Number(median(values)!.toFixed(2)) : null,
        avg_competition_count: avgComp != null ? Number(avgComp.toFixed(2)) : null,
        trend: labelTrend(slope, group.length),
        monthly_slope: slope,
      });
    }

    rows.sort((a, b) => b.opportunity_count - a.opportunity_count);
    const trimmed = rows.slice(0, input.top_n);

    const payload: MarketTrendsPayload = {
      window_days: input.window_days,
      computed_at: now.toISOString(),
      count: trimmed.length,
      results: trimmed,
    };

    const text = JSON.stringify(payload, null, 2);
    const outputBytes = Buffer.byteLength(text, "utf8");
    if (outputBytes > MAX_RESPONSE_BYTES_HARD) {
      throw new Error(`response of ${outputBytes} bytes exceeds hard cap ${MAX_RESPONSE_BYTES_HARD} — lower top_n`);
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
      naics_returned: trimmed.length,
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

export function registerGetMarketTrends(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    getMarketTrendsInputShape,
    async (input: GetMarketTrendsInputT) => handleGetMarketTrends(input, opts),
  );
}
