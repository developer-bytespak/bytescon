/**
 * Single-use enforcement for authorization codes and refresh tokens.
 *
 * Both are stateless signed JWTs, so replay can only be blocked by remembering
 * which `jti`s have already been redeemed. These are process-local maps; the
 * HTTP server runs as a single container (enforced by the fixed container_name
 * in docker-compose.prod.yml, which blocks `--scale`) so that is sufficient. A
 * restart clears them, but a code also expires in 60s so its post-restart
 * replay window is at most that TTL; a refresh token's ledger entry is kept for
 * its full lifetime so a captured refresh token cannot be replayed in parallel
 * while the process stays up. No database row is involved.
 */
const usedJti = new Map<string, number>(); // code jti -> exp (epoch seconds)
const usedRefreshJti = new Map<string, number>(); // refresh jti -> exp (epoch seconds)

/**
 * Record a code redemption. Returns true the first time a given jti is seen
 * (caller may proceed) and false on every subsequent call (replay -> reject).
 */
export function consumeCode(jti: string, exp: number, now: number): boolean {
  evictExpired(usedJti, now);
  if (usedJti.has(jti)) return false;
  usedJti.set(jti, exp);
  return true;
}

/**
 * Record a refresh-token redemption (OAuth 2.1 rotation). Returns true the
 * first time a given refresh jti is presented and false on every replay, so a
 * rotated/captured refresh token cannot be redeemed again. The ledger entry is
 * remembered until the refresh token's own exp, so the replay window is the
 * token lifetime, not the 60s code window.
 */
export function consumeRefresh(jti: string, exp: number, now: number): boolean {
  evictExpired(usedRefreshJti, now);
  if (usedRefreshJti.has(jti)) return false;
  usedRefreshJti.set(jti, exp);
  return true;
}

function evictExpired(ledger: Map<string, number>, now: number): void {
  for (const [jti, exp] of ledger) {
    if (exp <= now) ledger.delete(jti);
  }
}

/** Test seam: clear the in-memory code ledger. */
export function _resetUsedCodes(): void {
  usedJti.clear();
}

/** Test seam: clear the in-memory refresh-token ledger. */
export function _resetUsedRefresh(): void {
  usedRefreshJti.clear();
}
