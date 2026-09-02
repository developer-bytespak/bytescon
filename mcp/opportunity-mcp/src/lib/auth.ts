/**
 * Bearer-token resolution for opportunity-mcp.
 *
 * The generic implementation now lives in @bytescon/mcp-shared (prisma-injected
 * so it can be shared across the suite and unit-tested with a mock). This thin
 * adapter binds those shared helpers to opportunity-mcp's local Prisma
 * singleton and preserves the one-argument call sites this server has always
 * used (server.ts, fixtures, mint-token). Behavior is byte-identical: the same
 * api_tokens lookup, the same revoked/expired checks, the same best-effort
 * lastUsedAt update, and the same 16-char fingerprint.
 */
import {
  hashToken,
  tokenFingerprint,
  meetsTier,
  requireTier,
  resolveBearerToken as sharedResolveBearerToken,
  resolveTokenById as sharedResolveTokenById,
  type ApiTokenTier,
  type ResolvedTokenContext,
  type PrismaLikeClient,
} from "@bytescon/mcp-shared";
import { prisma } from "./prisma.js";

export { hashToken, tokenFingerprint, meetsTier, requireTier };
export type { ApiTokenTier, ResolvedTokenContext };

const sharedPrisma = prisma as unknown as PrismaLikeClient;

/** Resolve a raw bearer token to its tenant context against the local Prisma client. */
export async function resolveBearerToken(raw: string): Promise<ResolvedTokenContext | null> {
  return sharedResolveBearerToken(sharedPrisma, raw);
}

/** Resolve a tenant context from an api_tokens row id (OAuth access-token path). */
export async function resolveTokenById(tokenId: string): Promise<ResolvedTokenContext | null> {
  return sharedResolveTokenById(sharedPrisma, tokenId);
}
