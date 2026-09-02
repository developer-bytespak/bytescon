/**
 * Tests for `forecast_revenue` per the v0.2 suite DoD:
 *   (a) happy path, (b) input validation failure, (c) tenant isolation,
 *   (d) audit row assertion.
 *
 * The forecast is Monte Carlo (non-deterministic), so integration
 * assertions check structure, ordering invariants (p10 <= p50 <= p90),
 * counts, and magnitude bounds rather than exact dollar values.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { handleForecastRevenue } from "../src/tools/forecast-revenue.js";
import { ForecastRevenueInput } from "../src/schemas/forecast-revenue.js";
import type { ForecastRevenuePayload } from "../src/schemas/forecast-revenue.js";
import { prisma } from "../src/lib/prisma.js";
import {
  seedTenantV03,
  cleanupTenantV03,
  shouldSkipIntegrationTests,
  type SeededTenantV03,
} from "./fixtures-v03.js";

const SERVER_NAME = "opportunity-mcp";
const SERVER_VERSION = "0.3.0";

function ctxFor(tenant: SeededTenantV03) {
  return {
    ctx: {
      tokenId: tenant.tokenId,
      tokenFp: tenant.tokenFp,
      consultingFirmId: tenant.firmId,
      tier: "VAULT" as const,
    },
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
  };
}

describe("forecast_revenue — input validation (unit)", () => {
  it("applies defaults: months_ahead 6, include_portfolio_health false", () => {
    const parsed = ForecastRevenueInput.parse({});
    expect(parsed.months_ahead).toBe(6);
    expect(parsed.include_portfolio_health).toBe(false);
  });

  it("accepts the full valid range", () => {
    expect(ForecastRevenueInput.parse({ months_ahead: 1 }).months_ahead).toBe(1);
    expect(ForecastRevenueInput.parse({ months_ahead: 24 }).months_ahead).toBe(24);
    expect(
      ForecastRevenueInput.parse({ include_portfolio_health: true }).include_portfolio_health,
    ).toBe(true);
  });

  it("rejects months_ahead below 1 or above 24", () => {
    expect(() => ForecastRevenueInput.parse({ months_ahead: 0 })).toThrow();
    expect(() => ForecastRevenueInput.parse({ months_ahead: 25 })).toThrow();
  });

  it("rejects non-integer months_ahead", () => {
    expect(() => ForecastRevenueInput.parse({ months_ahead: 6.5 })).toThrow();
    expect(() => ForecastRevenueInput.parse({ months_ahead: "6" })).toThrow();
  });

  it("rejects non-boolean include_portfolio_health", () => {
    expect(() => ForecastRevenueInput.parse({ include_portfolio_health: "yes" })).toThrow();
  });
});

describe.skipIf(shouldSkipIntegrationTests())("forecast_revenue — handler (integration)", () => {
  let tenantA: SeededTenantV03;
  let tenantB: SeededTenantV03;
  let tenantC: SeededTenantV03;

  beforeAll(async () => {
    tenantA = await seedTenantV03({
      firmLabel: "forecast-A",
      opportunities: [
        {
          agency: "DoD",
          naicsCode: "541330",
          estimatedValue: 100_000,
          probabilityScore: 0.5,
          daysUntilDeadline: 20,
        },
        {
          agency: "GSA",
          naicsCode: "561720",
          estimatedValue: 50_000,
          probabilityScore: 0.4,
          daysUntilDeadline: 45,
        },
        // Excluded from forecast: archived.
        {
          agency: "VA",
          naicsCode: "541512",
          estimatedValue: 999_999,
          probabilityScore: 0.9,
          daysUntilDeadline: 25,
          status: "ARCHIVED",
        },
        // Excluded from forecast: no estimated value.
        { agency: "VA", naicsCode: "541512", probabilityScore: 0.9, daysUntilDeadline: 25 },
      ],
    });
    tenantB = await seedTenantV03({
      firmLabel: "forecast-B",
      opportunities: [
        {
          agency: "DoD",
          naicsCode: "541330",
          estimatedValue: 9_999_999,
          probabilityScore: 0.9,
          daysUntilDeadline: 20,
        },
      ],
    });
    // Single recompete opp with incumbentProbability EXACTLY 0; used by the
    // backend-parity regression test below.
    tenantC = await seedTenantV03({
      firmLabel: "forecast-recompete-zero",
      opportunities: [
        {
          agency: "DoD",
          naicsCode: "541330",
          estimatedValue: 1_000_000,
          probabilityScore: 0.78,
          daysUntilDeadline: 20,
          recompeteFlag: true,
          incumbentProbability: 0,
        },
      ],
    });
  });

  afterAll(async () => {
    if (tenantA) await cleanupTenantV03(tenantA);
    if (tenantB) await cleanupTenantV03(tenantB);
    if (tenantC) await cleanupTenantV03(tenantC);
    await prisma.$disconnect();
  });

  it("returns one row per month with consistent percentile ordering (happy path)", async () => {
    const result = await handleForecastRevenue(ForecastRevenueInput.parse({ months_ahead: 3 }), ctxFor(tenantA));
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as ForecastRevenuePayload;

    expect(payload.months_ahead).toBe(3);
    expect(payload.simulations).toBe(1000);
    expect(payload.forecast).toHaveLength(3);
    for (const month of payload.forecast) {
      expect(month.period).toMatch(/^\d{4}-\d{2}$/);
      expect(month.p10).toBeLessThanOrEqual(month.p50);
      expect(month.p50).toBeLessThanOrEqual(month.p90);
      expect(month.expected).toBeGreaterThanOrEqual(0);
    }
    // Two value-bearing ACTIVE opps in window; archived and value-less excluded.
    const totalOpps = payload.forecast.reduce((s, m) => s + m.opportunity_count, 0);
    expect(totalOpps).toBe(2);
    expect(payload.total_expected_revenue).toBeGreaterThan(0);
    expect(payload.portfolio_health).toBeNull();
  });

  it("includes the portfolio health summary when requested", async () => {
    const result = await handleForecastRevenue(
      ForecastRevenueInput.parse({ months_ahead: 3, include_portfolio_health: true }),
      ctxFor(tenantA),
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as ForecastRevenuePayload;
    expect(payload.portfolio_health).not.toBeNull();
    const health = payload.portfolio_health!;
    expect(health.diversification.naics_concentration).toBeGreaterThanOrEqual(0);
    expect(health.diversification.naics_concentration).toBeLessThanOrEqual(1);
    expect(health.diversification.agency_concentration).toBeGreaterThanOrEqual(0);
    expect(health.diversification.agency_concentration).toBeLessThanOrEqual(1);
    expect(health.diversification.set_aside_distribution.length).toBeGreaterThan(0);
    expect(health.risk_indicators.single_client_dependency_pct).toBeGreaterThanOrEqual(0);
    expect(health.risk_indicators.overdue_submission_rate_pct).toBeGreaterThanOrEqual(0);
  });

  it("tenant isolation: firm A forecast never reflects firm B's pipeline", async () => {
    const resultA = await handleForecastRevenue(ForecastRevenueInput.parse({ months_ahead: 3 }), ctxFor(tenantA));
    const payloadA = JSON.parse(resultA.content[0]!.text) as ForecastRevenuePayload;
    const countA = payloadA.forecast.reduce((s, m) => s + m.opportunity_count, 0);
    expect(countA).toBe(2);
    // Firm B's 10M opportunity at 0.9 probability would contribute roughly
    // 21M expected if leaked; firm A's own pipeline tops out far below 2M.
    expect(payloadA.total_expected_revenue).toBeLessThan(2_000_000);

    const resultB = await handleForecastRevenue(ForecastRevenueInput.parse({ months_ahead: 3 }), ctxFor(tenantB));
    const payloadB = JSON.parse(resultB.content[0]!.text) as ForecastRevenuePayload;
    const countB = payloadB.forecast.reduce((s, m) => s + m.opportunity_count, 0);
    expect(countB).toBe(1);
    expect(payloadB.total_expected_revenue).toBeGreaterThan(2_000_000);
  });

  it("treats incumbentProbability of exactly 0 as unset, matching the backend x1.08 branch", async () => {
    // Backend parity regression: revenueForecaster.ts uses a falsy check
    // (`opp.incumbentProbability ? ... : null`), so an incumbent probability
    // of exactly 0 maps to null and takes the x1.08 recompete boost, NOT the
    // x1.15 low-incumbent boost. The tool must replicate that semantics.
    const TIME_TO_AWARD_DISCOUNT = 1 / Math.pow(1.08, 9 / 12);
    const OPTION_YEAR_FACTOR = 2.5;
    const boostedProb = Math.min(0.78 * 1.08, 0.9); // 0.8424; x1.15 would give 0.897
    const parityExpected = boostedProb * 1_000_000 * OPTION_YEAR_FACTOR * TIME_TO_AWARD_DISCOUNT;

    const RUNS = 10;
    let sum = 0;
    for (let i = 0; i < RUNS; i++) {
      const result = await handleForecastRevenue(
        ForecastRevenueInput.parse({ months_ahead: 2 }),
        ctxFor(tenantC),
      );
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text) as ForecastRevenuePayload;
      expect(payload.forecast.reduce((s, m) => s + m.opportunity_count, 0)).toBe(1);
      sum += payload.total_expected_revenue;
    }
    const avg = sum / RUNS;
    // The x1.15 branch would land about 6.5 percent above parity. A 4 percent
    // band either side of the x1.08 value separates the two branches far
    // beyond Monte Carlo noise at 10 x 1000 simulations, and also catches a
    // missing boost (about 7.4 percent below parity).
    expect(avg).toBeGreaterThan(parityExpected * 0.96);
    expect(avg).toBeLessThan(parityExpected * 1.04);
  });

  it("writes exactly one audit row per call with the expected fields", async () => {
    const before = await prisma.mcpAuditLog.count({ where: { tenantId: tenantA.firmId } });
    await handleForecastRevenue(ForecastRevenueInput.parse({}), ctxFor(tenantA));
    const after = await prisma.mcpAuditLog.count({ where: { tenantId: tenantA.firmId } });
    expect(after - before).toBe(1);

    const latest = await prisma.mcpAuditLog.findFirst({
      where: { tenantId: tenantA.firmId, toolName: "forecast_revenue" },
      orderBy: { ts: "desc" },
    });
    expect(latest).not.toBeNull();
    expect(latest!.serverName).toBe(SERVER_NAME);
    expect(latest!.serverVersion).toBe(SERVER_VERSION);
    expect(latest!.outcome).toBe("ok");
    expect(latest!.tokenFp).toBe(tenantA.tokenFp);
    expect(latest!.tokenFp.length).toBe(16);
    expect(latest!.outputBytes).toBeGreaterThan(0);
    expect(latest!.durationMs).toBeGreaterThanOrEqual(0);
  });
});
