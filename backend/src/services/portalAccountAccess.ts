// =============================================================
// Client-portal account access — the single source of truth for
// "may this portal user still act?"
//
// There are THREE JWT verifiers that admit a portal user (clientPortal.ts
// authenticateClientJWT, clientDeliverables.ts authenticateClientJWT, and
// clientDeliverables.ts authenticateAny's CLIENT branch). They previously each
// hand-rolled their own checks and drifted: the first two re-read isActive while
// the third did not, so a deactivated user — and a contact of a SOFT-DELETED
// CLIENT COMPANY — kept full read/write access to deliverable comment threads.
// One helper, used by all three, is the fix for the drift itself.
//
// WHY A PER-REQUEST DB READ. Revocation is normally caught by the Redis
// not-valid-before cutoff (services/tokenRevocation.ts), but that check FAILS
// OPEN by design — a Redis blip must not lock every user out. Deactivation is a
// security control, so it cannot depend on a cache being reachable. Client
// tokens live 24h, which is how long a purely token-based check would leave a
// terminated contact with access.
//
// FAILS CLOSED: a lookup error propagates to the caller (which turns it into a
// 500) rather than being swallowed into "active". Callers must NOT wrap this in
// `.catch(() => null)` — a database problem is not an authorization decision.
// =============================================================

import { prisma } from '../config/database'

export interface PortalAccount {
  /** True only when BOTH the portal user and its client company are active. */
  active: boolean
  firstName: string
  lastName: string
  clientCompanyId: string
}

/**
 * Load a portal user's access status plus the display fields the comment
 * threads need, in one query. Returns null when the user does not exist.
 *
 * The company check matters independently of the user check: `DELETE
 * /api/clients/:id` soft-deletes a ClientCompany, and before this existed
 * nothing on the portal side consulted that flag — every contact at a
 * "deleted" client kept logging in. `clientCompanyHasPortal()` only resolves
 * the owning FIRM's billing entitlement, which is a different question.
 */
export async function loadPortalAccount(clientPortalUserId: string): Promise<PortalAccount | null> {
  const user = await prisma.clientPortalUser.findUnique({
    where: { id: clientPortalUserId },
    select: {
      isActive: true,
      firstName: true,
      lastName: true,
      clientCompanyId: true,
      clientCompany: { select: { isActive: true } },
    },
  })
  if (!user) return null
  return {
    active: Boolean(user.isActive && user.clientCompany?.isActive),
    firstName: user.firstName,
    lastName: user.lastName,
    clientCompanyId: user.clientCompanyId,
  }
}
