/**
 * Pure Zod input-validation unit tests for all five proposal-mcp tools.
 * No database required.
 */
import { describe, expect, it } from "vitest";
import { GetComplianceMatrixInput } from "../src/schemas/get-compliance-matrix.js";
import { ListMatrixRequirementsInput } from "../src/schemas/list-matrix-requirements.js";
import { GetBidGuidanceInput } from "../src/schemas/get-bid-guidance.js";
import { GetAdherenceScoreInput } from "../src/schemas/get-adherence-score.js";
import { GeneratePricingTemplateInput } from "../src/schemas/generate-pricing-template.js";

describe("get_compliance_matrix input validation (unit)", () => {
  it("accepts a minimal valid input and applies defaults", () => {
    const parsed = GetComplianceMatrixInput.parse({ opportunity_id: "abc-123" });
    expect(parsed.offset).toBe(0);
    expect(parsed.limit).toBe(25);
  });

  it("rejects an empty opportunity_id", () => {
    expect(() => GetComplianceMatrixInput.parse({ opportunity_id: "" })).toThrow();
  });

  it("rejects opportunity_id over 128 chars", () => {
    expect(() => GetComplianceMatrixInput.parse({ opportunity_id: "x".repeat(129) })).toThrow();
  });

  it("rejects limit 0 and limit above 50", () => {
    expect(() => GetComplianceMatrixInput.parse({ opportunity_id: "a", limit: 0 })).toThrow();
    expect(() => GetComplianceMatrixInput.parse({ opportunity_id: "a", limit: 51 })).toThrow();
  });

  it("rejects negative and non-integer offset", () => {
    expect(() => GetComplianceMatrixInput.parse({ opportunity_id: "a", offset: -1 })).toThrow();
    expect(() => GetComplianceMatrixInput.parse({ opportunity_id: "a", offset: 1.5 })).toThrow();
  });
});

describe("list_matrix_requirements input validation (unit)", () => {
  it("accepts an empty input with defaults", () => {
    const parsed = ListMatrixRequirementsInput.parse({});
    expect(parsed.mandatory_only).toBe(false);
    expect(parsed.offset).toBe(0);
    expect(parsed.limit).toBe(25);
    expect(parsed.opportunity_id).toBeUndefined();
  });

  it("accepts every documented section_type", () => {
    for (const sectionType of ["INSTRUCTION", "EVALUATION", "CLAUSE", "CERTIFICATION"]) {
      expect(ListMatrixRequirementsInput.parse({ section_type: sectionType }).section_type).toBe(
        sectionType
      );
    }
  });

  it("rejects an unknown section_type", () => {
    expect(() => ListMatrixRequirementsInput.parse({ section_type: "BOGUS" })).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() => ListMatrixRequirementsInput.parse({ status: "DONE" })).toThrow();
  });

  it("accepts every MatrixRequirementStatus value", () => {
    for (const status of ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "PENDING_REVIEW", "BLOCKED"]) {
      expect(ListMatrixRequirementsInput.parse({ status }).status).toBe(status);
    }
  });

  it("rejects limit above 50", () => {
    expect(() => ListMatrixRequirementsInput.parse({ limit: 51 })).toThrow();
  });

  it("rejects a non-boolean mandatory_only", () => {
    expect(() => ListMatrixRequirementsInput.parse({ mandatory_only: "yes" })).toThrow();
  });
});

describe("get_bid_guidance input validation (unit)", () => {
  it("requires opportunity_id", () => {
    expect(() => GetBidGuidanceInput.parse({})).toThrow();
  });

  it("rejects an empty opportunity_id", () => {
    expect(() => GetBidGuidanceInput.parse({ opportunity_id: "" })).toThrow();
  });

  it("accepts a UUID-like opportunity_id", () => {
    const parsed = GetBidGuidanceInput.parse({
      opportunity_id: "0d4e6f2a-9a76-4a51-b1de-79a1b2c3d4e5",
    });
    expect(parsed.opportunity_id).toContain("0d4e6f2a");
  });
});

describe("get_adherence_score input validation (unit)", () => {
  it("requires opportunity_id and defaults limit to 5", () => {
    expect(() => GetAdherenceScoreInput.parse({})).toThrow();
    const parsed = GetAdherenceScoreInput.parse({ opportunity_id: "abc" });
    expect(parsed.limit).toBe(5);
  });

  it("rejects limit 0 and limit above 20", () => {
    expect(() => GetAdherenceScoreInput.parse({ opportunity_id: "a", limit: 0 })).toThrow();
    expect(() => GetAdherenceScoreInput.parse({ opportunity_id: "a", limit: 21 })).toThrow();
  });
});

describe("generate_pricing_template input validation (unit)", () => {
  it("accepts an empty input and defaults contract_type to FFP", () => {
    const parsed = GeneratePricingTemplateInput.parse({});
    expect(parsed.contract_type).toBe("FFP");
    expect(parsed.opportunity_id).toBeUndefined();
    expect(parsed.labor_categories).toBeUndefined();
  });

  it("accepts T_AND_M and CPFF contract types", () => {
    expect(GeneratePricingTemplateInput.parse({ contract_type: "T_AND_M" }).contract_type).toBe(
      "T_AND_M"
    );
    expect(GeneratePricingTemplateInput.parse({ contract_type: "CPFF" }).contract_type).toBe(
      "CPFF"
    );
  });

  it("rejects an unknown contract_type", () => {
    expect(() => GeneratePricingTemplateInput.parse({ contract_type: "IDIQ" })).toThrow();
  });

  it("rejects more than 20 labor categories", () => {
    const categories = Array.from({ length: 21 }, (_, i) => `Category ${i}`);
    expect(() => GeneratePricingTemplateInput.parse({ labor_categories: categories })).toThrow();
  });

  it("rejects a labor category over 80 chars and an empty one", () => {
    expect(() =>
      GeneratePricingTemplateInput.parse({ labor_categories: ["x".repeat(81)] })
    ).toThrow();
    expect(() => GeneratePricingTemplateInput.parse({ labor_categories: [""] })).toThrow();
  });
});
