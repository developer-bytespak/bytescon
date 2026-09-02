/**
 * End-to-end OAuth handshake against the real Express app on an ephemeral port.
 *
 * Drives the full Claude-style connector flow: discovery -> 401 challenge ->
 * authorization-server metadata -> dynamic client registration -> consent
 * (paste-token) -> authorization code -> token exchange -> authenticated /mcp.
 * Then the security negatives: replayed code, bad PKCE verifier, unregistered
 * redirect_uri, tampered access token, refresh-token grant, and revocation of
 * the underlying api_tokens row (which must invalidate a live access token).
 *
 * Requests go through node:http (not fetch) so the 302 Location header on the
 * authorize response is readable; fetch's redirect:"manual" hides it.
 *
 * Skips cleanly when DATABASE_URL is unset (see fixtures.shouldSkipIntegrationTests).
 */
import http from "node:http";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { makeOAuthConfig, computeS256Challenge } from "@bytescon/mcp-shared";
import { prisma } from "../src/lib/prisma.js";
import {
  seedTenant,
  cleanupTenant,
  shouldSkipIntegrationTests,
  type SeededTenant,
} from "./fixtures.js";

const SIGNING_SECRET = "oauth-flow-test-signing-secret-key-0123456789";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

interface RawOptions {
  headers?: Record<string, string>;
  body?: string;
  /** Resolve after this many ms even if the response stream stays open (SSE). */
  softTimeoutMs?: number;
}

function rawRequest(port: number, method: string, path: string, opts: RawOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (r: RawResponse): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: opts.headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      let timer: NodeJS.Timeout | undefined;
      if (opts.softTimeoutMs) {
        timer = setTimeout(() => {
          finish({ status: res.statusCode ?? 0, headers: res.headers, text: data });
          req.destroy();
        }, opts.softTimeoutMs);
      }
      res.on("data", (chunk: string) => {
        data += chunk;
      });
      res.on("end", () => {
        if (timer) clearTimeout(timer);
        finish({ status: res.statusCode ?? 0, headers: res.headers, text: data });
      });
    });
    req.on("error", (err) => {
      if (!settled) reject(err);
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const form = (obj: Record<string, string>): string => new URLSearchParams(obj).toString();
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };
const JSON_HEADERS = { "content-type": "application/json" };

const skip = shouldSkipIntegrationTests();

describe.skipIf(skip)("opportunity-mcp OAuth handshake (integration)", () => {
  let server: http.Server;
  let port: number;
  let base: string;
  let tenant: SeededTenant;
  let revokedTenant: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant({
      firmLabel: "oauth-primary",
      opportunities: [{ title: "OAuth Test Opp", agency: "GSA", naicsCode: "541611" }],
    });
    revokedTenant = await seedTenant({
      firmLabel: "oauth-revoked",
      opportunities: [{ title: "Revoke Test Opp", agency: "GSA", naicsCode: "541611" }],
    });

    const { app } = createApp({
      oauth: makeOAuthConfig({ secret: SIGNING_SECRET }), // baseUrl derived from request
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
    if (tenant) await cleanupTenant(tenant);
    if (revokedTenant) await cleanupTenant(revokedTenant);
  });

  // Register a client and walk authorize -> code -> token; returns the grant.
  async function runHandshake(
    rawToken: string,
    redirectUri: string = CLAUDE_REDIRECT
  ): Promise<{ clientId: string; verifier: string; code: string; tokens: Record<string, string> }> {
    const reg = await rawRequest(port, "POST", "/mcp/oauth/register", {
      headers: JSON_HEADERS,
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Claude Test Connector" }),
    });
    expect(reg.status).toBe(201);
    const clientId = (JSON.parse(reg.text) as { client_id: string }).client_id;

    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = computeS256Challenge(verifier);
    const state = `state-${crypto.randomUUID()}`;
    const authQuery = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "mcp",
    }).toString();

    const consent = await rawRequest(port, "GET", `/mcp/oauth/authorize?${authQuery}`);
    expect(consent.status).toBe(200);
    expect(consent.text).toContain("Authorize");

    const submit = await rawRequest(port, "POST", "/mcp/oauth/authorize", {
      headers: FORM_HEADERS,
      body: form({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        scope: "mcp",
        api_token: rawToken,
      }),
    });
    expect(submit.status).toBe(302);
    const location = new URL(String(submit.headers["location"]));
    expect(location.searchParams.get("state")).toBe(state);
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenRes = await rawRequest(port, "POST", "/mcp/oauth/token", {
      headers: FORM_HEADERS,
      body: form({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: clientId,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = JSON.parse(tokenRes.text) as Record<string, string>;
    return { clientId, verifier, code: code!, tokens };
  }

  it("publishes protected-resource metadata pointing at this resource", async () => {
    const res = await rawRequest(port, "GET", "/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    const meta = JSON.parse(res.text) as { resource: string; authorization_servers: string[] };
    expect(meta.resource).toBe(`${base}/mcp`);
    expect(meta.authorization_servers).toEqual([base]);
  });

  it("challenges an unauthenticated /mcp request with WWW-Authenticate", async () => {
    const res = await rawRequest(port, "POST", "/mcp", {
      headers: { ...JSON_HEADERS, accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(String(res.headers["www-authenticate"])).toContain("resource_metadata=");
  });

  it("publishes authorization-server metadata advertising PKCE S256", async () => {
    const res = await rawRequest(port, "GET", "/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const meta = JSON.parse(res.text) as Record<string, unknown>;
    expect(meta["token_endpoint"]).toBe(`${base}/mcp/oauth/token`);
    expect(meta["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(meta["registration_endpoint"]).toBe(`${base}/mcp/oauth/register`);
  });

  it("completes the full handshake and accepts the issued access token on /mcp", async () => {
    const { tokens } = await runHandshake(tenant.rawToken);
    expect(tokens["token_type"]).toBe("Bearer");
    expect(tokens["access_token"]).toBeTruthy();
    expect(tokens["refresh_token"]).toBeTruthy();
    expect(Number(tokens["expires_in"])).toBeGreaterThan(0);

    const mcp = await rawRequest(port, "POST", "/mcp", {
      headers: {
        ...JSON_HEADERS,
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens["access_token"]}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "oauth-flow-test", version: "0.0.0" },
        },
      }),
      softTimeoutMs: 4000,
    });
    // The only path to a non-401 here is a successfully resolved access token.
    expect(mcp.status).toBe(200);
    expect(mcp.headers["www-authenticate"]).toBeUndefined();
  });

  it("rejects a replayed authorization code (single use)", async () => {
    const redirectUri = CLAUDE_REDIRECT;
    const { clientId, verifier, code } = await runHandshake(tenant.rawToken, redirectUri);
    // The handshake already redeemed this code once; a second exchange must fail.
    const replay = await rawRequest(port, "POST", "/mcp/oauth/token", {
      headers: FORM_HEADERS,
      body: form({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: clientId,
      }),
    });
    expect(replay.status).toBe(400);
    expect((JSON.parse(replay.text) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects a token exchange with a wrong PKCE verifier", async () => {
    const redirectUri = CLAUDE_REDIRECT;
    // Run authorize to mint a fresh, unredeemed code, then exchange with a bad verifier.
    const reg = await rawRequest(port, "POST", "/mcp/oauth/register", {
      headers: JSON_HEADERS,
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "PKCE Negative" }),
    });
    const clientId = (JSON.parse(reg.text) as { client_id: string }).client_id;
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = computeS256Challenge(verifier);
    const submit = await rawRequest(port, "POST", "/mcp/oauth/authorize", {
      headers: FORM_HEADERS,
      body: form({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "s",
        scope: "mcp",
        api_token: tenant.rawToken,
      }),
    });
    const code = new URL(String(submit.headers["location"])).searchParams.get("code")!;

    const wrongVerifier = crypto.randomBytes(32).toString("base64url");
    const res = await rawRequest(port, "POST", "/mcp/oauth/token", {
      headers: FORM_HEADERS,
      body: form({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: wrongVerifier,
        client_id: clientId,
      }),
    });
    expect(res.status).toBe(400);
    expect((JSON.parse(res.text) as { error: string }).error).toBe("invalid_grant");
  });

  it("refuses an authorize request whose redirect_uri is not registered", async () => {
    const reg = await rawRequest(port, "POST", "/mcp/oauth/register", {
      headers: JSON_HEADERS,
      body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT], client_name: "Redirect Negative" }),
    });
    const clientId = (JSON.parse(reg.text) as { client_id: string }).client_id;
    const challenge = computeS256Challenge(crypto.randomBytes(32).toString("base64url"));
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://attacker.example/steal", // valid scheme, but not registered
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
      scope: "mcp",
    }).toString();
    const res = await rawRequest(port, "GET", `/mcp/oauth/authorize?${query}`);
    // Must NOT redirect to the unregistered URI; renders a terminal error page.
    expect(res.status).toBe(400);
    expect(res.headers["location"]).toBeUndefined();
  });

  it("rejects a tampered access token on /mcp", async () => {
    const { tokens } = await runHandshake(tenant.rawToken);
    const parts = tokens["access_token"]!.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}AAAA`;
    const res = await rawRequest(port, "POST", "/mcp", {
      headers: {
        ...JSON_HEADERS,
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tampered}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(String(res.headers["www-authenticate"])).toContain('error="invalid_token"');
  });

  it("issues a new access token from a refresh token", async () => {
    const { tokens } = await runHandshake(tenant.rawToken);
    const res = await rawRequest(port, "POST", "/mcp/oauth/token", {
      headers: FORM_HEADERS,
      body: form({ grant_type: "refresh_token", refresh_token: tokens["refresh_token"]! }),
    });
    expect(res.status).toBe(200);
    const refreshed = JSON.parse(res.text) as Record<string, string>;
    expect(refreshed["access_token"]).toBeTruthy();
    expect(refreshed["token_type"]).toBe("Bearer");
  });

  it("rotates refresh tokens: the original is rejected after one use, the rotated one works", async () => {
    const { tokens } = await runHandshake(tenant.rawToken);
    const original = tokens["refresh_token"]!;

    // First use rotates: succeeds and returns a NEW refresh token.
    const first = await rawRequest(port, "POST", "/mcp/oauth/token", {
      headers: FORM_HEADERS,
      body: form({ grant_type: "refresh_token", refresh_token: original }),
    });
    expect(first.status).toBe(200);
    const rotated = (JSON.parse(first.text) as Record<string, string>)["refresh_token"]!;
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(original);

    // Replaying the original (now-burned) refresh token must fail.
    const replay = await rawRequest(port, "POST", "/mcp/oauth/token", {
      headers: FORM_HEADERS,
      body: form({ grant_type: "refresh_token", refresh_token: original }),
    });
    expect(replay.status).toBe(400);
    expect((JSON.parse(replay.text) as { error: string }).error).toBe("invalid_grant");

    // The rotated token is the live one and still works.
    const next = await rawRequest(port, "POST", "/mcp/oauth/token", {
      headers: FORM_HEADERS,
      body: form({ grant_type: "refresh_token", refresh_token: rotated }),
    });
    expect(next.status).toBe(200);
    expect((JSON.parse(next.text) as Record<string, string>)["access_token"]).toBeTruthy();
  });

  it("shows the redirect destination host on the consent page", async () => {
    const reg = await rawRequest(port, "POST", "/mcp/oauth/register", {
      headers: JSON_HEADERS,
      body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT], client_name: "Consent Host Display" }),
    });
    const clientId = (JSON.parse(reg.text) as { client_id: string }).client_id;
    const challenge = computeS256Challenge(crypto.randomBytes(32).toString("base64url"));
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
      scope: "mcp",
    }).toString();
    const consent = await rawRequest(port, "GET", `/mcp/oauth/authorize?${query}`);
    expect(consent.status).toBe(200);
    // The human must be able to see where the code will be sent before pasting a token.
    expect(consent.text).toContain("access will be sent to");
    expect(consent.text).toContain("claude.ai");
  });

  it("rejects an authorize request whose resource indicator names a foreign server", async () => {
    const reg = await rawRequest(port, "POST", "/mcp/oauth/register", {
      headers: JSON_HEADERS,
      body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT], client_name: "Resource Mismatch" }),
    });
    const clientId = (JSON.parse(reg.text) as { client_id: string }).client_id;
    const challenge = computeS256Challenge(crypto.randomBytes(32).toString("base64url"));
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
      scope: "mcp",
      resource: "https://someone-else.example/mcp", // RFC 8707 target not served here
    }).toString();
    const res = await rawRequest(port, "GET", `/mcp/oauth/authorize?${query}`);
    // redirect_uri is registered, so the error rides back on a 302 (not a page).
    expect(res.status).toBe(302);
    const location = new URL(String(res.headers["location"]));
    expect(location.searchParams.get("error")).toBe("invalid_target");
    expect(location.origin).toBe(new URL(CLAUDE_REDIRECT).origin);
  });

  it("invalidates a live access token once the underlying api_token is revoked", async () => {
    const { tokens } = await runHandshake(revokedTenant.rawToken);
    // Token works before revocation.
    const before = await rawRequest(port, "POST", "/mcp", {
      headers: {
        ...JSON_HEADERS,
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens["access_token"]}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "oauth-flow-test", version: "0.0.0" },
        },
      }),
      softTimeoutMs: 4000,
    });
    expect(before.status).toBe(200);

    // Revoke the api_tokens row the access token resolves to.
    await prisma.apiToken.update({
      where: { id: revokedTenant.tokenId },
      data: { revokedAt: new Date() },
    });

    const after = await rawRequest(port, "POST", "/mcp", {
      headers: {
        ...JSON_HEADERS,
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens["access_token"]}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(after.status).toBe(401);
    expect(String(after.headers["www-authenticate"])).toContain('error="invalid_token"');
  });
});
