/**
 * Unit tests for the parameterized OAuth config + metadata surface.
 *
 * Focus is the two things the relocation parameterized:
 *   - resolveUrls(config, req, mountPath): a non-default mount path must
 *     produce the right resource / PRM / endpoint URLs (and audience), while
 *     the default '/mcp' stays byte-identical to opportunity-mcp's historical
 *     values.
 *   - protectedResourceMetadata(urls, resourceName): the resource_name is now
 *     a parameter, not a hardcoded string.
 *
 * No database required.
 */
import { describe, it, expect } from "vitest";
import { loadOAuthConfig, makeOAuthConfig, resolveUrls } from "../src/oauth/config.js";
import { protectedResourceMetadata, authorizationServerMetadata } from "../src/oauth/metadata.js";

describe("oauth/config gating", () => {
  it("is disabled without a sufficiently long signing key", () => {
    expect(loadOAuthConfig({}).enabled).toBe(false);
    expect(loadOAuthConfig({ MCP_OAUTH_SIGNING_KEY: "short" }).enabled).toBe(false);
    expect(loadOAuthConfig({ MCP_OAUTH_SIGNING_KEY: "x".repeat(32) }).enabled).toBe(true);
  });

  it("fails closed in production when OAuth is enabled but base URL is unset", () => {
    expect(() =>
      loadOAuthConfig({ MCP_OAUTH_SIGNING_KEY: "x".repeat(40), NODE_ENV: "production" })
    ).toThrow(/MCP_PUBLIC_BASE_URL must be set/);
    expect(
      loadOAuthConfig({
        MCP_OAUTH_SIGNING_KEY: "x".repeat(40),
        NODE_ENV: "production",
        MCP_PUBLIC_BASE_URL: "https://bytescon.com",
      }).enabled
    ).toBe(true);
  });
});

describe("oauth/config resolveUrls default '/mcp' mount (byte-identical)", () => {
  it("derives the historical opportunity-mcp URLs when mountPath is omitted", () => {
    const cfg = makeOAuthConfig({ secret: "x".repeat(40), baseUrl: "https://bytescon.com/" });
    const urls = resolveUrls(cfg, {} as never);
    expect(urls.resource).toBe("https://bytescon.com/mcp");
    expect(urls.prmUrl).toBe("https://bytescon.com/.well-known/oauth-protected-resource/mcp");
    expect(urls.asmUrl).toBe("https://bytescon.com/.well-known/oauth-authorization-server");
    expect(urls.authorizeEndpoint).toBe("https://bytescon.com/mcp/oauth/authorize");
    expect(urls.tokenEndpoint).toBe("https://bytescon.com/mcp/oauth/token");
    expect(urls.registrationEndpoint).toBe("https://bytescon.com/mcp/oauth/register");
  });

  it("explicit '/mcp' matches the omitted-default exactly", () => {
    const cfg = makeOAuthConfig({ secret: "x".repeat(40), baseUrl: "https://bytescon.com" });
    expect(resolveUrls(cfg, {} as never, "/mcp")).toEqual(resolveUrls(cfg, {} as never));
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
});

describe("oauth/config resolveUrls with a non-'/mcp' mount", () => {
  it("derives resource / PRM / endpoints / audience from '/knowledge/mcp'", () => {
    const cfg = makeOAuthConfig({ secret: "x".repeat(40), baseUrl: "https://bytescon.com" });
    const urls = resolveUrls(cfg, {} as never, "/knowledge/mcp");
    // The access-token audience is the resource URL.
    expect(urls.resource).toBe("https://bytescon.com/knowledge/mcp");
    expect(urls.prmUrl).toBe(
      "https://bytescon.com/.well-known/oauth-protected-resource/knowledge/mcp"
    );
    // AS metadata path stays unsuffixed (its issuer is the base origin).
    expect(urls.asmUrl).toBe("https://bytescon.com/.well-known/oauth-authorization-server");
    expect(urls.issuer).toBe("https://bytescon.com");
    expect(urls.authorizeEndpoint).toBe("https://bytescon.com/knowledge/mcp/oauth/authorize");
    expect(urls.tokenEndpoint).toBe("https://bytescon.com/knowledge/mcp/oauth/token");
    expect(urls.registrationEndpoint).toBe("https://bytescon.com/knowledge/mcp/oauth/register");
  });

  it("normalizes a mount path missing its leading slash or carrying a trailing slash", () => {
    const cfg = makeOAuthConfig({ secret: "x".repeat(40), baseUrl: "https://bytescon.com" });
    expect(resolveUrls(cfg, {} as never, "carrier/mcp").resource).toBe(
      "https://bytescon.com/carrier/mcp"
    );
    expect(resolveUrls(cfg, {} as never, "/carrier/mcp/").resource).toBe(
      "https://bytescon.com/carrier/mcp"
    );
  });
});

describe("oauth/metadata reflects the passed resourceName", () => {
  it("advertises the supplied resource_name and resource URL", () => {
    const cfg = makeOAuthConfig({ secret: "x".repeat(40), baseUrl: "https://bytescon.com" });
    const urls = resolveUrls(cfg, {} as never, "/knowledge/mcp");
    const prm = protectedResourceMetadata(urls, "Bytescon knowledge base (MCP)");
    expect(prm["resource"]).toBe("https://bytescon.com/knowledge/mcp");
    expect(prm["authorization_servers"]).toEqual(["https://bytescon.com"]);
    expect(prm["resource_name"]).toBe("Bytescon knowledge base (MCP)");
  });

  it("keeps opportunity-mcp's resource_name byte-identical on the default mount", () => {
    const cfg = makeOAuthConfig({ secret: "x".repeat(40), baseUrl: "https://bytescon.com" });
    const urls = resolveUrls(cfg, {} as never);
    const prm = protectedResourceMetadata(urls, "Bytescon opportunity intelligence (MCP)");
    expect(prm["resource"]).toBe("https://bytescon.com/mcp");
    expect(prm["resource_name"]).toBe("Bytescon opportunity intelligence (MCP)");
  });

  it("emits spec-shaped authorization-server metadata", () => {
    const cfg = makeOAuthConfig({ secret: "x".repeat(40), baseUrl: "https://bytescon.com" });
    const urls = resolveUrls(cfg, {} as never);
    const asm = authorizationServerMetadata(urls);
    expect(asm["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(asm["token_endpoint_auth_methods_supported"]).toEqual(["none"]);
    expect(asm["grant_types_supported"]).toEqual(["authorization_code", "refresh_token"]);
  });
});
