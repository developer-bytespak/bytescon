/**
 * Embedded OAuth 2.1 authorization server for the shared MCP HTTP transport,
 * implementing the MCP authorization spec so remote/web connectors (Claude
 * Desktop, claude.ai) can sign in:
 *
 *   GET  /.well-known/oauth-protected-resource[<mount>]   RFC 9728 metadata
 *   GET  /.well-known/oauth-authorization-server          RFC 8414 metadata
 *   POST <mount>/oauth/register                           RFC 7591 dynamic registration
 *   GET  <mount>/oauth/authorize                          consent (paste-token) page
 *   POST <mount>/oauth/authorize                          validate token -> issue code
 *   POST <mount>/oauth/token                              code/refresh -> access token
 *
 * The user proves identity by pasting their existing Bytescon API token; the
 * server validates it against api_tokens and issues short-lived signed tokens.
 * No new database tables: clients, codes, and tokens are all stateless signed
 * JWTs (codes additionally tracked in an in-memory single-use ledger).
 *
 * Server-specific bindings (the database client, the mount path the resource
 * is served at, and the human-readable resource name) are injected, so a
 * sibling server mounted at a different path reuses this router unchanged.
 */
import express, { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { createStderrLogger } from "../lib/logger.js";
import { resolveBearerToken, resolveTokenById } from "../lib/auth.js";
import type { PrismaLikeClient } from "../lib/prisma-client.js";
import { resolveUrls, DEFAULT_MOUNT_PATH, type OAuthConfig, type OAuthUrls } from "./config.js";
import { protectedResourceMetadata, authorizationServerMetadata, MCP_SCOPE } from "./metadata.js";
import { signJwt, verifyJwt, nowSec, type JwtClaims } from "./jwt.js";
import { verifyPkceS256 } from "./pkce.js";
import {
  decodeClientId,
  encodeClientId,
  validateRedirectUris,
  clientFingerprint,
  isLoopbackRedirect,
  redirectHost,
} from "./clients.js";
import { consumeCode, consumeRefresh } from "./codes.js";
import { renderConsentPage, renderErrorPage } from "./consent.js";

const logger = createStderrLogger("mcp-shared-oauth");

const CODE_TYP = "code+jwt";
const ACCESS_TYP = "at+jwt";
const REFRESH_TYP = "rt+jwt";

/** Per-mount router configuration injected by the HTTP bootstrap. */
export interface OAuthRouterOptions {
  /** Prisma client used to validate pasted tokens and re-resolve OAuth subjects. */
  prisma: PrismaLikeClient;
  /** Mount path the MCP resource is served at (default `/mcp`). */
  mountPath?: string;
  /** Human-readable resource name advertised in PRM (`resource_name`). */
  resourceName: string;
}

/** Configuration for the resource-agnostic authorization-server router. */
export interface AuthorizationServerRouterOptions {
  /** Prisma client used to validate pasted tokens and re-resolve OAuth subjects. */
  prisma: PrismaLikeClient;
  /**
   * Mount path the AS endpoints live under (default `/mcp`). The
   * authorization-server metadata stays at the bare well-known path; only the
   * register/authorize/token endpoints carry this prefix. opportunity-mcp's
   * historical `/mcp/oauth/*` paths are preserved by keeping the default, so a
   * single gateway hosts ONE AS while serving N resources under sibling paths.
   */
  mountPath?: string;
  /**
   * Mount paths of ALL resources this AS issues tokens for (e.g.
   * `['/mcp','/knowledge/mcp',...]`). The issued access-token `aud` is bound to
   * the validated RFC 8707 `resource` request param when it names one of these;
   * a requested resource outside the set is rejected (invalid_target). Defaults
   * to `[mountPath]` (a single-resource server, e.g. standalone opportunity-mcp).
   */
  servedMountPaths?: string[];
}

/** Build the WWW-Authenticate header value pointing at the resource metadata. */
export function wwwAuthenticateChallenge(prmUrl: string, error?: string): string {
  let value = `Bearer resource_metadata="${prmUrl}"`;
  if (error) value += `, error="${error}"`;
  return value;
}

/** Normalize a mount path to a single leading slash and no trailing slash. */
function normalizeMount(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") return DEFAULT_MOUNT_PATH;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Build the single-resource OAuth router: the resource-agnostic authorization
 * server (ASM + register/authorize/token) PLUS this resource's RFC 9728
 * protected-resource metadata. Behavior is unchanged from the original
 * single-resource server; the gateway uses {@link createAuthorizationServerRouter}
 * (the AS alone) and one PRM per resource instead.
 */
export function createOAuthRouter(config: OAuthConfig, opts: OAuthRouterOptions): Router {
  const router = Router();
  const mountPath = normalizeMount(opts.mountPath);

  // This resource's RFC 9728 PRM, served at both the bare and the
  // mount-suffixed well-known path (so a client that probes either finds it).
  router.get(
    [
      "/.well-known/oauth-protected-resource",
      `/.well-known/oauth-protected-resource${mountPath}`,
    ],
    (req: Request, res: Response) => {
      res.json(protectedResourceMetadata(resolveUrls(config, req, mountPath), opts.resourceName));
    }
  );

  router.use(createAuthorizationServerRouter(config, { prisma: opts.prisma, mountPath }));
  return router;
}

/**
 * Build the resource-agnostic OAuth 2.1 authorization server. Mounted ONCE per
 * process. Serves:
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
 *   POST <mount>/oauth/register                    RFC 7591 dynamic registration
 *   GET  <mount>/oauth/authorize                    consent (paste-token) page
 *   POST <mount>/oauth/authorize                    validate token -> issue code
 *   POST <mount>/oauth/token                        code/refresh -> access token
 *
 * It binds each access token's `aud` to the RFC 8707 `resource` request param
 * when that resource names one of `servedMountPaths` (validated by origin AND
 * the served-path allowlist); a requested resource outside the set is rejected
 * with invalid_target, and an omitted resource falls back to the AS's own mount
 * (`/mcp`). Per-resource PRM is NOT served here (each
 * {@link createResourceMcpRouter} serves its own).
 */
export function createAuthorizationServerRouter(
  config: OAuthConfig,
  opts: AuthorizationServerRouterOptions
): Router {
  const router = Router();
  const { prisma } = opts;
  const mountPath = normalizeMount(opts.mountPath);
  const AUTHORIZE_PATH = `${mountPath}/oauth/authorize`;
  // The resources this AS may mint audiences for. Defaults to the single mount
  // (standalone server); the gateway passes all 5 so each resource's token is
  // bound to its own audience (cross-resource isolation depends on this).
  const servedMounts =
    opts.servedMountPaths && opts.servedMountPaths.length > 0
      ? opts.servedMountPaths.map(normalizeMount)
      : [mountPath];

  // AS metadata is served ONLY at the bare well-known path. Its `issuer` is the
  // base origin, which is RFC 8414 §3.3-consistent only for the non-suffixed
  // location; PRM advertises authorization_servers=[base], so well-behaved
  // clients fetch this path. (A mount-suffixed AS doc would return an issuer
  // that disagrees with its fetch URL, which strict validators reject.)
  router.get("/.well-known/oauth-authorization-server", (req: Request, res: Response) => {
    res.json(authorizationServerMetadata(resolveUrls(config, req, mountPath)));
  });

  // ── Dynamic Client Registration (RFC 7591) ──────────────────────────────
  router.post(`${mountPath}/oauth/register`, express.json(), (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const validation = validateRedirectUris(body["redirect_uris"], config.redirectAllowlist);
    if (!validation.ok) {
      // Surface rejected registrations: a client (e.g. a web connector) whose
      // callback host is not permitted by MCP_OAUTH_REDIRECT_ALLOWLIST never
      // receives a client_id and then fails downstream with "invalid client".
      logger.warn("oauth register: redirect_uris rejected", {
        error: validation.error,
        allowlist_configured: config.redirectAllowlist.length > 0,
      });
      res.status(400).json({ error: "invalid_redirect_uri", error_description: validation.error });
      return;
    }
    const nameRaw = body["client_name"];
    const clientName =
      typeof nameRaw === "string" && nameRaw.trim().length > 0 ? nameRaw.trim().slice(0, 200) : "MCP Client";
    const clientId = encodeClientId({ redirectUris: validation.uris, clientName }, config.signingKey);
    const externalHosts = [...new Set(validation.uris.filter((u) => !isLoopbackRedirect(u)).map(redirectHost))];
    logger.info("oauth register: client issued", {
      client: clientFingerprint(clientId),
      redirect_uri_count: validation.uris.length,
      redirect_hosts: externalHosts,
    });
    // Audit trail for the open-DCR phishing surface: surface every external
    // redirect host registered while no allowlist is enforced.
    if (config.redirectAllowlist.length === 0 && externalHosts.length > 0) {
      logger.warn(
        "oauth register: external https redirect host registered with no MCP_OAUTH_REDIRECT_ALLOWLIST set; set it to restrict where authorization codes can be sent",
        { client: clientFingerprint(clientId), redirect_hosts: externalHosts }
      );
    }
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: nowSec(),
      redirect_uris: validation.uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: clientName,
      scope: MCP_SCOPE,
    });
  });

  // ── Authorization endpoint: render consent (GET) ────────────────────────
  router.get(`${mountPath}/oauth/authorize`, (req: Request, res: Response) => {
    const urls = resolveUrls(config, req, mountPath);
    const p = readAuthorizeParams(req.query as Record<string, unknown>);

    const client = decodeClientId(p.client_id, config.signingKey);
    if (!client) {
      logClientDecodeFailure("GET /authorize", p.client_id);
      res.status(400).type("html").send(renderErrorPage("Unknown or invalid client. Please reconnect from the application."));
      return;
    }
    if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) {
      res.status(400).type("html").send(renderErrorPage("The redirect address is not registered for this client."));
      return;
    }
    // redirect_uri is trusted from here on; remaining errors redirect back.
    if (p.response_type !== "code") {
      redirectError(res, p.redirect_uri, p.state, "unsupported_response_type", "only response_type=code is supported");
      return;
    }
    if (!p.code_challenge || p.code_challenge_method !== "S256") {
      redirectError(res, p.redirect_uri, p.state, "invalid_request", "PKCE with code_challenge_method=S256 is required");
      return;
    }
    if (p.resource && !matchServedResource(p.resource, urls, servedMounts)) {
      redirectError(res, p.redirect_uri, p.state, "invalid_target", "the requested resource is not served by this authorization server");
      return;
    }

    res
      .status(200)
      .type("html")
      .send(renderConsentPage({ actionPath: AUTHORIZE_PATH, clientName: client.clientName, params: toConsentParams(p) }));
  });

  // ── Authorization endpoint: validate token, issue code (POST) ───────────
  router.post(`${mountPath}/oauth/authorize`, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
    const urls = resolveUrls(config, req, mountPath);
    const p = readAuthorizeParams((req.body ?? {}) as Record<string, unknown>);
    const apiToken = str((req.body ?? {})["api_token"]);

    const client = decodeClientId(p.client_id, config.signingKey);
    if (!client) {
      logClientDecodeFailure("POST /authorize", p.client_id);
      res.status(400).type("html").send(renderErrorPage("Unknown or invalid client."));
      return;
    }
    if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) {
      res.status(400).type("html").send(renderErrorPage("The redirect address is not registered for this client."));
      return;
    }
    if (p.response_type !== "code" || !p.code_challenge || p.code_challenge_method !== "S256") {
      redirectError(res, p.redirect_uri, p.state, "invalid_request", "invalid authorization request");
      return;
    }
    const boundResource = matchServedResource(p.resource, urls, servedMounts);
    if (p.resource && !boundResource) {
      redirectError(res, p.redirect_uri, p.state, "invalid_target", "the requested resource is not served by this authorization server");
      return;
    }

    const renderForm = (errorMessage: string): void => {
      res
        .status(200)
        .type("html")
        .send(renderConsentPage({ actionPath: AUTHORIZE_PATH, clientName: client.clientName, params: toConsentParams(p), errorMessage }));
    };

    if (!apiToken) {
      renderForm("Enter your API token to continue.");
      return;
    }

    const ctx = await resolveBearerToken(prisma, apiToken);
    if (!ctx) {
      logger.warn("oauth authorize: token rejected", { client: clientFingerprint(p.client_id) });
      renderForm("That token was not recognized. Check it and try again.");
      return;
    }

    const iat = nowSec();
    const claims: JwtClaims = {
      jti: crypto.randomUUID(),
      sub: ctx.tokenId,
      cc: p.code_challenge,
      ru: p.redirect_uri,
      cid: clientFingerprint(p.client_id),
      scope: p.scope || MCP_SCOPE,
      // Bind the code (→ access-token aud) to the validated requested resource,
      // falling back to this AS's own mount when the client omits `resource`.
      res: boundResource ?? urls.resource,
      iat,
      exp: iat + config.codeTtlSec,
    };
    const code = signJwt(claims, config.signingKey, { typ: CODE_TYP });
    logger.info("oauth authorize: code issued", {
      tenant_id: ctx.consultingFirmId,
      token_fp: ctx.tokenFp,
      client: clientFingerprint(p.client_id),
    });
    redirectWithCode(res, p.redirect_uri, code, p.state);
  });

  // ── Token endpoint ──────────────────────────────────────────────────────
  router.post(
    `${mountPath}/oauth/token`,
    express.urlencoded({ extended: false }),
    express.json(),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      const urls = resolveUrls(config, req, mountPath);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const grantType = str(body["grant_type"]);
      logger.info("oauth token: request", { grant_type: grantType || "(none)" });

      if (grantType === "authorization_code") {
        await handleAuthorizationCode(config, prisma, urls.issuer, body, res);
        return;
      }
      if (grantType === "refresh_token") {
        await handleRefreshToken(config, prisma, urls.issuer, urls.resource, body, res);
        return;
      }
      tokenError(res, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    }
  );

  return router;
}

// ── Grant handlers ──────────────────────────────────────────────────────────

async function handleAuthorizationCode(
  config: OAuthConfig,
  prisma: PrismaLikeClient,
  issuer: string,
  body: Record<string, unknown>,
  res: Response
): Promise<void> {
  const code = str(body["code"]);
  const redirectUri = str(body["redirect_uri"]);
  const codeVerifier = str(body["code_verifier"]);
  const clientId = str(body["client_id"]);

  const claims = verifyJwt(code, config.signingKey, { typ: CODE_TYP });
  if (!claims) {
    tokenError(res, "invalid_grant", "authorization code is invalid or expired");
    return;
  }
  // Validate the binding (redirect_uri, client, PKCE) BEFORE burning the code,
  // so a failed/malformed redemption cannot consume the code for the rightful
  // holder. A valid replay is still rejected below because the jti is burned on
  // the first fully-valid redemption.
  if (redirectUri !== str(claims["ru"])) {
    tokenError(res, "invalid_grant", "redirect_uri does not match the authorization request");
    return;
  }
  if (!clientId || clientFingerprint(clientId) !== str(claims["cid"]) || !decodeClientId(clientId, config.signingKey)) {
    tokenError(res, "invalid_grant", "client_id does not match the authorization request");
    return;
  }
  if (!verifyPkceS256(codeVerifier, str(claims["cc"]))) {
    tokenError(res, "invalid_grant", "PKCE verification failed");
    return;
  }
  const jti = str(claims["jti"]);
  const exp = typeof claims["exp"] === "number" ? (claims["exp"] as number) : 0;
  // Single-use: burn the code now that the request is fully validated.
  if (!jti || !consumeCode(jti, exp, nowSec())) {
    tokenError(res, "invalid_grant", "authorization code has already been used");
    return;
  }
  const ctx = await resolveTokenById(prisma, str(claims["sub"]));
  if (!ctx) {
    tokenError(res, "invalid_grant", "the underlying token is no longer valid");
    return;
  }
  const aud = str(claims["res"]) || `${issuer}/mcp`;
  const scope = str(claims["scope"]) || MCP_SCOPE;
  issueTokens(res, config, issuer, aud, ctx, scope);
}

async function handleRefreshToken(
  config: OAuthConfig,
  prisma: PrismaLikeClient,
  issuer: string,
  resource: string,
  body: Record<string, unknown>,
  res: Response
): Promise<void> {
  const refreshToken = str(body["refresh_token"]);
  const claims = verifyJwt(refreshToken, config.signingKey, { typ: REFRESH_TYP });
  if (!claims) {
    tokenError(res, "invalid_grant", "refresh token is invalid or expired");
    return;
  }
  // OAuth 2.1 rotation: burn the presented refresh jti so a captured refresh
  // token cannot be replayed. issueTokens mints a fresh refresh token (new jti)
  // each call, so the rotation is automatic once the old one is consumed.
  const jti = str(claims["jti"]);
  const exp = typeof claims["exp"] === "number" ? (claims["exp"] as number) : 0;
  if (!jti || !consumeRefresh(jti, exp, nowSec())) {
    tokenError(res, "invalid_grant", "refresh token has already been used");
    return;
  }
  const ctx = await resolveTokenById(prisma, str(claims["sub"]));
  if (!ctx) {
    tokenError(res, "invalid_grant", "the underlying token is no longer valid");
    return;
  }
  const aud = str(claims["aud"]) || resource;
  const scope = str(claims["scope"]) || MCP_SCOPE;
  issueTokens(res, config, issuer, aud, ctx, scope);
}

function issueTokens(
  res: Response,
  config: OAuthConfig,
  issuer: string,
  aud: string,
  ctx: { tokenId: string; tokenFp: string; consultingFirmId: string; tier: string },
  scope: string
): void {
  const iat = nowSec();
  const accessToken = signJwt(
    {
      iss: issuer,
      aud,
      sub: ctx.tokenId,
      fp: ctx.tokenFp,
      firm: ctx.consultingFirmId,
      tier: ctx.tier,
      scope,
      jti: crypto.randomUUID(),
      iat,
      exp: iat + config.accessTtlSec,
    },
    config.signingKey,
    { typ: ACCESS_TYP }
  );
  const refreshToken = signJwt(
    {
      iss: issuer,
      aud,
      sub: ctx.tokenId,
      scope,
      jti: crypto.randomUUID(),
      iat,
      exp: iat + config.refreshTtlSec,
    },
    config.signingKey,
    { typ: REFRESH_TYP }
  );
  logger.info("oauth token: issued", { aud, token_fp: ctx.tokenFp, scope });
  res.status(200).json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.accessTtlSec,
    refresh_token: refreshToken,
    scope,
  });
}

// ── Small helpers ────────────────────────────────────────────────────────────

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
  resource: string;
}

function readAuthorizeParams(source: Record<string, unknown>): AuthorizeParams {
  return {
    response_type: str(source["response_type"]),
    client_id: str(source["client_id"]),
    redirect_uri: str(source["redirect_uri"]),
    code_challenge: str(source["code_challenge"]),
    code_challenge_method: str(source["code_challenge_method"]),
    state: str(source["state"]),
    scope: str(source["scope"]),
    resource: str(source["resource"]),
  };
}

function toConsentParams(p: AuthorizeParams): AuthorizeParams {
  return { ...p, scope: p.scope || MCP_SCOPE };
}

/**
 * RFC 8707: resolve a requested `resource` to the canonical resource URL of a
 * SERVED mount, or null if it does not identify one. The value must parse,
 * share the base origin, and (after trailing-slash normalization) name one of
 * `servedMounts` — a bare origin maps to the default mount for back-compat. The
 * caller rejects a non-empty `requested` that resolves to null with
 * invalid_target and binds the issued audience to the returned URL, so a token
 * is only ever minted for a resource this gateway actually serves. This is what
 * makes per-resource audience isolation hold through the real OAuth flow (not
 * just for directly-minted test tokens).
 */
function matchServedResource(requested: string, urls: OAuthUrls, servedMounts: string[]): string | null {
  if (!requested) return null;
  let u: URL;
  try {
    u = new URL(requested);
  } catch {
    return null;
  }
  if (u.origin !== new URL(urls.base).origin) return null;
  const path = u.pathname.replace(/\/+$/, "");
  const candidate = path === "" ? DEFAULT_MOUNT_PATH : path;
  return servedMounts.includes(candidate) ? `${urls.base}${candidate}` : null;
}

/**
 * Diagnose a client_id that failed to decode. Without this the only signal is
 * the user-facing "Unknown or invalid client" page. The shape tells an operator
 * which case it is: a non-JWT (or empty) value means the client never completed
 * dynamic registration against this server; a well-formed JWT that still failed
 * means signature/typ verification failed — almost always a stale client_id
 * signed with a previous MCP_OAUTH_SIGNING_KEY, so the client must reconnect to
 * re-register.
 */
function logClientDecodeFailure(where: string, clientId: string): void {
  const looksLikeJwt = typeof clientId === "string" && clientId.split(".").length === 3;
  logger.warn("oauth authorize: client_id rejected (decode failed)", {
    where,
    client: clientId ? clientFingerprint(clientId) : "(empty)",
    client_id_length: typeof clientId === "string" ? clientId.length : 0,
    looks_like_jwt: looksLikeJwt,
    likely_cause: !clientId
      ? "no client_id sent — client did not complete dynamic registration"
      : looksLikeJwt
        ? "well-formed token failed signature/typ check — likely a stale client_id from a different MCP_OAUTH_SIGNING_KEY; reconnect the client to re-register"
        : "client_id is not a DCR token — client did not register against this server",
  });
}

/** Coerce an unknown query/body value to a single string (reject arrays). */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tokenError(res: Response, error: string, description: string): void {
  logger.warn("oauth token: rejected", { error, error_description: description });
  res.status(400).json({ error, error_description: description });
}

function redirectError(
  res: Response,
  redirectUri: string,
  state: string,
  error: string,
  description: string
): void {
  try {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state) url.searchParams.set("state", state);
    res.redirect(302, url.toString());
  } catch {
    res.status(400).type("html").send(renderErrorPage("Invalid redirect target."));
  }
}

function redirectWithCode(res: Response, redirectUri: string, code: string, state: string): void {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(302, url.toString());
}
