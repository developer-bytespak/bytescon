// =============================================================
// /api/fetch-history: every fetch of opportunities and what the firm now holds.
//
// Demo: the shared SAM.gov pool, for the pool administrator only.
// Full version: the signed-in firm's own fetches, for its admins.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { isPoolAdmin } from '../middleware/platformAdmin'
import { ForbiddenError, ValidationError } from '../utils/errors'
import { isDemo } from '../services/appEnvironment'
import { ensurePoolFirm } from '../services/demoOpportunityPool'
import { demoAccountsBreakdown, fetchedNotices, fetchHistory, HISTORY_DAYS_DEFAULT, holdingsBreakdown } from '../services/fetchHistory'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)

/** Whose fetches this request may see. */
async function scopeFirmId(req: AuthenticatedRequest): Promise<string> {
  if (isDemo()) {
    if (!isPoolAdmin(req.user?.email)) throw new ForbiddenError('Only the pool administrator can see the fetch history.')
    return (await ensurePoolFirm()).id
  }
  if (req.user?.role !== 'ADMIN') throw new ForbiddenError('Only admins can see the fetch history.')
  return getTenantId(req)
}

const HistoryQuery = z.object({ days: z.coerce.number().int().min(1).max(180).optional() })
const NoticesQuery = z.object({
  runKind: z.enum(['sam', 'source']).optional(),
  runId: z.string().max(64).optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
})

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new ValidationError(result.error.errors[0]?.message ?? 'Invalid request')
  return result.data
}

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = await scopeFirmId(req)
    const days = parse(HistoryQuery, req.query).days ?? HISTORY_DAYS_DEFAULT
    res.json({ success: true, data: { days, scope: isDemo() ? 'pool' : 'firm', fetches: await fetchHistory(firmId, days) } })
  } catch (err) {
    next(err)
  }
})

router.get('/breakdown', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = await scopeFirmId(req)
    const [holdings, accounts] = await Promise.all([holdingsBreakdown(firmId), demoAccountsBreakdown()])
    res.json({ success: true, data: { holdings, accounts } })
  } catch (err) {
    next(err)
  }
})

router.get('/notices', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = await scopeFirmId(req)
    res.json({ success: true, data: await fetchedNotices(firmId, parse(NoticesQuery, req.query)) })
  } catch (err) {
    next(err)
  }
})

export default router
