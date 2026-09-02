/**
 * Bearer-token resolution against the `api_tokens` table, plus the tier
 * gate helper. Extracted from opportunity-mcp v0.3 (src/lib/auth.ts) with
 * the Prisma client injected instead of imported, so unit tests can mock
 * it and servers can share one instance.
 *
 * The raw token is never logged or persisted. The server stores only the
 * SHA-256 hash for lookup and the first 16 hex chars of the hash as a
 * fingerprint for audit (CLAUDE.md section 6.3, "Token exfiltration").
 *
 * For stdio servers the token is resolved once at process startup and
 * cached for the process lifetime. HTTP/SSE in v0.2 will resolve per
 * request and move to OAuth 2.1 with PKCE.
 */
import crypto from "node:crypto";
import { McpAuthError } from "./errors.js";
import type { PrismaLikeClient } from "./prisma-client.js";

/**
 * Whether a token row belongs to this interface.
 *
 * The public REST API added in §8.4 shares the api_tokens table, so a bearer
 * that verifies is no longer proof that it was issued for MCP. A row with no
 * `kind` is an MCP token: the column defaults to MCP and every row written
 * before §8.4 predates the distinction.
 */
function isMcpToken(row: { kind?: string | null }): boolean {
  return row.kind == null || row.kind === "MCP";
}

/** Token privilege tiers, lowest to highest: CORE, PRO, VAULT. */
export type ApiTokenTier = "CORE" | "PRO" | "VAULT";

/** Tenant context resolved from a valid bearer token. */
export interface ResolvedTokenContext {
  /** api_tokens.id of the matched row. */
  tokenId: string;
  /** First 16 hex chars of the SHA-256 token hash; the only token artifact ever logged. */
  tokenFp: string;
  /** Tenant id; the mandatory first WHERE clause of every tenant-scoped query. */
  consultingFirmId: string;
  /** Privilege tier of the token. */
  tier: ApiTokenTier;
}

/**
 * SHA-256 hash of a raw bearer token, hex encoded. Matches the value
 * stored in api_tokens.tokenHash.
 *
 * @param raw - The raw bearer token.
 * @returns 64-char lowercase hex digest.
 */
export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Audit-safe fingerprint of a raw token: first 16 hex chars of its
 * SHA-256 hash. Stored in mcp_audit_log.token_fp.
 *
 * @param raw - The raw bearer token.
 * @returns 16-char fingerprint.
 */
export function tokenFingerprint(raw: string): string {
  return hashToken(raw).slice(0, 16);
}

/**
 * Resolve a raw bearer token to its tenant context.
 *
 * Checks revokedAt and expiresAt on every resolve. Fires a best-effort
 * lastUsedAt update that never blocks or fails resolution.
 *
 * @param prisma - Injected Prisma client (or mock).
 * @param raw - The raw bearer token from Bytescon_MCP_TOKEN.
 * @returns The resolved context, or null when the token is missing,
 *   too short, unknown, revoked, or expired.
 */
export async function resolveBearerToken(
  prisma: PrismaLikeClient,
  raw: string
): Promise<ResolvedTokenContext | null> {
  if (!raw || raw.length < 16) {
    return null;
  }
  const tokenHash = hashToken(raw);
  const row = await prisma.apiToken.findUnique({ where: { tokenHash } });
  if (!row) return null;
  if (!isMcpToken(row)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;

  // Best-effort lastUsedAt update; never block resolution on this.
  prisma.apiToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    tokenId: row.id,
    tokenFp: tokenHash.slice(0, 16),
    consultingFirmId: row.consultingFirmId,
    tier: row.tier as ApiTokenTier,
  };
}

/**
 * Resolve a tenant context from an api_tokens row id.
 *
 * Used by the OAuth access-token path: an OAuth access token embeds the
 * api_tokens id (claim `sub`), and every /mcp request re-loads that row here
 * so a token that has since been revoked or expired stops working immediately,
 * regardless of the access token's own (longer) JWT lifetime. The 16-char
 * fingerprint is recomputed from the stored hash so audit rows match the raw
 * Bearer path exactly.
 *
 * @param prisma - Injected Prisma client (or mock).
 * @param tokenId - api_tokens.id embedded in the OAuth access token (`sub`).
 * @returns The resolved context, or null when the id is missing, unknown,
 *   revoked, or expired.
 */
export async function resolveTokenById(
  prisma: PrismaLikeClient,
  tokenId: string
): Promise<ResolvedTokenContext | null> {
  if (!tokenId || typeof tokenId !== "string") return null;
  const row = await prisma.apiToken.findUnique({ where: { id: tokenId } });
  if (!row) return null;
  if (!isMcpToken(row)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;

  // Best-effort lastUsedAt update; never block resolution on this.
  prisma.apiToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    tokenId: row.id,
    tokenFp: row.tokenHash.slice(0, 16),
    consultingFirmId: row.consultingFirmId,
    tier: row.tier as ApiTokenTier,
  };
}

const TIER_RANK: Record<ApiTokenTier, number> = {
  CORE: 0,
  PRO: 1,
  VAULT: 2,
};

/**
 * Whether a token tier satisfies a minimum required tier
 * (CORE < PRO < VAULT).
 *
 * @param actual - Tier of the resolved token.
 * @param required - Minimum tier the operation demands.
 * @returns true when actual is at or above required.
 */
export function meetsTier(actual: ApiTokenTier, required: ApiTokenTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

/**
 * Tier gate: throw a typed auth error when the resolved context does not
 * meet the required tier. Tool handlers catch this and return a
 * structured `isError` response with outcome "auth_error" in the audit row.
 *
 * @param ctx - The resolved token context.
 * @param required - Minimum tier the operation demands.
 * @throws McpAuthError when the context tier is below the requirement.
 */
export function requireTier(ctx: ResolvedTokenContext, required: ApiTokenTier): void {
  if (!meetsTier(ctx.tier, required)) {
    throw new McpAuthError(
      `this operation requires token tier ${required} or higher, current tier is ${ctx.tier}`,
      { required_tier: required, actual_tier: ctx.tier }
    );
  }
}
