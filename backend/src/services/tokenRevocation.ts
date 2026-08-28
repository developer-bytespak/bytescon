// =============================================================
// Token revocation — per-principal "not-valid-before" cutoff in Redis.
//
// JWTs are stateless, so a leaked/old token stays valid until it expires.
// This lets security-sensitive events (password reset, deactivation) revoke
// every outstanding token for a principal immediately: we store a cutoff
// timestamp; any token whose `iat` (issued-at) predates the cutoff is
// rejected. A fresh login always mints an `iat` >= the cutoff, so it survives.
//
// Keys expire after the longest possible token lifetime, so the keyspace is
// bounded. The check is FAIL-OPEN: if Redis is unreachable we skip it (and
// log) rather than locking every user out — tokens still expire via `exp`.
// =============================================================
import { redis } from '../config/redis'
import { logger } from '../utils/logger'

export type PrincipalKind = 'user' | 'client' | 'partner'

// Longest-lived token is the 24h client token; add buffer so a cutoff always
// outlives any token it needs to invalidate.
const REVOKE_TTL_SECONDS = 26 * 60 * 60

function revokeKey(kind: PrincipalKind, id: string): string {
  return `revoke:${kind}:${id}`
}

async function setCutoff(kind: PrincipalKind, id: string): Promise<void> {
  if (!id) return
  const nowSec = Math.floor(Date.now() / 1000)
  try {
    await redis.set(revokeKey(kind, id), String(nowSec), 'EX', REVOKE_TTL_SECONDS)
  } catch (err) {
    // Don't fail the triggering action (e.g. password reset) on a Redis blip —
    // but log loudly: until the key is set, old tokens remain valid.
    logger.error('Token revocation write failed', { kind, error: (err as Error).message })
  }
}

/** Invalidate every outstanding consultant token for this user. */
export function revokeUserTokens(userId: string): Promise<void> {
  return setCutoff('user', userId)
}

/** Invalidate every outstanding client-portal token for this portal user. */
export function revokeClientTokens(clientPortalUserId: string): Promise<void> {
  return setCutoff('client', clientPortalUserId)
}

/**
 * Invalidate every outstanding partner-portal token for this portal user.
 *
 * Its own namespace rather than the client one: the two identities are
 * separate, and sharing a key would let one principal's revocation reason
 * about the other's sessions.
 */
export function revokePartnerTokens(partnerPortalUserId: string): Promise<void> {
  return setCutoff('partner', partnerPortalUserId)
}

/**
 * True when a token issued at `iat` (epoch seconds) for this principal was
 * minted before a revocation cutoff and must be rejected. Fail-open on a
 * missing `iat` or a Redis error.
 */
export async function isTokenStale(
  kind: PrincipalKind,
  id: string | undefined,
  iat: number | undefined
): Promise<boolean> {
  if (!id || typeof iat !== 'number') return false
  try {
    const cutoff = await redis.get(revokeKey(kind, id))
    if (!cutoff) return false
    return iat < Number(cutoff)
  } catch (err) {
    logger.warn('Token revocation check skipped (Redis error)', { kind, error: (err as Error).message })
    return false
  }
}
