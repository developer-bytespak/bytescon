// =============================================================
// Subcontracting Data Service
//
// Data sources:
//   1. SBA SUBNet  — actual subcontracting opportunity postings
//      from prime contractors seeking small-business subs.
//      https://eweb1.sba.gov/subnet/
//   2. SAM.gov     — set-aside solicitations where small firms
//      can pursue as a prime or teaming subcontractor.
//   3. USAspending — used ONLY for value enrichment: given a
//      prime contractor name or UEI, look up their active
//      contract award amounts so the estimated sub value is
//      meaningful rather than blank.
//
// NOTE: USAspending sub-award records (award_type A/B/C/D) are
// COMPLETED awards, not open opportunities.  They are NOT used
// as subcontracting listings here.
//
// FPDS (Federal Procurement Data System) is the authoritative
// contract award database.  USAspending ingests from FPDS.
// This service does not query FPDS directly.
// =============================================================
import axios from 'axios'
import { logger } from '../utils/logger'

export interface SubnetOpportunity {
  externalId:         string
  title:              string
  primeContractor:    string
  primeContractorUei: string | null
  naicsCode:          string | null
  agency:             string | null
  estimatedValue:     number | null
  responseDeadline:   Date | null
  description:        string | null
  contactEmail:       string | null
  contactName:        string | null
  sourceUrl:          string | null
  setAside:           string | null
  /** Which feed produced this row — carried into the contact pool's `source`. */
  source:             'sba_subnet' | 'sam_setaside'
}

const USA_SPENDING_BASE = process.env.USASPENDING_BASE_URL || 'https://api.usaspending.gov/api/v2'

// =============================================================
// 1. SBA SUBNet — now hosted at www.sba.gov/federal-contracting/
//    contracting-guide/prime-subcontracting/subcontracting-opportunities
//
//    The old eweb1.sba.gov/subnet API is gone.  The data lives
//    on SBA.gov as a Drupal CMS view (HTML table, no public JSON
//    API).  We scrape the HTML directly — patterns are stable.
// =============================================================
export async function fetchSubnetOpportunities(naicsCodes?: string[]): Promise<SubnetOpportunity[]> {
  const results: SubnetOpportunity[] = []
  const BASE_URL = 'https://www.sba.gov/federal-contracting/contracting-guide/prime-subcontracting/subcontracting-opportunities'

  try {
    // Fetch up to 3 pages (SBA shows ~10 rows/page)
    for (let page = 0; page <= 2; page++) {
      const params = new URLSearchParams({ state: 'All', keyword: '', page: String(page) })
      const resp = await axios.get(`${BASE_URL}?${params}`, {
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GovConBot/1.0)',
          Accept: 'text/html',
        },
      })

      const html: string = resp.data as string
      if (!html || typeof html !== 'string') break

      // Extract table rows — each <tr> contains one opportunity
      const rowMatches = html.match(/<tr>[\s\S]*?<\/tr>/g) || []
      let pageFound = 0

      for (const row of rowMatches) {
        // Title + slug
        const titleMatch = row.match(/class="subnet_title"[^>]*><a href="\/opportunity\/([^"]+)"[^>]*>([^<]+)<\/a>/)
        if (!titleMatch) continue
        const slug = titleMatch[1]
        const title = titleMatch[2].trim()

        // Prime contractor name
        const primeMatch = row.match(/class="subnet_business_name">([^<]+)</)
        const primeContractor = primeMatch ? primeMatch[1].trim() : 'Unknown Prime'

        // Description (inside <p> after business name)
        const descMatch = row.match(/subnet_business_name">[^<]*<\/span><br \/>(?:<p>)?([\s\S]*?)(?:<\/p>|<\/td>)/)
        const description = descMatch
          ? descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800)
          : null

        // Closing date
        const closingMatch = row.match(/views-field-field-subnet-closing-timestamp[^>]*>([\s\S]*?)<\/td>/)
        const closingRaw = closingMatch ? closingMatch[1].replace(/<[^>]+>/g, '').trim() : null
        const responseDeadline = closingRaw ? new Date(closingRaw) : null

        // State / place of performance
        const stateMatch = row.match(/views-field-field-subnet-place-performance[^>]*>([\s\S]*?)<\/td>/)
        const state = stateMatch ? stateMatch[1].replace(/<[^>]+>/g, '').trim() : null

        // NAICS code
        const naicsMatch = row.match(/views-field-field-subnet-naics[^>]*>([\s\S]*?)<\/td>/)
        const naicsRaw = naicsMatch ? naicsMatch[1].replace(/<[^>]+>/g, '').trim() : null
        const naicsCode = naicsRaw ? naicsRaw.split(':')[0].trim() : null

        // NAICS filter: if client codes provided, skip non-matching
        if (naicsCodes && naicsCodes.length > 0 && naicsCode) {
          const sector = naicsCode.substring(0, 2)
          const matches = naicsCodes.some(n =>
            n === naicsCode ||
            n.substring(0, 4) === naicsCode.substring(0, 4) ||
            n.substring(0, 2) === sector
          )
          if (!matches) continue
        }

        // Contact email + name
        const emailMatch = row.match(/href="mailto:([^"]+)">([^<]+)<\/a>/)
        const contactEmail = emailMatch ? emailMatch[1] : null
        const contactName  = emailMatch ? emailMatch[2].trim() : null

        results.push({
          source:             'sba_subnet',
          externalId:         `sba-subnet-${slug}`,
          title,
          primeContractor,
          primeContractorUei: null,
          naicsCode,
          agency:             state,
          estimatedValue:     null,
          responseDeadline:   responseDeadline && !isNaN(responseDeadline.getTime()) ? responseDeadline : null,
          description,
          contactEmail,
          contactName,
          sourceUrl:          `https://www.sba.gov/opportunity/${slug}`,
          setAside:           null,
        })
        pageFound++
      }

      logger.debug('SUBNet page scraped', { page, found: pageFound })
      if (pageFound === 0) break  // No more data
    }

    logger.info('SBA SUBNet scrape complete', { count: results.length })

    // Health check: warn if scraper returns zero results (possible SBA.gov redesign)
    if (results.length === 0) {
      logger.error('SUBNet scraper returned 0 results — SBA.gov page structure may have changed. Check HTML regex patterns in subnetScraper.ts.')
    }
  } catch (err) {
    const msg = (err as Error).message
    logger.error('SBA SUBNet scrape failed — site may be down or redesigned', { error: msg })
  }

  return results
}

// =============================================================
// 1b. SAM.gov broad set-aside feed — replaces SUBNet
//     Fetches ALL set-aside types (SDVOSB, 8a, HUBZone, WOSB,
//     SB) so small firms can identify teaming/sub opportunities.
//     This is the publicly available replacement for SUBNet.
// =============================================================
export async function fetchSamSetAsideBroad(
  samApiKey: string,
  naicsCodes?: string[]
): Promise<SubnetOpportunity[]> {
  if (!samApiKey) return []
  const results: SubnetOpportunity[] = []

  // All small-business set-aside type codes
  const SET_ASIDE_TYPES = [
    'SBA',   // Small Business
    'SBP',   // Small Business Set-Aside — Partial
    '8A',    // 8(a) Sole Source
    '8AN',   // 8(a) Competitive
    'HZC',   // HUBZone
    'HZS',   // HUBZone Sole Source
    'SDVOSBC', // SDVOSB Competitive
    'SDVOSBS', // SDVOSB Sole Source
    'WOSB',  // WOSB
    'EDWOSB', // Economically Disadvantaged WOSB
  ]

  try {
    const postedFrom = formatDate(new Date(Date.now() - 120 * 24 * 60 * 60 * 1000))
    const postedTo   = formatDate(new Date())

    const baseParams: Record<string, string | number> = {
      api_key:    samApiKey,
      limit:      100,
      postedFrom,
      postedTo,
      ptype:      'p,k,r,s',  // presol, combined synopsis, sources sought, solicitation
    }

    // SAM.gov `ncode` accepts only a SINGLE NAICS — a comma list or repeated
    // param both return zero results. So when NAICS codes are supplied we
    // issue one request per code and merge (deduped by noticeId); otherwise we
    // restrict by set-aside type to keep the unfiltered feed focused.
    const items: Record<string, unknown>[] = []
    const seen = new Set<string>()
    const collect = (data: { opportunitiesData?: Record<string, unknown>[] } | undefined) => {
      for (const r of data?.opportunitiesData ?? []) {
        const id = r['noticeId'] as string
        if (id && seen.has(id)) continue
        if (id) seen.add(id)
        items.push(r)
      }
    }

    if (naicsCodes && naicsCodes.length > 0) {
      for (const code of naicsCodes.slice(0, 5)) {
        const resp = await axios.get('https://api.sam.gov/opportunities/v2/search', {
          params: { ...baseParams, ncode: code },
          timeout: 30000,
        })
        collect(resp.data)
      }
    } else {
      const resp = await axios.get('https://api.sam.gov/opportunities/v2/search', {
        params: { ...baseParams, typeOfSetAside: SET_ASIDE_TYPES.join(',') },
        timeout: 30000,
      })
      collect(resp.data)
    }
    for (const r of items) {
      const noticeId = r['noticeId'] as string
      const setAsideRaw = (r['typeOfSetAsideDescription'] as string) || (r['typeOfSetAside'] as string) || null
      // Only include set-aside or small-business relevant opportunities
      if (!setAsideRaw && !naicsCodes?.length) continue

      results.push({
        source:             'sam_setaside',
        externalId:         `sam-setaside-${noticeId}`,
        title:              (r['title'] as string) || 'Untitled Solicitation',
        primeContractor:    'Open Solicitation — Teaming Opportunity',
        primeContractorUei: null,
        naicsCode:          (r['naicsCode'] as string) || null,
        agency:             (r['fullParentPathName'] as string)?.split('.')[0]?.trim() || null,
        estimatedValue:     null,
        responseDeadline:   r['responseDeadLine'] ? new Date(r['responseDeadLine'] as string) : null,
        description:        (r['description'] as string) || null,
        contactEmail:       (r['pointOfContact'] as any)?.[0]?.email || null,
        contactName:        (r['pointOfContact'] as any)?.[0]?.fullName || null,
        sourceUrl:          `https://sam.gov/opp/${noticeId}/view`,
        setAside:           mapSetAside(setAsideRaw),
      })
    }

    logger.info('SAM.gov broad set-aside feed complete', { count: results.length })
  } catch (err) {
    logger.warn('SAM.gov broad set-aside feed failed', { error: (err as Error).message })
  }

  return results
}

// =============================================================
// 2. SAM.gov — set-aside solicitations (legacy entry point)
//    Now delegates to fetchSamSetAsideBroad for full coverage.
// =============================================================
export async function scrapeSamSubcontracting(samApiKey: string): Promise<SubnetOpportunity[]> {
  return fetchSamSetAsideBroad(samApiKey)
}

// =============================================================
// 3. USAspending value enrichment
//    Given a list of prime contractor names or NAICS codes,
//    look up recent contract award amounts so we can show a
//    realistic "estimated sub value" instead of blank/null.
//
//    This queries COMPLETED awards from USAspending (which
//    sources from FPDS) — it is used for context/value only,
//    not as a source of open opportunities.
// =============================================================
export async function enrichValueFromUsaSpending(
  naicsCodes: string[]
): Promise<Map<string, number>> {
  // Returns a Map of naicsCode → median recent award amount
  const valueMap = new Map<string, number>()
  if (!naicsCodes || naicsCodes.length === 0) return valueMap

  try {
    const endDate   = new Date().toISOString().split('T')[0]
    const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    const resp = await axios.post(
      `${USA_SPENDING_BASE}/search/spending_by_award/`,
      {
        filters: {
          time_period:      [{ start_date: startDate, end_date: endDate }],
          award_type_codes: ['A', 'B', 'C', 'D'],
          naics_codes:      naicsCodes.slice(0, 10).map(String),
        },
        fields:  ['Award Amount', 'NAICS Code'],
        page:    1,
        limit:   200,
        sort:    'Award Amount',
        order:   'desc',
        subawards: false,
      },
      { timeout: 20000 }
    )

    // Build per-NAICS median award value
    const byNaics: Record<string, number[]> = {}
    for (const r of (resp.data?.results ?? []) as Record<string, unknown>[]) {
      const code = (r['NAICS Code'] ?? r['naics_code']) as string
      const amt  = r['Award Amount'] as number
      if (code && amt > 0) {
        if (!byNaics[code]) byNaics[code] = []
        byNaics[code].push(amt)
      }
    }
    for (const [code, amounts] of Object.entries(byNaics)) {
      const sorted  = amounts.sort((a, b) => a - b)
      const median  = sorted[Math.floor(sorted.length / 2)]
      valueMap.set(code, median)
    }
  } catch (err) {
    logger.warn('USAspending value enrichment failed', { error: (err as Error).message })
  }

  return valueMap
}

// =============================================================
// Helpers
// =============================================================
function mapSetAside(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.toUpperCase()
  if (s.includes('SERVICE-DISABLED') || s.includes('SDVOSB')) return 'SDVOSB'
  if (s.includes('8(A)') || s.includes('8A'))                   return '8(a)'
  if (s.includes('HUBZONE'))                                     return 'HUBZone'
  if (s.includes('WOMAN'))                                       return 'WOSB'
  if (s.includes('SMALL BUSINESS'))                              return 'SB'
  return raw
}

function formatDate(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
}
