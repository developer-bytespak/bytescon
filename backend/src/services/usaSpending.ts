// =============================================================
// USASpending API Service
// Full historical award enrichment for decision intelligence
// =============================================================
import axios, { AxiosInstance } from 'axios';
import { config } from '../config/config';
import { logger } from '../utils/logger';
import { EnrichmentResult, AwardRecord } from '../types';
import { getNaicsAwardIntel } from './fpdsAtom';

/**
 * Normalizes SAM.gov agency strings to USASpending toptier agency names.
 * SAM.gov returns strings like "VETERANS AFFAIRS, DEPARTMENT OF.PCAC (36C776)"
 * USASpending expects "Department of Veterans Affairs"
 */
function normalizeAgencyName(samAgency: string): string {
  // Take only the part before the first dot (removes subtier/office suffixes)
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
    'SOCIAL SECURITY ADMINISTRATION': 'Social Security Administration',
    'ENVIRONMENTAL PROTECTION AGENCY': 'Environmental Protection Agency',
    'NUCLEAR REGULATORY COMMISSION': 'Nuclear Regulatory Commission',
    'NATIONAL SCIENCE FOUNDATION': 'National Science Foundation',
    'OFFICE OF PERSONNEL MANAGEMENT': 'Office of Personnel Management',
    'FEDERAL EMERGENCY MANAGEMENT AGENCY': 'Federal Emergency Management Agency',
    'ARMY, DEPARTMENT OF THE': 'Department of the Army',
    'NAVY, DEPARTMENT OF THE': 'Department of the Navy',
    'AIR FORCE, DEPARTMENT OF THE': 'Department of the Air Force',
    'FEDERAL AVIATION ADMINISTRATION': 'Federal Aviation Administration',
    'CENTERS FOR MEDICARE AND MEDICAID SERVICES': 'Centers for Medicare and Medicaid Services',
  }

  return MAP[topLevel] || topLevel
}

/**
 * Many notices share a NAICS code and agency, and award history changes
 * slowly, so one lookup serves them all for a while. Caching also keeps
 * enrichment within what USAspending tolerates: without it a sync's worth of
 * notices sent the same requests hundreds of times and the API began dropping
 * connections ("socket hang up"). Concurrent identical calls share one
 * request; a failure is never cached.
 */
const ENRICHMENT_CACHE_MS = 6 * 60 * 60 * 1000
const AGENCY_RATES_CACHE_MS = 24 * 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 2000

class TtlCache<T> {
  private entries = new Map<string, { at: number; value: Promise<T> }>()
  constructor(private ttlMs: number) {}
  get(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && now - hit.at < this.ttlMs) return hit.value
    const value = load()
    if (this.entries.size >= CACHE_MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value as string)
    this.entries.set(key, { at: now, value })
    // Never keep a failure: the next call must try again.
    value.catch(() => { if (this.entries.get(key)?.value === value) this.entries.delete(key) })
    return value
  }
  clear() { this.entries.clear() }
}

class UsaSpendingService {
  private client: AxiosInstance;
  private enrichmentCache = new TtlCache<EnrichmentResult>(ENRICHMENT_CACHE_MS)
  private agencyRatesCache = new TtlCache<{ smallBizRate: number; sdvosbRate: number }>(AGENCY_RATES_CACHE_MS)

  /** Forget cached lookups (tests, or after a data fix). */
  clearCache(): void {
    this.enrichmentCache.clear()
    this.agencyRatesCache.clear()
  }

  constructor() {
    this.client = axios.create({
      baseURL: config.usaSpending.baseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Full enrichment for a single opportunity.
   * Pulls last 5 years of awards matching NAICS + Agency.
   * Computes: historical winner, avg award, competition count, incumbent probability.
   */
  async enrichOpportunity(params: {
    naicsCode: string;
    agency: string;
    pscCode?: string;
  }): Promise<EnrichmentResult> {
    // The result depends only on the NAICS code and the agency (pscCode is unused).
    const key = `${params.naicsCode ?? ''}|${params.agency ? normalizeAgencyName(params.agency) : ''}`
    return this.enrichmentCache.get(key, () => this.fetchEnrichment(params))
  }

  private async fetchEnrichment(params: {
    naicsCode: string;
    agency: string;
  }): Promise<EnrichmentResult> {
    // Award history is searched by NAICS; a notice without one has nothing to
    // compare, and USAspending rejects a blank code (422).
    if (!params.naicsCode?.trim()) return this.emptyEnrichment();
    try {
      const endDate = new Date().toISOString().split('T')[0];
      const startDate = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0];

      const normalizedAgency = params.agency ? normalizeAgencyName(params.agency) : null

      const filters: any = {
        time_period: [{ start_date: startDate, end_date: endDate }],
        naics_codes: [params.naicsCode],
        award_type_codes: ['A', 'B', 'C', 'D'], // Contract types only
      };

      if (normalizedAgency) {
        filters.agencies = [
          { type: 'awarding', tier: 'toptier', name: normalizedAgency },
        ];
      }

      const response = await this.client.post('/search/spending_by_award/', {
        filters,
        fields: [
          'Award Amount',
          'Recipient Name',
          'recipient_uei',
          'Award Date',
          'Base and All Options Value',
          'Award Type',
          'Contract Award Type',
          'generated_internal_id',
          'Number of Offers Received',
          'Extent Competed',
        ],
        page: 1,
        limit: 100,
        sort: 'Award Amount',
        order: 'desc',
      });

      const results = response.data?.results || [];
      const total = response.data?.page_metadata?.total || 0;

      if (results.length === 0) {
        return this.emptyEnrichment();
      }

      // Build award records
      const awards: AwardRecord[] = results.map((r: any) => ({
        recipientName: r['Recipient Name'] || 'Unknown',
        recipientUei: r['recipient_uei'] || undefined,
        awardAmount: r['Award Amount'] || 0,
        awardDate: r['Award Date'] || '',
        baseAndAllOptions: r['Base and All Options Value'] || undefined,
        awardType: r['Award Type'] || undefined,
        contractNumber: r['generated_internal_id'] || undefined,
      }))

      // Compute average offers received across all awards in result set
      const offerCounts = results
        .map((r: any) => r['Number of Offers Received'])
        .filter((v: any) => v !== null && v !== undefined && !isNaN(Number(v)))
        .map(Number)
      const avgOffersReceived = offerCounts.length > 0
        ? Math.round(offerCounts.reduce((a: number, b: number) => a + b, 0) / offerCounts.length)
        : null

      // Extent competed from most recent award
      const extentCompeted: string | null = results[0]?.['Extent Competed'] || null;

      // Compute winner analysis
      const recipientCounts: Record<string, number> = {};
      const recipientAmounts: Record<string, number> = {};

      for (const award of awards) {
        const name = award.recipientName;
        recipientCounts[name] = (recipientCounts[name] || 0) + 1;
        recipientAmounts[name] = (recipientAmounts[name] || 0) + award.awardAmount;
      }

      const sortedByCount = Object.entries(recipientCounts).sort((a, b) => b[1] - a[1]);
      const historicalWinner = sortedByCount[0]?.[0] || null;
      const winnerCount = sortedByCount[0]?.[1] || 0;
      const competitionCount = Object.keys(recipientCounts).length;
      const incumbentProbability = awards.length > 0 ? winnerCount / awards.length : null;

      const totalAmount = awards.reduce((sum, a) => sum + a.awardAmount, 0);
      const historicalAvgAward = awards.length > 0 ? totalAmount / awards.length : 0;

      // Pull agency small business / SDVOSB rates separately
      const agencyRates = await this.getAgencySetAsideRates(params.agency);

      // Recompete detection: title contains common recompete signals
      const recompeteFlag = false; // Set by enrichment worker from opportunity title/description

      // FPDS-NG carries authoritative per-award offer counts (USAspending's
      // "Number of Offers Received" is sparse). Best-effort + cached: returns
      // null on any failure, so offersReceived falls back to the USAspending
      // value. This replaces the previous estimate with real bidder counts.
      const fpds = await getNaicsAwardIntel(params.naicsCode);

      return {
        historicalWinner,
        historicalAvgAward,
        historicalAwardCount: total,
        competitionCount,
        incumbentProbability,
        agencySmallBizRate: agencyRates.smallBizRate,
        agencySdvosbRate: agencyRates.sdvosbRate,
        recompeteFlag,
        awards,
        offersReceived: fpds?.avgOffersReceived ?? avgOffersReceived,
        extentCompeted,
      };
    } catch (err) {
      // USAspending refusing the request itself (400/422: a code or agency it
      // can't search) won't change on retry, so the notice is recorded as
      // having no comparable history rather than retried five times.
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 400 || status === 422) {
        logger.warn('USASpending cannot search this NAICS/agency; recording no award history', {
          naicsCode: params.naicsCode, agency: params.agency, status,
        });
        return this.emptyEnrichment();
      }
      // P1-2b: a USASpending API/parse error is a real failure — surface it so
      // the enrichment worker retries, instead of marking the opportunity
      // enriched with fabricated federal-default rates. A genuine empty result
      // (no awards) is handled above via emptyEnrichment(), not here.
      logger.error('USASpending enrichment failed; surfacing for retry', {
        naicsCode: params.naicsCode,
        agency: params.agency,
        error: (err as Error).message,
      });
      throw err instanceof Error
        ? err
        : new Error(`USASpending enrichment failed for ${params.agency} / ${params.naicsCode}`);
    }
  }

  /**
   * Pull agency-level set-aside rates.
   * Queries small business and SDVOSB award percentages.
   */
  async getAgencySetAsideRates(
    agencyName: string
  ): Promise<{ smallBizRate: number; sdvosbRate: number }> {
    return this.agencyRatesCache.get(normalizeAgencyName(agencyName) ?? agencyName, () => this.fetchAgencySetAsideRates(agencyName))
  }

  private async fetchAgencySetAsideRates(
    agencyName: string
  ): Promise<{ smallBizRate: number; sdvosbRate: number }> {
    try {
      const endDate = new Date().toISOString().split('T')[0];
      const startDate = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0];

      const baseFilters = {
        agencies: [{ type: 'awarding', tier: 'toptier', name: normalizeAgencyName(agencyName) }],
        time_period: [{ start_date: startDate, end_date: endDate }],
        // award_type_codes is REQUIRED — without it the endpoint returns 422.
        award_type_codes: ['A', 'B', 'C', 'D'],
      };

      // Use spending_by_award_count (returns results.contracts). spending_by_award's
      // page_metadata has no `total` field, so the prior implementation always
      // resolved every rate to 0. Rate = small-business / SDVOSB contract counts
      // over the agency's total contract count. SDVOSB recipient token is
      // 'service_disabled_veteran_owned_business' (the *_small_business variant
      // returns no matches).
      const countContracts = (extra: Record<string, unknown>) =>
        this.client.post('/search/spending_by_award_count/', {
          filters: { ...baseFilters, ...extra },
        });

      const [totalRes, sbRes, sdvosbRes] = await Promise.allSettled([
        countContracts({}),
        countContracts({ recipient_type_names: ['small_business'] }),
        countContracts({ recipient_type_names: ['service_disabled_veteran_owned_business'] }),
      ]);

      // P1-2b: a FAILED count query is an error, not "no data". allSettled masks
      // rejections, and coercing them to contracts()=0 would silently emit the
      // federal-default prior (rejected total) or a fabricated 0% rate (rejected
      // sb/sdvosb) that gets persisted as isEnriched and never retried. Surface
      // ANY rejection, naming the failed query, so the enrichment job retries.
      const settled: Array<
        [string, PromiseSettledResult<{ data?: { results?: { contracts?: number } } }>]
      > = [
        ['total contract count', totalRes],
        ['small business count', sbRes],
        ['SDVOSB count', sdvosbRes],
      ];
      for (const [queryLabel, res] of settled) {
        if (res.status === 'rejected') {
          throw new Error(
            `Agency set-aside rates unavailable for "${agencyName}": ${queryLabel} query failed: ${
              res.reason instanceof Error ? res.reason.message : String(res.reason)
            }`
          );
        }
      }

      const contracts = (r: PromiseSettledResult<{ data?: { results?: { contracts?: number } } }>): number =>
        r.status === 'fulfilled' ? Number(r.value.data?.results?.contracts ?? 0) : 0;

      const grandTotal = contracts(totalRes);
      // Genuine no-data: the agency truly has zero matching contracts in window.
      // A federal-average prior is a legitimate default here (NOT error-hiding).
      if (!grandTotal) {
        logger.debug('Agency has no awards in window; using federal-default set-aside prior', { agencyName });
        return { smallBizRate: 0.25, sdvosbRate: 0.05 };
      }

      return {
        smallBizRate: Math.min(contracts(sbRes) / grandTotal, 1),
        sdvosbRate: Math.min(contracts(sdvosbRes) / grandTotal, 1),
      };
    } catch (err) {
      // P1-2b: surface the error (caller → BullMQ retry) instead of fabricating
      // federal averages on exception.
      logger.error('getAgencySetAsideRates failed', { agencyName, error: (err as Error).message });
      throw err instanceof Error ? err : new Error(`Agency set-aside rates unavailable for "${agencyName}"`);
    }
  }

  private emptyEnrichment(): EnrichmentResult {
    return {
      historicalWinner: null,
      historicalAvgAward: 0,
      historicalAwardCount: 0,
      // null = no data found — must NOT be 0, which would mean "confirmed 0 competitors / 0% incumbent"
      competitionCount: null,
      incumbentProbability: null,
      agencySmallBizRate: 0.25,
      agencySdvosbRate: 0.05,
      recompeteFlag: false,
      awards: [],
      offersReceived: null,
      extentCompeted: null,
    };
  }

  /**
   * Legacy method — kept for backward compatibility with scoring worker
   */
  computeAgencyAlignmentScore(
    stats: { sdvosbRate: number; totalAwards: number } | null,
    isSdvosb: boolean
  ): number {
    if (!stats) return 0.5;
    let score = 0.5;
    if (isSdvosb && stats.sdvosbRate > 0) {
      score += Math.min(stats.sdvosbRate * 2, 0.4);
    }
    if (stats.totalAwards > 1000) score += 0.1;
    else if (stats.totalAwards > 100) score += 0.05;
    return Math.min(score, 1.0);
  }

  /**
   * Sample awarded contracts for backtesting. Pulls a stratified slice across
   * the date range with NAICS, agency, value, and recipient info. Used by the
   * historical backtest service to feed the probability engine with real wins.
   */
  async sampleAwardedContracts(params: {
    yearsBack: number
    sampleSize: number
  }): Promise<Array<{
    contractId: string
    naicsCode: string
    agency: string
    awardAmount: number
    awardDate: string
    recipientName: string
    recipientUei: string | null
    setAside: string | null
  }>> {
    const endDate = new Date().toISOString().split('T')[0]
    const startDate = new Date(Date.now() - params.yearsBack * 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]

    // Page through results until we hit sampleSize. USAspending caps page size
    // at 100. We sort by award date descending for recency bias, but you could
    // randomize via NAICS sectors if needed.
    const PAGE_SIZE = 100
    // Sorting a 5-year unfiltered window is a heavy query on USAspending's
    // side — first-page latency routinely brushes 30s, so the client-level
    // 30s timeout intermittently killed the whole backtest ("zero awards").
    // This is a background/admin path, so give each page a generous budget
    // and one retry before giving up.
    const SAMPLE_PAGE_TIMEOUT_MS = 90_000
    const out: any[] = []
    let page = 1
    let retriedPage = 0
    while (out.length < params.sampleSize && page <= 50) {
      try {
        const response = await this.client.post(
          '/search/spending_by_award/',
          {
            filters: {
              time_period: [{ start_date: startDate, end_date: endDate }],
              award_type_codes: ['A', 'B', 'C', 'D'],
            },
            fields: [
              'Award Amount',
              'Recipient Name',
              'recipient_uei',
              'Award Date',
              'Awarding Agency',
              'NAICS',
              'Type of Set Aside',
              'generated_internal_id',
            ],
            page,
            limit: PAGE_SIZE,
            sort: 'Award Amount',
            order: 'desc',
          },
          { timeout: SAMPLE_PAGE_TIMEOUT_MS },
        )
        const results = response.data?.results || []
        if (results.length === 0) break
        for (const r of results) {
          // NAICS comes back as { code, description } — pluck the code
          const naicsRaw = r['NAICS']
          const naicsCode = typeof naicsRaw === 'object' && naicsRaw?.code
            ? String(naicsRaw.code)
            : typeof naicsRaw === 'string'
              ? naicsRaw.split(' ')[0]
              : ''
          if (!naicsCode || !r['Awarding Agency']) continue
          out.push({
            contractId: r['generated_internal_id'] || `${r['Recipient Name']}_${r['Award Date']}`,
            naicsCode,
            agency: r['Awarding Agency'],
            awardAmount: Number(r['Award Amount']) || 0,
            awardDate: r['Award Date'] || '',
            recipientName: r['Recipient Name'] || 'Unknown',
            recipientUei: r['recipient_uei'] || null,
            setAside: r['Type of Set Aside'] || null,
          })
          if (out.length >= params.sampleSize) break
        }
        page++
      } catch (err) {
        if (retriedPage < page) {
          retriedPage = page
          logger.warn('USAspending sample page failed — retrying once', {
            page,
            error: (err as Error).message,
          })
          continue
        }
        logger.warn('USAspending sample page failed after retry — stopping sample', {
          page,
          error: (err as Error).message,
        })
        break
      }
    }
    return out
  }
}

export const usaSpendingService = new UsaSpendingService();