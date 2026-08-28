// =============================================================
// GSA Per Diem API Service
// Lodging + M&IE (meals & incidentals) rates for travel pricing.
//
// Backed by the api.gsa.gov (api.data.gov–managed) Per Diem v2 API.
// One api.data.gov key (config.dataGov.apiKey) works across all
// api.gsa.gov GSA APIs (Per Diem, Regulations.gov, …) but NOT SAM.gov.
//
// Confirmed endpoint (2026-06):
//   GET {GSA_API_BASE_URL}/travel/perdiem/v2/rates/city/{city}/state/{ST}/year/{year}?api_key=KEY
// Confirmed shape:
//   { rates: [ { rate: [ { months: { month: [ {value,number,short,long} ] },
//                          meals, city, county, zip, standardRate } ] } ],
//     state, year, isOconus, errors }
// Not-found / standard-CONUS: 200 with `rates: []`.
//
// Pure transform helpers (normalizePerDiemResponse / lodgingByMonth) are
// split out so they can be unit-tested without any network access.
// =============================================================
import axios, { AxiosInstance } from 'axios';
import { config } from '../config/config';
import { logger } from '../utils/logger';

/** A single calendar-month lodging value as returned by GSA. */
export interface PerDiemMonthRate {
  /** 1-12 */
  month: number;
  /** Three-letter month abbreviation, e.g. "Jan". */
  short: string;
  /** Full month name, e.g. "January". */
  long: string;
  /** Max nightly lodging rate (USD) for that month. */
  lodging: number;
}

/** Normalized Per Diem result for a city/state/year. */
export interface PerDiemRates {
  city: string;
  state: string;
  year: number;
  county: string | null;
  zip: string | null;
  /**
   * True when GSA returned no city-specific rate — the caller should use the
   * standard CONUS rate. `lodgingByMonth`/`mealsRate` are null in this case.
   */
  isStandardRate: boolean;
  /** Per-month lodging schedule (12 entries when a specific rate exists). */
  lodgingByMonth: PerDiemMonthRate[];
  /** Highest monthly lodging rate across the year (USD), or null. */
  maxLodging: number | null;
  /** M&IE (meals & incidentals) daily rate (USD), or null. */
  mealsRate: number | null;
}

// ── Pure transform helpers (unit-tested, no network) ─────────────────────────

/** Build the rate path for a city/state/year (no api_key — that's a query param). */
export function buildPerDiemPath(city: string, state: string, year: number): string {
  const c = encodeURIComponent(city.trim());
  const s = encodeURIComponent(state.trim().toUpperCase());
  return `/travel/perdiem/v2/rates/city/${c}/state/${s}/year/${year}`;
}

/**
 * Normalize the raw GSA Per Diem response into a `PerDiemRates`.
 * Returns a standard-rate result (isStandardRate=true, null rates) when GSA
 * has no city-specific rate (`rates: []`).
 */
export function normalizePerDiemResponse(
  raw: any,
  city: string,
  state: string,
  year: number
): PerDiemRates {
  const rateBlocks: any[] = raw?.rates ?? [];
  // First rate entry inside the first rates block carries the schedule.
  const entry = rateBlocks[0]?.rate?.[0];

  if (!entry) {
    return {
      city: city.trim(),
      state: state.trim().toUpperCase(),
      year,
      county: null,
      zip: null,
      isStandardRate: true,
      lodgingByMonth: [],
      maxLodging: null,
      mealsRate: null,
    };
  }

  const months: any[] = entry?.months?.month ?? [];
  const lodgingByMonth: PerDiemMonthRate[] = months
    .map((m: any) => ({
      month: Number(m?.number),
      short: String(m?.short ?? ''),
      long: String(m?.long ?? ''),
      lodging: Number(m?.value),
    }))
    .filter((m) => Number.isFinite(m.month) && Number.isFinite(m.lodging));

  const maxLodging = lodgingByMonth.length
    ? Math.max(...lodgingByMonth.map((m) => m.lodging))
    : null;

  const mealsRaw = entry?.meals;
  const mealsRate =
    mealsRaw === null || mealsRaw === undefined || mealsRaw === ''
      ? null
      : Number(mealsRaw);

  // GSA encodes standardRate as the string "true"/"false".
  const isStandardRate = String(entry?.standardRate ?? 'false').toLowerCase() === 'true';

  return {
    city: entry?.city ?? city.trim(),
    state: raw?.state ?? state.trim().toUpperCase(),
    year: Number(raw?.year ?? year),
    county: entry?.county ?? null,
    zip: entry?.zip ?? null,
    isStandardRate,
    lodgingByMonth,
    maxLodging,
    mealsRate: Number.isFinite(mealsRate as number) ? (mealsRate as number) : null,
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

class PerDiemService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.dataGov.gsaBaseUrl,
      timeout: 20000,
      headers: { Accept: 'application/json' },
    });
  }

  /**
   * Fetch and normalize GSA Per Diem lodging + M&IE rates for a city/state/year.
   * Returns a standard-rate result (no city-specific rate) when GSA has none.
   * Throws on a missing key or an HTTP/transport error so callers can decide
   * whether to fall back to the standard rate or surface the failure.
   */
  async getPerDiemRates(city: string, state: string, year: number): Promise<PerDiemRates> {
    const apiKey = config.dataGov.apiKey;
    if (!apiKey) {
      throw new Error('DATA_GOV_API_KEY not configured');
    }
    if (!city?.trim() || !state?.trim()) {
      throw new Error('Per Diem lookup requires both city and state');
    }

    const path = buildPerDiemPath(city, state, year);

    let res: any;
    try {
      res = await this.client.get(path, { params: { api_key: apiKey } });
    } catch (axiosErr: any) {
      const status = axiosErr.response?.status ?? 0;
      const body = axiosErr.response?.data;
      const msg =
        body?.error?.message ??
        body?.errors ??
        body?.message ??
        axiosErr.message ??
        'GSA Per Diem request failed';
      logger.warn('GSA Per Diem API HTTP error', { status, city, state, year });
      throw new Error(`GSA Per Diem (HTTP ${status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }

    // The API can return 200 with a populated `errors` field.
    if (res.data?.errors) {
      const msg =
        typeof res.data.errors === 'string' ? res.data.errors : JSON.stringify(res.data.errors);
      logger.warn('GSA Per Diem API returned error body', { msg, city, state, year });
      throw new Error(`GSA Per Diem: ${msg}`);
    }

    const normalized = normalizePerDiemResponse(res.data, city, state, year);
    logger.debug('GSA Per Diem rates resolved', {
      city: normalized.city,
      state: normalized.state,
      year: normalized.year,
      isStandardRate: normalized.isStandardRate,
      maxLodging: normalized.maxLodging,
      mealsRate: normalized.mealsRate,
    });
    return normalized;
  }
}

export const perDiemService = new PerDiemService();
