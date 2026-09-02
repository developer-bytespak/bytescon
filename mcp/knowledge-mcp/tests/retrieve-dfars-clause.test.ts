/**
 * retrieve_dfars_clause: input validation (unit), handler happy path,
 * suggestions path, and audit assertions (integration).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleRetrieveDfarsClause } from "../src/tools/retrieve-dfars-clause.js";
import {
  RetrieveDfarsClauseInput,
  normalizeDfarsCode,
} from "../src/schemas/retrieve-dfars-clause.js";
import {
  cleanupTenant,
  ctxFor,
  handlerContext,
  prisma,
  shouldSkipIntegrationTests,
  type SeededTenant,
  seedTenant,
} from "./fixtures.js";

describe("retrieve_dfars_clause input validation (unit)", () => {
  it("accepts a full clause code", () => {
    const parsed = RetrieveDfarsClauseInput.parse({ code: "252.204-7012" });
    expect(parsed.code).toBe("252.204-7012");
  });

  it("accepts a partial code for suggestions", () => {
    expect(RetrieveDfarsClauseInput.parse({ code: "252.204" }).code).toBe("252.204");
  });

  it("accepts and normalizes a DFARS prefix", () => {
    const parsed = RetrieveDfarsClauseInput.parse({ code: "DFARS 252.204-7012" });
    expect(normalizeDfarsCode(parsed.code)).toBe("252.204-7012");
  });

  it("rejects empty and non-clause input", () => {
    expect(() => RetrieveDfarsClauseInput.parse({ code: "" })).toThrow();
    expect(() => RetrieveDfarsClauseInput.parse({ code: "cybersecurity" })).toThrow();
  });
});

describe.skipIf(shouldSkipIntegrationTests())("retrieve_dfars_clause handler (integration)", () => {
  let tenant: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant("dfars-clause");
  });

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant);
  });

  it("returns the full row for an exact code match", async () => {
    const result = await handleRetrieveDfarsClause(
      { code: "252.204-7012" },
      handlerContext(ctxFor(tenant))
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as {
      found: boolean;
      source: string;
      clause: Record<string, unknown>;
      data_completeness?: string;
    };
    expect(payload.found).toBe(true);
    expect(payload.source).toBe("DFARS");
    expect(payload.clause["code"]).toBe("252.204-7012");
    expect(String(payload.clause["title"])).toMatch(/Safeguarding/i);
    expect(payload.data_completeness).toContain("Summary-level entry");
  });

  it("returns at most 5 prefix suggestions when the code is absent", async () => {
    const result = await handleRetrieveDfarsClause(
      { code: "252.204" },
      handlerContext(ctxFor(tenant))
    );
    const payload = JSON.parse(result.content[0]!.text) as {
      found: boolean;
      suggestions: Array<{ code: string; title: string }>;
    };
    expect(payload.found).toBe(false);
    expect(payload.suggestions.length).toBeGreaterThan(0);
    expect(payload.suggestions.length).toBeLessThanOrEqual(5);
    for (const s of payload.suggestions) {
      expect(s.code.startsWith("252.204")).toBe(true);
    }
  });

  it("does not treat percent in a lookup code as a wildcard in suggestions", async () => {
    // Exercises the shared suggestCodes path below the zod boundary:
    // unescaped, the prefix query LIKE '252%204%' would surface every
    // 252.204-x row.
    const result = await handleRetrieveDfarsClause(
      { code: "252%204" },
      handlerContext(ctxFor(tenant))
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as {
      found: boolean;
      suggestions: Array<{ code: string }>;
    };
    expect(payload.found).toBe(false);
    expect(payload.suggestions).toEqual([]);
  });

  it("writes exactly one audit row per call with outcome ok", async () => {
    const before = await prisma.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
    await handleRetrieveDfarsClause({ code: "252.204-7019" }, handlerContext(ctxFor(tenant)));
    const after = await prisma.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
    expect(after - before).toBe(1);

    const latest = await prisma.mcpAuditLog.findFirst({
      where: { tenantId: tenant.firmId },
      orderBy: { ts: "desc" },
    });
    expect(latest!.toolName).toBe("retrieve_dfars_clause");
    expect(latest!.outcome).toBe("ok");
    expect(latest!.tokenFp).toBe(tenant.tokenFp);
  });
});
