/**
 * `forecast_revenue` tool handler.
 *
 * Monte Carlo revenue forecast over the calling tenant's ACTIVE
 * pipeline, with an optional portfolio health summary.
 *
 * Build decision (documented per workstream contract): the forecast
 * math is a local port of backend/src/services/revenueForecaster.ts
 * (forecastRevenue + getPortfolioHealth), NOT an import. Importing the
 * backend TS source is impossible here: this package compiles with
 * rootDir ./src, and the service pulls in backend/src/config/database
 * and backend/src/utils/logger, which would (a) fail tsc and (b) risk
 * stdout writes that corrupt the stdio MCP transport. The constants
 * (time-to-award discount, sub revenue share, option-year factor,
 * lognormal sigma, 5 percent probability floor, recompete boost) are
 * kept identical to the backend so both surfaces forecast alike.
 *
 * Tenant-scoped via consultingFirmId from the resolved bearer token.
 * Simulations are capped server-side at 1000 for latency.
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditEntry, hashInput } from "../lib/audit.js";
import type { ResolvedTokenContext } from "../lib/auth.js";
import { sanitize } from "./search-opportunities.js";
import {
  forecastRevenueInputShape,
  type ForecastRevenueInputT,
  type ForecastRevenuePayload,
  type ForecastMonthRow,
  type PortfolioHealthSummary,
} from "../schemas/forecast-revenue.js";

const TOOL_NAME = "forecast_revenue";

const TOOL_DESCRIPTION =
  "Monte Carlo revenue forecast over the calling tenant's active pipeline. For each month in the " +
  "horizon, simulates wins (Bernoulli on win probability, lognormal value noise) and returns expected, " +
  "p10, p50, and p90 revenue plus the opportunity count. Optionally includes a portfolio health summary " +
  "with diversification (NAICS and agency concentration) and risk indicators. Mirrors the platform's " +
  "backend revenueForecaster model, including option-year lifetime value and time-to-award discounting.";

const MAX_RESPONSE_BYTES_HARD = 16 * 1024;

/** Server-side simulation cap, matches the backend default and keeps p95 latency low. */
const SIMULATIONS = 1000;

// Model constants — keep in sync with backend/src/services/revenueForecaster.ts.
const TIME_TO_AWARD_DISCOUNT = 1 / Math.pow(1.08, 9 / 12); // federal avg 9 months deadline-to-award
const SUB_REVENUE_SHARE = 0.3;
const OPTION_YEAR_FACTOR = 2.5;
const LOGNORMAL_SIGMA = 0.2;
const UNSCORED_PROBABILITY_FLOOR = 0.05;

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

interface DecimalLike {
  toNumber: () => number;
}

interface PipelineOppRow {
  estimatedValue: DecimalLike | null;
  probabilityScore: number;
  responseDeadline: Date;
  recompeteFlag: boolean;
  incumbentProbability: number | null;
  bidDecisions: Array<{ winProbability: number | null; recommendation: string | null }>;
}

/** Box-Muller transform for a standard normal random variable. */
function gaussianRandom(): number {
  const u1 = Math.random() || Number.EPSILON;
  const u2 = Math.random() || Number.EPSILON;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** UTC "YYYY-MM" month key. */
function monthKey(year: number, monthIndex: number): string {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Herfindahl-Hirschman Index. 0 = perfectly diverse, 1 = fully concentrated. */
function computeHHI(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  return counts.reduce((hhi, count) => hhi + Math.pow(count / total, 2), 0);
}

/** Share of total represented by the top-N categories. */
function topNShare(counts: number[], n: number): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const sorted = [...counts].sort((a, b) => b - a);
  const topSum = sorted.slice(0, n).reduce((a, b) => a + b, 0);
  return topSum / total;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Monte Carlo forecast over the tenant's ACTIVE pipeline. Local port of forecastRevenue(). */
async function computeForecast(
  consultingFirmId: string,
  monthsAhead: number,
  simulations: number,
): Promise<ForecastMonthRow[]> {
  const now = new Date();
  const futureLimit = new Date(now);
  futureLimit.setUTCMonth(futureLimit.getUTCMonth() + monthsAhead);

  const opportunities = (await prisma.opportunity.findMany({
    where: {
      consultingFirmId,
      status: "ACTIVE",
      responseDeadline: { gte: now, lte: futureLimit },
    },
    select: {
      estimatedValue: true,
      probabilityScore: true,
      responseDeadline: true,
      recompeteFlag: true,
      incumbentProbability: true,
      bidDecisions: {
        select: { winProbability: true, recommendation: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
    },
  })) as unknown as PipelineOppRow[];

  const monthBuckets = new Map<string, Array<{ prob: number; value: number }>>();

  for (const opp of opportunities) {
    const month = monthKey(
      opp.responseDeadline.getUTCFullYear(),
      opp.responseDeadline.getUTCMonth(),
    );
    const bestDecision = opp.bidDecisions[0];
    let prob = Number(bestDecision?.winProbability ?? opp.probabilityScore ?? 0);
    const baseValue = opp.estimatedValue ? opp.estimatedValue.toNumber() : 0;

    if (baseValue <= 0) continue;
    // Low floor for unscored opps: better to under-show a speculative deal
    // than over-promise (matches backend rationale).
    if (prob <= 0) prob = UNSCORED_PROBABILITY_FLOOR;

    // Recompete boost (same logic as the backend decision engine).
    if (opp.recompeteFlag) {
      // Falsy check is intentional for dashboard parity: the backend
      // forecaster (revenueForecaster.ts) maps an incumbentProbability of
      // exactly 0 to null, which lands in the x1.08 branch, not x1.15.
      const incProb = opp.incumbentProbability ? Number(opp.incumbentProbability) : null;
      if (incProb !== null && incProb < 0.4) prob = Math.min(prob * 1.15, 0.9);
      else prob = Math.min(prob * 1.08, 0.9);
    }

    const isSub = bestDecision?.recommendation === "BID_SUB";
    const effectiveValue = isSub ? baseValue * SUB_REVENUE_SHARE : baseValue;
    const lifetimeValue = effectiveValue * OPTION_YEAR_FACTOR;
    const value = lifetimeValue * TIME_TO_AWARD_DISCOUNT;

    const bucket = monthBuckets.get(month);
    if (bucket) bucket.push({ prob, value });
    else monthBuckets.set(month, [{ prob, value }]);
  }

  const results = new Map<string, { sims: number[]; oppCount: number }>();
  const MU = -(LOGNORMAL_SIGMA * LOGNORMAL_SIGMA) / 2; // unbiased lognormal noise: E[noise] = 1
  for (const [month, opps] of monthBuckets) {
    const sims: number[] = [];
    for (let s = 0; s < simulations; s++) {
      let total = 0;
      for (const { prob, value } of opps) {
        if (Math.random() < prob) {
          const noise = Math.exp(MU + LOGNORMAL_SIGMA * gaussianRandom());
          total += value * noise;
        }
      }
      sims.push(total);
    }
    sims.sort((a, b) => a - b);
    results.set(month, { sims, oppCount: opps.length });
  }

  const forecast: ForecastMonthRow[] = [];
  for (let i = 0; i < monthsAhead; i++) {
    const period = monthKey(now.getUTCFullYear(), now.getUTCMonth() + i);
    const data = results.get(period);
    if (!data || data.sims.length === 0) {
      forecast.push({ period, expected: 0, p10: 0, p50: 0, p90: 0, opportunity_count: 0 });
      continue;
    }
    const { sims, oppCount } = data;
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    const pct = (p: number): number =>
      sims[Math.max(0, Math.min(sims.length - 1, Math.floor(sims.length * p)))]!;
    forecast.push({
      period,
      expected: Math.round(mean),
      p10: Math.round(pct(0.1)),
      p50: Math.round(pct(0.5)),
      p90: Math.round(pct(0.9)),
      opportunity_count: oppCount,
    });
  }
  return forecast;
}

/** Portfolio health summary. Local port of getPortfolioHealth() minus the embedded forecast. */
async function computePortfolioHealth(
  consultingFirmId: string,
  totalExpectedRevenue: number,
): Promise<PortfolioHealthSummary> {
  const [activeOppsRaw, setAsideGroupsRaw, clientGroupsRaw, submissionTotal, lateSubmissions, submissionRowsRaw] =
    await Promise.all([
      prisma.opportunity.findMany({
        where: { consultingFirmId, status: "ACTIVE" },
        select: { naicsCode: true, agency: true },
      }),
      prisma.opportunity.groupBy({
        by: ["setAsideType"],
        where: { consultingFirmId, status: "ACTIVE" },
        _count: true,
      }),
      prisma.bidDecision.groupBy({
        by: ["clientCompanyId"],
        where: { consultingFirmId },
        _sum: { expectedValue: true },
      }),
      prisma.submissionRecord.count({ where: { consultingFirmId } }),
      prisma.submissionRecord.count({ where: { consultingFirmId, wasOnTime: false } }),
      prisma.submissionRecord.findMany({
        where: { consultingFirmId, submittedAt: { not: null } },
        select: { submittedAt: true, opportunity: { select: { responseDeadline: true } } },
      }),
    ]);
  const activeOpps = activeOppsRaw as unknown as Array<{ naicsCode: string; agency: string }>;
  const setAsideGroups = setAsideGroupsRaw as unknown as Array<{ setAsideType: string; _count: number }>;
  const clientGroups = clientGroupsRaw as unknown as Array<{
    clientCompanyId: string;
    _sum: { expectedValue: DecimalLike | null };
  }>;
  const submissionRows = submissionRowsRaw as unknown as Array<{
    submittedAt: Date | null;
    opportunity: { responseDeadline: Date };
  }>;

  // Concentration over 2-digit NAICS sectors and over agencies.
  const naicsCounts = new Map<string, number>();
  const agencyCounts = new Map<string, number>();
  for (const o of activeOpps) {
    const sector = o.naicsCode.slice(0, 2);
    naicsCounts.set(sector, (naicsCounts.get(sector) ?? 0) + 1);
    agencyCounts.set(o.agency, (agencyCounts.get(o.agency) ?? 0) + 1);
  }
  const naicsCountList = [...naicsCounts.values()];
  const agencyCountList = [...agencyCounts.values()];

  const totalSetAside = setAsideGroups.reduce((sum, g) => sum + g._count, 0);
  const setAsideDistribution = setAsideGroups.map((g) => ({
    type: sanitize(g.setAsideType) || "NONE",
    count: g._count,
    percent: totalSetAside > 0 ? Math.round((g._count / totalSetAside) * 100) : 0,
  }));

  const clientValues = clientGroups
    .map((g) => (g._sum.expectedValue ? g._sum.expectedValue.toNumber() : 0))
    .sort((a, b) => b - a);
  const totalPipelineValue = clientValues.reduce((s, v) => s + v, 0);
  const singleClientDependency =
    totalPipelineValue > 0 && clientValues.length > 0
      ? Math.round((clientValues[0]! / totalPipelineValue) * 100)
      : 0;

  const overdueSubmissionRate =
    submissionTotal > 0 ? Math.round((lateSubmissions / submissionTotal) * 100) : 0;

  let avgDays = 0;
  const dayDeltas = submissionRows
    .filter((r) => r.submittedAt != null)
    .map((r) => (r.opportunity.responseDeadline.getTime() - r.submittedAt!.getTime()) / 86_400_000);
  if (dayDeltas.length > 0) {
    avgDays = Math.round(dayDeltas.reduce((a, b) => a + b, 0) / dayDeltas.length);
  }

  return {
    diversification: {
      naics_concentration: round2(computeHHI(naicsCountList)),
      agency_concentration: round2(computeHHI(agencyCountList)),
      naics_top_three_share: round2(topNShare(naicsCountList, 3)),
      agency_top_three_share: round2(topNShare(agencyCountList, 3)),
      set_aside_distribution: setAsideDistribution,
    },
    risk_indicators: {
      single_client_dependency_pct: singleClientDependency,
      overdue_submission_rate_pct: overdueSubmissionRate,
      avg_days_to_deadline_at_submission: avgDays,
      pipeline_coverage:
        totalExpectedRevenue > 0 ? round2(totalPipelineValue / totalExpectedRevenue) : 0,
    },
  };
}

export async function handleForecastRevenue(
  input: ForecastRevenueInputT,
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
    const forecast = await computeForecast(tenantId, input.months_ahead, SIMULATIONS);
    const totalExpectedRevenue = forecast.reduce((sum, m) => sum + m.expected, 0);

    const portfolioHealth = input.include_portfolio_health
      ? await computePortfolioHealth(tenantId, totalExpectedRevenue)
      : null;

    const payload: ForecastRevenuePayload = {
      months_ahead: input.months_ahead,
      simulations: SIMULATIONS,
      generated_at: new Date().toISOString(),
      forecast,
      total_expected_revenue: totalExpectedRevenue,
      portfolio_health: portfolioHealth,
    };

    const text = JSON.stringify(payload, null, 2);
    const outputBytes = Buffer.byteLength(text, "utf8");
    if (outputBytes > MAX_RESPONSE_BYTES_HARD) {
      throw new Error(
        `response of ${outputBytes} bytes exceeds hard cap ${MAX_RESPONSE_BYTES_HARD}; reduce months_ahead`,
      );
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
      months_ahead: input.months_ahead,
      total_expected_revenue: totalExpectedRevenue,
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

export function registerForecastRevenue(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    forecastRevenueInputShape,
    async (input: ForecastRevenueInputT) => handleForecastRevenue(input, opts),
  );
}
