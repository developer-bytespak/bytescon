// =============================================================
// /api/fetch-history: every fetch of opportunities and what is held.
//
// Only the one developer account may use it (isDeveloperAdmin): on the demo the
// pool administrator, who sees the shared SAM.gov pool; elsewhere the account
// named in DEVELOPER_ADMIN_EMAIL, who sees every firm or one at a time. Firm
// admins, consultants, clients and partners get a 403.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { enforceTenantScope } from '../middleware/tenant'
import { isDeveloperAdmin } from '../middleware/platformAdmin'
import { prisma } from '../config/database'
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors'
import { isDemo } from '../services/appEnvironment'
import { ensurePoolFirm } from '../services/demoOpportunityPool'
import { demoAccountsBreakdown, fetchedNotices, fetchHistory, FETCH_ROWS_MAX, firmsBreakdown, HISTORY_DAYS_DEFAULT, holdingsBreakdown, type Scope } from '../services/fetchHistory'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)

const FirmQuery = z.object({ firmId: z.string().max(64).optional() })

/** What this request may see: the pool on the demo, else every firm or the one asked for. */
async function scopeFor(req: AuthenticatedRequest): Promise<Scope> {
  if (!isDeveloperAdmin(req.user?.email, isDemo())) throw new ForbiddenError('Not available.')
  if (isDemo()) return (await ensurePoolFirm()).id
  const { firmId } = parse(FirmQuery, req.query)
  if (!firmId) return null
  if (!(await prisma.consultingFirm.findUnique({ where: { id: firmId }, select: { id: true } }))) throw new NotFoundError('Firm not found')
  return firmId
}

const HistoryQuery = z.object({ days: z.coerce.number().int().min(1).max(180).optional() })
const NoticesQuery = z.object({
  firmId: z.string().max(64).optional(),
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

/** Whether to show the signed-in user a link. Never an error, so nothing is revealed. */
router.get('/access', (req: AuthenticatedRequest, res: Response) => {
  res.json({ success: true, data: { allowed: isDeveloperAdmin(req.user?.email, isDemo()) } })
})

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const scope = await scopeFor(req)
    const days = parse(HistoryQuery.merge(FirmQuery), req.query).days ?? HISTORY_DAYS_DEFAULT
    const fetches = await fetchHistory(scope, days)
    res.json({ success: true, data: { days, scope: isDemo() ? 'pool' : scope ? 'firm' : 'all', fetches, capped: fetches.length >= FETCH_ROWS_MAX } })
  } catch (err) {
    next(err)
  }
})

router.get('/breakdown', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const scope = await scopeFor(req)
    const [holdings, accounts, firms] = await Promise.all([holdingsBreakdown(scope), demoAccountsBreakdown(), firmsBreakdown()])
    res.json({ success: true, data: { holdings, accounts, firms } })
  } catch (err) {
    next(err)
  }
})

router.get('/notices', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const scope = await scopeFor(req)
    res.json({ success: true, data: await fetchedNotices(scope, parse(NoticesQuery, req.query)) })
  } catch (err) {
    next(err)
  }
})

export default router
