/**
 * Tests for `list_agencies_by_naics` per the v0.2 suite DoD:
 *   (a) happy path, (b) input validation failure, (c) tenant isolation,
 *   (d) audit row assertion.
 *
 * AgencyAwardProfile is GLOBAL with a unique agencyName, so fixture
 * profiles carry the per-run test prefix and are removed in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { handleListAgenciesByNaics } from "../src/tools/list-agencies-by-naics.js";
import {
  ListAgenciesByNaicsInput,
  type ListAgenciesByNaicsPayload,
} from "../src/schemas/list-agencies-by-naics.js";
import { prisma } from "../src/lib/prisma.js";
import {
  seedTenantV03,
  cleanupTenantV03,
  seedAgencyProfile,
  cleanupAgencyProfiles,
  shouldSkipIntegrationTests,
  TEST_PREFIX_V03,
  type SeededTenantV03,
  type SeededAgencyProfile,
} from "./fixtures-v03.js";

const SERVER_NAME = "opportunity-mcp";
const SERVER_VERSION = "0.3.0";

const AGENCY_X = `${TEST_PREFIX_V03}Agency-X`;
const AGENCY_Y = `${TEST_PREFIX_V03}Agency-Y`;
const AGENCY_B_ONLY = `${TEST_PREFIX_V03}Agency-B-Only`;

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

describe("list_agencies_by_naics — input validation (unit)", () => {
  it("accepts a 6-digit naics and applies top_n default 10", () => {
    const parsed = ListAgenciesByNaicsInput.parse({ naics: "541330" });
    expect(parsed.naics).toBe("541330");
    expect(parsed.top_n).toBe(10);
  });

  it("rejects a missing naics", () => {
    expect(() => ListAgenciesByNaicsInput.parse({})).toThrow();
  });

  it("rejects naics that is not exactly 6 digits", () => {
    expect(() => ListAgenciesByNaicsInput.parse({ naics: "54133" })).toThrow();
    expect(() => ListAgenciesByNaicsInput.parse({ naics: "5413300" })).toThrow();
    expect(() => ListAgenciesByNaicsInput.parse({ naics: "54133X" })).toThrow();
  });

  it("rejects top_n out of range", () => {
    expect(() => ListAgenciesByNaicsInput.parse({ naics: "541330", top_n: 0 })).toThrow();
    expect(() => ListAgenciesByNaicsInput.parse({ naics: "541330", top_n: 51 })).toThrow();
    expect(() => ListAgenciesByNaicsInput.parse({ naics: "541330", top_n: 2.5 })).toThrow();
  });
});

describe.skipIf(shouldSkipIntegrationTests())("list_agencies_by_naics — handler (integration)", () => {
  let tenantA: SeededTenantV03;
  let tenantB: SeededTenantV03;
  let profiles: SeededAgencyProfile[] = [];

  beforeAll(async () => {
    tenantA = await seedTenantV03({
      firmLabel: "agencies-A",
      opportunities: [
        { agency: AGENCY_X, naicsCode: "541330", setAsideType: "SDVOSB", estimatedValue: 100_000 },
        { agency: AGENCY_X, naicsCode: "541330", setAsideType: "NONE", estimatedValue: 200_000 },
        { agency: AGENCY_X, naicsCode: "541330", setAsideType: "NONE", estimatedValue: 300_000, status: "EXPIRED" },
        { agency: AGENCY_Y, naicsCode: "541330" }, // no estimated value
        // Different NAICS: must not appear in results.
        { agency: `${TEST_PREFIX_V03}Agency-Z`, naicsCode: "561720", estimatedValue: 50_000 },
      ],
    });
    tenantB = await seedTenantV03({
      firmLabel: "agencies-B",
      opportunities: [{ agency: AGENCY_B_ONLY, naicsCode: "541330", estimatedValue: 75_000 }],
    });
    profiles = [
      await seedAgencyProfile({
        agencyName: AGENCY_X,
        avgAwardValue: 250_000,
        smallBizRate: 0.42,
        sdvosbRate: 0.18,
      }),
    ];
  });

  afterAll(async () => {
    if (tenantA) await cleanupTenantV03(tenantA);
    if (tenantB) await cleanupTenantV03(tenantB);
    await cleanupAgencyProfiles(profiles);
    await prisma.$disconnect();
  });

  it("aggregates by agency with counts, averages, set-aside mix, and profile join (happy path)", async () => {
    const result = await handleListAgenciesByNaics(
      ListAgenciesByNaicsInput.parse({ naics: "541330" }),
      ctxFor(tenantA),
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as ListAgenciesByNaicsPayload;

    expect(payload.naics).toBe("541330");
    expect(payload.count).toBe(2);

    const first = payload.results[0]!;
    expect(first.agency).toBe(AGENCY_X);
    expect(first.opportunity_count).toBe(3); // any status counts toward ranking
    expect(first.open_count).toBe(2); // EXPIRED row excluded from open
    expect(first.avg_estimated_value).toBe(200_000); // (100k + 200k + 300k) / 3
    const mixTotal = first.set_aside_mix.reduce((s, m) => s + m.count, 0);
    expect(mixTotal).toBe(3);
    expect(first.set_aside_mix.find((m) => m.set_aside === "SDVOSB")?.count).toBe(1);
    expect(first.award_profile).not.toBeNull();
    expect(first.award_profile!.small_biz_rate).toBeCloseTo(0.42);
    expect(first.award_profile!.sdvosb_rate).toBeCloseTo(0.18);
    expect(first.award_profile!.avg_award_value).toBeCloseTo(250_000);

    const second = payload.results[1]!;
    expect(second.agency).toBe(AGENCY_Y);
    expect(second.opportunity_count).toBe(1);
    expect(second.avg_estimated_value).toBeNull(); // no value on its only opp
    expect(second.award_profile).toBeNull(); // no global profile seeded

    // The 561720 opportunity's agency must not appear.
    expect(payload.results.find((r) => r.agency.includes("Agency-Z"))).toBeUndefined();
  });

  it("respects top_n", async () => {
    const result = await handleListAgenciesByNaics(
      ListAgenciesByNaicsInput.parse({ naics: "541330", top_n: 1 }),
      ctxFor(tenantA),
    );
    const payload = JSON.parse(result.content[0]!.text) as ListAgenciesByNaicsPayload;
    expect(payload.count).toBe(1);
    expect(payload.results[0]!.agency).toBe(AGENCY_X);
  });

  it("tenant isolation: firm A never sees firm B's agencies and vice versa", async () => {
    const resultA = await handleListAgenciesByNaics(
      ListAgenciesByNaicsInput.parse({ naics: "541330", top_n: 50 }),
      ctxFor(tenantA),
    );
    const payloadA = JSON.parse(resultA.content[0]!.text) as ListAgenciesByNaicsPayload;
    expect(payloadA.results.find((r) => r.agency === AGENCY_B_ONLY)).toBeUndefined();

    const resultB = await handleListAgenciesByNaics(
      ListAgenciesByNaicsInput.parse({ naics: "541330", top_n: 50 }),
      ctxFor(tenantB),
    );
    const payloadB = JSON.parse(resultB.content[0]!.text) as ListAgenciesByNaicsPayload;
    expect(payloadB.count).toBe(1);
    expect(payloadB.results[0]!.agency).toBe(AGENCY_B_ONLY);
    expect(payloadB.results.find((r) => r.agency === AGENCY_X)).toBeUndefined();
  });

  it("writes exactly one audit row per call with the expected fields", async () => {
    const before = await prisma.mcpAuditLog.count({ where: { tenantId: tenantA.firmId } });
    await handleListAgenciesByNaics(ListAgenciesByNaicsInput.parse({ naics: "541330" }), ctxFor(tenantA));
    const after = await prisma.mcpAuditLog.count({ where: { tenantId: tenantA.firmId } });
    expect(after - before).toBe(1);

    const latest = await prisma.mcpAuditLog.findFirst({
      where: { tenantId: tenantA.firmId, toolName: "list_agencies_by_naics" },
      orderBy: { ts: "desc" },
    });
    expect(latest).not.toBeNull();
    expect(latest!.serverName).toBe(SERVER_NAME);
    expect(latest!.serverVersion).toBe(SERVER_VERSION);
    expect(latest!.outcome).toBe("ok");
    expect(latest!.tokenFp).toBe(tenantA.tokenFp);
    expect(latest!.tokenFp.length).toBe(16);
    expect(latest!.outputBytes).toBeGreaterThan(0);
  });
});
