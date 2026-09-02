/**
 * Minimal HS256 JWT sign/verify built on node:crypto.
 *
 * opportunity-mcp deliberately carries no JWT dependency, so the embedded
 * OAuth authorization server signs its own short-lived tokens (authorization
 * codes, access tokens, refresh tokens, and the stateless DCR client_id)
 * with a single HMAC-SHA256 key. Verification is constant-time and rejects
 * any token whose header alg is not HS256 (no alg-confusion surface).
 *
 * These tokens are an OAuth transport wrapper only. The load-bearing
 * credential remains the row in api_tokens: every access token embeds the
 * api_tokens id (claim `sub`) and the /mcp request path re-resolves that row
 * on every call, so revocation and expiry are always honored regardless of
 * the JWT's own lifetime.
 */
import crypto from "node:crypto";

export function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

export function base64urlDecodeToString(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

export interface JwtHeader {
  alg: "HS256";
  typ: string;
}

export type JwtClaims = Record<string, unknown> & {
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
  jti?: string;
  sub?: string;
};

/** Sign a claims object as an HS256 JWT with the given `typ` header. */
export function signJwt(claims: JwtClaims, key: Buffer, opts: { typ: string }): string {
  const header: JwtHeader = { alg: "HS256", typ: opts.typ };
  const h = base64urlEncode(JSON.stringify(header));
  const p = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${h}.${p}`;
  const sig = crypto.createHmac("sha256", key).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

export interface VerifyOptions {
  /** Require this exact header `typ`. */
  typ?: string;
  /** Require this exact `iss` claim. */
  iss?: string;
  /** Require this exact `aud` claim. */
  aud?: string;
  /** Current time in epoch seconds; defaults to Date.now(). Test seam. */
  now?: number;
}

/**
 * Verify an HS256 JWT. Returns the claims on success, or null on any failure
 * (bad shape, wrong alg, signature mismatch, expired, typ/iss/aud mismatch).
 * Never throws.
 */
export function verifyJwt(token: string, key: Buffer, opts: VerifyOptions = {}): JwtClaims | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const h = parts[0]!;
  const p = parts[1]!;
  const s = parts[2]!;

  const signingInput = `${h}.${p}`;
  const expected = crypto.createHmac("sha256", key).update(signingInput).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(s, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;

  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = JSON.parse(base64urlDecodeToString(h)) as JwtHeader;
    claims = JSON.parse(base64urlDecodeToString(p)) as JwtClaims;
  } catch {
    return null;
  }
  if (!header || header.alg !== "HS256") return null;
  if (opts.typ !== undefined && header.typ !== opts.typ) return null;
  if (!claims || typeof claims !== "object") return null;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && now >= claims.exp) return null;
  // Reject tokens minted implausibly far in the future (clock-skew guard).
  if (typeof claims.iat === "number" && claims.iat > now + 120) return null;
  if (opts.iss !== undefined && claims.iss !== opts.iss) return null;
  if (opts.aud !== undefined && claims.aud !== opts.aud) return null;

  return claims;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
