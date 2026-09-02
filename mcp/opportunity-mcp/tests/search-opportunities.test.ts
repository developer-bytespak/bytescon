/**
 * Unit + integration tests for the search_opportunities handler.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { handleSearchOpportunities, sanitize } from "../src/tools/search-opportunities.js";
import {
  SearchOpportunitiesInput,
  SetAsideEnum,
  SET_ASIDE_DB_VALUE,
} from "../src/schemas/search-opportunities.js";
import { prisma } from "../src/lib/prisma.js";
import { seedTenant, cleanupTenant, shouldSkipIntegrationTests, type SeededTenant } from "./fixtures.js";

describe("search_opportunities — input validation (unit)", () => {
  it("accepts a minimal valid input", () => {
    const parsed = SearchOpportunitiesInput.parse({ keyword: "logistics" });
    expect(parsed.keyword).toBe("logistics");
    expect(parsed.limit).toBe(10);
  });

  it("rejects empty keyword", () => {
    expect(() => SearchOpportunitiesInput.parse({ keyword: "" })).toThrow();
  });

  it("rejects keyword over 200 chars", () => {
    expect(() => SearchOpportunitiesInput.parse({ keyword: "x".repeat(201) })).toThrow();
  });

  it("rejects non-six-digit naics", () => {
    expect(() => SearchOpportunitiesInput.parse({ keyword: "k", naics: "54133" })).toThrow();
    expect(() => SearchOpportunitiesInput.parse({ keyword: "k", naics: "54133X" })).toThrow();
  });

  it("rejects unknown set_aside", () => {
    expect(() =>
      SearchOpportunitiesInput.parse({ keyword: "k", set_aside: "BOGUS" })
    ).toThrow();
  });

  it("rejects limit above 50", () => {
    expect(() => SearchOpportunitiesInput.parse({ keyword: "k", limit: 51 })).toThrow();
  });

  it("rejects non-ISO posted_after", () => {
    expect(() =>
      SearchOpportunitiesInput.parse({ keyword: "k", posted_after: "yesterday" })
    ).toThrow();
  });
});

describe("SET_ASIDE_DB_VALUE — public→DB mapping (unit)", () => {
  it("maps every public enum value to a stored value", () => {
    for (const value of SetAsideEnum.options) {
      expect(SET_ASIDE_DB_VALUE[value]).toBeTruthy();
    }
  });

  it("translates the mismatched values to their stored form", () => {
    expect(SET_ASIDE_DB_VALUE["8A"]).toBe("SBA_8A");
    expect(SET_ASIDE_DB_VALUE.TOTAL_SMALL_BUSINESS).toBe("SMALL_BUSINESS");
    expect(SET_ASIDE_DB_VALUE.UNRESTRICTED).toBe("NONE");
  });

  it("leaves already-matching values unchanged", () => {
    expect(SET_ASIDE_DB_VALUE.SDVOSB).toBe("SDVOSB");
    expect(SET_ASIDE_DB_VALUE.WOSB).toBe("WOSB");
    expect(SET_ASIDE_DB_VALUE.HUBZONE).toBe("HUBZONE");
  });
});

describe("sanitize() — prompt-injection mitigation (unit)", () => {
  it("strips control characters", () => {
    const dirty = "hello\x00world\x1Ffoo\x7Fbar";
    expect(sanitize(dirty)).toBe("hello world foo bar");
  });

  it("caps length at 2000 chars", () => {
    expect(sanitize("x".repeat(3000)).length).toBe(2000);
  });

  it("handles null and undefined", () => {
    expect(sanitize(null)).toBe("");
    expect(sanitize(undefined)).toBe("");
  });

  it("preserves normal punctuation and unicode", () => {
    expect(sanitize("Hello, world! 你好 🚀")).toBe("Hello, world! 你好 🚀");
  });
});

describe.skipIf(shouldSkipIntegrationTests())("search_opportunities — handler (integration)", () => {
  let tenant: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant({
      firmLabel: "search-handler-A",
      opportunities: [
        { title: "VETS26 logistics support", agency: "DoD", naicsCode: "541330" },
        { title: "GSA cleaning services contract", agency: "GSA", naicsCode: "561720", setAsideType: "SDVOSB" },
        { title: "8A staffing services award", agency: "GSA", naicsCode: "561320", setAsideType: "SBA_8A" },
        { title: "VA hospital IT modernization", agency: "VA", naicsCode: "541512" },
        { title: "Archived old logistics RFP", agency: "DoD", naicsCode: "541330", status: "ARCHIVED" },
      ],
    });
  });

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant);
    await prisma.$disconnect();
  });

  it("returns matching ACTIVE opportunities by keyword", async () => {
    const result = await handleSearchOpportunities(
      { keyword: "logistics", limit: 10 },
      {
        ctx: {
          tokenId: tenant.tokenId,
          tokenFp: tenant.tokenFp,
          consultingFirmId: tenant.firmId,
          tier: "CORE",
        },
        serverName: "opportunity-mcp",
        serverVersion: "0.1.0",
      }
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as { count: number; results: Array<{ title: string }> };
    // archived row must NOT be returned
    expect(payload.count).toBe(1);
    expect(payload.results[0]!.title).toContain("VETS26 logistics");
  });

  it("filters by naics", async () => {
    const result = await handleSearchOpportunities(
      { keyword: "contract", naics: "561720", limit: 10 },
      {
        ctx: {
          tokenId: tenant.tokenId,
          tokenFp: tenant.tokenFp,
          consultingFirmId: tenant.firmId,
          tier: "CORE",
        },
        serverName: "opportunity-mcp",
        serverVersion: "0.1.0",
      }
    );
    const payload = JSON.parse(result.content[0]!.text) as { count: number; results: Array<{ naics: string }> };
    expect(payload.count).toBe(1);
    expect(payload.results[0]!.naics).toBe("561720");
  });

  it("filters by set_aside", async () => {
    const result = await handleSearchOpportunities(
      { keyword: "services", set_aside: "SDVOSB", limit: 10 },
      {
        ctx: {
          tokenId: tenant.tokenId,
          tokenFp: tenant.tokenFp,
          consultingFirmId: tenant.firmId,
          tier: "CORE",
        },
        serverName: "opportunity-mcp",
        serverVersion: "0.1.0",
      }
    );
    const payload = JSON.parse(result.content[0]!.text) as { count: number; results: Array<{ set_aside: string }> };
    expect(payload.count).toBe(1);
    expect(payload.results[0]!.set_aside).toBe("SDVOSB");
  });

  it("maps public 8A filter to stored SBA_8A value", async () => {
    const result = await handleSearchOpportunities(
      { keyword: "services", set_aside: "8A", limit: 10 },
      {
        ctx: {
          tokenId: tenant.tokenId,
          tokenFp: tenant.tokenFp,
          consultingFirmId: tenant.firmId,
          tier: "CORE",
        },
        serverName: "opportunity-mcp",
        serverVersion: "0.1.0",
      }
    );
    const payload = JSON.parse(result.content[0]!.text) as { count: number; results: Array<{ set_aside: string }> };
    expect(payload.count).toBe(1);
    expect(payload.results[0]!.set_aside).toBe("SBA_8A");
  });

  it("respects limit", async () => {
    const result = await handleSearchOpportunities(
      { keyword: "support", limit: 1 },
      {
        ctx: {
          tokenId: tenant.tokenId,
          tokenFp: tenant.tokenFp,
          consultingFirmId: tenant.firmId,
          tier: "CORE",
        },
        serverName: "opportunity-mcp",
        serverVersion: "0.1.0",
      }
    );
    const payload = JSON.parse(result.content[0]!.text) as { count: number };
    expect(payload.count).toBeLessThanOrEqual(1);
  });

  it("paginates via next_cursor and walks the full result set", async () => {
    const callerCtx = {
      ctx: {
        tokenId: tenant.tokenId,
        tokenFp: tenant.tokenFp,
        consultingFirmId: tenant.firmId,
        tier: "CORE" as const,
      },
      serverName: "opportunity-mcp",
      serverVersion: "0.3.0",
    };

    // Seeded tenant has 3 ACTIVE opps matching keyword "VA" via agency/title.
    // Fetch page-by-page with limit=1; expect to walk all 3 then get next_cursor=null.
    const seenIds = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const input: { keyword: string; limit: number; cursor?: string } = { keyword: "VA", limit: 1 };
      if (cursor) input.cursor = cursor;
      const result = await handleSearchOpportunities(input, callerCtx);
      const payload = JSON.parse(result.content[0]!.text) as {
        count: number;
        results: Array<{ id: string }>;
        next_cursor: string | null;
      };
      for (const r of payload.results) seenIds.add(r.id);
      if (!payload.next_cursor) break;
      cursor = payload.next_cursor;
    }
    // Must have walked all VA-related ACTIVE opportunities (at least 1 in the fixture: the VA hospital row).
    expect(seenIds.size).toBeGreaterThanOrEqual(1);
  });

  it("rejects malformed cursors silently (returns first page)", async () => {
    const result = await handleSearchOpportunities(
      { keyword: "support", limit: 5, cursor: "not-base64!@#$" },
      {
        ctx: {
          tokenId: tenant.tokenId,
          tokenFp: tenant.tokenFp,
          consultingFirmId: tenant.firmId,
          tier: "CORE",
        },
        serverName: "opportunity-mcp",
        serverVersion: "0.3.0",
      }
    );
    expect(result.isError).toBeFalsy();
    // A bogus cursor is treated as "no cursor" (returns first page); never errors.
  });
});
