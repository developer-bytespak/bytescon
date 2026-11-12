// =============================================================
// Score waiting opportunities as soon as a profile becomes complete.
//
// Scoring skips a company whose profile is incomplete (profileGate.ts), so
// opportunities that arrive before the profile is finished stay unscored.
// The sweep that scores them (enqueueAllOpportunitiesForScoring) otherwise
// runs only after the next opportunity sync. This middleware notes which
// profiles are complete before a save and, after a successful save, queues
// that sweep when a profile has just become complete.
//
// Mounted on the routers whose saves can complete a profile: My Company,
// clients, registration and both past-performance routers. Reads pass
// straight through.
// =============================================================
import { Response, NextFunction } from 'express'
import { AuthenticatedRequest } from '../types'
import { clientProfileStatuses } from '../services/profileGate'
import { enqueueAllOpportunitiesForScoring } from '../workers/scoringWorker'
import { logger } from '../utils/logger'

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

async function completeIds(consultingFirmId: string): Promise<Set<string>> {
  const { clients } = await clientProfileStatuses(consultingFirmId)
  return new Set(clients.filter((c) => c.complete).map((c) => c.clientCompanyId))
}

/** Queues scoring when a profile complete now was not complete before. Returns how many opportunities were queued. */
export async function rescoreIfNewlyComplete(consultingFirmId: string, before: Set<string>): Promise<number> {
  const after = await completeIds(consultingFirmId)
  const newlyComplete = [...after].filter((id) => !before.has(id))
  if (newlyComplete.length === 0) return 0
  const queued = await enqueueAllOpportunitiesForScoring(consultingFirmId)
  logger.info('Profile completed; waiting opportunities queued for scoring', { consultingFirmId, newlyComplete, queued })
  return queued
}

export function rescoreOnProfileComplete(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const consultingFirmId = req.user?.consultingFirmId
  if (READS.has(req.method) || !consultingFirmId) return next()
  completeIds(consultingFirmId).then(
    (before) => {
      res.on('finish', () => {
        if (res.statusCode >= 300) return
        rescoreIfNewlyComplete(consultingFirmId, before).catch((err: Error) => {
          logger.warn('Could not queue scoring after a profile completed', { consultingFirmId, error: err.message })
        })
      })
      next()
    },
    // Never block the save because the check failed.
    (err: Error) => {
      logger.warn('Profile completeness check failed before a save', { consultingFirmId, error: err.message })
      next()
    },
  )
}
