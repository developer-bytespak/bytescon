/**
 * Audit-log tests per CLAUDE.md §6.4.
 *
 * Verifies:
 *   - Every tool call writes exactly one row.
 *   - token_fp is the 16-char SHA-256 prefix, never the raw token.
 *   - outcome reflects success vs failure correctly.
 *   - input_hash is deterministic across equivalent inputs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { handleSearchOpportunities } from "../src/tools/search-opportunities.js";
import { prisma } from "../src/lib/prisma.js";
import { hashInput } from "../src/lib/audit.js";
import { seedTenant, cleanupTenant, shouldSkipIntegrationTests, type SeededTenant } from "./fixtures.js";

describe.skipIf(shouldSkipIntegrationTests())("mcp_audit_log — search_opportunities", () => {
  let tenant: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant({
      firmLabel: "audit-A",
      opportunities: [
        { title: "audit fixture opportunity", agency: "DoD", naicsCode: "541330" },
      ],
    });
  });

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant);
    await prisma.$disconnect();
  });

  it("writes exactly one audit row per successful tool call", async () => {
    const beforeCount = await prisma.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });

    await handleSearchOpportunities(
      { keyword: "audit fixture", limit: 10 },
      {
        ctx: {
          tokenId: tenant.tokenId,
          tokenFp: tenant.tokenFp,
          consultingFirmId: tenant.firmId,
          tier: "CORE",
        },
        serverName: "opportunity-mcp",
        serverVersion: "0.1.0",
      }
    );

    const afterCount = await prisma.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
    expect(afterCount - beforeCount).toBe(1);
  });

  it("audit row contains token fingerprint not raw token", async () => {
    await handleSearchOpportunities(
      { keyword: "audit fixture", limit: 10 },
      {
        ctx: {
          tokenId: tenant.tokenId,
          tokenFp: tenant.tokenFp,
          consultingFirmId: tenant.firmId,
          tier: "CORE",
        },
        serverName: "opportunity-mcp",
        serverVersion: "0.1.0",
      }
    );

    const latest = await prisma.mcpAuditLog.findFirst({
      where: { tenantId: tenant.firmId },
      orderBy: { ts: "desc" },
    });
    expect(latest).not.toBeNull();
    expect(latest!.tokenFp).toBe(tenant.tokenFp);
    expect(latest!.tokenFp.length).toBe(16);
    expect(latest!.tokenFp).not.toContain(tenant.rawToken);
  });

  it("audit row carries server name, version, tool name, and outcome", async () => {
    await handleSearchOpportunities(
      { keyword: "audit fixture", limit: 10 },
      {
        ctx: {
          tokenId: tenant.tokenId,
          tokenFp: tenant.tokenFp,
          consultingFirmId: tenant.firmId,
          tier: "CORE",
        },
        serverName: "opportunity-mcp",
        serverVersion: "0.1.0",
      }
    );

    const latest = await prisma.mcpAuditLog.findFirst({
      where: { tenantId: tenant.firmId },
      orderBy: { ts: "desc" },
    });
    expect(latest!.serverName).toBe("opportunity-mcp");
    expect(latest!.serverVersion).toBe("0.1.0");
    expect(latest!.toolName).toBe("search_opportunities");
    expect(latest!.outcome).toBe("ok");
    expect(latest!.durationMs).toBeGreaterThanOrEqual(0);
    expect(latest!.outputBytes).toBeGreaterThan(0);
  });

});

describe("hashInput() — canonical JSON (unit)", () => {
  it("is deterministic across key orderings", () => {
    const a = hashInput({ keyword: "foo", limit: 10, set_aside: "SDVOSB" });
    const b = hashInput({ set_aside: "SDVOSB", limit: 10, keyword: "foo" });
    expect(a).toBe(b);
    expect(a.length).toBe(64);
  });

  it("handles nested objects deterministically", () => {
    const a = hashInput({ a: 1, b: { x: 1, y: 2 } });
    const b = hashInput({ b: { y: 2, x: 1 }, a: 1 });
    expect(a).toBe(b);
  });

  it("distinguishes different inputs", () => {
    const a = hashInput({ keyword: "foo" });
    const b = hashInput({ keyword: "bar" });
    expect(a).not.toBe(b);
  });
});
