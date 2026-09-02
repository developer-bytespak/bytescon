/**
 * GSA data client for proposal-mcp (Per Diem + CALC labor rates).
 *
 * Mirrors the carrier-mcp FmcsaClient design exactly:
 *   - native fetch only, no HTTP client dependency
 *   - injectable fetcher so unit tests never call the real API
 *   - per-request timeout via AbortController
 *   - the api.data.gov key never appears in error messages (errors carry only
 *     the request path, never the query string)
 *   - defensive parsing: missing upstream fields become null/empty, never a
 *     fabricated default
 *
 * Two GSA APIs are wrapped (both on api.gsa.gov, the api.data.gov family —
 * one key spans them; NOT valid for SAM.gov):
 *
 *   Per Diem v2 (REQUIRES the key):
 *     GET /travel/perdiem/v2/rates/city/{city}/state/{ST}/year/{year}?api_key=KEY
 *     → { rates:[{ rate:[{ months:{ month:[{value,number,short,long}] },
 *                          meals, city, county, zip, standardRate }] }], ... }
 *     Not-found / standard CONUS: 200 with rates:[].
 *
 *   CALC+ v3 ceiling labor rates (key OPTIONAL — works anonymously, key only
 *   raises rate limits). The legacy CALC v1/v2 rates API was decommissioned
 *   (Feb 2025; v1 404s, v2 serves the IGCE web app HTML). Docs:
 *   https://open.gsa.gov/api/dx-calc-api/
 *     GET /acquisition/calc/v3/api/ceilingrates/?page=1&page_size=N&keyword=<term>
 *     → OpenSearch-shaped: { hits:{ total:{value,relation}, hits:[{_source:{
 *         labor_category, current_price, education_level, min_years_experience,
 *         idv_piid, schedule, ... }}] } }
 */

export const GSA_BASE_URL_DEFAULT = "https://api.gsa.gov";
export const GSA_TIMEOUT_MS_DEFAULT = 15_000;
export const GSA_USER_AGENT = "govcon-proposal-mcp/0.1.0";

export const PER_DIEM_KEY_MISSING_MESSAGE =
  "DATA_GOV_API_KEY is not configured, so GSA Per Diem travel rates cannot be fetched. " +
  "Set the DATA_GOV_API_KEY environment variable to an api.data.gov key and restart the server. " +
  "Get a free key at https://api.data.gov/signup (one key works across all GSA APIs).";

/** Minimal structural view of a fetch Response; the native Response satisfies it. */
export interface GsaHttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

/** Injectable fetch signature; globalThis.fetch satisfies it structurally. */
export type GsaFetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<GsaHttpResponse>;

export interface GsaClientOptions {
  /** api.data.gov key from DATA_GOV_API_KEY. Required for Per Diem; optional for CALC. */
  apiKey?: string | undefined;
  /** Injected fetch implementation. Defaults to native fetch. */
  fetcher?: GsaFetcher | undefined;
  /** Per-request timeout in milliseconds. Defaults to {@link GSA_TIMEOUT_MS_DEFAULT}. */
  timeoutMs?: number | undefined;
  /** Override base URL. Defaults to GSA_API_BASE_URL env or {@link GSA_BASE_URL_DEFAULT}. */
  baseUrl?: string | undefined;
}

// ── Normalized result shapes ────────────────────────────────────────────────

export interface PerDiemMonthRate {
  month: number;
  short: string;
  long: string;
  lodging: number;
}

export interface PerDiemRates {
  city: string;
  state: string;
  year: number;
  county: string | null;
  zip: string | null;
  /** True when GSA has no city-specific rate; use the standard CONUS rate. */
  isStandardRate: boolean;
  lodgingByMonth: PerDiemMonthRate[];
  /** Highest monthly lodging rate (USD), or null. */
  maxLodging: number | null;
  /** M&IE (meals & incidentals) daily rate (USD), or null. */
  mealsRate: number | null;
}

export interface LaborRateRecord {
  laborCategory: string;
  vendorName: string | null;
  currentPrice: number;
  minYearsExperience: number | null;
  educationLevel: string | null;
  idvPiid: string | null;
  schedule: string | null;
}

export interface LaborRateBenchmark {
  keyword: string;
  /** Total matching records across all pages (GSA caps the exact count). */
  total: number;
  count: number;
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  medianPrice: number;
  /** A few representative rows (capped) for transparency. */
  samples: LaborRateRecord[];
}

// ── Defensive parse helpers (pure, unit-tested) ─────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  return null;
}

/** Build the Per Diem rate path (no api_key — that's a query param). */
export function buildPerDiemPath(city: string, state: string, year: number): string {
  const c = encodeURIComponent(city.trim());
  const s = encodeURIComponent(state.trim().toUpperCase());
  return `/travel/perdiem/v2/rates/city/${c}/state/${s}/year/${year}`;
}

/** Normalize a raw Per Diem body; standard-rate when GSA has no city rate. */
export function parsePerDiemBody(
  raw: unknown,
  city: string,
  state: string,
  year: number
): PerDiemRates {
  const root = asRecord(raw);
  const rateBlocks = root && Array.isArray(root["rates"]) ? (root["rates"] as unknown[]) : [];
  const firstBlock = asRecord(rateBlocks[0]);
  const rateArr = firstBlock && Array.isArray(firstBlock["rate"]) ? (firstBlock["rate"] as unknown[]) : [];
  const entry = asRecord(rateArr[0]);

  const baseState = (asStringOrNull(root?.["state"]) ?? state).trim().toUpperCase();
  const baseYear = asNumberOrNull(root?.["year"]) ?? year;

  if (!entry) {
    return {
      city: city.trim(),
      state: baseState,
      year: baseYear,
      county: null,
      zip: null,
      isStandardRate: true,
      lodgingByMonth: [],
      maxLodging: null,
      mealsRate: null,
    };
  }

  const monthsWrap = asRecord(entry["months"]);
  const monthArr = monthsWrap && Array.isArray(monthsWrap["month"]) ? (monthsWrap["month"] as unknown[]) : [];
  const lodgingByMonth: PerDiemMonthRate[] = [];
  for (const m of monthArr) {
    const mr = asRecord(m);
    if (!mr) continue;
    const month = asNumberOrNull(mr["number"]);
    const lodging = asNumberOrNull(mr["value"]);
    if (month === null || lodging === null) continue;
    lodgingByMonth.push({
      month,
      short: asStringOrNull(mr["short"]) ?? "",
      long: asStringOrNull(mr["long"]) ?? "",
      lodging,
    });
  }

  const maxLodging = lodgingByMonth.length
    ? Math.max(...lodgingByMonth.map((m) => m.lodging))
    : null;

  return {
    city: asStringOrNull(entry["city"]) ?? city.trim(),
    state: baseState,
    year: baseYear,
    county: asStringOrNull(entry["county"]),
    zip: asStringOrNull(entry["zip"]),
    isStandardRate: String(entry["standardRate"] ?? "false").toLowerCase() === "true",
    lodgingByMonth,
    maxLodging,
    mealsRate: asNumberOrNull(entry["meals"]),
  };
}

/** Map one CALC OpenSearch `_source` to a labor-rate record (price required). */
export function parseLaborRateSource(raw: unknown): LaborRateRecord | null {
  const src = asRecord(raw);
  if (!src) return null;
  const currentPrice = asNumberOrNull(src["current_price"]);
  if (currentPrice === null) return null;
  return {
    laborCategory: asStringOrNull(src["labor_category"]) ?? "",
    vendorName: asStringOrNull(src["vendor_name"]),
    currentPrice,
    minYearsExperience: asNumberOrNull(src["min_years_experience"]),
    educationLevel: asStringOrNull(src["education_level"]),
    idvPiid: asStringOrNull(src["idv_piid"]),
    schedule: asStringOrNull(src["schedule"]),
  };
}

/** Normalize a raw CALC v3 body into a labor-rate benchmark, or null when empty. */
export function parseLaborRatesBody(
  raw: unknown,
  keyword: string,
  sampleLimit = 3
): LaborRateBenchmark | null {
  const root = asRecord(raw);
  const hitsWrap = root ? asRecord(root["hits"]) : null;
  const hits = hitsWrap && Array.isArray(hitsWrap["hits"]) ? (hitsWrap["hits"] as unknown[]) : [];

  const records: LaborRateRecord[] = [];
  for (const h of hits) {
    const wrap = asRecord(h);
    const rec = wrap ? parseLaborRateSource(wrap["_source"]) : null;
    if (rec) records.push(rec);
  }
  if (records.length === 0) return null;

  const prices = records.map((r) => r.currentPrice).sort((a, b) => a - b);
  const sum = prices.reduce((a, b) => a + b, 0);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 0 ? (prices[mid - 1]! + prices[mid]!) / 2 : prices[mid]!;

  // hits.total is { value, relation } on modern OpenSearch; tolerate a number.
  const totalRaw = hitsWrap ? hitsWrap["total"] : null;
  const total =
    typeof totalRaw === "number"
      ? totalRaw
      : asNumberOrNull(asRecord(totalRaw)?.["value"]) ?? records.length;

  return {
    keyword,
    total,
    count: records.length,
    minPrice: prices[0]!,
    maxPrice: prices[prices.length - 1]!,
    avgPrice: Math.round((sum / prices.length) * 100) / 100,
    medianPrice: median,
    samples: records.slice(0, sampleLimit),
  };
}

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * Thin GSA data client. Per Diem requires DATA_GOV_API_KEY; CALC works
 * anonymously (key sent when present for higher rate limits). Both operations
 * funnel through one request helper that owns the timeout and non-200 handling.
 * Network/HTTP failures throw; the pricing tool catches and degrades to
 * placeholders rather than failing the whole template.
 */
export class GsaClient {
  private readonly apiKey: string | undefined;
  private readonly fetcher: GsaFetcher;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options?: GsaClientOptions) {
    this.apiKey = options?.apiKey;
    this.fetcher =
      options?.fetcher ?? ((url, init) => fetch(url, init) as Promise<GsaHttpResponse>);
    this.timeoutMs = options?.timeoutMs ?? GSA_TIMEOUT_MS_DEFAULT;
    this.baseUrl =
      options?.baseUrl ?? process.env.GSA_API_BASE_URL ?? GSA_BASE_URL_DEFAULT;
  }

  public hasApiKey(): boolean {
    return typeof this.apiKey === "string" && this.apiKey.trim() !== "";
  }

  private async request(path: string, query: Record<string, string>): Promise<unknown> {
    const params = new URLSearchParams(query);
    const qs = params.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res: GsaHttpResponse;
      try {
        res = await this.fetcher(url, {
          headers: { "User-Agent": GSA_USER_AGENT, Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`GSA request timed out after ${this.timeoutMs}ms for ${path}`);
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`GSA request failed for ${path}: ${message}`);
      }

      if (!res.ok) {
        // Error message carries only the path, never the query string (no key leak).
        throw new Error(`GSA API returned HTTP ${res.status} for ${path}`);
      }

      try {
        return await res.json();
      } catch {
        if (controller.signal.aborted) {
          throw new Error(`GSA request timed out after ${this.timeoutMs}ms for ${path}`);
        }
        throw new Error(`GSA API returned a non-JSON body for ${path}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch normalized Per Diem lodging + M&IE rates for a city/state/year.
   * @throws Error when DATA_GOV_API_KEY is missing or the request fails.
   */
  public async getPerDiemRates(city: string, state: string, year: number): Promise<PerDiemRates> {
    if (!this.hasApiKey()) {
      throw new Error(PER_DIEM_KEY_MISSING_MESSAGE);
    }
    if (!city?.trim() || !state?.trim()) {
      throw new Error("Per Diem lookup requires both city and state");
    }
    const body = await this.request(buildPerDiemPath(city, state, year), {
      api_key: this.apiKey as string,
    });
    return parsePerDiemBody(body, city, state, year);
  }

  /**
   * Fetch a CALC+ labor-rate benchmark for a keyword. Works without a key;
   * sends it when present. Returns null when there are no matching rows.
   * @throws Error on HTTP/transport failure.
   */
  public async getLaborRateBenchmark(
    keyword: string,
    opts?: { pageSize?: number; sampleLimit?: number }
  ): Promise<LaborRateBenchmark | null> {
    const kw = keyword?.trim();
    if (!kw) throw new Error("Labor rate lookup requires a keyword");
    const pageSize = opts?.pageSize && opts.pageSize > 0 ? Math.min(Math.floor(opts.pageSize), 100) : 50;

    const query: Record<string, string> = {
      page: "1",
      page_size: String(pageSize),
      keyword: kw,
    };
    if (this.hasApiKey()) query.api_key = this.apiKey as string;

    const body = await this.request("/acquisition/calc/v3/api/ceilingrates/", query);
    return parseLaborRatesBody(body, kw, opts?.sampleLimit ?? 3);
  }
}
