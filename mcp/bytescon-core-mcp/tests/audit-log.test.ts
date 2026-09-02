/**
 * Audit-log tests per CLAUDE.md section 6.4 for bytescon-core-mcp.
 *
 * Verifies:
 *   - Every tool call writes exactly one row (all four tools).
 *   - token_fp is the 16-char SHA-256 prefix, never the raw token.
 *   - Row carries server name, version, tool name, outcome, input hash.
 *   - The error path writes a tool_error row with outputBytes 0 and the
 *     handler still returns a structured isError response.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hashInput, type PrismaLikeClient } from "@bytescon/mcp-shared";
import { handleListDeliverables } from "../src/tools/list-deliverables.js";
import { handleGetBillingStatus } from "../src/tools/get-billing-status.js";
import { handleGetUsageSummary } from "../src/tools/get-usage-summary.js";
import { handleListUsers } from "../src/tools/list-users.js";
import {
  cleanupTenant,
  db,
  makeContext,
  prisma,
  seedTenant,
  shouldSkipIntegrationTests,
  SERVER_NAME,
  SERVER_VERSION,
  type SeededTenant,
} from "./fixtures.js";

describe.skipIf(shouldSkipIntegrationTests())("mcp_audit_log, bytescon-core-mcp", () => {
  let tenant: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant({
      label: "audit-A",
      tier: "PRO",
      withBilling: true,
      deliverables: [{ title: "audit fixture deliverable" }],
      users: [{ firstName: "Audit", lastName: "User" }],
      usage: [{ provider: "claude", inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01 }],
    });
  });

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant);
    await prisma.$disconnect();
  });

  it("writes exactly one row per successful call, for each of the four tools", async () => {
    const context = makeContext(tenant);
    const calls: Array<{ tool: string; run: () => Promise<unknown> }> = [
      { tool: "list_deliverables", run: () => handleListDeliverables({ limit: 5, offset: 0 }, context) },
      { tool: "get_billing_status", run: () => handleGetBillingStatus({}, context) },
      { tool: "get_usage_summary", run: () => handleGetUsageSummary({ window_days: 30 }, context) },
      { tool: "list_users", run: () => handleListUsers({ include_emails: false, limit: 5, offset: 0 }, context) },
    ];

    for (const call of calls) {
      const before = await db.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
      await call.run();
      const after = await db.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
      expect(after - before).toBe(1);

      const latest = await db.mcpAuditLog.findFirst({
        where: { tenantId: tenant.firmId },
        orderBy: { ts: "desc" },
      });
      expect(latest!.toolName).toBe(call.tool);
      expect(latest!.outcome).toBe("ok");
    }
  });

  it("audit row contains the token fingerprint, never the raw token", async () => {
    await handleGetBillingStatus({}, makeContext(tenant));
    const latest = await db.mcpAuditLog.findFirst({
      where: { tenantId: tenant.firmId },
      orderBy: { ts: "desc" },
    });
    expect(latest).not.toBeNull();
    expect(latest!.tokenFp).toBe(tenant.tokenFp);
    expect(latest!.tokenFp.length).toBe(16);
    expect(tenant.rawToken).not.toContain(latest!.tokenFp);
  });

  it("audit row carries server identity, canonical input hash, and timing", async () => {
    const input = { window_days: 90 };
    await handleGetUsageSummary(input, makeContext(tenant));
    const latest = await db.mcpAuditLog.findFirst({
      where: { tenantId: tenant.firmId },
      orderBy: { ts: "desc" },
    });
    expect(latest!.serverName).toBe(SERVER_NAME);
    expect(latest!.serverVersion).toBe(SERVER_VERSION);
    expect(latest!.toolName).toBe("get_usage_summary");
    expect(latest!.outcome).toBe("ok");
    expect(latest!.inputHash).toBe(hashInput(input));
    expect(latest!.inputHash.length).toBe(64);
    expect(latest!.durationMs).toBeGreaterThanOrEqual(0);
    expect(latest!.outputBytes).toBeGreaterThan(0);
    expect(latest!.correlationId).toBeTruthy();
  });

  it("the error path writes a tool_error row and returns isError", async () => {
    // Inject a client whose query methods fail but whose audit append
    // still reaches the real database.
    const real = prisma as unknown as {
      mcpAuditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
    };
    const failing = {
      documentRequirement: {
        findMany: async (): Promise<never> => {
          throw new Error("simulated db failure");
        },
        count: async (): Promise<never> => {
          throw new Error("simulated db failure");
        },
      },
      mcpAuditLog: real.mcpAuditLog,
    };
    const context = makeContext(tenant, { prisma: failing as unknown as PrismaLikeClient });

    const before = await db.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
    const result = await handleListDeliverables({ limit: 5, offset: 0 }, context);
    const after = await db.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Tool error");
    expect(result.content[0]!.text).toContain("simulated db failure");
    expect(after - before).toBe(1);

    const latest = await db.mcpAuditLog.findFirst({
      where: { tenantId: tenant.firmId },
      orderBy: { ts: "desc" },
    });
    expect(latest!.outcome).toBe("tool_error");
    expect(latest!.toolName).toBe("list_deliverables");
    expect(latest!.outputBytes).toBe(0);
  });
});
