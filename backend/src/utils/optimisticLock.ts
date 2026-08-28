// =============================================================
// Optimistic locking — the shared F4 primitive every editable
// entity uses. The client sends the updatedAt it last read; the
// server compares it to the current row and rejects a stale write
// with 409 STALE_WRITE (carrying the current server updatedAt).
//
// Usage in a PATCH handler:
//   const current = await prisma.thing.findFirst({ where: { id, consultingFirmId } })
//   if (!current) throw new NotFoundError('Thing')
//   assertFresh(current.updatedAt, body.updatedAt)
//   const updated = await prisma.thing.update({ where: { id }, data })
// =============================================================
import { StaleWriteError, ValidationError } from './errors';

/**
 * Throw unless the client's last-known updatedAt exactly matches the current
 * server row. Millisecond-precision equality (Prisma DateTime round-trips at ms).
 *
 * @param serverUpdatedAt  the current row's updatedAt (Date from Prisma)
 * @param clientUpdatedAt  the updatedAt the client read before editing
 */
export function assertFresh(
  serverUpdatedAt: Date,
  clientUpdatedAt: string | Date | null | undefined,
): void {
  if (clientUpdatedAt == null || clientUpdatedAt === '') {
    throw new ValidationError('updatedAt is required to safely update this record');
  }
  const clientMs = new Date(clientUpdatedAt).getTime();
  if (Number.isNaN(clientMs)) {
    throw new ValidationError('updatedAt is not a valid timestamp');
  }
  if (clientMs !== serverUpdatedAt.getTime()) {
    throw new StaleWriteError(serverUpdatedAt);
  }
}
