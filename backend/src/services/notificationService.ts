// =============================================================
// In-app user notifications (§5.2 qualification / gate reviews).
//
// Minimal, honest in-app feed — the platform had no generic per-user
// notification store (only client-match emails + ops alerts). Writes are
// deduped on a caller-supplied stable `dedupeKey` so re-assigning the same
// reviewer, or a retried request, never produces a duplicate row. No email
// dependency — the platform stays functional with no mail key.
// =============================================================
import { Prisma, NotificationType } from '@prisma/client'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'

export interface NotifyInput {
  consultingFirmId: string
  userId: string
  type: NotificationType
  title: string
  body?: string
  linkPath?: string
  entityType?: string
  entityId?: string
  dedupeKey: string
}

/**
 * Create an in-app notification, deduped by `dedupeKey`. Idempotent: a second
 * call with the same key is a no-op. Non-throwing — a notification failure must
 * never break the business action that triggered it. Accepts an optional
 * transaction client so it can participate in the caller's transaction.
 */
export async function notifyUser(
  input: NotifyInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  try {
    const existing = await tx.userNotification.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } })
    if (existing) return
    await tx.userNotification.create({
      data: {
        consultingFirmId: input.consultingFirmId,
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        linkPath: input.linkPath ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        dedupeKey: input.dedupeKey,
      },
    })
  } catch (err) {
    // Unique-violation race → another request already inserted the same key.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return
    logger.error('Failed to write user notification', { type: input.type, userId: input.userId, error: (err as Error).message })
  }
}
