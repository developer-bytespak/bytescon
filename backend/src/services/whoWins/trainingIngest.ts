// =============================================================
// Who-Wins — training-data ingest from USAspending award summaries.
//
// Endpoint: POST /api/v2/download/awards/ (async CSV generation).
// This is the ADVANCED-SEARCH download — it honors a flat naics_codes
// array and per-column selection (both validated live 2026-07-02).
// The superficially similar /bulk_download/awards/ SILENTLY DROPS a
// naics filter (same failure mode as the type_set_aside filter noted
// in usaspendingPull.ts) — do not switch endpoints casually.
//
// Flow per (NAICS batch × fiscal year): request → poll status →
// download zip → parse Contracts_PrimeAwardSummaries_*.csv → filter to
// competed base awards → upsert by awardKey. Chunking keeps every file
// far below the server's 500k-row cap and lets a failed chunk retry
// without losing the run. See docs/WHO_WINS_MODEL.md §2.
// =============================================================

import axios from 'axios'
import AdmZip from 'adm-zip'
import { randomUUID } from 'crypto'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { parseCsv } from './csv'

const USA_SPENDING_BASE = process.env.USASPENDING_BASE_URL || 'https://api.usaspending.gov/api/v2'

/** Competed-award family — the only records where a "win" event exists.
 *  B/C/G/NDO (not competed / not available) are a different process. */
const COMPETED_EXTENTS = new Set(['A', 'D', 'E', 'F', 'CDO'])

/** Award-summary column names — validated against the live d1 layout. */
const COLUMNS = [
  'award_id_piid',
  'naics_code',
  'awarding_agency_code',
  'awarding_agency_name',
  'type_of_set_aside_code',
  'extent_competed_code',
  'number_of_offers_received',
  'recipient_uei',
  'recipient_parent_uei',
  'recipient_name',
  'recipient_state_code',
  'total_obligated_amount',
  'award_base_action_date',
  'award_base_action_date_fiscal_year',
]

export interface IngestOptions {
  /** 6-digit NAICS codes to pull. */
  naicsCodes: string[]
  /** Inclusive fiscal-year span, e.g. 2022..2026. */
  fyStart: number
  fyEnd: number
  /** Floor on total obligated dollars — match the market the product scores. */
  minObligated?: number
  /** NAICS codes per download request. */
  batchSize?: number
  /** Max minutes to wait for one file to generate server-side. */
  pollTimeoutMinutes?: number
}

export interface IngestResult {
  ingestBatchId: string
  requests: number
  failedChunks: { naics: string[]; fy: number; error: string }[]
  rowsSeen: number
  rowsKept: number
  rowsInserted: number
}

/** The NAICS universe the product actually scores: every client's registered
 *  codes plus every NAICS on an ingested opportunity — platform-wide. */
export async function resolveNaicsUniverse(): Promise<string[]> {
  const [clients, opps] = await Promise.all([
    prisma.clientCompany.findMany({ select: { naicsCodes: true } }),
    prisma.opportunity.findMany({
      select: { naicsCode: true },
      distinct: ['naicsCode'],
    }),
  ])
  const set = new Set<string>()
  for (const c of clients) for (const code of c.naicsCodes) {
    const clean = code.replace(/\D/g, '')
    if (isValidNaics(clean)) set.add(clean)
  }
  for (const o of opps) {
    const clean = (o.naicsCode ?? '').replace(/\D/g, '')
    if (isValidNaics(clean)) set.add(clean)
  }
  return [...set].sort()
}

/** Real NAICS sectors span 11–92; garbage codes like "000000" (seen in
 *  client records) make USAspending reject the ENTIRE batch request with
 *  InvalidParameterException — one bad code poisons 25 good ones. */
export function isValidNaics(code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false
  const sector = Number(code.slice(0, 2))
  return sector >= 11 && sector <= 92
}

/** US federal FY n runs (n-1)-10-01 .. n-09-30. */
function fyDates(fy: number): { start_date: string; end_date: string } {
  return { start_date: `${fy - 1}-10-01`, end_date: `${fy}-09-30` }
}

async function requestDownload(naics: string[], fy: number): Promise<{ fileName: string; fileUrl: string }> {
  const resp = await axios.post(
    `${USA_SPENDING_BASE}/download/awards/`,
    {
      filters: {
        award_type_codes: ['A', 'B', 'C', 'D'],
        time_period: [fyDates(fy)],
        naics_codes: naics,
      },
      columns: COLUMNS,
      file_format: 'csv',
    },
    { timeout: 60_000 },
  )
  const fileName = resp.data?.file_name
  const fileUrl = resp.data?.file_url
  if (!fileName || !fileUrl) throw new Error('download request returned no file_name')
  // Guard against silently-dropped filters: the API echoes the accepted
  // request — if naics_codes is missing there, we'd ingest the whole
  // government-wide corpus for the window.
  const echoed = resp.data?.download_request?.filters?.naics_codes
  if (!Array.isArray(echoed) || echoed.length === 0) {
    throw new Error('USAspending dropped the naics_codes filter — aborting chunk')
  }
  return { fileName, fileUrl }
}

async function waitForFile(fileName: string, timeoutMinutes: number): Promise<void> {
  const deadline = Date.now() + timeoutMinutes * 60_000
  // Poll gently — file generation is server-side work we can't speed up.
  while (Date.now() < deadline) {
    const resp = await axios.get(`${USA_SPENDING_BASE}/download/status`, {
      params: { file_name: fileName },
      timeout: 30_000,
    })
    const status = resp.data?.status
    if (status === 'finished') return
    if (status === 'failed') throw new Error(`download generation failed: ${String(resp.data?.message).slice(0, 200)}`)
    await new Promise((r) => setTimeout(r, 15_000))
  }
  throw new Error(`download not ready after ${timeoutMinutes} minutes`)
}

interface ParsedAward {
  awardKey: string
  piid: string
  naicsCode: string
  agencyCode: string | null
  agencyName: string | null
  setAsideCode: string | null
  extentCompetedCode: string | null
  offersReceived: number | null
  recipientUei: string
  recipientParentUei: string | null
  recipientName: string | null
  recipientStateCode: string | null
  obligatedAmount: number
  actionDate: Date
  fiscalYear: number
}

function parseRow(r: Record<string, string>, minObligated: number): ParsedAward | null {
  const extent = (r.extent_competed_code ?? '').trim().toUpperCase()
  if (!COMPETED_EXTENTS.has(extent)) return null

  const naics = (r.naics_code ?? '').replace(/\D/g, '')
  if (naics.length !== 6) return null

  const uei = (r.recipient_uei ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{12}$/.test(uei)) return null

  const piid = (r.award_id_piid ?? '').trim()
  if (!piid) return null

  const obligated = Number(r.total_obligated_amount)
  if (!Number.isFinite(obligated) || obligated < minObligated) return null

  const actionDate = new Date((r.award_base_action_date ?? '').slice(0, 10) + 'T00:00:00.000Z')
  if (Number.isNaN(actionDate.getTime())) return null
  const fy = Number(r.award_base_action_date_fiscal_year)
  if (!Number.isFinite(fy) || fy < 2000 || fy > 2100) return null

  // Winsorize offers to [1, 50]: FPDS values are CO-keyed and occasionally
  // junk (0, 999, blank). Null = not reported — kept for experience counting,
  // excluded from offers statistics downstream.
  let offers: number | null = null
  const rawOffers = Number(r.number_of_offers_received)
  if (Number.isFinite(rawOffers) && rawOffers >= 1) offers = Math.min(Math.round(rawOffers), 50)

  const agencyCode = (r.awarding_agency_code ?? '').trim() || null
  return {
    awardKey: `${agencyCode ?? 'NA'}:${piid}`,
    piid,
    naicsCode: naics,
    agencyCode,
    agencyName: (r.awarding_agency_name ?? '').trim() || null,
    setAsideCode: (r.type_of_set_aside_code ?? '').trim().toUpperCase() || null,
    extentCompetedCode: extent,
    offersReceived: offers,
    recipientUei: uei,
    recipientParentUei: (r.recipient_parent_uei ?? '').trim().toUpperCase() || null,
    recipientName: (r.recipient_name ?? '').trim() || null,
    recipientStateCode: (r.recipient_state_code ?? '').trim().toUpperCase() || null,
    obligatedAmount: Math.round(obligated * 100) / 100,
    actionDate,
    fiscalYear: fy,
  }
}

/** Pull, filter, and stage the training corpus. Sequential chunks — the
 *  generation work is server-side, and USAspending throttles aggressive
 *  clients (see the 2026-05-26 lesson in awardEnrichment.ts). */
export async function runTrainingIngest(opts: IngestOptions): Promise<IngestResult> {
  const {
    naicsCodes, fyStart, fyEnd,
    minObligated = 10_000,
    batchSize = 25,
    pollTimeoutMinutes = 30,
  } = opts

  const ingestBatchId = randomUUID()
  const result: IngestResult = {
    ingestBatchId, requests: 0, failedChunks: [], rowsSeen: 0, rowsKept: 0, rowsInserted: 0,
  }

  const batches: string[][] = []
  for (let i = 0; i < naicsCodes.length; i += batchSize) {
    batches.push(naicsCodes.slice(i, i + batchSize))
  }

  const totalChunks = batches.length * (fyEnd - fyStart + 1)
  let chunkNo = 0

  const runChunk = async (batch: string[], fy: number): Promise<number> => {
    const { fileName, fileUrl } = await requestDownload(batch, fy)
    await waitForFile(fileName, pollTimeoutMinutes)

    const zipResp = await axios.get<ArrayBuffer>(fileUrl, {
      responseType: 'arraybuffer',
      timeout: 300_000,
      maxContentLength: 1_500_000_000,
    })
    const zip = new AdmZip(Buffer.from(zipResp.data))

    const kept: ParsedAward[] = []
    for (const entry of zip.getEntries()) {
      // The zip also contains a Subawards CSV — ignore it.
      if (!/PrimeAwardSummaries.*\.csv$/i.test(entry.entryName)) continue
      const rows = parseCsv(entry.getData().toString('utf-8'))
      result.rowsSeen += rows.length
      for (const r of rows) {
        const parsed = parseRow(r, minObligated)
        if (parsed) kept.push(parsed)
      }
    }
    result.rowsKept += kept.length

    let inserted = 0
    for (let i = 0; i < kept.length; i += 1000) {
      const chunk = kept.slice(i, i + 1000)
      const created = await prisma.publicAwardTraining.createMany({
        data: chunk.map((a) => ({ ...a, ingestBatchId })),
        skipDuplicates: true, // idempotent by awardKey across FY-overlap + re-runs
      })
      inserted += created.count
    }
    result.rowsInserted += inserted
    return inserted
  }

  const skipCovered = process.env.WHO_WINS_FORCE_REFETCH !== 'true'
  const spacingMs = Number(process.env.WHO_WINS_CHUNK_SPACING_MS || 15_000)
  const cooloffMs = Number(process.env.WHO_WINS_COOLOFF_MS || 300_000)
  const maxRetries = 2

  for (const batch of batches) {
    for (let fy = fyStart; fy <= fyEnd; fy++) {
      result.requests++
      chunkNo++

      // Skip chunks whose data is already staged (idempotent re-runs walk the
      // whole plan; re-downloading a covered chunk costs 1-3 min of server
      // generation for zero new rows AND burns rate-limit budget). A 25-code
      // batch × FY with zero rows government-wide doesn't happen for real
      // NAICS, so rows-exist is a safe coverage signal.
      if (skipCovered) {
        const existing = await prisma.publicAwardTraining.count({
          where: { naicsCode: { in: batch }, fiscalYear: fy },
        })
        if (existing > 0) {
          console.log(`[whoWins ingest] chunk ${chunkNo}/${totalChunks} FY${fy} already covered (${existing} rows) — skipped`)
          continue
        }
      }

      // Retries with a long cooling-off: once USAspending's connection
      // throttle engages ("socket hang up"), short waits don't clear it —
      // 147/160 chunks died that way on a rapid full-universe re-walk.
      let attempt = 0
      for (;;) {
        try {
          const inserted = await runChunk(batch, fy)
          // stdout progress — winston output is invisible from detached
          // container execs, which made a healthy 2-hour run look hung.
          console.log(`[whoWins ingest] chunk ${chunkNo}/${totalChunks} FY${fy} ok — +${inserted} rows (total ${result.rowsInserted})`)
          break
        } catch (err) {
          const msg = (err as Error).message
          const transient = /socket hang up|ECONNRESET|500|timeout/i.test(msg)
          if (transient && attempt < maxRetries) {
            attempt++
            console.log(`[whoWins ingest] chunk ${chunkNo}/${totalChunks} FY${fy} transient failure (${msg.slice(0, 60)}) — cooling off ${Math.round(cooloffMs / 1000)}s (retry ${attempt}/${maxRetries})`)
            await new Promise((r) => setTimeout(r, cooloffMs))
            continue
          }
          result.failedChunks.push({ naics: batch, fy, error: msg })
          console.log(`[whoWins ingest] chunk ${chunkNo}/${totalChunks} FY${fy} FAILED: ${msg.slice(0, 120)}`)
          logger.warn('WhoWins ingest chunk failed — continuing', { fy, naics: batch.slice(0, 3), error: msg })
          break
        }
      }
      // Polite inter-chunk spacing.
      await new Promise((r) => setTimeout(r, spacingMs))
    }
  }

  return result
}
