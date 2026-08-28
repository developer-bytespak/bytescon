// =============================================================
// §8.3 — Partner portal identity and engagement access.
//
// Two rules govern everything here:
//
//  1. A partner portal user is a SEPARATE external identity. It is never an
//     internal `User`, never carries the CONSULTANT role (an internal read-only
//     identity), and its token is rejected by internal middleware.
//  2. Access is DEFAULT-DENY. Belonging to the partner company grants nothing.
//     A user reaches an engagement only through an explicit, human-granted,
//     unrevoked access row — and every resource is re-derived from those grants
//     rather than trusted from the request.
// =============================================================
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { PartnerEngagementScope } from '@prisma/client'
import { prisma } from '../../config/database'
import { config } from '../../config/config'
import { UnauthorizedError, ForbiddenError } from '../../utils/errors'
import { isTokenStale } from '../tokenRevocation'

export interface PartnerJwtPayload {
  partnerPortalUserId: string
  partnerId: string
  consultingFirmId: string
  /** Distinct from 'CLIENT' and from every internal role. */
  role: 'PARTNER'
  email: string
  /**
   * Present only on the short-lived token issued between a correct password and
   * a correct second factor. A scoped token reaches the MFA challenge endpoint
   * and nothing else — every data route rejects it.
   */
  scope?: 'mfa_challenge'
  iat?: number
  exp?: number
}

export function generatePartnerToken(payload: PartnerJwtPayload): string {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: '12h', algorithm: 'HS256' } as jwt.SignOptions)
}

/** The MFA challenge token. Short-lived, and useless anywhere but /auth/mfa/verify. */
export function generatePartnerChallengeToken(payload: Omit<PartnerJwtPayload, 'scope'>): string {
  return jwt.sign({ ...payload, scope: 'mfa_challenge' }, config.jwt.secret, {
    expiresIn: '10m', algorithm: 'HS256',
  } as jwt.SignOptions)
}

export interface PartnerRequest extends Request {
  partnerUser?: PartnerJwtPayload
}

/**
 * Verify a partner token. Failures are Unauthorized without hinting at the
 * cause, and the account is re-checked on every request so a revocation takes
 * effect immediately rather than at token expiry.
 */
async function authenticate(
  req: PartnerRequest, next: NextFunction, allowChallengeScope: boolean,
): Promise<void> {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return next(new UnauthorizedError('No token provided'))
    const token = header.split(' ')[1]

    let payload: PartnerJwtPayload
    try {
      payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as PartnerJwtPayload
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) return next(new UnauthorizedError('Token expired'))
      return next(new UnauthorizedError('Invalid token'))
    }

    // A client-portal or internal token must never satisfy a partner route.
    if (payload.role !== 'PARTNER') return next(new UnauthorizedError('Not a partner token'))
    // A half-authenticated session is not a session.
    if (payload.scope === 'mfa_challenge' && !allowChallengeScope) {
      return next(new UnauthorizedError('Complete the second factor to continue'))
    }
    if (payload.scope && payload.scope !== 'mfa_challenge') {
      return next(new UnauthorizedError('Invalid token'))
    }

    if (await isTokenStale('partner', payload.partnerPortalUserId, payload.iat)) {
      return next(new UnauthorizedError('Session expired, please sign in again'))
    }

    const account = await prisma.partnerPortalUser.findUnique({
      where: { id: payload.partnerPortalUserId },
      select: { id: true, isActive: true, revokedAt: true, partnerId: true, consultingFirmId: true, acceptedAt: true },
    })
    if (!account || !account.isActive || account.revokedAt || !account.acceptedAt) {
      return next(new UnauthorizedError('Account access has been disabled'))
    }
    // Rebound from the database rather than trusted from the token body.
    req.partnerUser = { ...payload, partnerId: account.partnerId, consultingFirmId: account.consultingFirmId }
    next()
  } catch (err) {
    next(err)
  }
}

export function authenticatePartnerJWT(req: PartnerRequest, _res: Response, next: NextFunction): Promise<void> {
  return authenticate(req, next, false)
}

/** Accepts ONLY the challenge token, so a full session cannot re-run the challenge. */
export async function authenticatePartnerChallenge(
  req: PartnerRequest, _res: Response, next: NextFunction,
): Promise<void> {
  await authenticate(req, (err?: unknown) => {
    if (err) return next(err)
    if (req.partnerUser?.scope !== 'mfa_challenge') {
      return next(new UnauthorizedError('This endpoint requires a second-factor challenge token'))
    }
    next()
  }, true)
}

export function getPartnerCtx(req: PartnerRequest): PartnerJwtPayload {
  if (!req.partnerUser) throw new UnauthorizedError('Partner authentication required')
  return req.partnerUser
}

export interface EngagementGrant {
  scopeType: PartnerEngagementScope
  scopeId: string
}

export async function loadGrants(partnerPortalUserId: string): Promise<EngagementGrant[]> {
  return prisma.partnerEngagementAccess.findMany({
    where: { partnerPortalUserId, revokedAt: null },
    select: { scopeType: true, scopeId: true },
  })
}

export async function hasGrant(
  partnerPortalUserId: string, scopeType: PartnerEngagementScope, scopeId: string,
): Promise<boolean> {
  const row = await prisma.partnerEngagementAccess.findFirst({
    where: { partnerPortalUserId, scopeType, scopeId, revokedAt: null }, select: { id: true },
  })
  return Boolean(row)
}

/**
 * Assert a grant or refuse. The message is deliberately neutral: an external
 * caller learns only that they may not have access, never whether the record
 * exists.
 */
export async function assertGrant(
  partnerPortalUserId: string, scopeType: PartnerEngagementScope, scopeId: string,
): Promise<void> {
  if (!(await hasGrant(partnerPortalUserId, scopeType, scopeId))) {
    throw new ForbiddenError('You do not have access to this engagement')
  }
}

/**
 * Resolve a purchase order the caller may act on.
 *
 * Four independent conditions must all hold, each re-derived from the database
 * rather than taken from the request: the order exists, it belongs to the prime
 * tenant on the token, it belongs to the caller's own partner company, and the
 * caller holds an unrevoked grant for it or for its parent contract.
 *
 * Note what is NOT selected: no internal budget, margin, cost build-up or other
 * vendor's terms ever leaves this function.
 */
export async function resolveAccessiblePurchaseOrder(ctx: PartnerJwtPayload, purchaseOrderId: string) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, consultingFirmId: ctx.consultingFirmId, partnerId: ctx.partnerId },
    select: {
      id: true, poNumber: true, vendorName: true, status: true, ceilingAmount: true,
      description: true, startDate: true, endDate: true, isSubcontract: true, contractId: true,
      lines: { select: { id: true, description: true, amount: true, quantity: true, unit: true, unitPrice: true } },
    },
  })
  if (!po) throw new ForbiddenError('You do not have access to this purchase order')

  const direct = await hasGrant(ctx.partnerPortalUserId, PartnerEngagementScope.PURCHASE_ORDER, po.id)
  const viaContract = await hasGrant(ctx.partnerPortalUserId, PartnerEngagementScope.CONTRACT, po.contractId)
  if (!direct && !viaContract) throw new ForbiddenError('You do not have access to this purchase order')

  return po
}

/**
 * Resolve a deliverable the caller may respond to.
 *
 * Same four independent conditions as a purchase order, re-derived from the
 * database: the deliverable exists, it belongs to the prime tenant on the
 * token, a prime human explicitly attributed it to the caller's partner
 * company (`partnerId`), and the caller holds an unrevoked grant for its
 * contract.
 *
 * Note what is NOT selected: no owner, reviewer, government acceptance record
 * or internal note. The partner sees the ask and its date, not the prime's
 * handling of it.
 */
export async function resolveAccessibleDeliverable(ctx: PartnerJwtPayload, deliverableId: string) {
  const deliverable = await prisma.contractDeliverable.findFirst({
    where: {
      id: deliverableId,
      consultingFirmId: ctx.consultingFirmId,
      partnerId: ctx.partnerId,
      isArchived: false,
    },
    select: {
      id: true, name: true, cdrlNumber: true, description: true, dueDate: true,
      status: true, contractId: true, frequency: true,
    },
  })
  if (!deliverable) throw new ForbiddenError('You do not have access to this deliverable')

  if (!(await hasGrant(ctx.partnerPortalUserId, PartnerEngagementScope.CONTRACT, deliverable.contractId))) {
    throw new ForbiddenError('You do not have access to this deliverable')
  }
  return deliverable
}
