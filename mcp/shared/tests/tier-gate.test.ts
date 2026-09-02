import { describe, expect, it } from "vitest";
import { meetsTier, requireTier, type ApiTokenTier, type ResolvedTokenContext } from "../src/lib/auth.js";
import { isMcpToolError, McpAuthError } from "../src/lib/errors.js";
import { TEST_PREFIX } from "./helpers/mock-prisma.js";

function ctxWithTier(tier: ApiTokenTier): ResolvedTokenContext {
  return {
    tokenId: `${TEST_PREFIX}token-id`,
    tokenFp: "0123456789abcdef",
    consultingFirmId: `${TEST_PREFIX}firm-id`,
    tier,
  };
}

describe("meetsTier() (unit)", () => {
  const cases: Array<[ApiTokenTier, ApiTokenTier, boolean]> = [
    ["CORE", "CORE", true],
    ["CORE", "PRO", false],
    ["CORE", "VAULT", false],
    ["PRO", "CORE", true],
    ["PRO", "PRO", true],
    ["PRO", "VAULT", false],
    ["VAULT", "CORE", true],
    ["VAULT", "PRO", true],
    ["VAULT", "VAULT", true],
  ];

  for (const [actual, required, expected] of cases) {
    it(`${actual} meets ${required}: ${expected}`, () => {
      expect(meetsTier(actual, required)).toBe(expected);
    });
  }
});

describe("requireTier() (unit)", () => {
  it("passes silently when tier is sufficient", () => {
    expect(() => requireTier(ctxWithTier("VAULT"), "PRO")).not.toThrow();
    expect(() => requireTier(ctxWithTier("PRO"), "PRO")).not.toThrow();
    expect(() => requireTier(ctxWithTier("CORE"), "CORE")).not.toThrow();
  });

  it("throws McpAuthError with AUTH_ERROR code when tier is insufficient", () => {
    try {
      requireTier(ctxWithTier("CORE"), "PRO");
      expect.unreachable("requireTier should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(McpAuthError);
      expect(isMcpToolError(err)).toBe(true);
      if (isMcpToolError(err)) {
        expect(err.code).toBe("AUTH_ERROR");
        expect(err.message).toContain("PRO");
        expect(err.message).toContain("CORE");
        expect(err.details).toEqual({ required_tier: "PRO", actual_tier: "CORE" });
      }
    }
  });

  it("error message contains no em or en dashes", () => {
    try {
      requireTier(ctxWithTier("CORE"), "VAULT");
      expect.unreachable("requireTier should have thrown");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toMatch(/[–—]/);
    }
  });
});
