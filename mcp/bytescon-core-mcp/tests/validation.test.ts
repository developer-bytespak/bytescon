/**
 * Input validation unit tests for all four tool schemas. Pure Zod, no
 * database required.
 */
import { describe, it, expect } from "vitest";
import { ListDeliverablesInput } from "../src/schemas/list-deliverables.js";
import { GetBillingStatusInput } from "../src/schemas/get-billing-status.js";
import { GetUsageSummaryInput } from "../src/schemas/get-usage-summary.js";
import { ListUsersInput } from "../src/schemas/list-users.js";

describe("list_deliverables input validation (unit)", () => {
  it("accepts an empty input and applies defaults", () => {
    const parsed = ListDeliverablesInput.parse({});
    expect(parsed.limit).toBe(25);
    expect(parsed.offset).toBe(0);
    expect(parsed.status).toBeUndefined();
  });

  it("accepts every documented status value", () => {
    for (const status of ["PENDING", "IN_PROGRESS", "SUBMITTED", "APPROVED", "REJECTED"]) {
      expect(ListDeliverablesInput.parse({ status }).status).toBe(status);
    }
  });

  it("rejects an unknown status", () => {
    expect(() => ListDeliverablesInput.parse({ status: "OVERDUE" })).toThrow();
  });

  it("rejects a non-ISO due_before", () => {
    expect(() => ListDeliverablesInput.parse({ due_before: "tomorrow" })).toThrow();
    expect(() => ListDeliverablesInput.parse({ due_before: "2026-06-11" })).toThrow();
  });

  it("accepts an ISO due_before with offset", () => {
    const parsed = ListDeliverablesInput.parse({ due_before: "2026-07-01T00:00:00Z" });
    expect(parsed.due_before).toBe("2026-07-01T00:00:00Z");
  });

  it("rejects limit out of range and non-integers", () => {
    expect(() => ListDeliverablesInput.parse({ limit: 0 })).toThrow();
    expect(() => ListDeliverablesInput.parse({ limit: 101 })).toThrow();
    expect(() => ListDeliverablesInput.parse({ limit: 2.5 })).toThrow();
  });

  it("rejects negative offset", () => {
    expect(() => ListDeliverablesInput.parse({ offset: -1 })).toThrow();
  });

  it("rejects an empty client_company_id", () => {
    expect(() => ListDeliverablesInput.parse({ client_company_id: "" })).toThrow();
  });
});

describe("get_billing_status input validation (unit)", () => {
  it("accepts an empty input", () => {
    expect(GetBillingStatusInput.parse({})).toEqual({});
  });
});

describe("get_usage_summary input validation (unit)", () => {
  it("defaults window_days to 30", () => {
    expect(GetUsageSummaryInput.parse({}).window_days).toBe(30);
  });

  it("accepts the documented bounds", () => {
    expect(GetUsageSummaryInput.parse({ window_days: 1 }).window_days).toBe(1);
    expect(GetUsageSummaryInput.parse({ window_days: 365 }).window_days).toBe(365);
  });

  it("rejects out-of-range and non-integer windows", () => {
    expect(() => GetUsageSummaryInput.parse({ window_days: 0 })).toThrow();
    expect(() => GetUsageSummaryInput.parse({ window_days: 366 })).toThrow();
    expect(() => GetUsageSummaryInput.parse({ window_days: 1.5 })).toThrow();
  });
});

describe("list_users input validation (unit)", () => {
  it("defaults include_emails to false", () => {
    const parsed = ListUsersInput.parse({});
    expect(parsed.include_emails).toBe(false);
    expect(parsed.limit).toBe(25);
    expect(parsed.offset).toBe(0);
  });

  it("rejects non-boolean include_emails", () => {
    expect(() => ListUsersInput.parse({ include_emails: "yes" })).toThrow();
  });

  it("rejects limit out of range", () => {
    expect(() => ListUsersInput.parse({ limit: 0 })).toThrow();
    expect(() => ListUsersInput.parse({ limit: 101 })).toThrow();
  });
});
