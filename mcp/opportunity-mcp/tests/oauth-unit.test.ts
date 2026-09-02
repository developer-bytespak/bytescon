/**
 * Unit tests for the embedded OAuth primitives (no database required).
 * Covers JWT sign/verify, PKCE S256, stateless DCR client_id, single-use
 * code ledger, config gating, URL resolution, and discovery metadata shape.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  signJwt,
  verifyJwt,
  nowSec,
  base64urlEncode,
  computeS256Challenge,
  verifyPkceS256,
  encodeClientId,
  decodeClientId,
  isAllowedRedirectUri,
  validateRedirectUris,
  clientFingerprint,
  consumeCode,
  consumeRefresh,
  _resetUsedCodes,
  _resetUsedRefresh,
  loadOAuthConfig,
  makeOAuthConfig,
  resolveUrls,
  protectedResourceMetadata,
  authorizationServerMetadata,
} from "@bytescon/mcp-shared";

const KEY = crypto.createHash("sha256").update("unit-test-signing-secret-unit-test").digest();

describe("oauth/jwt", () => {
  it("round-trips a signed token", () => {
    const t = signJwt({ sub: "abc", iat: nowSec(), exp: nowSec() + 60 }, KEY, { typ: "at+jwt" });
    const claims = verifyJwt(t, KEY, { typ: "at+jwt" });
    expect(claims?.sub).toBe("abc");
  });

  it("rejects a tampered signature", () => {
    const t = signJwt({ sub: "abc" }, KEY, { typ: "at+jwt" });
    const parts = t.split(".");
    const forged = `${parts[0]}.${parts[1]}.${base64urlEncode("not-the-signature")}`;
    expect(verifyJwt(forged, KEY, { typ: "at+jwt" })).toBeNull();
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const t = signJwt({ sub: "abc" }, KEY, { typ: "at+jwt" });
    const parts = t.split(".");
    const evilPayload = base64urlEncode(JSON.stringify({ sub: "admin" }));
    expect(verifyJwt(`${parts[0]}.${evilPayload}.${parts[2]}`, KEY, { typ: "at+jwt" })).toBeNull();
  });

  it("rejects a wrong key", () => {
    const t = signJwt({ sub: "abc" }, KEY, { typ: "at+jwt" });
    const otherKey = crypto.createHash("sha256").update("a-different-secret-a-different-x").digest();
    expect(verifyJwt(t, otherKey, { typ: "at+jwt" })).toBeNull();
  });

  it("enforces typ, exp, aud, iss", () => {
    const base = { sub: "x", iat: nowSec() };
    const expired = signJwt({ ...base, exp: nowSec() - 1 }, KEY, { typ: "at+jwt" });
    expect(verifyJwt(expired, KEY, { typ: "at+jwt" })).toBeNull();

    const wrongTyp = signJwt({ ...base, exp: nowSec() + 60 }, KEY, { typ: "rt+jwt" });
    expect(verifyJwt(wrongTyp, KEY, { typ: "at+jwt" })).toBeNull();

    const aud = signJwt({ ...base, aud: "https://a/mcp", exp: nowSec() + 60 }, KEY, { typ: "at+jwt" });
    expect(verifyJwt(aud, KEY, { typ: "at+jwt", aud: "https://a/mcp" })?.sub).toBe("x");
    expect(verifyJwt(aud, KEY, { typ: "at+jwt", aud: "https://b/mcp" })).toBeNull();

    const iss = signJwt({ ...base, iss: "https://a", exp: nowSec() + 60 }, KEY, { typ: "at+jwt" });
    expect(verifyJwt(iss, KEY, { typ: "at+jwt", iss: "https://b" })).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyJwt("not-a-jwt", KEY)).toBeNull();
    expect(verifyJwt("a.b", KEY)).toBeNull();
    expect(verifyJwt("", KEY)).toBeNull();
  });

  it("rejects an alg:none forgery", () => {
    const header = base64urlEncode(JSON.stringify({ alg: "none", typ: "at+jwt" }));
    const payload = base64urlEncode(JSON.stringify({ sub: "admin", exp: nowSec() + 60 }));
    expect(verifyJwt(`${header}.${payload}.`, KEY, { typ: "at+jwt" })).toBeNull();
  });
});

describe("oauth/pkce", () => {
  it("matches the RFC 7636 Appendix B test vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(computeS256Challenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("verifies a matching verifier/challenge and rejects a mismatch", () => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = computeS256Challenge(verifier);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256(verifier, computeS256Challenge("different-but-valid-length-verifier-aaaa"))).toBe(false);
  });

  it("rejects out-of-bounds or malformed verifiers", () => {
    const challenge = computeS256Challenge("x".repeat(50));
    expect(verifyPkceS256("short", challenge)).toBe(false);
    expect(verifyPkceS256("x".repeat(200), challenge)).toBe(false);
    expect(verifyPkceS256("contains spaces and !!!", challenge)).toBe(false);
  });
});

describe("oauth/clients", () => {
  it("round-trips a stateless client_id", () => {
    const id = encodeClientId({ redirectUris: ["https://claude.ai/cb"], clientName: "Claude" }, KEY);
    const client = decodeClientId(id, KEY);
    expect(client?.redirectUris).toEqual(["https://claude.ai/cb"]);
    expect(client?.clientName).toBe("Claude");
  });

  it("rejects a tampered or wrong-key client_id", () => {
    const id = encodeClientId({ redirectUris: ["https://claude.ai/cb"], clientName: "Claude" }, KEY);
    expect(decodeClientId(id + "x", KEY)).toBeNull();
    const other = crypto.createHash("sha256").update("another-secret-another-secret-32x").digest();
    expect(decodeClientId(id, other)).toBeNull();
  });

  it("enforces the redirect_uri policy (permissive: any https, loopback http only)", () => {
    const permissive: string[] = [];
    expect(isAllowedRedirectUri("https://claude.ai/cb", permissive)).toBe(true);
    expect(isAllowedRedirectUri("https://anything.example/cb", permissive)).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:9000/cb", permissive)).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1/cb", permissive)).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example/cb", permissive)).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)", permissive)).toBe(false);
    expect(isAllowedRedirectUri("not a url", permissive)).toBe(false);
  });

  it("enforces an https host allowlist (exact + subdomain, no suffix spoof)", () => {
    const allow = ["claude.ai", "anthropic.com"];
    expect(isAllowedRedirectUri("https://claude.ai/cb", allow)).toBe(true);
    expect(isAllowedRedirectUri("https://foo.claude.ai/cb", allow)).toBe(true);
    expect(isAllowedRedirectUri("https://anthropic.com/cb", allow)).toBe(true);
    expect(isAllowedRedirectUri("https://evil.example/cb", allow)).toBe(false);
    // "claude.ai.evil.com" must NOT satisfy the "claude.ai" entry.
    expect(isAllowedRedirectUri("https://claude.ai.evil.com/cb", allow)).toBe(false);
    // loopback http is always allowed regardless of allowlist.
    expect(isAllowedRedirectUri("http://127.0.0.1/cb", allow)).toBe(true);
    // wildcard re-opens to any https host.
    expect(isAllowedRedirectUri("https://evil.example/cb", ["*"])).toBe(true);
  });

  it("validates registration redirect_uris arrays against the allowlist", () => {
    expect(validateRedirectUris(["https://a/cb"], []).ok).toBe(true);
    expect(validateRedirectUris([], []).ok).toBe(false);
    expect(validateRedirectUris("https://a/cb", []).ok).toBe(false);
    expect(validateRedirectUris(["https://a/cb", "http://evil/cb"], []).ok).toBe(false);
    expect(validateRedirectUris(["https://claude.ai/cb"], ["claude.ai"]).ok).toBe(true);
    expect(validateRedirectUris(["https://evil.example/cb"], ["claude.ai"]).ok).toBe(false);
  });

  it("fingerprints deterministically", () => {
    expect(clientFingerprint("abc")).toBe(clientFingerprint("abc"));
    expect(clientFingerprint("abc")).not.toBe(clientFingerprint("abd"));
    expect(clientFingerprint("abc")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("oauth/codes", () => {
  beforeEach(() => {
    _resetUsedCodes();
    _resetUsedRefresh();
  });

  it("permits first use and rejects replay", () => {
    const now = nowSec();
    expect(consumeCode("jti-1", now + 60, now)).toBe(true);
    expect(consumeCode("jti-1", now + 60, now)).toBe(false);
  });

  it("evicts expired jtis so memory does not grow unbounded", () => {
    const now = nowSec();
    expect(consumeCode("old", now + 10, now)).toBe(true);
    // Advance past expiry: a later consume triggers eviction; reusing the id is
    // allowed again only because the code itself would have expired by then.
    expect(consumeCode("new", now + 60, now + 20)).toBe(true);
    expect(consumeCode("old", now + 60, now + 20)).toBe(true);
  });

  it("rotates refresh tokens: first use succeeds, replay is rejected", () => {
    const now = nowSec();
    expect(consumeRefresh("rt-1", now + 2592000, now)).toBe(true);
    expect(consumeRefresh("rt-1", now + 2592000, now)).toBe(false);
  });

  it("tracks refresh and code ledgers independently", () => {
    const now = nowSec();
    // Same jti string in both ledgers must not collide.
    expect(consumeCode("shared", now + 60, now)).toBe(true);
    expect(consumeRefresh("shared", now + 2592000, now)).toBe(true);
    expect(consumeCode("shared", now + 60, now)).toBe(false);
    expect(consumeRefresh("shared", now + 2592000, now)).toBe(false);
  });
});

describe("oauth/config + metadata", () => {
  it("is disabled without a sufficiently long signing key", () => {
    expect(loadOAuthConfig({}).enabled).toBe(false);
    expect(loadOAuthConfig({ MCP_OAUTH_SIGNING_KEY: "short" }).enabled).toBe(false);
    expect(loadOAuthConfig({ MCP_OAUTH_SIGNING_KEY: "x".repeat(32) }).enabled).toBe(true);
  });

  it("parses the redirect allowlist (trim, lowercase, drop empties)", () => {
    expect(loadOAuthConfig({}).redirectAllowlist).toEqual([]);
    expect(
      loadOAuthConfig({ MCP_OAUTH_REDIRECT_ALLOWLIST: " Claude.ai , ,CLAUDE.com " }).redirectAllowlist
    ).toEqual(["claude.ai", "claude.com"]);
    expect(loadOAuthConfig({ MCP_OAUTH_REDIRECT_ALLOWLIST: "*" }).redirectAllowlist).toEqual(["*"]);
  });

  it("fails closed in production when OAuth is enabled but base URL is unset", () => {
    expect(() =>
      loadOAuthConfig({ MCP_OAUTH_SIGNING_KEY: "x".repeat(40), NODE_ENV: "production" })
    ).toThrow(/MCP_PUBLIC_BASE_URL must be set/);
    // With a base URL present it loads fine.
    expect(
      loadOAuthConfig({
        MCP_OAUTH_SIGNING_KEY: "x".repeat(40),
        NODE_ENV: "production",
        MCP_PUBLIC_BASE_URL: "https://bytescon.com",
      }).enabled
    ).toBe(true);
    // Non-production derives from the request, so an empty base URL is allowed.
    expect(loadOAuthConfig({ MCP_OAUTH_SIGNING_KEY: "x".repeat(40) }).enabled).toBe(true);
  });

  it("resolves canonical URLs from configured baseUrl", () => {
    const cfg = makeOAuthConfig({ secret: "x".repeat(40), baseUrl: "https://bytescon.com/" });
    const urls = resolveUrls(cfg, {} as never);
    expect(urls.resource).toBe("https://bytescon.com/mcp");
    expect(urls.prmUrl).toBe("https://bytescon.com/.well-known/oauth-protected-resource/mcp");
    expect(urls.authorizeEndpoint).toBe("https://bytescon.com/mcp/oauth/authorize");
  });

  it("derives URLs from the request when baseUrl is unset", () => {
    const cfg = makeOAuthConfig({ secret: "x".repeat(40) });
    const fakeReq = {
      headers: { "x-forwarded-proto": "https" },
      protocol: "http",
      get: (h: string) => (h === "host" ? "example.test" : undefined),
    };
    const urls = resolveUrls(cfg, fakeReq as never);
    expect(urls.resource).toBe("https://example.test/mcp");
  });

  it("emits spec-shaped discovery documents", () => {
    const cfg = makeOAuthConfig({ secret: "x".repeat(40), baseUrl: "https://bytescon.com" });
    const urls = resolveUrls(cfg, {} as never);
    const prm = protectedResourceMetadata(urls, "Bytescon opportunity intelligence (MCP)");
    expect(prm["resource"]).toBe("https://bytescon.com/mcp");
    expect(prm["authorization_servers"]).toEqual(["https://bytescon.com"]);

    const asm = authorizationServerMetadata(urls);
    expect(asm["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(asm["token_endpoint_auth_methods_supported"]).toEqual(["none"]);
    expect(asm["grant_types_supported"]).toEqual(["authorization_code", "refresh_token"]);
  });
});
