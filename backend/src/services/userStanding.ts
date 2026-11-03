// =============================================================
// Is this signed-in user still allowed in?
//
// Session tokens are stateless and last hours. The Redis revocation cutoff
// (tokenRevocation.ts) ends them early, but it is fail-open and the store can
// be wiped, so on its own a deactivated member could keep working until the
// token expires. This check reads the user row itself — active user, active
// firm, and still in the firm the token names — with a short in-process cache
// so it costs one indexed lookup per user every CACHE_MS, not one per request.
// Deactivation clears the entry, so on this instance it applies at once and on
// any other within CACHE_MS.
// =============================================================
import { prisma } from '../config/database'

const CACHE_MS = 30_000
const MAX_ENTRIES = 10_000

const cache = new Map<string, { allowed: boolean; at: number; firmId: string }>()

export async function isUserInGoodStanding(userId: string, consultingFirmId: string): Promise<boolean> {
  const hit = cache.get(userId)
  if (hit && hit.firmId === consultingFirmId && Date.now() - hit.at < CACHE_MS) return hit.allowed

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isActive: true, consultingFirmId: true, consultingFirm: { select: { isActive: true } } },
  })
  const allowed = Boolean(
    user && user.isActive && user.consultingFirm.isActive && user.consultingFirmId === consultingFirmId,
  )
  if (cache.size >= MAX_ENTRIES) cache.clear()
  cache.set(userId, { allowed, at: Date.now(), firmId: consultingFirmId })
  return allowed
}

/** Drop the cached answer so a deactivation takes effect on the next request. */
export function forgetUserStanding(userId: string): void {
  cache.delete(userId)
}
