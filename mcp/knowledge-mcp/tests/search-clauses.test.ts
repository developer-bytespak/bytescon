/**
 * search_clauses: input validation (unit), keyword search across both
 * catalogs, source filter, limit, fixture-row matching, and audit
 * assertions (integration).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSearchClauses } from "../src/tools/search-clauses.js";
import { SearchClausesInput } from "../src/schemas/search-clauses.js";
import {
  TEST_PREFIX,
  cleanupTenant,
  ctxFor,
  handlerContext,
  prisma,
  shouldSkipIntegrationTests,
  type SeededTenant,
  seedTenant,
} from "./fixtures.js";

describe("search_clauses input validation (unit)", () => {
  it("accepts a minimal valid input and applies the default limit", () => {
    const parsed = SearchClausesInput.parse({ keyword: "subcontracting" });
    expect(parsed.keyword).toBe("subcontracting");
    expect(parsed.limit).toBe(10);
    expect(parsed.source).toBeUndefined();
  });

  it("accepts FAR and DFARS sources", () => {
    expect(SearchClausesInput.parse({ keyword: "cyber", source: "FAR" }).source).toBe("FAR");
    expect(SearchClausesInput.parse({ keyword: "cyber", source: "DFARS" }).source).toBe("DFARS");
  });

  it("rejects unknown source", () => {
    expect(() => SearchClausesInput.parse({ keyword: "cyber", source: "NIST" })).toThrow();
  });

  it("rejects keyword under 2 or over 100 chars", () => {
    expect(() => SearchClausesInput.parse({ keyword: "x" })).toThrow();
    expect(() => SearchClausesInput.parse({ keyword: "x".repeat(101) })).toThrow();
  });

  it("rejects limit outside 1-25", () => {
    expect(() => SearchClausesInput.parse({ keyword: "cyber", limit: 0 })).toThrow();
    expect(() => SearchClausesInput.parse({ keyword: "cyber", limit: 26 })).toThrow();
    expect(() => SearchClausesInput.parse({ keyword: "cyber", limit: 2.5 })).toThrow();
  });
});

describe.skipIf(shouldSkipIntegrationTests())("search_clauses handler (integration)", () => {
  let tenant: SeededTenant;
  const fixtureClauseId = `${TEST_PREFIX}far-clause`;
  // Unique keyword that exists nowhere in the real catalog.
  const fixtureKeyword = `${TEST_PREFIX}zeta-keyword`;
  // Separate unique keyword for the round-robin interleave fixtures.
  const interleaveKeyword = `${TEST_PREFIX}rho-keyword`;
  const runTag = TEST_PREFIX.slice(-9, -1);
  const INTERLEAVE_FAR_COUNT = 6;
  const INTERLEAVE_DFARS_COUNT = 3;

  beforeAll(async () => {
    tenant = await seedTenant("search-clauses");
    await prisma.farClause.create({
      data: {
        id: fixtureClauseId,
        code: `KMT-${runTag}`,
        partNumber: "52",
        title: `Test fixture clause ${fixtureKeyword}`,
        summary: `Fixture summary mentioning ${fixtureKeyword} for search isolation.`,
        text: "[Summary-level entry, full clause text not yet ingested]",
        tags: ["TEST_FIXTURE"],
      },
    });
    // Round-robin fixtures: more FAR rows than the limit used in the
    // interleave test, plus DFARS rows, all sharing one unique keyword,
    // so FAR alone exceeding the limit would starve DFARS without the
    // round-robin merge.
    for (let i = 0; i < INTERLEAVE_FAR_COUNT; i++) {
      await prisma.farClause.create({
        data: {
          id: `${TEST_PREFIX}rr-far-${i}`,
          code: `KMF-${runTag}-${i}`,
          partNumber: "52",
          title: `Round robin FAR fixture ${i} ${interleaveKeyword}`,
          summary: `FAR fixture ${i} for interleave coverage.`,
          tags: ["TEST_FIXTURE"],
        },
      });
    }
    for (let i = 0; i < INTERLEAVE_DFARS_COUNT; i++) {
      await prisma.dfarsClause.create({
        data: {
          id: `${TEST_PREFIX}rr-dfars-${i}`,
          code: `KMD-${runTag}-${i}`,
          partNumber: "252",
          title: `Round robin DFARS fixture ${i} ${interleaveKeyword}`,
          summary: `DFARS fixture ${i} for interleave coverage.`,
          tags: ["TEST_FIXTURE"],
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.farClause.deleteMany({ where: { id: { startsWith: TEST_PREFIX } } });
    await prisma.dfarsClause.deleteMany({ where: { id: { startsWith: TEST_PREFIX } } });
    if (tenant) await cleanupTenant(tenant);
  });

  it("finds catalog clauses by keyword across titles", async () => {
    const result = await handleSearchClauses(
      { keyword: "subcontracting", limit: 25 },
      handlerContext(ctxFor(tenant))
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as {
      count: number;
      results: Array<{ source: string; code: string; title: string }>;
    };
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.results.some((r) => r.code === "52.219-14")).toBe(true);
  });

  it("interleaves FAR and DFARS matches round-robin when source is ALL", async () => {
    // 6 FAR fixtures alone exceed the limit of 4; before the round-robin
    // merge the DFARS fixtures were starved out entirely.
    const result = await handleSearchClauses(
      { keyword: interleaveKeyword, limit: 4 },
      handlerContext(ctxFor(tenant))
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as {
      count: number;
      results: Array<{ source: string; code: string }>;
    };
    expect(payload.count).toBe(4);
    expect(payload.results.map((r) => r.source)).toEqual(["FAR", "DFARS", "FAR", "DFARS"]);
    // Ordering within each catalog stays deterministic (code ascending).
    const farCodes = payload.results.filter((r) => r.source === "FAR").map((r) => r.code);
    const dfarsCodes = payload.results.filter((r) => r.source === "DFARS").map((r) => r.code);
    expect(farCodes).toEqual([`KMF-${runTag}-0`, `KMF-${runTag}-1`]);
    expect(dfarsCodes).toEqual([`KMD-${runTag}-0`, `KMD-${runTag}-1`]);
  });

  it("falls back to FAR-only rows once DFARS matches are exhausted", async () => {
    const result = await handleSearchClauses(
      { keyword: interleaveKeyword, limit: 25 },
      handlerContext(ctxFor(tenant))
    );
    const payload = JSON.parse(result.content[0]!.text) as {
      count: number;
      results: Array<{ source: string }>;
    };
    expect(payload.count).toBe(INTERLEAVE_FAR_COUNT + INTERLEAVE_DFARS_COUNT);
    expect(payload.results.filter((r) => r.source === "FAR").length).toBe(INTERLEAVE_FAR_COUNT);
    expect(payload.results.filter((r) => r.source === "DFARS").length).toBe(
      INTERLEAVE_DFARS_COUNT
    );
  });

  it("restricts results to DFARS when source is DFARS", async () => {
    const result = await handleSearchClauses(
      { keyword: "252.204", source: "DFARS", limit: 25 },
      handlerContext(ctxFor(tenant))
    );
    const payload = JSON.parse(result.content[0]!.text) as {
      count: number;
      results: Array<{ source: string; code: string }>;
    };
    expect(payload.count).toBeGreaterThan(0);
    for (const r of payload.results) {
      expect(r.source).toBe("DFARS");
      expect(r.code.startsWith("252.204")).toBe(true);
    }
  });

  it("restricts results to FAR when source is FAR", async () => {
    const result = await handleSearchClauses(
      { keyword: "cyber", source: "FAR", limit: 25 },
      handlerContext(ctxFor(tenant))
    );
    const payload = JSON.parse(result.content[0]!.text) as {
      results: Array<{ source: string }>;
    };
    for (const r of payload.results) {
      expect(r.source).toBe("FAR");
    }
  });

  it("respects the limit", async () => {
    const result = await handleSearchClauses(
      { keyword: "contract", limit: 3 },
      handlerContext(ctxFor(tenant))
    );
    const payload = JSON.parse(result.content[0]!.text) as { count: number; results: unknown[] };
    expect(payload.count).toBeLessThanOrEqual(3);
    expect(payload.results.length).toBeLessThanOrEqual(3);
  });

  it("finds the fixture clause by its unique keyword and flags summary-level text", async () => {
    const result = await handleSearchClauses(
      { keyword: fixtureKeyword, limit: 10 },
      handlerContext(ctxFor(tenant))
    );
    const payload = JSON.parse(result.content[0]!.text) as {
      count: number;
      results: Array<{ code: string; text_is_summary_level: boolean }>;
    };
    expect(payload.count).toBe(1);
    expect(payload.results[0]!.text_is_summary_level).toBe(true);
  });

  it("returns an empty result set for a no-match keyword", async () => {
    const result = await handleSearchClauses(
      { keyword: `${TEST_PREFIX}no-such-keyword-anywhere`, limit: 10 },
      handlerContext(ctxFor(tenant))
    );
    const payload = JSON.parse(result.content[0]!.text) as { count: number };
    expect(payload.count).toBe(0);
  });

  it("treats percent in the keyword literally, not as a wildcard", async () => {
    const result = await handleSearchClauses(
      { keyword: "52%219", limit: 25 },
      handlerContext(ctxFor(tenant))
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as {
      results: Array<{ code: string }>;
    };
    // Unescaped, ILIKE '%52%219%' would match every 52.219-x catalog row.
    expect(payload.results.some((r) => r.code.startsWith("52.219"))).toBe(false);
  });

  it("treats underscores in the keyword literally, not as wildcards", async () => {
    const result = await handleSearchClauses(
      { keyword: "____", limit: 25 },
      handlerContext(ctxFor(tenant))
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as { count: number };
    // Unescaped, ILIKE '%____%' matches any clause with 4+ characters of
    // text; no catalog or fixture row contains four literal underscores.
    expect(payload.count).toBe(0);
  });

  it("writes exactly one audit row per call with outcome ok", async () => {
    const before = await prisma.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
    await handleSearchClauses(
      { keyword: "small business", limit: 5 },
      handlerContext(ctxFor(tenant))
    );
    const after = await prisma.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
    expect(after - before).toBe(1);

    const latest = await prisma.mcpAuditLog.findFirst({
      where: { tenantId: tenant.firmId },
      orderBy: { ts: "desc" },
    });
    expect(latest!.toolName).toBe("search_clauses");
    expect(latest!.outcome).toBe("ok");
    expect(latest!.inputHash.length).toBe(64);
  });
});
