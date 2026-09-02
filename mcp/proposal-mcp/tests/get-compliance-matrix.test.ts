/**
 * Integration tests for the get_compliance_matrix handler against the
 * shared dev database, using this server's own prefixed fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleGetComplianceMatrix } from "../src/tools/get-compliance-matrix.js";
import type { ComplianceMatrixPayload } from "../src/schemas/get-compliance-matrix.js";
import {
  cleanupTenant,
  contextFor,
  parsePayload,
  prismaTest,
  seedTenant,
  shouldSkipIntegrationTests,
  type SeededTenant,
} from "./fixtures.js";

describe.skipIf(shouldSkipIntegrationTests())("get_compliance_matrix handler (integration)", () => {
  let tenant: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant("gcm-A");
  });

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant);
    await prismaTest.$disconnect();
  });

  it("returns the matrix with all five requirements", async () => {
    const result = await handleGetComplianceMatrix(
      { opportunity_id: tenant.opportunityId, offset: 0, limit: 25 },
      contextFor(tenant)
    );
    expect(result.isError).toBeFalsy();
    const payload = parsePayload<ComplianceMatrixPayload>(result);
    expect(payload.matrix_id).toBe(tenant.matrixId);
    expect(payload.opportunity_id).toBe(tenant.opportunityId);
    expect(payload.has_bid_guidance).toBe(true);
    expect(payload.requirement_total).toBe(5);
    expect(payload.requirements).toHaveLength(5);
    expect(payload.requirements[0]!.section).toBe("L.3.1");
    expect(payload.requirements[0]!.requirement_text).toContain("gcm-A-SECRET-REQ");
  });

  it("paginates with offset and limit ordered by sortOrder", async () => {
    const result = await handleGetComplianceMatrix(
      { opportunity_id: tenant.opportunityId, offset: 2, limit: 2 },
      contextFor(tenant)
    );
    const payload = parsePayload<ComplianceMatrixPayload>(result);
    expect(payload.requirement_total).toBe(5);
    expect(payload.requirements).toHaveLength(2);
    expect(payload.requirements.map((r) => r.sort_order)).toEqual([3, 4]);
    expect(payload.requirements[1]!.far_reference).toBe("52.219-14");
  });

  it("returns a matrix with zero requirements and no guidance for the bare opportunity", async () => {
    const result = await handleGetComplianceMatrix(
      { opportunity_id: tenant.bareOpportunityId, offset: 0, limit: 25 },
      contextFor(tenant)
    );
    const payload = parsePayload<ComplianceMatrixPayload>(result);
    expect(payload.matrix_id).toBe(tenant.bareMatrixId);
    expect(payload.has_bid_guidance).toBe(false);
    expect(payload.requirement_total).toBe(0);
    expect(payload.requirements).toHaveLength(0);
  });

  it("returns isError for an unknown opportunity id", async () => {
    const result = await handleGetComplianceMatrix(
      { opportunity_id: "proposal-mcp-test-does-not-exist", offset: 0, limit: 25 },
      contextFor(tenant)
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("no compliance matrix found");
  });
});
