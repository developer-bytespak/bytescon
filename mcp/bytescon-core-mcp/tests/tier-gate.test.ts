/**
 * Tier gate tests (DESIGN.md workstream 5): bytescon-core-mcp requires tier
 * PRO. A CORE-tier fixture token, minted exactly like opportunity-mcp's
 * fixtures (raw token -> shared hashToken -> api_tokens.tokenHash), must
 * be resolvable by resolveBearerToken yet REJECTED by every tool, with an
 * auth_error audit row written for each rejected call.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveBearerToken } from "@bytescon/mcp-shared";
import { handleListDeliverables } from "../src/tools/list-deliverables.js";
import { handleGetBillingStatus } from "../src/tools/get-billing-status.js";
import { handleGetUsageSummary } from "../src/tools/get-usage-summary.js";
import { handleListUsers } from "../src/tools/list-users.js";
import type { HandlerResult, ToolHandlerContext } from "@bytescon/mcp-shared";
import {
  cleanupTenant,
  db,
  makeContext,
  prisma,
  seedTenant,
  shouldSkipIntegrationTests,
  type SeededTenant,
} from "./fixtures.js";

function expectTierRejection(result: HandlerResult): void {
  expect(result.isError).toBe(true);
  const text = result.content[0]!.text;
  expect(text).toContain("Auth error");
  expect(text).toContain("requires token tier PRO");
  expect(text).toContain("current tier is CORE");
}

describe.skipIf(shouldSkipIntegrationTests())("tier gate, CORE token rejected", () => {
  let coreTenant: SeededTenant;
  let context: ToolHandlerContext;

  beforeAll(async () => {
    coreTenant = await seedTenant({
      label: "tier-core",
      tier: "CORE",
      withBilling: true,
      deliverables: [{ title: "tier gate fixture deliverable" }],
      users: [{ firstName: "Core", lastName: "User" }],
      usage: [{ provider: "claude", inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01 }],
    });
    context = makeContext(coreTenant);
  });

  afterAll(async () => {
    if (coreTenant) await cleanupTenant(coreTenant);
    await prisma.$disconnect();
  });

  it("the CORE fixture token resolves through the real auth path with tier CORE", async () => {
    const resolved = await resolveBearerToken(prisma, coreTenant.rawToken);
    expect(resolved).not.toBeNull();
    expect(resolved!.tier).toBe("CORE");
    expect(resolved!.consultingFirmId).toBe(coreTenant.firmId);
    expect(resolved!.tokenFp).toBe(coreTenant.tokenFp);
  });

  it("list_deliverables rejects a CORE-tier context", async () => {
    const result = await handleListDeliverables({ limit: 25, offset: 0 }, context);
    expectTierRejection(result);
  });

  it("get_billing_status rejects a CORE-tier context", async () => {
    const result = await handleGetBillingStatus({}, context);
    expectTierRejection(result);
  });

  it("get_usage_summary rejects a CORE-tier context", async () => {
    const result = await handleGetUsageSummary({ window_days: 30 }, context);
    expectTierRejection(result);
  });

  it("list_users rejects a CORE-tier context", async () => {
    const result = await handleListUsers(
      { include_emails: false, limit: 25, offset: 0 },
      context
    );
    expectTierRejection(result);
  });

  it("each rejected call writes exactly one auth_error audit row", async () => {
    const before = await db.mcpAuditLog.count({
      where: { tenantId: coreTenant.firmId, outcome: "auth_error" },
    });
    await handleListUsers({ include_emails: false, limit: 25, offset: 0 }, context);
    const after = await db.mcpAuditLog.count({
      where: { tenantId: coreTenant.firmId, outcome: "auth_error" },
    });
    expect(after - before).toBe(1);

    const latest = await db.mcpAuditLog.findFirst({
      where: { tenantId: coreTenant.firmId },
      orderBy: { ts: "desc" },
    });
    expect(latest!.outcome).toBe("auth_error");
    expect(latest!.toolName).toBe("list_users");
    expect(latest!.outputBytes).toBe(0);
    expect(latest!.tokenFp).toBe(coreTenant.tokenFp);
  });

  it("a PRO-tier context for the same tenant data passes the gate", async () => {
    // Same tenant, tier overridden to PRO: the gate, not the data, was the blocker.
    const result = await handleListDeliverables(
      { limit: 25, offset: 0 },
      makeContext(coreTenant, { tier: "PRO" })
    );
    expect(result.isError).toBeFalsy();
  });
});
