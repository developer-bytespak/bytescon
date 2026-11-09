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
import { keyForPath, removeUpload } from '../services/fileStorage'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('state_municipal'))

// =============================================================
// Discovery-feed rows (§6.1A state_local adapter) live in the main
// Opportunity table, not this module's own table. This page is the single
// "everything non-federal" view, so they are merged in here, mapped to the
// same row shape. `origin` tells the UI apart: LOCAL rows (scraper / CSV /
// manual) can be deleted here; FEED rows are managed by the hourly source
// sync and link out via sourceUrl.
// =============================================================
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
}

function jurisdictionToState(jurisdiction: string | null): string {
  if (!jurisdiction) return '—'
  const m = jurisdiction.match(/,\s*([A-Z]{2})\s*$/)
  if (m) return m[1]
  return STATE_NAME_TO_CODE[jurisdiction.trim().toLowerCase()] ?? jurisdiction.slice(0, 2).toUpperCase()
}

function jurisdictionToLevel(jurisdiction: string | null): 'STATE' | 'COUNTY' | 'MUNICIPAL' {
  const j = (jurisdiction ?? '').toLowerCase()
  if (j.includes('county')) return 'COUNTY'
  // "City, ST" labels are municipal; bare state names are state-level.
  if (/,\s*[a-z]{2}\s*$/i.test(jurisdiction ?? '')) return 'MUNICIPAL'
  return 'STATE'
}

interface MergedRow {
  id: string
  title: string
  agency: string
  state: string
  contractLevel: string
  naicsCode: string | null
  estimatedValue: number | string | null
  responseDeadline: Date | null
  solicitationNumber: string | null
  sourceUrl: string | null
  postedAt: Date | null
  origin: 'LOCAL' | 'FEED'
}

async function fetchFeedRows(consultingFirmId: string): Promise<MergedRow[]> {
  const rows = await prisma.opportunity.findMany({
    where: { consultingFirmId, source: 'STATE_LOCAL' },
    select: {
      id: true, title: true, agency: true, naicsCode: true, estimatedValue: true,
      responseDeadline: true, solicitationNumber: true, sourceUrl: true,
      postedDate: true, sourceMetadata: true,
    },
    take: 2000,
  })
  return rows.map((o) => {
    const jurisdiction = ((o.sourceMetadata as Record<string, unknown> | null)?.jurisdiction as string | undefined) ?? null
    return {
      id: o.id,
      title: o.title,
      agency: o.agency,
      state: jurisdictionToState(jurisdiction),
      contractLevel: jurisdictionToLevel(jurisdiction),
      naicsCode: o.naicsCode || null,
      estimatedValue: o.estimatedValue !== null ? Number(o.estimatedValue) : null,
      responseDeadline: o.responseDeadline,
      solicitationNumber: o.solicitationNumber,
      sourceUrl: o.sourceUrl,
      postedAt: o.postedDate,
      origin: 'FEED' as const,
    }
  })
}

// =============================================================
// GET /api/state-municipal/opportunities
// =============================================================
router.get('/opportunities', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { state, level, search, limit = '50', offset = '0' } = req.query as Record<string, string>

    const where: Record<string, unknown> = { consultingFirmId }
    if (state)  where.state         = state
    // NON_FEDERAL is the page default: real state, county and municipal bids;
    // USAspending federal awards are reference data one filter away.
    if (level === 'NON_FEDERAL') where.contractLevel = { not: 'FEDERAL' }
    else if (level) where.contractLevel = level
    if (search) where.title         = { contains: search, mode: 'insensitive' }

    const [localRows, feedRowsAll] = await Promise.all([
      prisma.stateMunicipalOpportunity.findMany({ where, take: 2000 }),
      fetchFeedRows(consultingFirmId),
    ])

    // Feed rows are never FEDERAL, so the NON_FEDERAL page default keeps them.
    const q = (search ?? '').toLowerCase()
    const feedRows = feedRowsAll.filter((r) =>
      (!state || r.state === state) &&
      (!level || level === 'NON_FEDERAL' || r.contractLevel === level) &&
      (!q || r.title.toLowerCase().includes(q)))

    const merged: MergedRow[] = [
      ...localRows.map((o) => ({
        id: o.id, title: o.title, agency: o.agency, state: o.state,
        contractLevel: o.contractLevel as string, naicsCode: o.naicsCode,
        estimatedValue: o.estimatedValue !== null ? Number(o.estimatedValue) : null,
        responseDeadline: o.responseDeadline, solicitationNumber: o.solicitationNumber,
        sourceUrl: o.sourceUrl, postedAt: o.postedAt, origin: 'LOCAL' as const,
      })),
      ...feedRows,
    ]
    // Soonest deadline first; undated rows last, newest of those first.
    merged.sort((a, b) => {
      if (a.responseDeadline && b.responseDeadline) return a.responseDeadline.getTime() - b.responseDeadline.getTime()
      if (a.responseDeadline) return -1
      if (b.responseDeadline) return 1
      return (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0)
    })

    const off = parseInt(offset) || 0
    const lim = parseInt(limit) || 50
    res.json({ success: true, data: { opportunities: merged.slice(off, off + lim), total: merged.length } })
  } catch (err) { next(err) }
})

// =============================================================
// GET /api/state-municipal/stats
// =============================================================
router.get('/stats', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [total, byLevelRaw, byStateRaw, feedRows] = await Promise.all([
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
      fetchFeedRows(consultingFirmId),
    ])

    // Fold the discovery-feed rows into the same aggregate shapes.
    const levelCounts = new Map(byLevelRaw.map((x) => [x.contractLevel as string, x._count._all]))
    const stateCounts = new Map(byStateRaw.map((x) => [x.state, x._count._all]))
    for (const r of feedRows) {
      levelCounts.set(r.contractLevel, (levelCounts.get(r.contractLevel) ?? 0) + 1)
      stateCounts.set(r.state, (stateCounts.get(r.state) ?? 0) + 1)
    }
    const byLevel = [...levelCounts.entries()].map(([contractLevel, n]) => ({ contractLevel, _count: { _all: n } }))
    const byState = [...stateCounts.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([state, n]) => ({ state, _count: { _all: n } }))

    res.json({ success: true, data: { total: total + feedRows.length, byLevel, byState } })
  } catch (err) { next(err) }
})

// =============================================================
// POST /api/state-municipal/sync
// Pull state/municipal contract data from open data sources
// =============================================================
// One status record per firm, kept in this process. A sync runs in the
// web process that accepted it, so the status lives beside it; a restart
// simply reads as "no sync yet".
interface SyncStatus {
  running: boolean
  startedAt?: string
  finishedAt?: string
  fetched?: number
  created?: number
  skipped?: number
  bySource?: Record<string, number | 'failed'>
  error?: string
}
const SYNC_STATUS = new Map<string, SyncStatus>()

router.get('/sync/status', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    res.json({ success: true, data: SYNC_STATUS.get(consultingFirmId) ?? { running: false } })
  } catch (err) { next(err) }
})

router.post('/sync', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    if (SYNC_STATUS.get(consultingFirmId)?.running) {
      return res.status(409).json({ success: false, error: 'A sync is already running for this firm.' })
    }
    const startedAt = new Date().toISOString()
    SYNC_STATUS.set(consultingFirmId, { running: true, startedAt })
    res.json({ success: true, message: 'State & municipal sync started. Pulling procurement contracts (not grants) from public sources.' })
    // Fire and forget; progress is readable at GET /sync/status.
    setImmediate(async () => {
      try {
        const summary = await syncStateMunicipalData(consultingFirmId)
        SYNC_STATUS.set(consultingFirmId, { running: false, startedAt, finishedAt: new Date().toISOString(), ...summary })
      } catch (err) {
        logger.error('State/municipal sync failed', { error: (err as Error).message })
        SYNC_STATUS.set(consultingFirmId, { running: false, startedAt, finishedAt: new Date().toISOString(), error: (err as Error).message })
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
    if (filePath) await removeUpload(keyForPath(filePath))
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
// Sources:
//   NY NYSCR (scraped).
//   FL VBS, CA eProcure, MD eMMA, PA eMarketplace: only with portal logins (env).
//   SAM.gov by state: only with the firm's own SAM key.
// Switched off (2026-11-10), reported to the page with the reason instead of a
// silent 0: TX, VA, GA, NC, OH and IL portals no longer work (dataset removed,
// pages moved, or the site blocks automated access — which we don't bypass), and
// the USAspending fallback, which added past awards to a list of open bids.
// Official open-data feeds are to replace them as Discovery sources.
// =============================================================
interface SyncSummary { fetched: number; created: number; skipped: number; bySource: Record<string, number | 'failed'>; unavailable: Record<string, string> }

/** Portals that no longer work, and why. Shown on the page instead of a silent 0. */
export const UNAVAILABLE_PORTALS: Record<string, string> = {
  tx: 'state removed its data feed',
  va: 'site blocks automated access',
  ga: 'site blocks automated access',
  nc: 'bid pages moved',
  oh: 'bid pages moved',
  il: 'site requires a CAPTCHA',
}
const NEEDS_LOGIN = 'needs portal login'

export async function syncStateMunicipalData(consultingFirmId: string): Promise<SyncSummary> {
  const {
    scrapeNYSCR, scrapeFLVBS, scrapeCAeProcure, scrapeMDEmma, scrapePAeMarketplace, scrapeSamGovByState,
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

  const unavailable: Record<string, string> = { ...UNAVAILABLE_PORTALS }
  // Portals that need a login are only tried when it's set.
  const withLogin = <T,>(key: string, user: string | undefined, pass: string | undefined, run: () => Promise<T[]>): Promise<T[]> => {
    if (user && pass) return run()
    unavailable[key] = NEEDS_LOGIN
    return Promise.resolve([])
  }

  const portals = {
    nyscr: () => scrapeNYSCR(4),
    fl: () => withLogin('fl', flUser, flPass, () => scrapeFLVBS(3, flUser, flPass)),
    ca: () => withLogin('ca', caUser, caPass, () => scrapeCAeProcure(3, caUser, caPass)),
    md: () => withLogin('md', mdUser, mdPass, () => scrapeMDEmma(mdUser, mdPass)),
    pa: () => withLogin('pa', paUser, paPass, () => scrapePAeMarketplace(paUser, paPass)),
  }
  const keys = Object.keys(portals) as Array<keyof typeof portals>
  const results = await Promise.allSettled(keys.map((key) => portals[key]()))

  const allRecords = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  const bySource: Record<string, number | 'failed'> = {}
  keys.forEach((key, i) => {
    if (unavailable[key]) return
    const r = results[i]
    bySource[key] = r.status === 'fulfilled' ? r.value.length : 'failed'
  })
  logger.info('Portal scrapes complete', { total: allRecords.length, bySource, unavailable })

  // SAM.gov by state, only with the firm's own key: the shared key belongs to the platform.
  if (samKey) {
    try {
      const sam = await scrapeSamGovByState(samKey, 20)
      allRecords.push(...sam)
      bySource.sam = sam.length
      logger.info('SAM.gov state scrape complete', { count: sam.length })
    } catch (err) {
      bySource.sam = 'failed'
      logger.warn('SAM.gov scrape failed', { error: (err as Error).message })
    }
  } else {
    unavailable.sam = 'add your own SAM.gov key in Settings'
  }

  // Upsert all collected records
  let created = 0
  let skipped = 0
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

      if (existing) { skipped++; continue }

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

  logger.info('State/municipal sync complete', { consultingFirmId, created, skipped, total: allRecords.length, usedSamApi: !!samKey })
  return { fetched: allRecords.length, created, skipped, bySource, unavailable }
}

export default router
