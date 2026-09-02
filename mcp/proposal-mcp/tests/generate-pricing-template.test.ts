/**
 * Tests for the generate_pricing_template handler. The generator is pure
 * (no domain DB writes); the optional opportunity prefill and the
 * mandatory audit row are the only database touches, so most assertions
 * run against the shared dev database with this server's fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleGeneratePricingTemplate } from "../src/tools/generate-pricing-template.js";
import type { PricingTemplatePayload } from "../src/schemas/generate-pricing-template.js";
import {
  cleanupTenant,
  contextFor,
  parsePayload,
  prismaTest,
  seedTenant,
  shouldSkipIntegrationTests,
  type SeededTenant,
} from "./fixtures.js";

describe.skipIf(shouldSkipIntegrationTests())(
  "generate_pricing_template handler (integration)",
  () => {
    let tenant: SeededTenant;

    beforeAll(async () => {
      tenant = await seedTenant("gpt-A");
    });

    afterAll(async () => {
      if (tenant) await cleanupTenant(tenant);
      await prismaTest.$disconnect();
    });

    it("generates the default FFP template with the starter labor set", async () => {
      const result = await handleGeneratePricingTemplate(
        { contract_type: "FFP" },
        contextFor(tenant)
      );
      expect(result.isError).toBeFalsy();
      const payload = parsePayload<PricingTemplatePayload>(result);
      expect(payload.template_version).toBe("proposal-mcp/0.1.0");
      expect(payload.scenario_name).toBe("Base");
      expect(payload.contract_type).toBe("FFP");
      expect(payload.opportunity).toBeNull();
      expect(payload.labor_categories).toHaveLength(3);
      expect(payload.labor_categories[0]).toEqual({
        category: "Program Manager",
        level: null,
        hours: 0,
        directRate: null,
        escalationPct: 0,
        extendedCost: null,
      });
      expect(payload.indirect_rates).toEqual({
        fringePct: null,
        overheadPct: null,
        gaPct: null,
        feePct: null,
      });
      expect(payload.odc_lines).toHaveLength(1);
      expect(payload.travel_lines).toHaveLength(1);
      expect(payload.total_proposed_price).toBeNull();
      expect(payload.basis_of_estimate_checklist.length).toBeGreaterThanOrEqual(8);
    });

    it("uses the provided labor categories and contract type notes", async () => {
      const result = await handleGeneratePricingTemplate(
        { contract_type: "T_AND_M", labor_categories: ["Cloud Engineer", "Help Desk Tier 1"] },
        contextFor(tenant)
      );
      const payload = parsePayload<PricingTemplatePayload>(result);
      expect(payload.contract_type).toBe("T_AND_M");
      expect(payload.contract_type_notes).toContain("Time and materials");
      expect(payload.labor_categories.map((l) => l.category)).toEqual([
        "Cloud Engineer",
        "Help Desk Tier 1",
      ]);
    });

    it("prefills from a tenant-visible opportunity", async () => {
      const result = await handleGeneratePricingTemplate(
        { contract_type: "CPFF", opportunity_id: tenant.opportunityId },
        contextFor(tenant)
      );
      const payload = parsePayload<PricingTemplatePayload>(result);
      expect(payload.opportunity).not.toBeNull();
      expect(payload.opportunity!.id).toBe(tenant.opportunityId);
      expect(payload.opportunity!.title).toContain("gpt-A-SECRET-OPP");
      expect(payload.opportunity!.estimated_value).toBe(2500000);
      expect(payload.opportunity!.naics).toBe("541512");
      expect(payload.opportunity!.set_aside).toBe("SDVOSB");
    });

    it("returns isError for an opportunity id outside the tenant", async () => {
      const result = await handleGeneratePricingTemplate(
        { contract_type: "FFP", opportunity_id: "proposal-mcp-test-ghost-opp" },
        contextFor(tenant)
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("not found or not accessible");
    });

    it("never writes a cost_volumes row", async () => {
      await handleGeneratePricingTemplate(
        { contract_type: "FFP", opportunity_id: tenant.opportunityId },
        contextFor(tenant)
      );
      const count = await prismaTest.costVolume.count({
        where: { consultingFirmId: tenant.firmId },
      });
      expect(count).toBe(0);
    });
  }
);
