/**
 * Integration tests for the get_adherence_score handler against the
 * shared dev database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleGetAdherenceScore } from "../src/tools/get-adherence-score.js";
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

describe.skipIf(shouldSkipIntegrationTests())("get_adherence_score handler (integration)", () => {
  let tenant: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant("gas-A");
  });

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant);
    await prismaTest.$disconnect();
  });

  it("returns both fixture scores newest first", async () => {
    const result = await handleGetAdherenceScore(
      { opportunity_id: tenant.opportunityId, limit: 5 },
      contextFor(tenant)
    );
    expect(result.isError).toBeFalsy();
    const payload = parsePayload<GetAdherenceScorePayload>(result);
    expect(payload.count).toBe(2);
    expect(payload.note).toBeNull();
    expect(payload.scores[0]!.overall_score).toBe(82.5);
    expect(payload.scores[0]!.scope).toBe("proposal");
    expect(payload.scores[1]!.overall_score).toBe(74);
    const blockers = payload.scores[0]!.blockers as {
      blockers: Array<{ severity: string; note: string }>;
    };
    expect(blockers.blockers[0]!.severity).toBe("HIGH");
    expect(blockers.blockers[0]!.note).toContain("gas-A-SECRET-BLOCKER");
  });

  it("respects limit", async () => {
    const result = await handleGetAdherenceScore(
      { opportunity_id: tenant.opportunityId, limit: 1 },
      contextFor(tenant)
    );
    const payload = parsePayload<GetAdherenceScorePayload>(result);
    expect(payload.count).toBe(1);
    expect(payload.scores[0]!.overall_score).toBe(82.5);
  });

  it("returns an empty list with a note for an unscored opportunity, not an error", async () => {
    const result = await handleGetAdherenceScore(
      { opportunity_id: tenant.bareOpportunityId, limit: 5 },
      contextFor(tenant)
    );
    expect(result.isError).toBeFalsy();
    const payload = parsePayload<GetAdherenceScorePayload>(result);
    expect(payload.count).toBe(0);
    expect(payload.scores).toHaveLength(0);
    expect(payload.note).toContain("no adherence scores");
  });
});
