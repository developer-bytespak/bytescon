/**
 * Integration tests for the list_matrix_requirements handler filters and
 * pagination against the shared dev database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleListMatrixRequirements } from "../src/tools/list-matrix-requirements.js";
import type { ListMatrixRequirementsPayload } from "../src/schemas/list-matrix-requirements.js";
import {
  cleanupTenant,
  contextFor,
  parsePayload,
  prismaTest,
  seedTenant,
  shouldSkipIntegrationTests,
  type SeededTenant,
} from "./fixtures.js";

const BASE = { mandatory_only: false, offset: 0, limit: 25 } as const;

describe.skipIf(shouldSkipIntegrationTests())(
  "list_matrix_requirements handler (integration)",
  () => {
    let tenant: SeededTenant;

    beforeAll(async () => {
      tenant = await seedTenant("lmr-A");
    });

    afterAll(async () => {
      if (tenant) await cleanupTenant(tenant);
      await prismaTest.$disconnect();
    });

    it("returns all five fixture requirements without filters", async () => {
      const result = await handleListMatrixRequirements({ ...BASE }, contextFor(tenant));
      expect(result.isError).toBeFalsy();
      const payload = parsePayload<ListMatrixRequirementsPayload>(result);
      expect(payload.total).toBe(5);
      expect(payload.count).toBe(5);
      expect(payload.requirements.every((r) => r.matrix_id === tenant.matrixId)).toBe(true);
      expect(payload.requirements.every((r) => r.opportunity_id === tenant.opportunityId)).toBe(
        true
      );
    });

    it("filters by section_type", async () => {
      const result = await handleListMatrixRequirements(
        { ...BASE, section_type: "INSTRUCTION" },
        contextFor(tenant)
      );
      const payload = parsePayload<ListMatrixRequirementsPayload>(result);
      expect(payload.total).toBe(2);
      expect(payload.requirements.every((r) => r.section_type === "INSTRUCTION")).toBe(true);
    });

    it("filters with mandatory_only", async () => {
      const result = await handleListMatrixRequirements(
        { ...BASE, mandatory_only: true },
        contextFor(tenant)
      );
      const payload = parsePayload<ListMatrixRequirementsPayload>(result);
      expect(payload.total).toBe(4);
      expect(payload.requirements.every((r) => r.is_mandatory)).toBe(true);
    });

    it("filters by status", async () => {
      const result = await handleListMatrixRequirements(
        { ...BASE, status: "PENDING_REVIEW" },
        contextFor(tenant)
      );
      const payload = parsePayload<ListMatrixRequirementsPayload>(result);
      expect(payload.total).toBe(1);
      expect(payload.requirements[0]!.section).toBe("K.1");
    });

    it("filters by opportunity_id and returns zero for the bare matrix", async () => {
      const withOpp = await handleListMatrixRequirements(
        { ...BASE, opportunity_id: tenant.opportunityId },
        contextFor(tenant)
      );
      expect(parsePayload<ListMatrixRequirementsPayload>(withOpp).total).toBe(5);

      const bare = await handleListMatrixRequirements(
        { ...BASE, opportunity_id: tenant.bareOpportunityId },
        contextFor(tenant)
      );
      expect(parsePayload<ListMatrixRequirementsPayload>(bare).total).toBe(0);
    });

    it("paginates and reports the unfiltered total", async () => {
      const result = await handleListMatrixRequirements(
        { ...BASE, offset: 3, limit: 2 },
        contextFor(tenant)
      );
      const payload = parsePayload<ListMatrixRequirementsPayload>(result);
      expect(payload.total).toBe(5);
      expect(payload.count).toBe(2);
      expect(payload.requirements.map((r) => r.sort_order)).toEqual([4, 5]);
    });
  }
);
