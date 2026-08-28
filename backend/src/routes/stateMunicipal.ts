// =============================================================
// State & Municipal Opportunities Route
// Manages state/county/municipal government contract pipeline
// =============================================================
import { Router, Response, NextFunction } from 'express'
import fs from 'fs'
import { prisma } from '../config/database'
import { decryptSecret } from '../utils/fieldCrypto'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { upload } from '../middleware/upload'
import { logger } from '../utils/logger'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('state_municipal'))

// =============================================================
// GET /api/state-municipal/opportunities
// =============================================================
router.get('/opportunities', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { state, level, search, limit = '50', offset = '0' } = req.query as Record<string, string>

    const where: Record<string, unknown> = { consultingFirmId }
    if (state)  where.state         = state
    if (level)  where.contractLevel = level
    if (search) where.title         = { contains: search, mode: 'insensitive' }

    const [opportunities, total] = await Promise.all([
      prisma.stateMunicipalOpportunity.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.stateMunicipalOpportunity.count({ where }),
    ])

    res.json({ success: true, data: { opportunities, total } })
  } catch (err) { next(err) }
})

// =============================================================
// GET /api/state-municipal/stats
// =============================================================
router.get('/stats', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [total, byLevel, byState] = await Promise.all([
      prisma.stateMunicipalOpportunity.count({ where: { consultingFirmId } }),
      prisma.stateMunicipalOpportunity.groupBy({
        by: ['contractLevel'],
        where: { consultingFirmId },
        _count: { _all: true },
      }),
      prisma.stateMunicipalOpportunity.groupBy({
        by: ['state'],
        where: { consultingFirmId },
        _count: { _all: true },
        orderBy: { _count: { state: 'desc' } },
        take: 10,
      }),
    ])
    res.json({ success: true, data: { total, byLevel, byState } })
  } catch (err) { next(err) }
})

// =============================================================
// POST /api/state-municipal/sync
// Pull state/municipal contract data from open data sources
// =============================================================
router.post('/sync', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    res.json({ success: true, message: 'State & municipal sync started. Pulling procurement contracts (not grants) from open data sources.' })

    // Fire and forget — pull from SAM.gov or USAspending contracts
    setImmediate(async () => {
      try {
        await syncStateMunicipalData(consultingFirmId)
      } catch (err) {
        logger.error('State/municipal sync failed', { error: (err as Error).message })
      }
    })
  } catch (err) { next(err) }
})

// DELETE /api/state-municipal/all — wipe all auto-synced records for this firm
router.delete('/all', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { count } = await prisma.stateMunicipalOpportunity.deleteMany({ where: { consultingFirmId } })
    logger.info('State/municipal data cleared', { consultingFirmId, count })
    res.json({ success: true, deleted: count })
  } catch (err) { next(err) }
})

// =============================================================
// POST /api/state-municipal/import
// Accepts: CSV or Excel file export from any state portal.
// Auto-detects common column names, deduplicates, returns preview
// stats. Body param ?preview=true returns rows without saving.
// =============================================================

/** Maps common state portal column name variants → our field names */
const COL_MAP: Record<string, string> = {
  // title
  title: 'title', 'bid title': 'title', 'solicitation title': 'title',
  'opportunity title': 'title', 'project title': 'title', description: 'title',
  'bid description': 'title', 'item description': 'title', 'contract title': 'title',
  'short description': 'title', name: 'title',
  // agency
  agency: 'agency', 'agency name': 'agency', department: 'agency',
  'department name': 'agency', 'issuing agency': 'agency', 'buying agency': 'agency',
  organization: 'agency', 'org name': 'agency', buyer: 'agency',
  // state
  state: 'state', 'state code': 'state', 'place of performance state': 'state',
  'pop state': 'state', 'performance state': 'state',
  // solicitation number
  'solicitation number': 'solicitationNumber', 'bid number': 'solicitationNumber',
  'rfp number': 'solicitationNumber', 'rfq number': 'solicitationNumber',
  'contract number': 'solicitationNumber', 'opportunity number': 'solicitationNumber',
  'solicitation #': 'solicitationNumber', 'bid #': 'solicitationNumber',
  id: 'solicitationNumber', 'bid id': 'solicitationNumber', 'event id': 'solicitationNumber',
  // response deadline
  'response deadline': 'responseDeadline', 'due date': 'responseDeadline',
  'close date': 'responseDeadline', 'closing date': 'responseDeadline',
  'submission deadline': 'responseDeadline', 'bid due date': 'responseDeadline',
  'bid close date': 'responseDeadline', 'end date': 'responseDeadline',
  'rfp close date': 'responseDeadline', 'expiration date': 'responseDeadline',
  // estimated value
  'estimated value': 'estimatedValue', 'award amount': 'estimatedValue',
  'contract value': 'estimatedValue', 'contract amount': 'estimatedValue',
  'bid amount': 'estimatedValue', 'estimated contract value': 'estimatedValue',
  value: 'estimatedValue', amount: 'estimatedValue',
  // naics
  'naics code': 'naicsCode', naics: 'naicsCode', 'naics #': 'naicsCode',
  'commodity code': 'naicsCode', 'unspsc code': 'naicsCode',
  // contact email
  'contact email': 'contactEmail', 'buyer email': 'contactEmail',
  email: 'contactEmail', 'point of contact email': 'contactEmail',
  // source url
  'source url': 'sourceUrl', url: 'sourceUrl', link: 'sourceUrl',
  'solicitation url': 'sourceUrl', 'bid url': 'sourceUrl',
  // posted date
  'posted date': 'postedAt', 'issue date': 'postedAt', 'open date': 'postedAt',
  'publish date': 'postedAt', 'start date': 'postedAt',
  // contract level
  level: 'contractLevel', 'contract level': 'contractLevel', type: 'contractLevel',
  'government level': 'contractLevel',
}

/** Normalise a column header for lookup */
function normHeader(h: string): string {
  return h.toLowerCase().replace(/[_\-\/\\]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Parse a dollar string → number or null */
function parseMoney(v: string): number | null {
  if (!v) return null
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''))
  return isNaN(n) ? null : n
}

/** Infer US state 2-letter code from a cell value */
function inferState(v: string): string | null {
  const clean = String(v || '').trim().toUpperCase()
  const STATE_NAMES: Record<string, string> = {
    ALABAMA:'AL',ALASKA:'AK',ARIZONA:'AZ',ARKANSAS:'AR',CALIFORNIA:'CA',
    COLORADO:'CO',CONNECTICUT:'CT',DELAWARE:'DE',FLORIDA:'FL',GEORGIA:'GA',
    HAWAII:'HI',IDAHO:'ID',ILLINOIS:'IL',INDIANA:'IN',IOWA:'IA',KANSAS:'KS',
    KENTUCKY:'KY',LOUISIANA:'LA',MAINE:'ME',MARYLAND:'MD',MASSACHUSETTS:'MA',
    MICHIGAN:'MI',MINNESOTA:'MN',MISSISSIPPI:'MS',MISSOURI:'MO',MONTANA:'MT',
    NEBRASKA:'NE',NEVADA:'NV','NEW HAMPSHIRE':'NH','NEW JERSEY':'NJ',
    'NEW MEXICO':'NM','NEW YORK':'NY','NORTH CAROLINA':'NC','NORTH DAKOTA':'ND',
    OHIO:'OH',OKLAHOMA:'OK',OREGON:'OR',PENNSYLVANIA:'PA','RHODE ISLAND':'RI',
    'SOUTH CAROLINA':'SC','SOUTH DAKOTA':'SD',TENNESSEE:'TN',TEXAS:'TX',
    UTAH:'UT',VERMONT:'VT',VIRGINIA:'VA',WASHINGTON:'WA','WEST VIRGINIA':'WV',
    WISCONSIN:'WI',WYOMING:'WY',
  }
  if (clean.length === 2 && STATE_NAMES[Object.keys(STATE_NAMES).find(k => STATE_NAMES[k] === clean) || '']) return clean
  if (clean.length === 2) return clean  // assume it's already a code
  return STATE_NAMES[clean] ?? null
}

router.post('/import', upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  let filePath: string | null = null
  try {
    const consultingFirmId = getTenantId(req)
    const isPreview = req.query.preview === 'true'
    const defaultState = (req.body.defaultState as string || '').toUpperCase().slice(0, 2) || null

    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' })
    filePath = req.file.path

    // Parse file into rows
    let rows: Record<string, string>[] = []
    const ext = req.file.originalname.toLowerCase().split('.').pop() || ''

    if (ext === 'csv' || ext === 'txt') {
      const text = fs.readFileSync(filePath, 'utf-8')
      const lines = text.split(/\r?\n/).filter(l => l.trim())
      if (lines.length < 2) return res.status(400).json({ success: false, error: 'File has no data rows' })
      const headers = lines[0].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(h => h.replace(/^"|"$/g, '').trim())
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(v => v.replace(/^"|"$/g, '').trim())
        const row: Record<string, string> = {}
        headers.forEach((h, idx) => { row[h] = vals[idx] ?? '' })
        rows.push(row)
      }
    } else {
      // Excel — dynamic import so xlsx isn't required at startup
      const XLSX = await import('xlsx')
      const wb = XLSX.readFile(filePath, { cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '', raw: false })
    }

    // Map columns
    const sampleRow = rows[0] || {}
    const colMapping: Record<string, string> = {}  // originalCol → ourField
    for (const col of Object.keys(sampleRow)) {
      const field = COL_MAP[normHeader(col)]
      if (field) colMapping[col] = field
    }

    // Build mapped records
    const mapped = rows.map(row => {
      const r: Record<string, string> = {}
      for (const [orig, field] of Object.entries(colMapping)) {
        if (row[orig]) r[field] = row[orig]
      }
      return r
    }).filter(r => r.title && r.title.length > 3)

    if (isPreview) {
      return res.json({
        success: true,
        totalRows: rows.length,
        mappableRows: mapped.length,
        columnMapping: colMapping,
        detectedColumns: Object.keys(sampleRow),
        sample: mapped.slice(0, 5),
      })
    }

    // Upsert records
    let imported = 0
    let skipped = 0
    const errors: string[] = []

    for (const r of mapped) {
      try {
        const state = inferState(r.state || defaultState || '') || defaultState || 'XX'
        const title = r.title.slice(0, 500)
        const agency = (r.agency || 'Unknown Agency').slice(0, 255)
        const solicitationNumber = r.solicitationNumber?.slice(0, 100) || null

        // Dedup check
        const existing = solicitationNumber
          ? await prisma.stateMunicipalOpportunity.findFirst({
              where: { consultingFirmId, solicitationNumber, state },
            })
          : await prisma.stateMunicipalOpportunity.findFirst({
              where: { consultingFirmId, title, agency, state },
            })

        if (existing) { skipped++; continue }

        const levelRaw = (r.contractLevel || '').toUpperCase()
        const contractLevel = (['STATE', 'MUNICIPAL', 'COUNTY', 'FEDERAL'].includes(levelRaw) ? levelRaw : 'STATE') as 'STATE' | 'MUNICIPAL' | 'COUNTY' | 'FEDERAL'

        const responseDeadline = r.responseDeadline ? new Date(r.responseDeadline) : null
        const postedAt = r.postedAt ? new Date(r.postedAt) : null
        const estimatedValue = parseMoney(r.estimatedValue || '')

        await prisma.stateMunicipalOpportunity.create({
          data: {
            consultingFirmId, title, agency, state, contractLevel,
            naicsCode: r.naicsCode?.slice(0, 20) || null,
            estimatedValue: estimatedValue && !isNaN(estimatedValue) ? estimatedValue : null,
            responseDeadline: responseDeadline && !isNaN(responseDeadline.getTime()) ? responseDeadline : null,
            description: null,
            solicitationNumber,
            contactEmail: r.contactEmail?.slice(0, 255) || null,
            sourceUrl: r.sourceUrl?.slice(0, 500) || null,
            status: 'ACTIVE',
            postedAt: postedAt && !isNaN(postedAt.getTime()) ? postedAt : null,
          },
        })
        imported++
      } catch (err) {
        errors.push(`Row "${r.title?.slice(0, 40)}": ${(err as Error).message}`)
        if (errors.length > 10) break
      }
    }

    logger.info('State/municipal bulk import complete', { consultingFirmId, imported, skipped, errors: errors.length })
    res.json({ success: true, imported, skipped, errors: errors.slice(0, 5) })
  } catch (err) {
    next(err)
  } finally {
    if (filePath) try { fs.unlinkSync(filePath) } catch {}
  }
})

// =============================================================
// POST /api/state-municipal/opportunities  (manual add)
// =============================================================
router.post('/opportunities', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { title, agency, state, contractLevel, naicsCode, estimatedValue,
            responseDeadline, description, solicitationNumber, contactEmail, sourceUrl } = req.body

    if (!title || !agency || !state) {
      return res.status(400).json({ success: false, error: 'title, agency, and state are required' })
    }

    const opp = await prisma.stateMunicipalOpportunity.create({
      data: {
        consultingFirmId, title, agency, state,
        contractLevel: contractLevel ?? 'STATE',
        naicsCode: naicsCode ?? null,
        estimatedValue: estimatedValue ? parseFloat(estimatedValue) : null,
        responseDeadline: responseDeadline ? new Date(responseDeadline) : null,
        description: description ?? null,
        solicitationNumber: solicitationNumber ?? null,
        contactEmail: contactEmail ?? null,
        sourceUrl: sourceUrl ?? null,
      },
    })
    res.status(201).json({ success: true, data: opp })
  } catch (err) { next(err) }
})

// =============================================================
// DELETE /api/state-municipal/opportunities/:id
// =============================================================
router.delete('/opportunities/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.stateMunicipalOpportunity.findFirst({
      where: { id: req.params.id, consultingFirmId },
    })
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' })
    await prisma.stateMunicipalOpportunity.delete({ where: { id: req.params.id } })
    res.json({ success: true })
  } catch (err) { next(err) }
})

// =============================================================
// Internal: sync state/municipal PROCUREMENT CONTRACTS
// Sources (in priority order):
//   Always: NY NYSCR, TX ESBD, FL VBS, VA eVA, GA GPR, NC, OH, IL, CA
//   With SAM key: SAM.gov API for all 20 states
//   Auth optional: MD eMMA, PA eMarketplace (creds from env)
//   Fallback (no SAM key): USAspending contracts A/B/C/D
// =============================================================
async function syncStateMunicipalData(consultingFirmId: string): Promise<void> {
  const {
    scrapeNYSCR, scrapeTXESBD, scrapeFLVBS, scrapeVAeVA, scrapeGAGPR,
    scrapeNCIPS, scrapeOHProcurement, scrapeILBidBuy, scrapeCAeProcure,
    scrapeMDEmma, scrapePAeMarketplace,
    scrapeSamGovByState, scrapeUSAspendingContracts, TOP_20_STATES,
  } = await import('../services/stateProcurementScraper')

  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { samApiKey: true },
  })
  const samKey = decryptSecret(firm?.samApiKey ?? null)

  // Portal credentials from environment
  const caUser  = process.env.PORTAL_CA_USER
  const caPass  = process.env.PORTAL_CA_PASS
  const flUser  = process.env.PORTAL_FL_USER
  const flPass  = process.env.PORTAL_FL_PASS
  const mdUser  = process.env.PORTAL_MD_USER
  const mdPass  = process.env.PORTAL_MD_PASS
  const paUser  = process.env.PORTAL_PA_USER
  const paPass  = process.env.PORTAL_PA_PASS

  // Run all portal scrapers in parallel
  const [nyscr, txEsbd, flVbs, vaEva, gaGpr, ncIps, ohProc, ilBid, caEpro, mdEmma, paEmkt] =
    await Promise.allSettled([
      scrapeNYSCR(4),
      scrapeTXESBD(3),
      scrapeFLVBS(3, flUser, flPass),
      scrapeVAeVA(),
      scrapeGAGPR(3),
      scrapeNCIPS(3),
      scrapeOHProcurement(3),
      scrapeILBidBuy(3),
      scrapeCAeProcure(3, caUser, caPass),
      scrapeMDEmma(mdUser, mdPass),
      scrapePAeMarketplace(paUser, paPass),
    ])

  const allRecords = [
    ...(nyscr.status === 'fulfilled'   ? nyscr.value   : []),
    ...(txEsbd.status === 'fulfilled'  ? txEsbd.value  : []),
    ...(flVbs.status === 'fulfilled'   ? flVbs.value   : []),
    ...(vaEva.status === 'fulfilled'   ? vaEva.value   : []),
    ...(gaGpr.status === 'fulfilled'   ? gaGpr.value   : []),
    ...(ncIps.status === 'fulfilled'   ? ncIps.value   : []),
    ...(ohProc.status === 'fulfilled'  ? ohProc.value  : []),
    ...(ilBid.status === 'fulfilled'   ? ilBid.value   : []),
    ...(caEpro.status === 'fulfilled'  ? caEpro.value  : []),
    ...(mdEmma.status === 'fulfilled'  ? mdEmma.value  : []),
    ...(paEmkt.status === 'fulfilled'  ? paEmkt.value  : []),
  ]

  logger.info('Portal scrapes complete', {
    total: allRecords.length,
    bySource: {
      nyscr: nyscr.status === 'fulfilled' ? nyscr.value.length : 'failed',
      tx:    txEsbd.status === 'fulfilled' ? txEsbd.value.length : 'failed',
      fl:    flVbs.status === 'fulfilled' ? flVbs.value.length : 'failed',
      va:    vaEva.status === 'fulfilled' ? vaEva.value.length : 'failed',
      ga:    gaGpr.status === 'fulfilled' ? gaGpr.value.length : 'failed',
      nc:    ncIps.status === 'fulfilled' ? ncIps.value.length : 'failed',
      oh:    ohProc.status === 'fulfilled' ? ohProc.value.length : 'failed',
      il:    ilBid.status === 'fulfilled' ? ilBid.value.length : 'failed',
      ca:    caEpro.status === 'fulfilled' ? caEpro.value.length : 'failed',
      md:    mdEmma.status === 'fulfilled' ? mdEmma.value.length : 'failed',
      pa:    paEmkt.status === 'fulfilled' ? paEmkt.value.length : 'failed',
    },
  })

  // Add SAM.gov or USAspending on top
  if (samKey) {
    try {
      const sam = await scrapeSamGovByState(samKey, 20)
      allRecords.push(...sam)
      logger.info('SAM.gov state scrape complete', { count: sam.length })
    } catch (err) {
      logger.warn('SAM.gov scrape failed', { error: (err as Error).message })
    }
  } else {
    try {
      const usa = await scrapeUSAspendingContracts(TOP_20_STATES.slice(0, 10))
      allRecords.push(...usa)
      logger.info('USAspending scrape complete', { count: usa.length })
    } catch (err) {
      logger.warn('USAspending scrape failed', { error: (err as Error).message })
    }
  }

  // Upsert all collected records
  let created = 0
  for (const rec of allRecords) {
    try {
      // Dedup: match on solicitationNumber+state or title+agency+state
      const existing = rec.solicitationNumber
        ? await prisma.stateMunicipalOpportunity.findFirst({
            where: { consultingFirmId, solicitationNumber: rec.solicitationNumber, state: rec.state },
          })
        : await prisma.stateMunicipalOpportunity.findFirst({
            where: { consultingFirmId, title: rec.title, agency: rec.agency, state: rec.state },
          })

      if (existing) continue

      await prisma.stateMunicipalOpportunity.create({
        data: {
          consultingFirmId,
          title: rec.title,
          agency: rec.agency,
          state: rec.state,
          contractLevel: rec.contractLevel,
          naicsCode: rec.naicsCode ?? null,
          estimatedValue: rec.estimatedValue ?? null,
          responseDeadline: rec.responseDeadline ?? null,
          description: rec.description ?? null,
          solicitationNumber: rec.solicitationNumber ?? null,
          contactEmail: rec.contactEmail ?? null,
          sourceUrl: rec.sourceUrl ?? null,
          status: 'ACTIVE',
          postedAt: rec.postedAt ?? null,
        },
      })
      created++
    } catch (err) {
      logger.warn('Failed to upsert state/municipal record', { title: rec.title, error: (err as Error).message })
    }
  }

  logger.info('State/municipal sync complete', { consultingFirmId, created, total: allRecords.length, usedSamApi: !!samKey })
}

export default router
