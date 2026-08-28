// =============================================================
// BigQuery Ingestion Service
// Pulls award data from USAspending API → BigQuery award_history
//
// USAspending is free public data. BigQuery is the compute layer
// that enables complex SQL analytics beyond what the REST API
// supports (aggregations, window functions, cross-NAICS joins).
// =============================================================
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'
import { getBigQuery, GCP_PROJECT_ID, BQ_DATASET, BQ_TABLES } from '../../config/bigquery'
import { logger } from '../../utils/logger'

const USA_SPENDING_BASE = process.env.USASPENDING_BASE_URL || 'https://api.usaspending.gov/api/v2'

export interface IngestionResult {
  naicsCode: string
  agency?: string
  rowsInserted: number
  skipped: number
  durationMs: number
}

/**
 * Pull USAspending awards for a NAICS code (+ optional agency) and load into BigQuery.
 * Fetches up to `maxPages` pages of 100 records each (default: 5 pages = 500 rows).
 *
 * Idempotent by contractNumber — duplicate rows are skipped via DELETE+INSERT pattern
 * once we have enough data. For Phase 1, inserts are append-only (duplicate rows
 * don't distort aggregates since analytics queries use DISTINCT or GROUP BY).
 */
export async function ingestAwardsForNaics(params: {
  naicsCode: string
  agency?: string
  maxPages?: number
  yearsBack?: number
}): Promise<IngestionResult> {
  const { naicsCode, agency, maxPages = 5, yearsBack = 5 } = params
  const startMs = Date.now()

  const endDate = new Date().toISOString().split('T')[0]
  const startDate = new Date(Date.now() - yearsBack * 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0]

  const filters: Record<string, unknown> = {
    time_period: [{ start_date: startDate, end_date: endDate }],
    naics_codes: [naicsCode],
    award_type_codes: ['A', 'B', 'C', 'D'],
  }

  if (agency) {
    const normalizedAgency = normalizeAgencyName(agency)
    filters.agencies = [{ type: 'awarding', tier: 'toptier', name: normalizedAgency }]
  }

  const rows: Record<string, unknown>[] = []
  let page = 1
  let hasMore = true

  while (hasMore && page <= maxPages) {
    try {
      const resp = await axios.post(
        `${USA_SPENDING_BASE}/search/spending_by_award/`,
        {
          filters,
          fields: [
            'Award Amount',
            'Recipient Name',
            'recipient_uei',
            // USAspending has NO "Award Date" field on spending_by_award.
            // The closest semantic for "when was this contract awarded" is
            // "Base Obligation Date" (date funds were obligated). When that
            // is null we fall back to "Last Modified Date" (always populated)
            // and "Period of Performance Start Date" as a last resort.
            'Base Obligation Date',
            'Last Modified Date',
            'Period of Performance Start Date',
            'Base and All Options Value',
            'Award Type',
            'Contract Award Type',
            'generated_internal_id',
            'Number of Offers Received',
            'Extent Competed',
            'recipient_id',
          ],
          page,
          limit: 100,
          sort: 'Award Amount',
          order: 'desc',
        },
        { timeout: 30000 }
      )

      const results: Record<string, unknown>[] = resp.data?.results ?? []
      const total: number = resp.data?.page_metadata?.total ?? 0

      for (const r of results) {
        // Derive a usable date in priority order: Base Obligation Date
        // (the contract obligation date — the real "award date" for
        // procurement awards) → Last Modified Date (always populated by
        // USAspending, useful as a stable fallback) → Period of
        // Performance Start Date. Truncate any datetime form to YYYY-MM-DD
        // so the BigQuery DATE column accepts it cleanly.
        const rawDate =
          (r['Base Obligation Date'] as string | null) ||
          (r['Last Modified Date'] as string | null) ||
          (r['Period of Performance Start Date'] as string | null) ||
          null
        const awardDate = rawDate ? rawDate.slice(0, 10) : null

        rows.push({
          id:             uuidv4(),
          naicsCode,
          agency:         agency ?? 'ALL',
          recipientName:  (r['Recipient Name'] as string) ?? 'Unknown',
          recipientUei:   (r['recipient_uei'] as string) ?? null,
          awardAmount:    Number(r['Award Amount'] ?? 0),
          awardDate,
          setAsideType:   (r['Award Type'] as string) ?? null,
          offersReceived: r['Number of Offers Received'] != null
            ? Number(r['Number of Offers Received'])
            : null,
          extentCompeted: (r['Extent Competed'] as string) ?? null,
          awardType:      (r['Contract Award Type'] as string) ?? null,
          contractNumber: (r['generated_internal_id'] as string) ?? null,
          baseAllOptions: r['Base and All Options Value'] != null
            ? Number(r['Base and All Options Value'])
            : null,
          ingestedAt: new Date().toISOString(),
        })
      }

      hasMore = page * 100 < total
      page++
    } catch (err) {
      logger.warn('USAspending page fetch failed during BQ ingestion', {
        naicsCode,
        page,
        error: (err as Error).message,
      })
      break
    }
  }

  if (rows.length === 0) {
    return { naicsCode, agency, rowsInserted: 0, skipped: 0, durationMs: Date.now() - startMs }
  }

  // Insert into BigQuery
  const bq = getBigQuery()
  const table = bq.dataset(BQ_DATASET, { projectId: GCP_PROJECT_ID }).table(BQ_TABLES.AWARD_HISTORY)

  const insertErrors: unknown[] = []
  // BigQuery insertAll handles up to 50k rows per call; batch by 500
  const BATCH = 500
  let inserted = 0

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const [errs] = await table.insert(batch, { skipInvalidRows: true, ignoreUnknownValues: true })
    if (errs && (errs as unknown[]).length > 0) {
      insertErrors.push(...(errs as unknown[]))
    } else {
      inserted += batch.length
    }
  }

  if (insertErrors.length > 0) {
    logger.warn('BigQuery insert partial errors', {
      naicsCode,
      totalErrors: insertErrors.length,
      sample: JSON.stringify(insertErrors[0]).slice(0, 200),
    })
  }

  logger.info('BQ ingestion complete', {
    naicsCode,
    agency: agency ?? 'ALL',
    rowsInserted: inserted,
    durationMs: Date.now() - startMs,
  })

  return {
    naicsCode,
    agency,
    rowsInserted: inserted,
    skipped: rows.length - inserted,
    durationMs: Date.now() - startMs,
  }
}

/**
 * Bulk ingest for a list of NAICS codes — used for firm-wide market backfill.
 * Runs sequentially to avoid rate-limiting USAspending.
 */
export async function ingestBulkNaics(
  naicsCodes: string[],
  options?: { maxPages?: number; yearsBack?: number }
): Promise<IngestionResult[]> {
  const results: IngestionResult[] = []
  for (const code of naicsCodes) {
    const result = await ingestAwardsForNaics({ naicsCode: code, ...options })
    results.push(result)
    // Polite delay between NAICS codes
    await new Promise((r) => setTimeout(r, 1000))
  }
  return results
}

// Mirrors normalizeAgencyName from usaSpending.ts to keep parity
function normalizeAgencyName(samAgency: string): string {
  const topLevel = samAgency.split('.')[0].trim().toUpperCase()
  const MAP: Record<string, string> = {
    'VETERANS AFFAIRS, DEPARTMENT OF': 'Department of Veterans Affairs',
    'DEFENSE, DEPARTMENT OF': 'Department of Defense',
    'HOMELAND SECURITY, DEPARTMENT OF': 'Department of Homeland Security',
    'HEALTH AND HUMAN SERVICES, DEPARTMENT OF': 'Department of Health and Human Services',
    'TRANSPORTATION, DEPARTMENT OF': 'Department of Transportation',
    'AGRICULTURE, DEPARTMENT OF': 'Department of Agriculture',
    'ENERGY, DEPARTMENT OF': 'Department of Energy',
    'INTERIOR, DEPARTMENT OF THE': 'Department of the Interior',
    'JUSTICE, DEPARTMENT OF': 'Department of Justice',
    'LABOR, DEPARTMENT OF': 'Department of Labor',
    'STATE, DEPARTMENT OF': 'Department of State',
    'TREASURY, DEPARTMENT OF THE': 'Department of the Treasury',
    'COMMERCE, DEPARTMENT OF': 'Department of Commerce',
    'EDUCATION, DEPARTMENT OF': 'Department of Education',
    'HOUSING AND URBAN DEVELOPMENT, DEPARTMENT OF': 'Department of Housing and Urban Development',
    'GENERAL SERVICES ADMINISTRATION': 'General Services Administration',
    'NATIONAL AERONAUTICS AND SPACE ADMINISTRATION': 'National Aeronautics and Space Administration',
    'SMALL BUSINESS ADMINISTRATION': 'Small Business Administration',
    'ARMY, DEPARTMENT OF THE': 'Department of the Army',
    'NAVY, DEPARTMENT OF THE': 'Department of the Navy',
    'AIR FORCE, DEPARTMENT OF THE': 'Department of the Air Force',
  }
  return MAP[topLevel] ?? topLevel
}
