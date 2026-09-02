/**
 * Mandatory tenant-isolation test per CLAUDE.md §7.2 and §6.3.
 *
 * Two distinct tenants are seeded, each with a unique opportunity that
 * shares the same keyword. The handler is invoked with Tenant A's
 * context and must NOT return Tenant B's row, ever.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { handleSearchOpportunities } from "../src/tools/search-opportunities.js";
import { prisma } from "../src/lib/prisma.js";
import { seedTenant, cleanupTenant, shouldSkipIntegrationTests, type SeededTenant } from "./fixtures.js";

describe.skipIf(shouldSkipIntegrationTests())("tenant-isolation — search_opportunities", () => {
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  beforeAll(async () => {
    tenantA = await seedTenant({
      firmLabel: "tenant-A",
      opportunities: [
        { title: "TENANT-A-SECRET keyword match", agency: "DoD", naicsCode: "541330" },
      ],
    });
    tenantB = await seedTenant({
      firmLabel: "tenant-B",
      opportunities: [
        { title: "TENANT-B-SECRET keyword match", agency: "DoD", naicsCode: "541330" },
      ],
    });
  });

  afterAll(async () => {
    if (tenantA) await cleanupTenant(tenantA);
    if (tenantB) await cleanupTenant(tenantB);
    await prisma.$disconnect();
  });

  it("Tenant A token cannot see Tenant B opportunities", async () => {
    const result = await handleSearchOpportunities(
      { keyword: "keyword match", limit: 50 },
      {
        ctx: {
          tokenId: tenantA.tokenId,
          tokenFp: tenantA.tokenFp,
          consultingFirmId: tenantA.firmId,
          tier: "CORE",
        },
        serverName: "opportunity-mcp",
        serverVersion: "0.1.0",
      }
    );
    const payload = JSON.parse(result.content[0]!.text) as {
      count: number;
      results: Array<{ id: string; title: string }>;
    };
    expect(payload.count).toBe(1);
    expect(payload.results[0]!.title).toContain("TENANT-A-SECRET");
    expect(payload.results.find((r) => r.title.includes("TENANT-B-SECRET"))).toBeUndefined();
    // double-check: no Tenant B opportunity id present
    for (const row of payload.results) {
      expect(tenantB.opportunityIds.includes(row.id)).toBe(false);
    }
  });

  it("Tenant B token cannot see Tenant A opportunities", async () => {
    const result = await handleSearchOpportunities(
      { keyword: "keyword match", limit: 50 },
      {
        ctx: {
          tokenId: tenantB.tokenId,
          tokenFp: tenantB.tokenFp,
          consultingFirmId: tenantB.firmId,
          tier: "CORE",
        },
        serverName: "opportunity-mcp",
        serverVersion: "0.1.0",
      }
    );
    const payload = JSON.parse(result.content[0]!.text) as {
      count: number;
      results: Array<{ id: string; title: string }>;
    };
    expect(payload.count).toBe(1);
    expect(payload.results[0]!.title).toContain("TENANT-B-SECRET");
    for (const row of payload.results) {
      expect(tenantA.opportunityIds.includes(row.id)).toBe(false);
    }
  });
});
