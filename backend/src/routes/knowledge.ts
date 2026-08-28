// =============================================================
// §8.4 — Knowledge search endpoint.
//
// One read across the assets that already exist. No writes live on this
// router, so there is nothing here an agent or an external caller could use to
// change what the firm claims about itself.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { ValidationError } from '../utils/errors'
import {
  KNOWLEDGE_RESULT_TYPES, searchKnowledge, type KnowledgeResultType,
} from '../services/knowledge/knowledgeSearch'

const router = Router()
router.use(authenticateJWT, enforceTenantScope, requireActiveBase)

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

const SearchSchema = z.object({
  q: z.string().trim().min(1).max(200),
  types: z.string().trim().max(400).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
})

router.get('/search', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = SearchSchema.safeParse(req.query ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'A search term is required')

    // An unknown type is refused rather than ignored, so a caller is never told
    // "no results" for a filter the server quietly dropped.
    let types: KnowledgeResultType[] | undefined
    if (parsed.data.types) {
      const requested = parsed.data.types.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
      const unknown = requested.filter((t) => !(KNOWLEDGE_RESULT_TYPES as readonly string[]).includes(t))
      if (unknown.length > 0) throw new ValidationError(`Unknown result type: ${unknown[0]}`)
      types = requested as KnowledgeResultType[]
    }

    const data = await searchKnowledge(consultingFirmId, {
      query: parsed.data.q,
      types,
      includeArchived: parsed.data.includeArchived === 'true',
      limit: parsed.data.limit ?? DEFAULT_LIMIT,
      offset: parsed.data.offset ?? 0,
    })
    res.json({ success: true, data })
  } catch (err) { next(err) }
})

router.get('/search/types', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { types: KNOWLEDGE_RESULT_TYPES } })
  } catch (err) { next(err) }
})

export default router
