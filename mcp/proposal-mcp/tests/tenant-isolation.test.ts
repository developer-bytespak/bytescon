/**
 * MANDATORY tenant isolation tests: two seeded firms, zero
 * cross-contamination through any of the four read tools or the pricing
 * template prefill. Firm A's context must never surface firm B's matrix,
 * requirements, guidance, adherence scores, or opportunity data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleGetComplianceMatrix } from "../src/tools/get-compliance-matrix.js";
import { handleListMatrixRequirements } from "../src/tools/list-matrix-requirements.js";
import { handleGetBidGuidance } from "../src/tools/get-bid-guidance.js";
import { handleGetAdherenceScore } from "../src/tools/get-adherence-score.js";
import { handleGeneratePricingTemplate } from "../src/tools/generate-pricing-template.js";
import type { ListMatrixRequirementsPayload } from "../src/schemas/list-matrix-requirements.js";
import type { BidGuidancePayload } from "../src/schemas/get-bid-guidance.js";
import type { GetAdherenceScorePayload } from "../src/schemas/get-adherence-score.js";
import {
  cleanupTenant,
  contextFor,
  parsePayload,
  prismaTest,
  seedTenant,
  shouldSkipIntegrationTests,
  type SeededTenant,
} from "./fixtures.js";

describe.skipIf(shouldSkipIntegrationTests())("tenant isolation (integration, mandatory)", () => {
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  beforeAll(async () => {
    tenantA = await seedTenant("iso-A");
    tenantB = await seedTenant("iso-B");
  });

  afterAll(async () => {
    if (tenantA) await cleanupTenant(tenantA);
    if (tenantB) await cleanupTenant(tenantB);
    await prismaTest.$disconnect();
  });

  it("get_compliance_matrix: firm A cannot read firm B's matrix", async () => {
    const result = await handleGetComplianceMatrix(
      { opportunity_id: tenantB.opportunityId, offset: 0, limit: 25 },
      contextFor(tenantA)
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain("iso-B-SECRET");
  });

  it("list_matrix_requirements: firm A sees only firm A rows", async () => {
    const result = await handleListMatrixRequirements(
      { mandatory_only: false, offset: 0, limit: 50 },
      contextFor(tenantA)
    );
    const payload = parsePayload<ListMatrixRequirementsPayload>(result);
    expect(payload.total).toBe(5);
    for (const row of payload.requirements) {
      expect(tenantB.requirementIds.includes(row.id)).toBe(false);
      expect(row.requirement_text).not.toContain("iso-B-SECRET-REQ");
      expect(row.requirement_text).toContain("iso-A-SECRET-REQ");
    }
  });

  it("list_matrix_requirements: firm B sees only firm B rows (symmetry)", async () => {
    const result = await handleListMatrixRequirements(
      { mandatory_only: false, offset: 0, limit: 50 },
      contextFor(tenantB)
    );
    const payload = parsePayload<ListMatrixRequirementsPayload>(result);
    expect(payload.total).toBe(5);
    for (const row of payload.requirements) {
      expect(tenantA.requirementIds.includes(row.id)).toBe(false);
      expect(row.requirement_text).toContain("iso-B-SECRET-REQ");
    }
  });

  it("list_matrix_requirements: firm A filtering by firm B's opportunity id returns zero rows", async () => {
    const result = await handleListMatrixRequirements(
      { opportunity_id: tenantB.opportunityId, mandatory_only: false, offset: 0, limit: 50 },
      contextFor(tenantA)
    );
    const payload = parsePayload<ListMatrixRequirementsPayload>(result);
    expect(payload.total).toBe(0);
    expect(payload.requirements).toHaveLength(0);
  });

  it("get_bid_guidance: firm A cannot read firm B's guidance, firm B still can", async () => {
    const crossTenant = await handleGetBidGuidance(
      { opportunity_id: tenantB.opportunityId },
      contextFor(tenantA)
    );
    expect(crossTenant.isError).toBe(true);
    expect(crossTenant.content[0]!.text).not.toContain("iso-B-SECRET-GUIDANCE");

    const sameTenant = await handleGetBidGuidance(
      { opportunity_id: tenantB.opportunityId },
      contextFor(tenantB)
    );
    expect(sameTenant.isError).toBeFalsy();
    const payload = parsePayload<BidGuidancePayload>(sameTenant);
    expect(JSON.stringify(payload.bid_guidance)).toContain("iso-B-SECRET-GUIDANCE");
  });

  it("get_adherence_score: firm A gets zero rows for firm B's opportunity", async () => {
    const result = await handleGetAdherenceScore(
      { opportunity_id: tenantB.opportunityId, limit: 20 },
      contextFor(tenantA)
    );
    expect(result.isError).toBeFalsy();
    const payload = parsePayload<GetAdherenceScorePayload>(result);
    expect(payload.count).toBe(0);
    expect(JSON.stringify(payload)).not.toContain("iso-B-SECRET-BLOCKER");
  });

  it("generate_pricing_template: firm A cannot prefill from firm B's opportunity", async () => {
    const result = await handleGeneratePricingTemplate(
      { contract_type: "FFP", opportunity_id: tenantB.opportunityId },
      contextFor(tenantA)
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain("iso-B-SECRET-OPP");
  });
});
