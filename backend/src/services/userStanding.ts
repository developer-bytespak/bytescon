// =============================================================
// Is this signed-in user still allowed in?
//
// Session tokens are stateless and last hours. The Redis revocation cutoff
// (tokenRevocation.ts) ends them early, but it is fail-open and the store can
// be wiped, so on its own a deactivated member could keep working until the
// token expires. This check reads the user row itself — active user, active
// firm, still in the firm the token names, and the role it holds now — with a short in-process cache
// so it costs one indexed lookup per user every CACHE_MS, not one per request.
// Deactivation clears the entry, so on this instance it applies at once and on
// any other within CACHE_MS.
// =============================================================
import { prisma } from '../config/database'
import { isRole } from './rbac/permissions'
import type { UserRole } from '../types'
import { demoAccessOf } from './demoAccess'

const CACHE_MS = 30_000
const MAX_ENTRIES = 10_000

export interface UserStanding {
  allowed: boolean
  /**
   * The role on the user row right now. Session tokens carry the role from
   * sign-in, so after a demotion the token still says ADMIN for hours (B7);
   * authenticateJWT replaces it with this value on every request.
   */
  role: UserRole | null
}

const cache = new Map<string, { standing: UserStanding; at: number; firmId: string }>()

export async function getUserStanding(userId: string, consultingFirmId: string): Promise<UserStanding> {
  const hit = cache.get(userId)
  if (hit && hit.firmId === consultingFirmId && Date.now() - hit.at < CACHE_MS) return hit.standing

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isActive: true, role: true, email: true, consultingFirmId: true, consultingFirm: { select: { isActive: true, demoExpiresAt: true } } },
  })
  const role = user && isRole(user.role) ? (user.role as UserRole) : null
  const allowed = Boolean(
    user && role && user.isActive && user.consultingFirm.isActive && demoAccessOf(user.email, user.consultingFirm.demoExpiresAt) === 'ACTIVE' && user.consultingFirmId === consultingFirmId,
  )
  const standing: UserStanding = { allowed, role: allowed ? role : null }
  if (cache.size >= MAX_ENTRIES) cache.clear()
  cache.set(userId, { standing, at: Date.now(), firmId: consultingFirmId })
  return standing
}

export async function isUserInGoodStanding(userId: string, consultingFirmId: string): Promise<boolean> {
  return (await getUserStanding(userId, consultingFirmId)).allowed
}

/** Drop the cached answer so a deactivation or role change applies on the next request. */
export function forgetUserStanding(userId: string): void {
  cache.delete(userId)
}
