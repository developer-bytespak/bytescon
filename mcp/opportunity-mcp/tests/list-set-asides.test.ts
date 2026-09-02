/**
 * Tests for `list_set_asides` per the v0.2 suite DoD:
 *   (a) happy path, (b) input validation failure, (c) tenant isolation,
 *   (d) audit row assertion.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { handleListSetAsides } from "../src/tools/list-set-asides.js";
import { ListSetAsidesInput, type ListSetAsidesPayload } from "../src/schemas/list-set-asides.js";
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

function countFor(payload: ListSetAsidesPayload, setAside: string): number | undefined {
  return payload.results.find((r) => r.set_aside === setAside)?.open_count;
}

describe("list_set_asides — input validation (unit)", () => {
  it("applies default include_zero_counts=true", () => {
    expect(ListSetAsidesInput.parse({}).include_zero_counts).toBe(true);
  });

  it("accepts explicit booleans", () => {
    expect(ListSetAsidesInput.parse({ include_zero_counts: false }).include_zero_counts).toBe(false);
  });

  it("rejects non-boolean include_zero_counts", () => {
    expect(() => ListSetAsidesInput.parse({ include_zero_counts: "yes" })).toThrow();
    expect(() => ListSetAsidesInput.parse({ include_zero_counts: 1 })).toThrow();
  });
});

describe.skipIf(shouldSkipIntegrationTests())("list_set_asides — handler (integration)", () => {
  let tenantA: SeededTenantV03;
  let tenantB: SeededTenantV03;

  beforeAll(async () => {
    tenantA = await seedTenantV03({
      firmLabel: "setasides-A",
      opportunities: [
        { agency: "DoD", naicsCode: "541330", setAsideType: "SDVOSB" },
        { agency: "DoD", naicsCode: "541330", setAsideType: "SDVOSB" },
        { agency: "GSA", naicsCode: "561720", setAsideType: "WOSB" },
        // Stored as SBA_8A; surfaces under canonical "8A".
        { agency: "GSA", naicsCode: "561320", setAsideType: "SBA_8A" },
        // Excluded: not ACTIVE.
        { agency: "DoD", naicsCode: "541330", setAsideType: "SDVOSB", status: "ARCHIVED" },
        // Non-canonical stored value; surfaces under `other`.
        { agency: "VA", naicsCode: "541512", setAsideType: "HUBZONE_SDVOSB_COMBO" },
      ],
    });
    tenantB = await seedTenantV03({
      firmLabel: "setasides-B",
      opportunities: [
        { agency: "DoD", naicsCode: "541330", setAsideType: "HUBZONE" },
        { agency: "DoD", naicsCode: "541330", setAsideType: "HUBZONE" },
        { agency: "DoD", naicsCode: "541330", setAsideType: "HUBZONE" },
      ],
    });
  });

  afterAll(async () => {
    if (tenantA) await cleanupTenantV03(tenantA);
    if (tenantB) await cleanupTenantV03(tenantB);
    await prisma.$disconnect();
  });

  it("returns canonical values with live open counts (happy path)", async () => {
    const result = await handleListSetAsides(ListSetAsidesInput.parse({}), ctxFor(tenantA));
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as ListSetAsidesPayload;

    // All 7 canonical values present when include_zero_counts (default true).
    expect(payload.count).toBe(7);
    expect(countFor(payload, "SDVOSB")).toBe(2); // archived row excluded
    expect(countFor(payload, "WOSB")).toBe(1);
    expect(countFor(payload, "8A")).toBe(1); // stored SBA_8A maps to canonical 8A
    expect(countFor(payload, "HUBZONE")).toBe(0);
    expect(countFor(payload, "VOSB")).toBe(0);

    // The non-canonical stored value lands in `other`, not in results.
    expect(payload.other.find((o) => o.stored_value === "HUBZONE_SDVOSB_COMBO")?.open_count).toBe(1);
  });

  it("omits zero-count categories when include_zero_counts=false", async () => {
    const result = await handleListSetAsides(
      ListSetAsidesInput.parse({ include_zero_counts: false }),
      ctxFor(tenantA),
    );
    const payload = JSON.parse(result.content[0]!.text) as ListSetAsidesPayload;
    expect(payload.results.every((r) => r.open_count > 0)).toBe(true);
    expect(countFor(payload, "HUBZONE")).toBeUndefined();
    expect(countFor(payload, "SDVOSB")).toBe(2);
  });

  it("tenant isolation: firm A counts never include firm B rows and vice versa", async () => {
    const resultA = await handleListSetAsides(ListSetAsidesInput.parse({}), ctxFor(tenantA));
    const payloadA = JSON.parse(resultA.content[0]!.text) as ListSetAsidesPayload;
    expect(countFor(payloadA, "HUBZONE")).toBe(0); // B's three HUBZONE rows invisible to A

    const resultB = await handleListSetAsides(ListSetAsidesInput.parse({}), ctxFor(tenantB));
    const payloadB = JSON.parse(resultB.content[0]!.text) as ListSetAsidesPayload;
    expect(countFor(payloadB, "HUBZONE")).toBe(3);
    expect(countFor(payloadB, "SDVOSB")).toBe(0); // A's SDVOSB rows invisible to B
    expect(payloadB.other).toHaveLength(0);
  });

  it("writes exactly one audit row per call with the expected fields", async () => {
    const before = await prisma.mcpAuditLog.count({ where: { tenantId: tenantA.firmId } });
    await handleListSetAsides(ListSetAsidesInput.parse({}), ctxFor(tenantA));
    const after = await prisma.mcpAuditLog.count({ where: { tenantId: tenantA.firmId } });
    expect(after - before).toBe(1);

    const latest = await prisma.mcpAuditLog.findFirst({
      where: { tenantId: tenantA.firmId, toolName: "list_set_asides" },
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
