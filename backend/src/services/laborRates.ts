// =============================================================
// GSA CALC+ Labor Rates Service (Contract-Awarded Labor Category)
//
// The legacy CALC v1/v2 "rates" JSON API was decommissioned (Feb 2025):
//   - api.gsa.gov/acquisition/calc/v1/rates  → 404
//   - api.gsa.gov/acquisition/calc/v2/(api/)rates → 200 but serves the IGCE
//     web app HTML, not JSON
// GSA replaced it with the v3 "CALC+ / DX CALC" ceiling-rates API (AWS
// OpenSearch backed). Confirmed live + returning JSON (2026-06):
//   GET {GSA_API_BASE_URL}/acquisition/calc/v3/api/ceilingrates/
//       ?page=1&page_size=N&keyword=<term>
// Docs: https://open.gsa.gov/api/dx-calc-api/
//
// Auth: this endpoint requires NO key (verified anonymous 200). We still send
// the api.data.gov key when configured for higher api.gsa.gov rate limits; the
// service works without a key (unlike Per Diem, which requires one).
//
// Response is OpenSearch-shaped: records live under hits.hits[]._source and
// hits.total is { value, relation }. Pure transform helpers are split out for
// unit testing without network access.
// =============================================================
import axios, { AxiosInstance } from 'axios';
import { config } from '../config/config';
import { logger } from '../utils/logger';

/** One normalized labor-rate record. */
export interface LaborRateRecord {
  vendorName: string | null;
  laborCategory: string;
  /** Current-year fully-burdened ceiling hourly rate (USD). */
  currentPrice: number;
  nextYearPrice: number | null;
  secondYearPrice: number | null;
  minYearsExperience: number | null;
  educationLevel: string | null;
  securityClearance: boolean | null;
  idvPiid: string | null;
  schedule: string | null;
  businessSize: string | null;
  worksite: string | null;
  contractStart: string | null;
  contractEnd: string | null;
}

/** Normalized labor-rate query result. */
export interface LaborRatesResult {
  keyword: string;
  /** Total matching records across all pages (GSA caps the exact count). */
  total: number;
  page: number;
  pageSize: number;
  rates: LaborRateRecord[];
  /** Simple price summary across the returned page (null when no rows). */
  summary: LaborRateSummary | null;
}

export interface LaborRateSummary {
  count: number;
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  medianPrice: number;
}

export interface GetLaborRatesParams {
  keyword: string;
  page?: number;
  pageSize?: number;
}

// ── Pure transform helpers (unit-tested, no network) ─────────────────────────

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map a single OpenSearch `_source` to a `LaborRateRecord` (price required). */
export function mapLaborRateSource(src: any): LaborRateRecord | null {
  if (!src) return null;
  const currentPrice = toNum(src.current_price);
  // A row with no usable current price is not pricing-useful.
  if (currentPrice === null) return null;
  return {
    vendorName: src.vendor_name ?? null,
    laborCategory: String(src.labor_category ?? ''),
    currentPrice,
    nextYearPrice: toNum(src.next_year_price),
    secondYearPrice: toNum(src.second_year_price),
    minYearsExperience: toNum(src.min_years_experience),
    educationLevel: src.education_level ?? null,
    securityClearance:
      typeof src.security_clearance === 'boolean' ? src.security_clearance : null,
    idvPiid: src.idv_piid ?? null,
    schedule: src.schedule ?? null,
    businessSize: src.business_size ?? null,
    worksite: src.worksite ?? null,
    contractStart: src.contract_start ?? null,
    contractEnd: src.contract_end ?? null,
  };
}

/** Compute a min/max/avg/median price summary over the returned page. */
export function summarizeLaborRates(rates: LaborRateRecord[]): LaborRateSummary | null {
  if (rates.length === 0) return null;
  const prices = rates.map((r) => r.currentPrice).sort((a, b) => a - b);
  const sum = prices.reduce((a, b) => a + b, 0);
  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
  return {
    count: prices.length,
    minPrice: prices[0],
    maxPrice: prices[prices.length - 1],
    avgPrice: sum / prices.length,
    medianPrice: median,
  };
}

/** Normalize the raw OpenSearch-shaped response into a `LaborRatesResult`. */
export function normalizeLaborRatesResponse(
  raw: any,
  keyword: string,
  page: number,
  pageSize: number
): LaborRatesResult {
  const hits: any[] = raw?.hits?.hits ?? [];
  const rates = hits
    .map((h) => mapLaborRateSource(h?._source))
    .filter((r): r is LaborRateRecord => r !== null);

  // hits.total is { value, relation } on modern OpenSearch; tolerate a number.
  const totalRaw = raw?.hits?.total;
  const total =
    typeof totalRaw === 'number'
      ? totalRaw
      : Number(totalRaw?.value ?? rates.length) || rates.length;

  return {
    keyword,
    total,
    page,
    pageSize,
    rates,
    summary: summarizeLaborRates(rates),
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

class LaborRatesService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.dataGov.gsaBaseUrl,
      timeout: 20000,
      headers: { Accept: 'application/json' },
    });
  }

  /**
   * Query GSA CALC+ ceiling labor rates by keyword. Returns up to `pageSize`
   * matching rate records plus a price summary. Works without a key; sends the
   * api.data.gov key when configured for higher rate limits. Throws on HTTP /
   * transport errors so the caller can fall back gracefully.
   */
  async getLaborRates(params: GetLaborRatesParams): Promise<LaborRatesResult> {
    const keyword = params.keyword?.trim();
    if (!keyword) {
      throw new Error('Labor rate lookup requires a keyword');
    }
    const page = params.page && params.page > 0 ? Math.floor(params.page) : 1;
    const pageSize =
      params.pageSize && params.pageSize > 0 ? Math.min(Math.floor(params.pageSize), 100) : 20;

    const query: Record<string, string | number> = {
      page,
      page_size: pageSize,
      keyword,
    };
    // Optional: improves rate limits on api.gsa.gov; endpoint also works anon.
    if (config.dataGov.apiKey) {
      query.api_key = config.dataGov.apiKey;
    }

    let res: any;
    try {
      res = await this.client.get('/acquisition/calc/v3/api/ceilingrates/', { params: query });
    } catch (axiosErr: any) {
      const status = axiosErr.response?.status ?? 0;
      const body = axiosErr.response?.data;
      const msg =
        body?.error?.message ?? body?.message ?? axiosErr.message ?? 'GSA CALC request failed';
      logger.warn('GSA CALC labor-rates API HTTP error', { status, keyword, page, pageSize });
      throw new Error(`GSA CALC (HTTP ${status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }

    const normalized = normalizeLaborRatesResponse(res.data, keyword, page, pageSize);
    logger.debug('GSA CALC labor rates resolved', {
      keyword,
      total: normalized.total,
      returned: normalized.rates.length,
      avgPrice: normalized.summary?.avgPrice ?? null,
    });
    return normalized;
  }
}

export const laborRatesService = new LaborRatesService();
