/**
 * Stateless Dynamic Client Registration (RFC 7591).
 *
 * Registered clients are public (PKCE, no client secret), so there is nothing
 * confidential to store. Rather than persist a clients table, the client_id IS
 * a signed JWT that carries the client's registered redirect_uris. At
 * /authorize and /token we verify the client_id signature and confirm the
 * supplied redirect_uri is one of the registered ones. A forged or tampered
 * client_id fails signature verification and is rejected.
 */
import crypto from "node:crypto";
import { signJwt, verifyJwt, nowSec, type JwtClaims } from "./jwt.js";

const CLIENT_TYP = "dcr+jwt";

/** Stable 16-hex fingerprint of a client_id, used to bind a code to a client. */
export function clientFingerprint(clientId: string): string {
  return crypto.createHash("sha256").update(clientId, "utf8").digest("hex").slice(0, 16);
}

export interface RegisteredClient {
  redirectUris: string[];
  clientName: string;
}

export function encodeClientId(client: RegisteredClient, key: Buffer): string {
  const claims: JwtClaims = {
    ru: client.redirectUris,
    cn: client.clientName,
    iat: nowSec(),
  };
  return signJwt(claims, key, { typ: CLIENT_TYP });
}

export function decodeClientId(clientId: string, key: Buffer): RegisteredClient | null {
  const claims = verifyJwt(clientId, key, { typ: CLIENT_TYP });
  if (!claims) return null;
  const ru = claims["ru"];
  if (!Array.isArray(ru) || ru.length === 0 || ru.some((u) => typeof u !== "string")) {
    return null;
  }
  const cn = claims["cn"];
  return {
    redirectUris: ru as string[],
    clientName: typeof cn === "string" && cn.length > 0 ? cn : "MCP Client",
  };
}

/** True for an http loopback callback (localhost / 127.0.0.1 / ::1). */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return (
      u.protocol === "http:" &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1")
    );
  } catch {
    return false;
  }
}

/** The host:port shown to the user on the consent page; falls back to the raw value. */
export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Redirect URI policy: http only on loopback (native clients), https otherwise.
 * For external https hosts, an operator-configured allowlist (exact host or
 * subdomain) is enforced when present; an empty allowlist is permissive (any
 * https host, the pre-hardening behavior) and `["*"]` is explicitly permissive.
 * This blocks the open-DCR token-phishing vector when an allowlist is set,
 * while still working out of the box for an unconfigured deployment.
 */
export function isAllowedRedirectUri(uri: string, allowlist: string[]): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (isLoopbackRedirect(uri)) return true;
  if (u.protocol !== "https:") return false;
  if (allowlist.length === 0 || allowlist.includes("*")) return true;
  return hostMatchesAllowlist(u.hostname.toLowerCase(), allowlist);
}

/** Validate a registration request's redirect_uris array. */
export function validateRedirectUris(
  input: unknown,
  allowlist: string[]
): { ok: true; uris: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: "redirect_uris must be a non-empty array" };
  }
  const uris: string[] = [];
  for (const candidate of input) {
    if (typeof candidate !== "string" || !isAllowedRedirectUri(candidate, allowlist)) {
      return { ok: false, error: `invalid redirect_uri: ${String(candidate)}` };
    }
    uris.push(candidate);
  }
  return { ok: true, uris };
}
