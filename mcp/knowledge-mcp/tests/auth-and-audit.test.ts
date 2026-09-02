/**
 * Auth requirement tests for knowledge-mcp.
 *
 * The clause catalog and agency profiles are GLOBAL tables, but DESIGN.md
 * workstream 2 requires that global reads still demand a valid token:
 *   1. boot-level: resolveBearerToken rejects unknown, revoked, and
 *      expired tokens (bootstrapStdioServer then exits non-zero), and
 *   2. call-level: handlers refuse malformed token contexts with a
 *      structured auth error and outcome "auth_error" in mcp_audit_log.
 */
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  McpAuthError,
  hashToken,
  resolveBearerToken,
  type ResolvedTokenContext,
} from "@bytescon/mcp-shared";
import { guardAuth } from "../src/lib/guard.js";
import { handleRetrieveFarClause } from "../src/tools/retrieve-far-clause.js";
import { handleSearchClauses } from "../src/tools/search-clauses.js";
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

describe("guardAuth (unit)", () => {
  const valid: ResolvedTokenContext = {
    tokenId: "token-id",
    tokenFp: "a".repeat(16),
    consultingFirmId: "firm-id",
    tier: "CORE",
  };

  it("accepts a well-formed CORE context", () => {
    expect(() => guardAuth(valid)).not.toThrow();
  });

  it("accepts PRO and VAULT tiers (at or above CORE)", () => {
    expect(() => guardAuth({ ...valid, tier: "PRO" })).not.toThrow();
    expect(() => guardAuth({ ...valid, tier: "VAULT" })).not.toThrow();
  });

  it("rejects a missing context", () => {
    expect(() => guardAuth(null)).toThrow(McpAuthError);
    expect(() => guardAuth(undefined)).toThrow(McpAuthError);
  });

  it("rejects missing tokenId, missing tenant id, and malformed fingerprint", () => {
    expect(() => guardAuth({ ...valid, tokenId: "" })).toThrow(McpAuthError);
    expect(() => guardAuth({ ...valid, consultingFirmId: "" })).toThrow(McpAuthError);
    expect(() => guardAuth({ ...valid, tokenFp: "short" })).toThrow(McpAuthError);
  });

  it("rejects an unknown tier", () => {
    expect(() =>
      guardAuth({ ...valid, tier: "PLATINUM" as ResolvedTokenContext["tier"] })
    ).toThrow(McpAuthError);
  });
});

describe.skipIf(shouldSkipIntegrationTests())("token resolution (integration)", () => {
  let tenant: SeededTenant;
  let revoked: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant("auth-valid");
    revoked = await seedTenant("auth-revoked");
    await prisma.apiToken.update({
      where: { id: revoked.tokenId },
      data: { revokedAt: new Date() } as never,
    });
  });

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant);
    if (revoked) await cleanupTenant(revoked);
  });

  it("resolves a valid token to its tenant and tier", async () => {
    const ctx = await resolveBearerToken(prisma, tenant.rawToken);
    expect(ctx).not.toBeNull();
    expect(ctx!.consultingFirmId).toBe(tenant.firmId);
    expect(ctx!.tier).toBe("CORE");
    expect(ctx!.tokenFp).toBe(tenant.tokenFp);
  });

  it("rejects an unknown token (boot would exit non-zero)", async () => {
    const ctx = await resolveBearerToken(prisma, `${TEST_PREFIX}bogus-${crypto.randomUUID()}`);
    expect(ctx).toBeNull();
  });

  it("rejects a revoked token", async () => {
    const ctx = await resolveBearerToken(prisma, revoked.rawToken);
    expect(ctx).toBeNull();
  });

  it("rejects a too-short token", async () => {
    const ctx = await resolveBearerToken(prisma, "short");
    expect(ctx).toBeNull();
  });
});

describe.skipIf(shouldSkipIntegrationTests())(
  "global reads require a valid token context (integration)",
  () => {
    let tenant: SeededTenant;

    beforeAll(async () => {
      tenant = await seedTenant("auth-handler");
    });

    afterAll(async () => {
      if (tenant) await cleanupTenant(tenant);
    });

    it("refuses retrieve_far_clause with a malformed context and audits auth_error", async () => {
      const badCtx: ResolvedTokenContext = { ...ctxFor(tenant), tokenId: "" };
      const before = await prisma.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });

      const result = await handleRetrieveFarClause({ code: "52.219-14" }, handlerContext(badCtx));

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/valid Bytescon_MCP_TOKEN is required/);

      const after = await prisma.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
      expect(after - before).toBe(1);
      const latest = await prisma.mcpAuditLog.findFirst({
        where: { tenantId: tenant.firmId },
        orderBy: { ts: "desc" },
      });
      expect(latest!.outcome).toBe("auth_error");
      expect(latest!.toolName).toBe("retrieve_far_clause");
      expect(latest!.outputBytes).toBe(0);
    });

    it("refuses search_clauses with a malformed fingerprint", async () => {
      const badCtx: ResolvedTokenContext = { ...ctxFor(tenant), tokenFp: "short" };
      const result = await handleSearchClauses(
        { keyword: "subcontracting", limit: 5 },
        handlerContext(badCtx)
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/valid Bytescon_MCP_TOKEN is required/);
    });

    it("audit rows never contain the raw token", async () => {
      await handleRetrieveFarClause({ code: "52.204-7" }, handlerContext(ctxFor(tenant)));
      const latest = await prisma.mcpAuditLog.findFirst({
        where: { tenantId: tenant.firmId },
        orderBy: { ts: "desc" },
      });
      expect(latest!.tokenFp.length).toBe(16);
      expect(tenant.rawToken).not.toContain(latest!.tokenFp);
    });
  }
);
