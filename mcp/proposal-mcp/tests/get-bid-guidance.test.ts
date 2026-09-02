/**
 * Integration tests for the get_bid_guidance handler against the shared
 * dev database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleGetBidGuidance } from "../src/tools/get-bid-guidance.js";
import type { BidGuidancePayload } from "../src/schemas/get-bid-guidance.js";
import {
  cleanupTenant,
  contextFor,
  parsePayload,
  prismaTest,
  seedTenant,
  shouldSkipIntegrationTests,
  type SeededTenant,
} from "./fixtures.js";

describe.skipIf(shouldSkipIntegrationTests())("get_bid_guidance handler (integration)", () => {
  let tenant: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant("gbg-A");
  });

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant);
    await prismaTest.$disconnect();
  });

  it("returns the stored guidance JSON for the tenant's matrix", async () => {
    const result = await handleGetBidGuidance(
      { opportunity_id: tenant.opportunityId },
      contextFor(tenant)
    );
    expect(result.isError).toBeFalsy();
    const payload = parsePayload<BidGuidancePayload>(result);
    expect(payload.matrix_id).toBe(tenant.matrixId);
    expect(payload.has_guidance).toBe(true);
    expect(payload.generated_at).toBeTruthy();
    expect(payload.note).toBeNull();
    const guidance = payload.bid_guidance as {
      winStrategy: string;
      redFlags: string[];
      evaluationCriteria: Array<{ factor: string }>;
    };
    expect(guidance.winStrategy).toContain("gbg-A-SECRET-GUIDANCE");
    expect(guidance.redFlags).toContain("compressed turnaround");
    expect(guidance.evaluationCriteria[0]!.factor).toBe("Technical");
  });

  it("returns has_guidance false with a note when the matrix has no guidance", async () => {
    const result = await handleGetBidGuidance(
      { opportunity_id: tenant.bareOpportunityId },
      contextFor(tenant)
    );
    expect(result.isError).toBeFalsy();
    const payload = parsePayload<BidGuidancePayload>(result);
    expect(payload.matrix_id).toBe(tenant.bareMatrixId);
    expect(payload.has_guidance).toBe(false);
    expect(payload.bid_guidance).toBeNull();
    expect(payload.note).toContain("not been generated");
  });

  it("returns isError for an unknown opportunity id", async () => {
    const result = await handleGetBidGuidance(
      { opportunity_id: "proposal-mcp-test-no-such-opp" },
      contextFor(tenant)
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("no compliance matrix found");
  });
});
