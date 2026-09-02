/**
 * Bearer resolution for the /mcp request path.
 *
 * Two credential shapes are accepted:
 *  1. An OAuth access token (HS256 JWT, typ "at+jwt") issued by this server's
 *     embedded authorization server. Verified by signature + audience, then
 *     the embedded api_tokens id (`sub`) is re-resolved against the database so
 *     revocation/expiry are enforced on every call.
 *  2. A raw api_tokens Bearer token (the pre-OAuth path), unchanged. Raw tokens
 *     are opaque base64url with no dots, so they never collide with the JWT
 *     shape, and the discriminator below is unambiguous.
 *
 * When OAuth is disabled (no signing key) only path 2 is used, so behavior is
 * byte-for-byte the pre-OAuth behavior.
 */
import {
  resolveBearerToken,
  resolveTokenById,
  type ResolvedTokenContext,
} from "../lib/auth.js";
import type { PrismaLikeClient } from "../lib/prisma-client.js";
import { verifyJwt } from "./jwt.js";
import type { OAuthConfig } from "./config.js";

export const ACCESS_TOKEN_TYP = "at+jwt";

function looksLikeJwt(raw: string): boolean {
  return typeof raw === "string" && raw.split(".").length === 3;
}

export async function resolveAccessToken(
  prisma: PrismaLikeClient,
  raw: string,
  config: OAuthConfig,
  resource: string
): Promise<ResolvedTokenContext | null> {
  if (config.enabled && looksLikeJwt(raw)) {
    const claims = verifyJwt(raw, config.signingKey, { typ: ACCESS_TOKEN_TYP, aud: resource });
    if (!claims) return null;
    const sub = typeof claims.sub === "string" ? claims.sub : null;
    if (!sub) return null;
    return resolveTokenById(prisma, sub);
  }
  return resolveBearerToken(prisma, raw);
}
