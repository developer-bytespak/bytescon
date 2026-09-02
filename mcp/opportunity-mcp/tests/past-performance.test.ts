/**
 * Tests for the past-performance tools (list_past_performance,
 * get_past_performance_detail) per the suite DoD:
 *   (a) input-schema validation (unit),
 *   (b) tenant isolation (integration): one firm can never see another
 *       firm's records — not via list, not via a cross-tenant
 *       client_company_id filter, and not via get_*_detail by id.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { handleListPastPerformance } from "../src/tools/list-past-performance.js";
import { handleGetPastPerformanceDetail } from "../src/tools/get-past-performance-detail.js";
import {
  ListPastPerformanceInput,
  type PastPerformanceListPayload,
} from "../src/schemas/list-past-performance.js";
import {
  GetPastPerformanceDetailInput,
  type PastPerformanceDetailPayload,
} from "../src/schemas/get-past-performance-detail.js";
import { prisma } from "../src/lib/prisma.js";
import {
  seedTenantPp,
  cleanupTenantPp,
  shouldSkipIntegrationTests,
  type SeededTenantPp,
} from "./fixtures-pp.js";

const SERVER_NAME = "opportunity-mcp";
const SERVER_VERSION = "0.4.0";

// A relevance tag carrying a control byte (0x07 BELL), built at runtime so no
// raw control char sits in source (mirrors the CONTROL_CHARS_RE note in
// search-opportunities.ts). sanitize() must strip it from the output.
const TAG_WITH_CONTROL_CHAR = `scope${String.fromCharCode(7)}bell`;
// Matches any char sanitize() replaces (0x00-0x1F and 0x7F). Built at runtime
// for the same reason — a literal NUL in source makes git treat the file as
// binary.
const CONTROL_CHAR_RE = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + "]",
);

function ctxFor(tenant: SeededTenantPp) {
  return {
    ctx: {
      tokenId: tenant.tokenId,
      tokenFp: tenant.tokenFp,
      consultingFirmId: tenant.firmId,
      tier: "VAULT" as const,
    },
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
  };
}

describe("list_past_performance — input validation (unit)", () => {
  it("defaults: is_current is UNSET (no default) and limit defaults to 25", () => {
    const parsed = ListPastPerformanceInput.parse({});
    expect(parsed.is_current).toBeUndefined();
    expect(parsed.limit).toBe(25);
    expect(parsed.client_company_id).toBeUndefined();
  });

  it("accepts explicit is_current true or false", () => {
    expect(ListPastPerformanceInput.parse({ is_current: true }).is_current).toBe(true);
    expect(ListPastPerformanceInput.parse({ is_current: false }).is_current).toBe(false);
  });

  it("enforces limit bounds 1..100", () => {
    expect(ListPastPerformanceInput.parse({ limit: 1 }).limit).toBe(1);
    expect(ListPastPerformanceInput.parse({ limit: 100 }).limit).toBe(100);
    expect(() => ListPastPerformanceInput.parse({ limit: 0 })).toThrow();
    expect(() => ListPastPerformanceInput.parse({ limit: 101 })).toThrow();
    expect(() => ListPastPerformanceInput.parse({ limit: 2.5 })).toThrow();
  });

  it("rejects empty / oversize client_company_id and non-boolean is_current", () => {
    expect(() => ListPastPerformanceInput.parse({ client_company_id: "" })).toThrow();
    expect(() => ListPastPerformanceInput.parse({ client_company_id: "x".repeat(65) })).toThrow();
    expect(() => ListPastPerformanceInput.parse({ is_current: "yes" })).toThrow();
  });
});

describe("get_past_performance_detail — input validation (unit)", () => {
  it("accepts a non-empty 1..64-char id", () => {
    expect(GetPastPerformanceDetailInput.parse({ id: "abc123" }).id).toBe("abc123");
    expect(GetPastPerformanceDetailInput.parse({ id: "x".repeat(64) }).id).toBe("x".repeat(64));
  });

  it("rejects empty or oversize id", () => {
    expect(() => GetPastPerformanceDetailInput.parse({ id: "" })).toThrow();
    expect(() => GetPastPerformanceDetailInput.parse({ id: "x".repeat(65) })).toThrow();
  });
});

describe.skipIf(shouldSkipIntegrationTests())("past-performance tools — tenant isolation (integration)", () => {
  let tenantA: SeededTenantPp;
  let tenantB: SeededTenantPp;

  beforeAll(async () => {
    tenantA = await seedTenantPp({
      firmLabel: "pp-A",
      clientLabels: ["clientA1", "clientA2"],
      records: [
        {
          contractNumber: "A-CURRENT-1",
          customerName: "A Dept of Defense",
          customerAgency: "DoD",
          isCurrent: true,
          clientLabel: "clientA1",
          relevanceTags: ["NAICS-541614", TAG_WITH_CONTROL_CHAR],
        },
        {
          contractNumber: "A-HISTORICAL-1",
          customerName: "A General Services Admin",
          customerAgency: "GSA",
          isCurrent: false,
        },
        {
          contractNumber: "A-CURRENT-2",
          customerName: "A Dept of Veterans Affairs",
          customerAgency: "VA",
          isCurrent: true,
          clientLabel: "clientA2",
        },
      ],
    });
    tenantB = await seedTenantPp({
      firmLabel: "pp-B",
      clientLabels: ["clientB1"],
      records: [
        {
          contractNumber: "B-CURRENT-1",
          customerName: "B Dept of Energy",
          customerAgency: "DoE",
          isCurrent: true,
          clientLabel: "clientB1",
        },
      ],
    });
  });

  afterAll(async () => {
    if (tenantA) await cleanupTenantPp(tenantA);
    if (tenantB) await cleanupTenantPp(tenantB);
    await prisma.$disconnect();
  });

  it("list_past_performance (no args) returns ALL of firm A's records (incl. historical) and none of firm B's", async () => {
    const result = await handleListPastPerformance(ListPastPerformanceInput.parse({}), ctxFor(tenantA));
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as PastPerformanceListPayload;

    // All three of A's records (the historical one included by default).
    expect(payload.count).toBe(3);
    const ids = payload.results.map((r) => r.id);
    for (const rec of tenantA.records) expect(ids).toContain(rec.id);
    // The historical record (is_current=false) is present by default.
    expect(payload.results.some((r) => r.is_current === false)).toBe(true);

    // No firm B row may ever appear.
    const bIds = new Set(tenantB.records.map((r) => r.id));
    for (const r of payload.results) expect(bIds.has(r.id)).toBe(false);
  });

  it("relevance_tags are sanitized (control characters stripped)", async () => {
    const result = await handleListPastPerformance(ListPastPerformanceInput.parse({}), ctxFor(tenantA));
    const payload = JSON.parse(result.content[0]!.text) as PastPerformanceListPayload;
    const tagged = payload.results.find((r) => r.relevance_tags.length > 0);
    expect(tagged).toBeDefined();
    for (const tag of tagged!.relevance_tags) {
      expect(CONTROL_CHAR_RE.test(tag)).toBe(false);
    }
  });

  it("is_current=true filters out firm A's historical record", async () => {
    const result = await handleListPastPerformance(
      ListPastPerformanceInput.parse({ is_current: true }),
      ctxFor(tenantA),
    );
    const payload = JSON.parse(result.content[0]!.text) as PastPerformanceListPayload;
    expect(payload.count).toBe(2);
    expect(payload.results.every((r) => r.is_current === true)).toBe(true);
  });

  it("a CROSS-TENANT client_company_id filter returns zero rows (tenant scope wins, no leak)", async () => {
    const crossTenantClientId = tenantB.clients[0]!.id;
    const result = await handleListPastPerformance(
      ListPastPerformanceInput.parse({ client_company_id: crossTenantClientId }),
      ctxFor(tenantA),
    );
    const payload = JSON.parse(result.content[0]!.text) as PastPerformanceListPayload;
    expect(payload.count).toBe(0);
    expect(payload.results).toHaveLength(0);
  });

  it("get_past_performance_detail returns not-found (isError) for an id owned by a DIFFERENT firm", async () => {
    const bRecordId = tenantB.records[0]!.id;
    const result = await handleGetPastPerformanceDetail(
      GetPastPerformanceDetailInput.parse({ id: bRecordId }),
      ctxFor(tenantA),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("not found");
  });

  it("get_past_performance_detail returns the record for the OWNING firm", async () => {
    const ownId = tenantA.records[0]!.id;
    const result = await handleGetPastPerformanceDetail(
      GetPastPerformanceDetailInput.parse({ id: ownId }),
      ctxFor(tenantA),
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as PastPerformanceDetailPayload;
    expect(payload.id).toBe(ownId);
    expect(payload.client_company_name).toBe(tenantA.clients[0]!.name);
  });
});
