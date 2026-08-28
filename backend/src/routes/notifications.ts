// =============================================================
// In-app notifications feed (§5.2). Per-user, tenant-scoped. Reads list the
// current user's notifications; mark-read mutates only the caller's own rows.
// Mounted at /api/notifications.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError } from '../utils/errors'
import { prisma } from '../config/database'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

// GET /api/notifications — the caller's feed (+ unread count).
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user!.userId
    const q = req.query
    const page = Math.max(1, parseInt(String(q.page || '1'), 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || '25'), 10) || 25))
    const where: Prisma.UserNotificationWhereInput = { consultingFirmId, userId }
    if (q.unread === 'true') where.isRead = false
    // Archived notifications are hidden unless explicitly requested.
    if (String(q.includeArchived) !== 'true') where.isArchived = false

    const [items, total, unreadCount] = await Promise.all([
      prisma.userNotification.findMany({ where, orderBy: [{ isRead: 'asc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      prisma.userNotification.count({ where }),
      prisma.userNotification.count({ where: { consultingFirmId, userId, isRead: false, isArchived: false } }),
    ])
    res.json({ success: true, data: { items, total, unreadCount, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } })
  } catch (err) { next(err) }
})

// POST /api/notifications/:id/read — mark one of the caller's notifications read.
router.post('/:id/read', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user!.userId
    const existing = await prisma.userNotification.findFirst({ where: { id: req.params.id, consultingFirmId, userId } })
    if (!existing) throw new NotFoundError('Notification not found')
    const updated = await prisma.userNotification.update({ where: { id: existing.id }, data: { isRead: true, readAt: existing.readAt ?? new Date() } })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// POST /api/notifications/:id/unread — mark one back to unread.
router.post('/:id/unread', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user!.userId
    const existing = await prisma.userNotification.findFirst({ where: { id: req.params.id, consultingFirmId, userId } })
    if (!existing) throw new NotFoundError('Notification not found')
    const updated = await prisma.userNotification.update({ where: { id: existing.id }, data: { isRead: false, readAt: null } })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// POST /api/notifications/read-all — mark all the caller's notifications read.
router.post('/read-all', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user!.userId
    const result = await prisma.userNotification.updateMany({ where: { consultingFirmId, userId, isRead: false, isArchived: false }, data: { isRead: true, readAt: new Date() } })
    res.json({ success: true, data: { updated: result.count } })
  } catch (err) { next(err) }
})

// POST /api/notifications/:id/archive — notifications are archived, never deleted.
router.post('/:id/archive', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user!.userId
    const existing = await prisma.userNotification.findFirst({ where: { id: req.params.id, consultingFirmId, userId } })
    if (!existing) throw new NotFoundError('Notification not found')
    const updated = await prisma.userNotification.update({ where: { id: existing.id }, data: { isArchived: true, isRead: true, readAt: existing.readAt ?? new Date() } })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// POST /api/notifications/:id/restore — un-archive.
router.post('/:id/restore', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user!.userId
    const existing = await prisma.userNotification.findFirst({ where: { id: req.params.id, consultingFirmId, userId } })
    if (!existing) throw new NotFoundError('Notification not found')
    const updated = await prisma.userNotification.update({ where: { id: existing.id }, data: { isArchived: false } })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

export default router
