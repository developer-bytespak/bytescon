/**
 * Audit-log assertions: every tool call that reaches the handler writes
 * exactly one mcp_audit_log row, success or failure, carrying the server
 * identity, the 16-char token fingerprint (never the raw token), and the
 * outcome. Calls rejected by SDK input validation never reach the handler
 * and write no row (known suite-wide limitation, see mcp/README.md).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleGetComplianceMatrix } from "../src/tools/get-compliance-matrix.js";
import { handleListMatrixRequirements } from "../src/tools/list-matrix-requirements.js";
import { handleGetBidGuidance } from "../src/tools/get-bid-guidance.js";
import { handleGetAdherenceScore } from "../src/tools/get-adherence-score.js";
import { handleGeneratePricingTemplate } from "../src/tools/generate-pricing-template.js";
import {
  cleanupTenant,
  contextFor,
  prismaTest,
  seedTenant,
  shouldSkipIntegrationTests,
  SERVER_NAME,
  SERVER_VERSION,
  type SeededTenant,
} from "./fixtures.js";

describe.skipIf(shouldSkipIntegrationTests())("mcp_audit_log writes (integration)", () => {
  let tenant: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant("audit-A");
  });

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant);
    await prismaTest.$disconnect();
  });

  async function countRows(): Promise<number> {
    return prismaTest.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
  }

  async function latestRow() {
    return prismaTest.mcpAuditLog.findFirst({
      where: { tenantId: tenant.firmId },
      orderBy: { ts: "desc" },
    });
  }

  it("writes exactly one row per successful call for each of the five tools", async () => {
    const context = contextFor(tenant);
    const calls: Array<[string, () => Promise<unknown>]> = [
      [
        "get_compliance_matrix",
        () =>
          handleGetComplianceMatrix(
            { opportunity_id: tenant.opportunityId, offset: 0, limit: 5 },
            context
          ),
      ],
      [
        "list_matrix_requirements",
        () => handleListMatrixRequirements({ mandatory_only: false, offset: 0, limit: 5 }, context),
      ],
      ["get_bid_guidance", () => handleGetBidGuidance({ opportunity_id: tenant.opportunityId }, context)],
      [
        "get_adherence_score",
        () => handleGetAdherenceScore({ opportunity_id: tenant.opportunityId, limit: 5 }, context),
      ],
      ["generate_pricing_template", () => handleGeneratePricingTemplate({ contract_type: "FFP" }, context)],
    ];

    for (const [toolName, invoke] of calls) {
      const before = await countRows();
      await invoke();
      const after = await countRows();
      expect(after - before).toBe(1);

      const row = await latestRow();
      expect(row).not.toBeNull();
      expect(row!.serverName).toBe(SERVER_NAME);
      expect(row!.serverVersion).toBe(SERVER_VERSION);
      expect(row!.toolName).toBe(toolName);
      expect(row!.outcome).toBe("ok");
      expect(row!.outputBytes).toBeGreaterThan(0);
      expect(row!.durationMs).toBeGreaterThanOrEqual(0);
      expect(row!.correlationId).toBeTruthy();
      expect(row!.inputHash).toHaveLength(64);
    }
  });

  it("stores the 16-char token fingerprint, never the raw token", async () => {
    await handleGetBidGuidance({ opportunity_id: tenant.opportunityId }, contextFor(tenant));
    const row = await latestRow();
    expect(row!.tokenFp).toBe(tenant.tokenFp);
    expect(row!.tokenFp).toHaveLength(16);
    expect(tenant.rawToken).not.toContain(row!.tokenFp);
  });

  it("writes one row with outcome tool_error on the error path", async () => {
    const before = await countRows();
    const result = await handleGetComplianceMatrix(
      { opportunity_id: "proposal-mcp-test-audit-missing", offset: 0, limit: 5 },
      contextFor(tenant)
    );
    expect(result.isError).toBe(true);
    const after = await countRows();
    expect(after - before).toBe(1);

    const row = await latestRow();
    expect(row!.toolName).toBe("get_compliance_matrix");
    expect(row!.outcome).toBe("tool_error");
    expect(row!.outputBytes).toBe(0);
  });
});
