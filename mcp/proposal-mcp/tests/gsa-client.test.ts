/**
 * Unit tests for the GSA data client (Per Diem + CALC labor rates). The
 * fetcher is always injected; the real api.gsa.gov is never called.
 */
import { describe, expect, it, vi } from "vitest";
import {
  GsaClient,
  GSA_USER_AGENT,
  parsePerDiemBody,
  parseLaborRatesBody,
  parseLaborRateSource,
  buildPerDiemPath,
  type GsaFetcher,
  type GsaHttpResponse,
} from "../src/lib/gsa-client.js";

const jsonResponse = (status: number, body: unknown): GsaHttpResponse => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

/** Records the URLs requested and returns queued responses in order. */
function makeFetcher(responses: GsaHttpResponse[]): { fetcher: GsaFetcher; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetcher: GsaFetcher = async (url, init) => {
    calls.push(url);
    expect(init.headers["User-Agent"]).toBe(GSA_USER_AGENT);
    const res = responses[i++];
    if (!res) throw new Error("no queued response");
    return res;
  };
  return { fetcher, calls };
}

// Confirmed Per Diem shape (Albuquerque/NM/2025, two months).
const perDiemBody = {
  request: null,
  errors: null,
  rates: [
    {
      rate: [
        {
          months: {
            month: [
              { value: 144, number: 1, short: "Jan", long: "January" },
              { value: 158, number: 4, short: "Apr", long: "April" },
            ],
          },
          meals: 80,
          county: "Bernalillo",
          city: "Albuquerque",
          zip: null,
          standardRate: "false",
        },
      ],
    },
  ],
  state: "NM",
  year: 2025,
};

// Confirmed CALC v3 OpenSearch shape.
const calcBody = {
  hits: {
    total: { value: 8765, relation: "eq" },
    hits: [
      { _id: "1", _source: { labor_category: "Program Manager", current_price: 100, education_level: "Bachelors", min_years_experience: 5, idv_piid: "X", schedule: "MAS", vendor_name: "Acme" } },
      { _id: "2", _source: { labor_category: "Sr PM", current_price: 200 } },
      { _id: "3", _source: { labor_category: "Jr PM", current_price: 150 } },
    ],
  },
};

describe("buildPerDiemPath", () => {
  it("builds the path and uppercases + encodes", () => {
    expect(buildPerDiemPath("San Diego", "ca", 2026)).toBe(
      "/travel/perdiem/v2/rates/city/San%20Diego/state/CA/year/2026"
    );
  });
});

describe("parsePerDiemBody (pure)", () => {
  it("maps lodging by month, max lodging, and M&IE", () => {
    const r = parsePerDiemBody(perDiemBody, "Albuquerque", "NM", 2025);
    expect(r.isStandardRate).toBe(false);
    expect(r.maxLodging).toBe(158);
    expect(r.mealsRate).toBe(80);
    expect(r.lodgingByMonth).toHaveLength(2);
    expect(r.county).toBe("Bernalillo");
  });

  it("flags standard CONUS when rates is empty", () => {
    const r = parsePerDiemBody({ rates: [], errors: null }, "Nowhere", "zz", 2025);
    expect(r.isStandardRate).toBe(true);
    expect(r.maxLodging).toBeNull();
    expect(r.mealsRate).toBeNull();
    expect(r.state).toBe("ZZ");
  });
});

describe("parseLaborRateSource / parseLaborRatesBody (pure)", () => {
  it("drops rows with no current_price", () => {
    expect(parseLaborRateSource({ labor_category: "x", current_price: null })).toBeNull();
  });

  it("computes the benchmark from hits.hits[]._source", () => {
    const b = parseLaborRatesBody(calcBody, "program manager", 2)!;
    expect(b.total).toBe(8765);
    expect(b.count).toBe(3);
    expect(b.minPrice).toBe(100);
    expect(b.maxPrice).toBe(200);
    expect(b.medianPrice).toBe(150);
    expect(b.avgPrice).toBe(150);
    expect(b.samples).toHaveLength(2); // sampleLimit
  });

  it("returns null when there are no hits", () => {
    expect(parseLaborRatesBody({ hits: { total: 0, hits: [] } }, "x")).toBeNull();
  });
});

describe("GsaClient.getPerDiemRates (injected fetcher)", () => {
  it("throws the setup error when DATA_GOV_API_KEY is unset (no network)", async () => {
    const { fetcher, calls } = makeFetcher([]);
    const client = new GsaClient({ apiKey: undefined, fetcher });
    await expect(client.getPerDiemRates("Albuquerque", "NM", 2025)).rejects.toThrow(/DATA_GOV_API_KEY/);
    expect(calls.length).toBe(0);
  });

  it("hits the correct path with api_key and normalizes", async () => {
    const { fetcher, calls } = makeFetcher([jsonResponse(200, perDiemBody)]);
    const client = new GsaClient({ apiKey: "TEST_KEY", fetcher, baseUrl: "https://api.gsa.gov" });
    const r = await client.getPerDiemRates("Albuquerque", "NM", 2025);
    expect(calls[0]).toContain("/travel/perdiem/v2/rates/city/Albuquerque/state/NM/year/2025");
    expect(calls[0]).toContain("api_key=TEST_KEY");
    expect(r.maxLodging).toBe(158);
  });

  it("throws on a non-200 (path only, no query string in message)", async () => {
    const { fetcher } = makeFetcher([jsonResponse(403, { error: "over rate limit" })]);
    const client = new GsaClient({ apiKey: "TEST_KEY", fetcher });
    const err = await client.getPerDiemRates("Albuquerque", "NM", 2025).catch((e) => e as Error);
    expect(err.message).toMatch(/HTTP 403/);
    expect(err.message).not.toContain("TEST_KEY"); // key never leaks
  });
});

describe("GsaClient.getLaborRateBenchmark (injected fetcher)", () => {
  it("works WITHOUT a key (anonymous) and hits the v3 ceilingrates path", async () => {
    const { fetcher, calls } = makeFetcher([jsonResponse(200, calcBody)]);
    const client = new GsaClient({ apiKey: undefined, fetcher, baseUrl: "https://api.gsa.gov" });
    const b = await client.getLaborRateBenchmark("program manager", { pageSize: 50 });
    expect(b!.medianPrice).toBe(150);
    expect(calls[0]).toContain("/acquisition/calc/v3/api/ceilingrates/");
    expect(calls[0]).toContain("keyword=program+manager");
    expect(calls[0]).not.toContain("api_key"); // no key sent when unset
  });

  it("sends api_key when present", async () => {
    const { fetcher, calls } = makeFetcher([jsonResponse(200, calcBody)]);
    const client = new GsaClient({ apiKey: "TEST_KEY", fetcher });
    await client.getLaborRateBenchmark("engineer");
    expect(calls[0]).toContain("api_key=TEST_KEY");
  });

  it("returns null on empty results", async () => {
    const { fetcher } = makeFetcher([jsonResponse(200, { hits: { total: 0, hits: [] } })]);
    const client = new GsaClient({ apiKey: "TEST_KEY", fetcher });
    expect(await client.getLaborRateBenchmark("nonexistent")).toBeNull();
  });
});
