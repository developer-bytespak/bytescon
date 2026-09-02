/**
 * Input-validation unit tests for the v0.2 suite tools.
 *
 * Integration tests (live DB) for these tools should be added once a
 * seeded fixture exists for BidDecision, RecipientProfile, and
 * ComplianceMatrix. For now this file pins the Zod contract so a
 * schema change can't ship silently.
 */
import { describe, it, expect } from "vitest";
import { GetOpportunityDetailInput } from "../src/schemas/get-opportunity-detail.js";
import { GetBidDecisionInput } from "../src/schemas/get-bid-decision.js";
import { ListComplianceGapsInput } from "../src/schemas/list-compliance-gaps.js";
import { LookupRecipientInput } from "../src/schemas/lookup-recipient.js";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("get_opportunity_detail input", () => {
  it("accepts a UUID or any non-empty 1..128-char string", () => {
    expect(GetOpportunityDetailInput.parse({ opportunity_id: UUID }).opportunity_id).toBe(UUID);
    expect(GetOpportunityDetailInput.parse({ opportunity_id: "SAM-NOTICE-ABC-123" }).opportunity_id).toBe(
      "SAM-NOTICE-ABC-123",
    );
  });

  it("rejects empty or oversize opportunity_id", () => {
    expect(() => GetOpportunityDetailInput.parse({ opportunity_id: "" })).toThrow();
    expect(() => GetOpportunityDetailInput.parse({ opportunity_id: "x".repeat(129) })).toThrow();
  });
});

describe("get_bid_decision input", () => {
  it("accepts a valid (opportunity_id, client_company_id) UUID pair", () => {
    const parsed = GetBidDecisionInput.parse({
      opportunity_id: UUID,
      client_company_id: UUID,
    });
    expect(parsed.opportunity_id).toBe(UUID);
    expect(parsed.client_company_id).toBe(UUID);
  });

  it("rejects non-UUID inputs", () => {
    expect(() =>
      GetBidDecisionInput.parse({ opportunity_id: "not-a-uuid", client_company_id: UUID }),
    ).toThrow();
    expect(() =>
      GetBidDecisionInput.parse({ opportunity_id: UUID, client_company_id: "not-a-uuid" }),
    ).toThrow();
  });
});

describe("list_compliance_gaps input", () => {
  it("accepts a UUID with default mandatory_only=false", () => {
    const parsed = ListComplianceGapsInput.parse({ opportunity_id: UUID });
    expect(parsed.opportunity_id).toBe(UUID);
    expect(parsed.mandatory_only).toBe(false);
  });

  it("accepts mandatory_only=true", () => {
    const parsed = ListComplianceGapsInput.parse({ opportunity_id: UUID, mandatory_only: true });
    expect(parsed.mandatory_only).toBe(true);
  });

  it("rejects non-UUID opportunity_id", () => {
    expect(() => ListComplianceGapsInput.parse({ opportunity_id: "abc" })).toThrow();
  });
});

describe("lookup_recipient input", () => {
  it("accepts a 12-char alphanumeric UEI", () => {
    expect(LookupRecipientInput.parse({ uei: "HX6FDVAF2TL6" }).uei).toBe("HX6FDVAF2TL6");
    expect(LookupRecipientInput.parse({ uei: "abc123def456" }).uei).toBe("abc123def456");
  });

  it("rejects UEIs that are too short, too long, or contain symbols", () => {
    expect(() => LookupRecipientInput.parse({ uei: "TOOSHORT" })).toThrow();
    expect(() => LookupRecipientInput.parse({ uei: "WAYTOOLONGFORUEI" })).toThrow();
    expect(() => LookupRecipientInput.parse({ uei: "HX6FDVAF-TL6" })).toThrow();
    expect(() => LookupRecipientInput.parse({ uei: "HX6FDVAF TL6" })).toThrow();
  });
});
