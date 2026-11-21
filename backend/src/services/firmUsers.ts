// A person picked as a writer, reviewer or owner must be one of the firm's
// own staff. The pickers only list them; this stops a crafted request from
// storing someone else's user.
import { prisma } from '../config/database'
import { ValidationError } from '../utils/errors'

export async function assertFirmUsers(consultingFirmId: string, ...userIds: Array<string | null | undefined>): Promise<void> {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) return
  const found = await prisma.user.count({ where: { id: { in: ids }, consultingFirmId } })
  if (found !== ids.length) throw new ValidationError('The person chosen is not in your firm.')
}
