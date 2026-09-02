/**
 * Multiplexed gateway integration tests.
 *
 * Boots the real createGatewayApp on an ephemeral port with all 5 resources and
 * proves the security-critical multiplex properties:
 *
 *   1. Cross-resource audience isolation (BLOCKER): an OAuth at+jwt minted with
 *      aud = https://host/knowledge/mcp is ACCEPTED at /knowledge/mcp but
 *      REJECTED (401) at /mcp and /core/mcp.
 *   2. Each resource exposes its own RFC 9728 PRM at
 *      /.well-known/oauth-protected-resource<mountPath> with the correct
 *      resource URL + resource_name.
 *   3. A raw api_token can tools/list over HTTP for >= 2 resources and gets that
 *      server's tools (knowledge -> 4; bytescon-core enforces PRO tier).
 *   4. OAuth is inert when no signing key is configured.
 *
 * Skips cleanly when DATABASE_URL is unset.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGatewayApp,
  makeOAuthConfig,
  signJwt,
  verifyJwt,
  nowSec,
  computeS256Challenge,
  loadOAuthConfig,
  createStderrLogger,
  type ResourceSpec,
  type OAuthConfig,
  type PrismaLikeClient,
} from "@bytescon/mcp-shared";
import { resource as opportunityResource } from "@bytescon/opportunity-mcp/resource";
import { resource as knowledgeResource } from "@bytescon/knowledge-mcp/resource";
import { resource as proposalResource } from "@bytescon/proposal-mcp/resource";
import { resource as bytesconCoreResource } from "@bytescon/bytescon-core-mcp/resource";
import {
  prisma,
  seedTenant,
  cleanupTenant,
  shouldSkipIntegrationTests,
  type SeededTenant,
} from "./fixtures.js";
import { rawRequest, parseMcpBody, JSON_MCP_HEADERS } from "./helpers/http.js";

const SIGNING_SECRET = "gateway-test-signing-secret-key-0123456789abcd";
const logger = createStderrLogger("mcp-gateway-test");

/** Metadata of the aggregate single-connector resource (mirrors server-http.ts). */
const AGGREGATE_NAME = "bytescon-all";
const AGGREGATE_MOUNT = "/all/mcp";
const AGGREGATE_RESOURCE_NAME = "Bytescon — all tools (MCP)";
/** Total tool count across all 5 servers: 11 + 4 + 5 + 3 + 4 = 27. */
const AGGREGATE_TOOL_COUNT = 27;

/**
 * Build the 5 per-server ResourceSpecs the gateway mounts (same wiring as
 * server-http.ts), plus the aggregate `/all/mcp` resource that concatenates all
 * 5 servers' tool arrays (no minTier — CORE may connect; bytescon-core PRO tools
 * self-gate per call). Tool arrays are built once and reused for the aggregate.
 */
function buildResources(): ResourceSpec[] {
  const specs = [
    opportunityResource,
    knowledgeResource,
    proposalResource,
    bytesconCoreResource,
  ];
  const perServer: ResourceSpec[] = specs.map((mod) => ({
    name: mod.name,
    version: mod.version,
    resourceName: mod.resourceName,
    mountPath: mod.mountPath,
    tools: mod.makeTools(prisma as PrismaLikeClient, logger),
    ...(mod.minTier ? { minTier: mod.minTier } : {}),
  }));

  const aggregate: ResourceSpec = {
    name: AGGREGATE_NAME,
    version: "0.0.0-test",
    resourceName: AGGREGATE_RESOURCE_NAME,
    mountPath: AGGREGATE_MOUNT,
    tools: perServer.flatMap((s) => s.tools),
    // minTier intentionally omitted (undefined).
  };

  return [...perServer, aggregate];
}

/** Mint an at+jwt access token bound to a specific resource (audience). */
function mintAccessToken(config: OAuthConfig, sub: string, aud: string, tier: string): string {
  const iat = nowSec();
  return signJwt(
    {
      iss: "https://test",
      aud,
      sub,
      fp: "ignored-recomputed",
      firm: "ignored-reresolved",
      tier,
      scope: "mcp",
      jti: `jti-${iat}-${Math.random()}`,
      iat,
      exp: iat + 3600,
    },
    config.signingKey,
    { typ: "at+jwt" }
  );
}

/** POST a JSON-RPC message to a mount path; returns the parsed MCP body. */
async function mcpRpc(
  port: number,
  mountPath: string,
  message: Record<string, unknown>,
  authToken: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body?: Record<string, unknown> }> {
  const res = await rawRequest(port, "POST", mountPath, {
    headers: { ...JSON_MCP_HEADERS, authorization: `Bearer ${authToken}` },
    body: JSON.stringify(message),
    softTimeoutMs: 4000,
  });
  let body: Record<string, unknown> | undefined;
  if (res.status === 200) {
    try {
      body = parseMcpBody(res.text);
    } catch {
      body = undefined;
    }
  }
  return { status: res.status, headers: res.headers, body };
}

const TOOLS_LIST_MSG = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

const skip = shouldSkipIntegrationTests();

describe.skipIf(skip)("multiplexed MCP gateway", () => {
  let server: http.Server;
  let port: number;
  let base: string;
  let oauthConfig: OAuthConfig;
  let coreTenant: SeededTenant;
  let proTenant: SeededTenant;

  beforeAll(async () => {
    coreTenant = await seedTenant("core", "CORE");
    proTenant = await seedTenant("pro", "PRO");

    // baseUrl derived from the request (dev/test): the resource URL is then
    // http://127.0.0.1:<port><mount>, which the audience checks compare against.
    oauthConfig = makeOAuthConfig({ secret: SIGNING_SECRET });
    const { app } = createGatewayApp({
      resources: buildResources(),
      oauthConfig,
      prisma: prisma as PrismaLikeClient,
      logger,
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("failed to bind ephemeral port");
    port = addr.port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (coreTenant) await cleanupTenant(coreTenant);
    if (proTenant) await cleanupTenant(proTenant);
  });

  // ── 1. Cross-resource audience isolation (BLOCKER) ──────────────────────
  describe("cross-resource audience isolation", () => {
    it("accepts a knowledge-audience token at /knowledge/mcp but rejects it at /mcp and /core/mcp", async () => {
      const knowledgeAud = `${base}/knowledge/mcp`;
      const token = mintAccessToken(oauthConfig, coreTenant.tokenId, knowledgeAud, "CORE");

      // Accepted at the matching resource.
      const ok = await mcpRpc(port, "/knowledge/mcp", TOOLS_LIST_MSG, token);
      expect(ok.status).toBe(200);
      expect(ok.headers["www-authenticate"]).toBeUndefined();

      // Rejected at a sibling resource (different audience) -> 401 invalid_token.
      const atOpportunity = await mcpRpc(port, "/mcp", TOOLS_LIST_MSG, token);
      expect(atOpportunity.status).toBe(401);
      expect(String(atOpportunity.headers["www-authenticate"])).toContain('error="invalid_token"');

      const atCore = await mcpRpc(port, "/core/mcp", TOOLS_LIST_MSG, token);
      expect(atCore.status).toBe(401);
      expect(String(atCore.headers["www-authenticate"])).toContain('error="invalid_token"');
    });

    it("accepts an opportunity-audience token at /mcp but rejects it at /knowledge/mcp", async () => {
      const opportunityAud = `${base}/mcp`;
      const token = mintAccessToken(oauthConfig, coreTenant.tokenId, opportunityAud, "CORE");

      const ok = await mcpRpc(port, "/mcp", TOOLS_LIST_MSG, token);
      expect(ok.status).toBe(200);

      const wrong = await mcpRpc(port, "/knowledge/mcp", TOOLS_LIST_MSG, token);
      expect(wrong.status).toBe(401);
      expect(String(wrong.headers["www-authenticate"])).toContain('error="invalid_token"');
    });
  });

  // ── 1b. Full OAuth flow binds the audience to the REQUESTED resource ─────
  // Regression guard for the bug the directly-minted-token tests above miss:
  // the AS used to hard-pin every issued aud to /mcp, so a real
  // register→authorize→token flow for /knowledge/mcp produced a token rejected
  // at /knowledge/mcp. This drives the actual flow and asserts the bound aud.
  describe("full OAuth flow → per-resource audience", () => {
    const REDIRECT = "http://127.0.0.1:9876/callback"; // loopback http is always allowed
    const VERIFIER = "rt-pkce-verifier-0123456789-0123456789-0123456789"; // 43-128 chars

    async function registerClient(): Promise<string> {
      const reg = await rawRequest(port, "POST", "/mcp/oauth/register", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "round-trip-test" }),
      });
      expect(reg.status).toBe(201);
      return (JSON.parse(reg.text) as { client_id: string }).client_id;
    }

    async function authorize(clientId: string, resource: string) {
      const body = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: computeS256Challenge(VERIFIER),
        code_challenge_method: "S256",
        scope: "mcp",
        resource,
        state: "st",
        api_token: coreTenant.rawToken,
      }).toString();
      return rawRequest(port, "POST", "/mcp/oauth/authorize", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    }

    it("a /knowledge/mcp token from the real flow has that aud, works there, and is rejected at /mcp", async () => {
      const clientId = await registerClient();
      const resource = `${base}/knowledge/mcp`;

      const auth = await authorize(clientId, resource);
      expect(auth.status).toBe(302);
      const code = new URL(String(auth.headers["location"])).searchParams.get("code");
      expect(code).toBeTruthy();

      const tokenRes = await rawRequest(port, "POST", "/mcp/oauth/token", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          redirect_uri: REDIRECT,
          code_verifier: VERIFIER,
          client_id: clientId,
          resource,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const accessToken = (JSON.parse(tokenRes.text) as { access_token: string }).access_token;

      // The minted audience must be the REQUESTED resource (the bug pinned it to /mcp).
      const claims = verifyJwt(accessToken, oauthConfig.signingKey, { typ: "at+jwt" });
      expect(claims?.["aud"]).toBe(resource);

      // ...and the real token is accepted at /knowledge/mcp but rejected at /mcp.
      const ok = await mcpRpc(port, "/knowledge/mcp", TOOLS_LIST_MSG, accessToken);
      expect(ok.status).toBe(200);
      const wrong = await mcpRpc(port, "/mcp", TOOLS_LIST_MSG, accessToken);
      expect(wrong.status).toBe(401);
    });

    it("rejects authorize for a resource the gateway does not serve (invalid_target)", async () => {
      const clientId = await registerClient();
      const auth = await authorize(clientId, `${base}/nope/mcp`);
      expect(auth.status).toBe(302);
      const loc = new URL(String(auth.headers["location"]));
      expect(loc.searchParams.get("error")).toBe("invalid_target");
    });
  });

  // ── 2. Per-resource PRM ──────────────────────────────────────────────────
  describe("per-resource protected-resource metadata", () => {
    const cases: Array<{ mount: string; resourceName: string }> = [
      { mount: "/mcp", resourceName: opportunityResource.resourceName },
      { mount: "/knowledge/mcp", resourceName: knowledgeResource.resourceName },
      { mount: "/proposal/mcp", resourceName: proposalResource.resourceName },
      { mount: "/core/mcp", resourceName: bytesconCoreResource.resourceName },
      { mount: AGGREGATE_MOUNT, resourceName: AGGREGATE_RESOURCE_NAME },
    ];

    for (const c of cases) {
      it(`serves PRM for ${c.mount} with the right resource + name`, async () => {
        const res = await rawRequest(port, "GET", `/.well-known/oauth-protected-resource${c.mount}`);
        expect(res.status).toBe(200);
        const meta = JSON.parse(res.text) as {
          resource: string;
          authorization_servers: string[];
          resource_name: string;
        };
        expect(meta.resource).toBe(`${base}${c.mount}`);
        expect(meta.authorization_servers).toEqual([base]);
        expect(meta.resource_name).toBe(c.resourceName);
      });
    }

    it("serves the single shared authorization-server metadata at the bare well-known path", async () => {
      const res = await rawRequest(port, "GET", "/.well-known/oauth-authorization-server");
      expect(res.status).toBe(200);
      const meta = JSON.parse(res.text) as Record<string, unknown>;
      expect(meta["issuer"]).toBe(base);
      expect(meta["token_endpoint"]).toBe(`${base}/mcp/oauth/token`);
      expect(meta["code_challenge_methods_supported"]).toEqual(["S256"]);
    });
  });

  // ── 3. tools/list over HTTP for multiple resources ──────────────────────
  describe("tools/list per resource", () => {
    function toolNames(body: Record<string, unknown> | undefined): string[] {
      const result = (body?.["result"] ?? {}) as { tools?: Array<{ name: string }> };
      return (result.tools ?? []).map((t) => t.name);
    }

    it("a raw CORE api_token lists knowledge-mcp's 4 tools at /knowledge/mcp", async () => {
      const res = await mcpRpc(port, "/knowledge/mcp", TOOLS_LIST_MSG, coreTenant.rawToken);
      expect(res.status).toBe(200);
      const names = toolNames(res.body);
      expect(names).toHaveLength(4);
      expect(names).toEqual(
        expect.arrayContaining([
          "retrieve_far_clause",
          "retrieve_dfars_clause",
          "retrieve_agency_pattern",
          "search_clauses",
        ])
      );
    });

    it("a raw CORE api_token lists opportunity-mcp's 14 tools at /mcp", async () => {
      const res = await mcpRpc(port, "/mcp", TOOLS_LIST_MSG, coreTenant.rawToken);
      expect(res.status).toBe(200);
      expect(toolNames(res.body)).toHaveLength(14);
    });

    it("bytescon-core enforces PRO: a CORE token is 403 at /core/mcp, a PRO token lists its 4 tools", async () => {
      const denied = await mcpRpc(port, "/core/mcp", TOOLS_LIST_MSG, coreTenant.rawToken);
      expect(denied.status).toBe(403);

      const allowed = await mcpRpc(port, "/core/mcp", TOOLS_LIST_MSG, proTenant.rawToken);
      expect(allowed.status).toBe(200);
      const names = toolNames(allowed.body);
      expect(names).toHaveLength(4);
      expect(names).toEqual(
        expect.arrayContaining([
          "list_deliverables",
          "get_billing_status",
          "get_usage_summary",
          "list_users",
        ])
      );
    });
  });

  // ── 3b. Aggregate single-connector /all/mcp (all 27 tools, no minTier) ───
  describe("aggregate single-connector at /all/mcp", () => {
    function toolNames(body: Record<string, unknown> | undefined): string[] {
      const result = (body?.["result"] ?? {}) as { tools?: Array<{ name: string }> };
      return (result.tools ?? []).map((t) => t.name);
    }
    function callResult(
      body: Record<string, unknown> | undefined
    ): { isError?: boolean; content?: Array<{ type: string; text: string }> } {
      return (body?.["result"] ?? {}) as {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
    }

    it("a PRO token lists ALL 27 tools, spanning every server", async () => {
      const res = await mcpRpc(port, AGGREGATE_MOUNT, TOOLS_LIST_MSG, proTenant.rawToken);
      expect(res.status).toBe(200);
      const names = toolNames(res.body);
      expect(names).toHaveLength(AGGREGATE_TOOL_COUNT);
      // No name collisions across the 5 servers: the unique set is the full count.
      expect(new Set(names).size).toBe(AGGREGATE_TOOL_COUNT);
      // Spot-check one tool from each of the 5 servers.
      expect(names).toEqual(
        expect.arrayContaining([
          "search_opportunities", // opportunity
          "retrieve_far_clause", // knowledge
          "get_compliance_matrix", // proposal
          "list_deliverables", // bytescon-core (PRO)
        ])
      );
    });

    it("a CORE token CAN connect and list at /all/mcp (no minTier gate)", async () => {
      const res = await mcpRpc(port, AGGREGATE_MOUNT, TOOLS_LIST_MSG, coreTenant.rawToken);
      expect(res.status).toBe(200);
      const names = toolNames(res.body);
      // The full catalog is listed; per-tool PRO gating happens at call time.
      expect(names).toHaveLength(AGGREGATE_TOOL_COUNT);
      expect(names).toEqual(
        expect.arrayContaining(["search_opportunities", "list_deliverables"])
      );
    });

    it("a CORE token is tier-denied per call for EVERY bytescon-core PRO tool", async () => {
      // /all/mcp has no resource-level minTier, so each PRO tool's own per-call
      // gate is the ONLY barrier. Verify ALL four bytescon-core tools deny a CORE
      // caller — not just one — so a future tool dropped off the gate can't
      // silently leak PRO tenant data through the aggregate.
      const PRO_TOOLS = ["list_deliverables", "get_billing_status", "get_usage_summary", "list_users"];

      // Guard: every PRO tool is actually exposed in the aggregate catalog, so a
      // newly added bytescon-core tool is forced through this denial check.
      const listed = toolNames(
        (await mcpRpc(port, AGGREGATE_MOUNT, TOOLS_LIST_MSG, coreTenant.rawToken)).body
      );
      for (const name of PRO_TOOLS) expect(listed, `${name} exposed at /all/mcp`).toContain(name);

      for (const name of PRO_TOOLS) {
        const res = await mcpRpc(
          port,
          AGGREGATE_MOUNT,
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } },
          coreTenant.rawToken
        );
        // Dispatch succeeds (200); the tool returns the tier rejection. All four
        // input shapes are all-optional, so {} passes SDK validation and the
        // call reaches the per-tool tier gate (not a validation error).
        expect(res.status, `${name} dispatch`).toBe(200);
        const result = callResult(res.body);
        expect(result.isError, `${name} tier-denied for CORE`).toBe(true);
        const text = result.content?.[0]?.text ?? "";
        expect(text).toContain("requires token tier PRO");
        expect(text).toContain("current tier is CORE");
      }
    });

    it("a CORE token CAN call a CORE-tier tool (e.g. opportunity search) at /all/mcp", async () => {
      const callMsg = {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_opportunities", arguments: { limit: 1 } },
      };
      const res = await mcpRpc(port, AGGREGATE_MOUNT, callMsg, coreTenant.rawToken);
      expect(res.status).toBe(200);
      // Not tier-denied: a CORE tool runs for a CORE caller (success or a
      // domain-level result, but NOT the PRO tier-rejection text).
      const result = callResult(res.body);
      const text = result.content?.[0]?.text ?? "";
      expect(text).not.toContain("requires token tier PRO");
    });
  });

  // ── 4. Unauthenticated request is challenged ────────────────────────────
  it("challenges an unauthenticated resource request with a resource-specific WWW-Authenticate", async () => {
    const res = await rawRequest(port, "POST", "/knowledge/mcp", {
      headers: JSON_MCP_HEADERS,
      body: JSON.stringify(TOOLS_LIST_MSG),
    });
    expect(res.status).toBe(401);
    expect(String(res.headers["www-authenticate"])).toContain(
      "oauth-protected-resource/knowledge/mcp"
    );
  });
});

// ── 5. OAuth inert when no signing key is configured ──────────────────────
describe.skipIf(skip)("gateway with OAuth disabled (no signing key)", () => {
  let server: http.Server;
  let port: number;
  let tenant: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant("nooauth", "CORE");
    // loadOAuthConfig with no MCP_OAUTH_SIGNING_KEY in env -> disabled.
    const disabled = loadOAuthConfig({ ...process.env, MCP_OAUTH_SIGNING_KEY: "" });
    expect(disabled.enabled).toBe(false);
    const { app } = createGatewayApp({
      resources: buildResources(),
      oauthConfig: disabled,
      prisma: prisma as PrismaLikeClient,
      logger,
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("failed to bind ephemeral port");
    port = addr.port;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tenant) await cleanupTenant(tenant);
  });

  it("does not serve the authorization-server metadata endpoint", async () => {
    const res = await rawRequest(port, "GET", "/.well-known/oauth-authorization-server");
    expect(res.status).toBe(404);
  });

  it("still serves resources with raw Bearer tokens and omits the WWW-Authenticate challenge", async () => {
    // A raw api_token still works (the pre-OAuth path).
    const ok = await mcpRpc(port, "/knowledge/mcp", TOOLS_LIST_MSG, tenant.rawToken);
    expect(ok.status).toBe(200);

    // An unauthenticated request is 401 but carries NO WWW-Authenticate (OAuth off).
    const unauth = await rawRequest(port, "POST", "/knowledge/mcp", {
      headers: JSON_MCP_HEADERS,
      body: JSON.stringify(TOOLS_LIST_MSG),
    });
    expect(unauth.status).toBe(401);
    expect(unauth.headers["www-authenticate"]).toBeUndefined();
  });
});
