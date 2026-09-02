import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashToken, resolveBearerToken, resolveTokenById, tokenFingerprint } from "../src/lib/auth.js";
import { makeMockPrisma, makeTokenRow, TEST_PREFIX } from "./helpers/mock-prisma.js";

const RAW_TOKEN = `${TEST_PREFIX}raw-token-${"a".repeat(32)}`;

describe("hashToken() / tokenFingerprint() (unit)", () => {
  it("produces the sha256 hex of the raw token", () => {
    const expected = crypto.createHash("sha256").update(RAW_TOKEN, "utf8").digest("hex");
    expect(hashToken(RAW_TOKEN)).toBe(expected);
    expect(hashToken(RAW_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic and input-sensitive", () => {
    expect(hashToken(RAW_TOKEN)).toBe(hashToken(RAW_TOKEN));
    expect(hashToken(RAW_TOKEN)).not.toBe(hashToken(RAW_TOKEN + "x"));
  });

  it("fingerprint is the first 16 chars of the hash", () => {
    expect(tokenFingerprint(RAW_TOKEN)).toBe(hashToken(RAW_TOKEN).slice(0, 16));
    expect(tokenFingerprint(RAW_TOKEN).length).toBe(16);
  });
});

describe("resolveBearerToken() with injected mock prisma (unit)", () => {
  it("returns null for empty token without querying the DB", async () => {
    const prisma = makeMockPrisma();
    expect(await resolveBearerToken(prisma, "")).toBeNull();
    expect(prisma.apiToken.findUnique).not.toHaveBeenCalled();
  });

  it("returns null for tokens shorter than 16 chars without querying", async () => {
    const prisma = makeMockPrisma();
    expect(await resolveBearerToken(prisma, "short-token")).toBeNull();
    expect(prisma.apiToken.findUnique).not.toHaveBeenCalled();
  });

  it("returns null when no api_tokens row matches the hash", async () => {
    const prisma = makeMockPrisma(null);
    expect(await resolveBearerToken(prisma, RAW_TOKEN)).toBeNull();
    expect(prisma.apiToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(RAW_TOKEN) },
    });
  });

  // §8.4 — the public REST API now shares api_tokens. A verifying bearer is no
  // longer proof the credential was issued for MCP.
  it("returns null for a PUBLIC_API token, even though the hash matches", async () => {
    const prisma = makeMockPrisma(makeTokenRow({ kind: "PUBLIC_API" }));
    expect(await resolveBearerToken(prisma, RAW_TOKEN)).toBeNull();
  });

  it("accepts a row with no kind at all — every pre-8.4 token is an MCP token", async () => {
    const row = makeTokenRow();
    delete (row as { kind?: unknown }).kind;
    const ctx = await resolveBearerToken(makeMockPrisma(row), RAW_TOKEN);
    expect(ctx).not.toBeNull();
  });

  it("accepts an explicit MCP token", async () => {
    const ctx = await resolveBearerToken(makeMockPrisma(makeTokenRow({ kind: "MCP" })), RAW_TOKEN);
    expect(ctx).not.toBeNull();
  });

  it("returns null for a revoked token", async () => {
    const prisma = makeMockPrisma(makeTokenRow({ revokedAt: new Date("2026-01-01T00:00:00Z") }));
    expect(await resolveBearerToken(prisma, RAW_TOKEN)).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const prisma = makeMockPrisma(makeTokenRow({ expiresAt: new Date(Date.now() - 60_000) }));
    expect(await resolveBearerToken(prisma, RAW_TOKEN)).toBeNull();
  });

  it("accepts a token with a future expiry", async () => {
    const prisma = makeMockPrisma(makeTokenRow({ expiresAt: new Date(Date.now() + 86_400_000) }));
    const ctx = await resolveBearerToken(prisma, RAW_TOKEN);
    expect(ctx).not.toBeNull();
  });

  it("resolves a valid token to the full context", async () => {
    const row = makeTokenRow({ tier: "VAULT" });
    const prisma = makeMockPrisma(row);
    const ctx = await resolveBearerToken(prisma, RAW_TOKEN);
    expect(ctx).toEqual({
      tokenId: row.id,
      tokenFp: hashToken(RAW_TOKEN).slice(0, 16),
      consultingFirmId: row.consultingFirmId,
      tier: "VAULT",
    });
  });

  it("fires a best-effort lastUsedAt update on success", async () => {
    const row = makeTokenRow();
    const prisma = makeMockPrisma(row);
    await resolveBearerToken(prisma, RAW_TOKEN);
    expect(prisma.apiToken.update).toHaveBeenCalledTimes(1);
    const arg = prisma.apiToken.update.mock.calls[0]![0] as {
      where: { id: string };
      data: { lastUsedAt: Date };
    };
    expect(arg.where.id).toBe(row.id);
    expect(arg.data.lastUsedAt).toBeInstanceOf(Date);
  });

  it("still resolves when the lastUsedAt update rejects", async () => {
    const prisma = makeMockPrisma(makeTokenRow());
    prisma.apiToken.update.mockRejectedValue(new Error("db write blocked"));
    const ctx = await resolveBearerToken(prisma, RAW_TOKEN);
    expect(ctx).not.toBeNull();
    // Drain the microtask queue so the swallowed rejection settles in-test.
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe("resolveTokenById() with injected mock prisma (unit)", () => {
  const TOKEN_ID = `${TEST_PREFIX}token-id`;

  it("returns null for an empty id without querying the DB", async () => {
    const prisma = makeMockPrisma();
    expect(await resolveTokenById(prisma, "")).toBeNull();
    expect(prisma.apiToken.findUnique).not.toHaveBeenCalled();
  });

  it("looks the row up by id, not by token hash", async () => {
    const prisma = makeMockPrisma(makeTokenRow());
    await resolveTokenById(prisma, TOKEN_ID);
    expect(prisma.apiToken.findUnique).toHaveBeenCalledWith({ where: { id: TOKEN_ID } });
  });

  it("returns null for a revoked or expired underlying token", async () => {
    const revoked = makeMockPrisma(makeTokenRow({ revokedAt: new Date("2026-01-01T00:00:00Z") }));
    expect(await resolveTokenById(revoked, TOKEN_ID)).toBeNull();
    const expired = makeMockPrisma(makeTokenRow({ expiresAt: new Date(Date.now() - 60_000) }));
    expect(await resolveTokenById(expired, TOKEN_ID)).toBeNull();
  });

  it("derives the fingerprint from the stored hash so audit rows match the raw path", async () => {
    const row = makeTokenRow({ tokenHash: "f".repeat(64), tier: "PRO" });
    const prisma = makeMockPrisma(row);
    const ctx = await resolveTokenById(prisma, TOKEN_ID);
    expect(ctx).toEqual({
      tokenId: row.id,
      tokenFp: "f".repeat(16),
      consultingFirmId: row.consultingFirmId,
      tier: "PRO",
    });
  });
});
