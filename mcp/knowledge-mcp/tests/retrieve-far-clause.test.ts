/**
 * retrieve_far_clause: input validation (unit), handler happy path,
 * suggestions path, and audit assertions (integration against the seeded
 * clause catalog on the dev DB).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleRetrieveFarClause } from "../src/tools/retrieve-far-clause.js";
import {
  RetrieveFarClauseInput,
  normalizeFarCode,
} from "../src/schemas/retrieve-far-clause.js";
import {
  cleanupTenant,
  ctxFor,
  handlerContext,
  prisma,
  shouldSkipIntegrationTests,
  type SeededTenant,
  seedTenant,
} from "./fixtures.js";

describe("retrieve_far_clause input validation (unit)", () => {
  it("accepts a full clause code", () => {
    const parsed = RetrieveFarClauseInput.parse({ code: "52.219-14" });
    expect(parsed.code).toBe("52.219-14");
  });

  it("accepts a partial code for suggestions", () => {
    expect(RetrieveFarClauseInput.parse({ code: "52.219" }).code).toBe("52.219");
    expect(RetrieveFarClauseInput.parse({ code: "52" }).code).toBe("52");
  });

  it("accepts and normalizes a FAR prefix", () => {
    const parsed = RetrieveFarClauseInput.parse({ code: "FAR 52.219-14" });
    expect(normalizeFarCode(parsed.code)).toBe("52.219-14");
  });

  it("rejects empty and non-clause input", () => {
    expect(() => RetrieveFarClauseInput.parse({ code: "" })).toThrow();
    expect(() => RetrieveFarClauseInput.parse({ code: "subcontracting" })).toThrow();
    expect(() => RetrieveFarClauseInput.parse({ code: "52.219-14; DROP TABLE x" })).toThrow();
  });

  it("rejects codes over 24 chars", () => {
    expect(() => RetrieveFarClauseInput.parse({ code: "5".repeat(25) })).toThrow();
  });
});

describe.skipIf(shouldSkipIntegrationTests())("retrieve_far_clause handler (integration)", () => {
  let tenant: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant("far-clause");
  });

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant);
  });

  it("returns the full row for an exact code match", async () => {
    const result = await handleRetrieveFarClause(
      { code: "52.219-14" },
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
    expect(payload.source).toBe("FAR");
    expect(payload.clause["code"]).toBe("52.219-14");
    expect(payload.clause["title"]).toContain("Limitations on Subcontracting");
    expect(Array.isArray(payload.clause["set_aside_triggers"])).toBe(true);
    expect(typeof payload.clause["flow_down_required"]).toBe("boolean");
    expect(payload.clause["summary"]).toBeTruthy();
  });

  it("includes a data_completeness note for summary-level text", async () => {
    const result = await handleRetrieveFarClause(
      { code: "52.219-14" },
      handlerContext(ctxFor(tenant))
    );
    const payload = JSON.parse(result.content[0]!.text) as { data_completeness?: string };
    expect(payload.data_completeness).toContain("Summary-level entry");
  });

  it("normalizes a FAR prefixed code to the same row", async () => {
    const result = await handleRetrieveFarClause(
      { code: "FAR 52.219-14" },
      handlerContext(ctxFor(tenant))
    );
    const payload = JSON.parse(result.content[0]!.text) as {
      found: boolean;
      clause: Record<string, unknown>;
    };
    expect(payload.found).toBe(true);
    expect(payload.clause["code"]).toBe("52.219-14");
  });

  it("returns at most 5 prefix suggestions when the code is absent", async () => {
    const result = await handleRetrieveFarClause(
      { code: "52.219" },
      handlerContext(ctxFor(tenant))
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as {
      found: boolean;
      suggestions: Array<{ code: string; title: string }>;
    };
    expect(payload.found).toBe(false);
    expect(payload.suggestions.length).toBeGreaterThan(0);
    expect(payload.suggestions.length).toBeLessThanOrEqual(5);
    for (const s of payload.suggestions) {
      expect(s.code.startsWith("52.219")).toBe(true);
      expect(s.title).toBeTruthy();
    }
  });

  it("returns empty suggestions for a code far outside the catalog", async () => {
    const result = await handleRetrieveFarClause(
      { code: "99.999-99" },
      handlerContext(ctxFor(tenant))
    );
    const payload = JSON.parse(result.content[0]!.text) as {
      found: boolean;
      suggestions: unknown[];
    };
    expect(payload.found).toBe(false);
    expect(payload.suggestions).toEqual([]);
  });

  it("does not treat percent in a lookup code as a wildcard in suggestions", async () => {
    // Exercises suggestCodes below the zod boundary: unescaped, the
    // prefix query LIKE '52%219%' would surface every 52.219-x row.
    const result = await handleRetrieveFarClause(
      { code: "52%219" },
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
    await handleRetrieveFarClause({ code: "52.204-7" }, handlerContext(ctxFor(tenant)));
    const after = await prisma.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
    expect(after - before).toBe(1);

    const latest = await prisma.mcpAuditLog.findFirst({
      where: { tenantId: tenant.firmId },
      orderBy: { ts: "desc" },
    });
    expect(latest).not.toBeNull();
    expect(latest!.serverName).toBe("knowledge-mcp");
    expect(latest!.serverVersion).toBe("0.1.0");
    expect(latest!.toolName).toBe("retrieve_far_clause");
    expect(latest!.outcome).toBe("ok");
    expect(latest!.tokenFp).toBe(tenant.tokenFp);
    expect(latest!.tokenFp.length).toBe(16);
    expect(latest!.outputBytes).toBeGreaterThan(0);
    expect(latest!.durationMs).toBeGreaterThanOrEqual(0);
  });
});
