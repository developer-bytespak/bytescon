/**
 * OAuth authorization-server configuration for the shared MCP HTTP transport.
 *
 * OAuth is OFF unless `MCP_OAUTH_SIGNING_KEY` is set to a secret of at least
 * 32 characters. When off, the HTTP server behaves exactly as before (raw
 * Bearer api_tokens only, no OAuth endpoints, no WWW-Authenticate challenge),
 * so an environment that has not provisioned a key is never broken by this
 * feature. The signing key is hashed to a fixed 32-byte HMAC key so any
 * sufficiently long secret works.
 *
 * `MCP_PUBLIC_BASE_URL` (e.g. https://bytescon.com) is the canonical origin
 * used to build issuer / resource / endpoint URLs and the access-token
 * audience. In production it MUST be set so those values are independent of
 * the inbound (and spoofable) Host header. This is enforced: when OAuth is
 * enabled and `NODE_ENV=production`, loadOAuthConfig throws at startup if the
 * base URL is empty rather than silently deriving issuer/audience from the
 * request. Only local/dev/test (where the host is trusted) derive from the
 * request.
 *
 * `MCP_OAUTH_REDIRECT_ALLOWLIST` (comma-separated hosts, or `*`) restricts
 * which external https redirect hosts may register. When empty the server is
 * permissive (any https host, the pre-hardening behavior) but logs a warning
 * for each external host that registers; the consent page always shows the
 * redirect destination host regardless, so the human can spot a hostile target.
 *
 * All resource / discovery / endpoint URLs are derived from a per-mount path
 * (default `/mcp`), so a sibling server mounted at, say, `/knowledge/mcp`
 * advertises and validates against its own resource without code changes.
 */
import crypto from "node:crypto";
import type { Request } from "express";
import { createStderrLogger } from "../lib/logger.js";

const logger = createStderrLogger("mcp-shared-oauth");

/** Default mount path for the MCP resource (opportunity-mcp's historical path). */
export const DEFAULT_MOUNT_PATH = "/mcp";

export interface OAuthConfig {
  enabled: boolean;
  /** Canonical origin without trailing slash, or "" to derive per request. */
  baseUrl: string;
  /** 32-byte HMAC key (empty when disabled). */
  signingKey: Buffer;
  /**
   * Allowed external https redirect hosts (exact or subdomain match). Empty =
   * permissive (any https host) with a per-registration warning; `["*"]` =
   * explicitly permissive with no warning. Loopback http is always allowed.
   */
  redirectAllowlist: string[];
  accessTtlSec: number;
  refreshTtlSec: number;
  codeTtlSec: number;
}

const MIN_SECRET_CHARS = 32;

/** Parse a comma-separated host allowlist into trimmed, lowercased entries. */
function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const rawKey = (env.MCP_OAUTH_SIGNING_KEY ?? "").trim();
  const enabled = rawKey.length >= MIN_SECRET_CHARS;
  // Distinguish "set but too short" from "unset" so a truncated/typo'd key is
  // not silently indistinguishable from an intentionally-disabled deployment.
  if (!enabled && rawKey.length > 0) {
    logger.warn(
      "MCP_OAUTH_SIGNING_KEY is set but shorter than 32 chars; OAuth stays DISABLED (raw Bearer tokens only). Use `openssl rand -base64 48`.",
      { length: rawKey.length }
    );
  }
  const baseUrl = normalizeBaseUrl(env.MCP_PUBLIC_BASE_URL ?? "");
  // Fail closed: never derive issuer/audience from a spoofable Host header in prod.
  if (enabled && env.NODE_ENV === "production" && baseUrl === "") {
    throw new Error(
      "MCP_PUBLIC_BASE_URL must be set (no trailing slash) when OAuth is enabled in production; refusing to derive issuer/audience from the inbound Host header"
    );
  }
  const signingKey = enabled
    ? crypto.createHash("sha256").update(rawKey, "utf8").digest()
    : Buffer.alloc(0);
  return {
    enabled,
    baseUrl,
    signingKey,
    redirectAllowlist: parseAllowlist(env.MCP_OAUTH_REDIRECT_ALLOWLIST),
    accessTtlSec: 3600, // 1 hour
    refreshTtlSec: 30 * 24 * 3600, // 30 days
    codeTtlSec: 300, // 5 min — generous for slow remote clients exchanging the code
  };
}

/** Build an explicit config (used by tests to inject a fixed base URL). */
export function makeOAuthConfig(opts: {
  secret: string;
  baseUrl?: string;
  redirectAllowlist?: string[];
  accessTtlSec?: number;
  refreshTtlSec?: number;
  codeTtlSec?: number;
}): OAuthConfig {
  const enabled = opts.secret.length >= MIN_SECRET_CHARS;
  return {
    enabled,
    baseUrl: normalizeBaseUrl(opts.baseUrl ?? ""),
    signingKey: enabled ? crypto.createHash("sha256").update(opts.secret, "utf8").digest() : Buffer.alloc(0),
    redirectAllowlist: opts.redirectAllowlist ?? [],
    accessTtlSec: opts.accessTtlSec ?? 3600,
    refreshTtlSec: opts.refreshTtlSec ?? 30 * 24 * 3600,
    codeTtlSec: opts.codeTtlSec ?? 300,
  };
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed;
}

/** Normalize a mount path to a single leading slash and no trailing slash. */
function normalizeMountPath(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return DEFAULT_MOUNT_PATH;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export interface OAuthUrls {
  base: string;
  issuer: string;
  resource: string;
  prmUrl: string;
  asmUrl: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}

/**
 * Resolve the public URLs for this deployment. Uses the configured baseUrl
 * when present (production); otherwise derives the origin from the request
 * (honoring X-Forwarded-Proto set by the TLS-terminating proxy).
 *
 * `mountPath` (default `/mcp`) is where the MCP resource is served; the
 * resource, PRM, OAuth endpoints, and access-token audience are all derived
 * from it. The bare authorization-server metadata path stays unsuffixed (its
 * issuer is the base origin), matching RFC 8414 expectations.
 */
export function resolveUrls(config: OAuthConfig, req: Request, mountPath: string = DEFAULT_MOUNT_PATH): OAuthUrls {
  const base = config.baseUrl || requestOrigin(req);
  const mount = normalizeMountPath(mountPath);
  return {
    base,
    issuer: base,
    resource: `${base}${mount}`,
    prmUrl: `${base}/.well-known/oauth-protected-resource${mount}`,
    asmUrl: `${base}/.well-known/oauth-authorization-server`,
    authorizeEndpoint: `${base}${mount}/oauth/authorize`,
    tokenEndpoint: `${base}${mount}/oauth/token`,
    registrationEndpoint: `${base}${mount}/oauth/register`,
  };
}

function requestOrigin(req: Request): string {
  const fwdProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const proto = fwdProto || req.protocol || "http";
  const host = req.get("host") ?? "localhost";
  return `${proto}://${host}`;
}
