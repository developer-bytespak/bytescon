// =============================================================
// /api/far/clauses — read-only catalog API for the regulatory
// ontology. Frontend uses this for the FarClauseChip hover-card
// and the catalog browser.
// =============================================================
import { Router, Response } from 'express'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope } from '../middleware/tenant'
import { rejectScopedToken } from '../middleware/rejectScopedToken'
import { AuthenticatedRequest } from '../types'
import {
  ClauseSource,
  findByContractType,
  findBySetAside,
  findByTag,
  findPrerequisites,
  lookup,
} from '../services/far/farCatalogService'

const router = Router()

// Charter §3 ("multi-tenant model is enforced at two layers and must not be
// weakened") — even though this catalog read is global, every authenticated
// route runs through enforceTenantScope for consistency. Scoped tokens are
// rejected because catalog browsing is not part of the gate-3 flow.
router.use(authenticateJWT)
router.use(requireActiveBase, requireAddon('contract_analysis'))
router.use(enforceTenantScope)
router.use(rejectScopedToken)

/**
 * GET /api/far/clauses?source=FAR&contractType=FFP&setAside=SDVOSB&tag=CYBERSECURITY
 * Filter clauses by any combination of source, contract type, set-aside, tag.
 */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const source = (req.query.source as ClauseSource | undefined) ?? undefined
  const contractType = req.query.contractType as string | undefined
  const setAside = req.query.setAside as string | undefined
  const tag = req.query.tag as string | undefined

  let results

  if (contractType) {
    results = await findByContractType(contractType, source)
  } else if (setAside) {
    results = await findBySetAside(setAside, source)
  } else if (tag) {
    results = await findByTag(tag, source)
  } else {
    res.status(400).json({
      success: false,
      error: 'At least one filter required: contractType | setAside | tag',
    })
    return
  }

  res.json({ success: true, count: results.length, data: results })
})

/**
 * GET /api/far/clauses/:source/:code
 * Look up a single clause + its prerequisites.
 */
router.get('/:source/:code', async (req: AuthenticatedRequest, res: Response) => {
  const source = req.params.source.toUpperCase() as ClauseSource
  const code = req.params.code

  if (!['FAR', 'DFARS', 'NIST', 'CMMC', 'SECTION_508'].includes(source)) {
    res.status(400).json({ success: false, error: 'Invalid source. Use FAR, DFARS, NIST, CMMC, or SECTION_508.' })
    return
  }

  const clause = await lookup(code, source)
  if (!clause) {
    res.status(404).json({ success: false, error: 'Clause not found' })
    return
  }

  const prerequisites = await findPrerequisites(code, source)

  res.json({
    success: true,
    data: {
      ...clause,
      prerequisites,
    },
  })
})

export default router
