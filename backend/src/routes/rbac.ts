// =============================================================
// §8.5 — Roles and permissions administration.
//
// Small on purpose. The permission VOCABULARY lives in code, because a
// permission that can be invented at runtime is a permission nobody reviewed;
// this router only assigns the roles that already exist and reports what the
// caller holds.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requirePermission, loadPermissions } from '../middleware/permissions'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { ValidationError, NotFoundError } from '../utils/errors'
import { logAudit } from '../services/auditService'
import { revokeUserTokens } from '../services/tokenRevocation'
import { forgetUserStanding } from '../services/userStanding'
import { checkUserLimit } from '../middleware/tierGate'
import {
  PERMISSIONS, PERMISSION_DESCRIPTIONS, ROLES, ROLE_PERMISSIONS, isPermission, isRole,
} from '../services/rbac/permissions'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)

/** The vocabulary, so the UI never has to hard-code it. */
router.get('/catalog', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: {
        roles: ROLES.map((role) => ({ role, permissions: ROLE_PERMISSIONS[role] })),
        permissions: PERMISSIONS.map((permission) => ({ permission, description: PERMISSION_DESCRIPTIONS[permission] })),
      },
    })
  } catch (err) { next(err) }
})

/** What the caller can actually do, so the UI can hide what it cannot. */
router.get('/me', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const held = await loadPermissions(req)
    res.json({ success: true, data: { userId: req.user?.userId ?? null, role: req.user?.role ?? null, permissions: [...held].sort() } })
  } catch (err) { next(err) }
})

router.get('/users', requirePermission('ADMIN_SETTINGS'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const rows = await prisma.user.findMany({
      where: { consultingFirmId },
      select: {
        id: true, email: true, firstName: true, lastName: true, role: true,
        extraPermissions: true, isActive: true, lastLoginAt: true,
      },
      orderBy: { createdAt: 'asc' }, take: 500,
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

const AssignSchema = z.object({
  role: z.string().trim().max(40).optional(),
  extraPermissions: z.array(z.string().trim().max(60)).max(30).optional(),
}).strict()

/**
 * Change a member's role, or grant an extra permission.
 *
 * Two guards that are easy to forget and expensive to miss:
 *
 *  - The target must be in the caller's own tenant, re-read here rather than
 *    trusted from the id.
 *  - A firm cannot remove its own last active administrator. Doing so leaves
 *    nobody able to grant the role back, and the only remedy is the platform
 *    operator editing the database.
 */
router.put('/users/:id', requirePermission('ADMIN_SETTINGS'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = AssignSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('Invalid role assignment')
    if (parsed.data.role !== undefined && !isRole(parsed.data.role)) throw new ValidationError('That is not a valid role')
    for (const permission of parsed.data.extraPermissions ?? []) {
      if (!isPermission(permission)) throw new ValidationError(`Unknown permission: ${permission}`)
    }

    const target = await prisma.user.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, role: true, email: true, extraPermissions: true },
    })
    if (!target) throw new NotFoundError('User not found')

    if (parsed.data.role && target.role === 'ADMIN' && parsed.data.role !== 'ADMIN') {
      const remaining = await prisma.user.count({
        where: { consultingFirmId, role: 'ADMIN', isActive: true, id: { not: target.id } },
      })
      if (remaining === 0) {
        throw new ValidationError('This is the last administrator. Promote someone else before changing this role.')
      }
    }

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: {
        ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
        ...(parsed.data.extraPermissions !== undefined ? { extraPermissions: parsed.data.extraPermissions } : {}),
      },
      select: { id: true, email: true, role: true, extraPermissions: true },
    })
    await logAudit({
      consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
      actorKind: 'INTERNAL_USER', action: 'UPDATE', entityType: 'User', entityId: target.id,
      rationale: `Access changed: role ${target.role} → ${updated.role}`,
      before: { role: target.role, extraPermissions: target.extraPermissions },
      after: { role: updated.role, extraPermissions: updated.extraPermissions },
    })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

/**
 * Remove a member's access (B4). The account is kept, not deleted, so their
 * name stays on past audit entries, proposals and notes. Deactivation:
 *   - ends every open session now (Redis cutoff + the per-request account
 *     check in authenticateJWT, which does not depend on Redis);
 *   - voids unused invite / password-reset links;
 *   - frees the member's seat (checkUserLimit counts active users only).
 * An admin cannot deactivate themselves, and the last active admin stays.
 */
router.post('/users/:id/deactivate', requirePermission('ADMIN_SETTINGS'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, email: true, role: true, isActive: true },
    })
    if (!target) throw new NotFoundError('User not found')
    if (target.id === req.user?.userId) throw new ValidationError('You cannot deactivate your own account.')
    if (!target.isActive) return res.json({ success: true, data: { id: target.id, isActive: false } })

    if (target.role === 'ADMIN') {
      const remaining = await prisma.user.count({
        where: { consultingFirmId, role: 'ADMIN', isActive: true, id: { not: target.id } },
      })
      if (remaining === 0) {
        throw new ValidationError('This is the last administrator. Promote someone else before deactivating them.')
      }
    }

    await prisma.$transaction([
      prisma.user.update({ where: { id: target.id }, data: { isActive: false } }),
      prisma.passwordResetToken.updateMany({
        where: { userId: target.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ])
    forgetUserStanding(target.id)
    await revokeUserTokens(target.id)

    await logAudit({
      consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
      actorKind: 'INTERNAL_USER', action: 'UPDATE', entityType: 'User', entityId: target.id,
      rationale: `Member deactivated: ${target.email}`,
      before: { isActive: true }, after: { isActive: false },
    })
    res.json({ success: true, data: { id: target.id, isActive: false } })
  } catch (err) { next(err) }
})

/** Restore a deactivated member. Needs a free seat, so the plan limit holds. */
router.post('/users/:id/reactivate', requirePermission('ADMIN_SETTINGS'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, email: true, isActive: true },
    })
    if (!target) throw new NotFoundError('User not found')
    if (target.isActive) return res.json({ success: true, data: { id: target.id, isActive: true } })

    const seat = await checkUserLimit(consultingFirmId)
    if (!seat.allowed) {
      return res.status(403).json({
        success: false,
        code: 'TIER_LIMIT',
        error: `Your plan includes ${seat.max} seats and all are in use. Deactivate someone or upgrade your plan first.`,
      })
    }

    await prisma.user.update({ where: { id: target.id }, data: { isActive: true } })
    forgetUserStanding(target.id)

    await logAudit({
      consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
      actorKind: 'INTERNAL_USER', action: 'UPDATE', entityType: 'User', entityId: target.id,
      rationale: `Member reactivated: ${target.email}`,
      before: { isActive: false }, after: { isActive: true },
    })
    res.json({ success: true, data: { id: target.id, isActive: true } })
  } catch (err) { next(err) }
})

export default router
