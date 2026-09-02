/**
 * generate_pricing_template GSA-enrichment tests (no database, no network).
 *
 * The handler is exercised directly with:
 *   - a fake prisma whose only used method is mcpAuditLog.create (stubbed); no
 *     opportunity_id is supplied, so there is no DB read.
 *   - a GsaClient built with an injected fetcher, so api.gsa.gov is never hit.
 * This isolates the travel/labor enrichment wiring from both Postgres and the
 * live API, complementing the DB-backed integration tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  handleGeneratePricingTemplate,
  type PricingToolContext,
} from "../src/tools/generate-pricing-template.js";
import {
  GsaClient,
  type GsaFetcher,
  type GsaHttpResponse,
} from "../src/lib/gsa-client.js";
import type { PricingTemplatePayload } from "../src/schemas/generate-pricing-template.js";
import { createStderrLogger, type PrismaLikeClient } from "@bytescon/mcp-shared";

const jsonResponse = (status: number, body: unknown): GsaHttpResponse => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

const perDiemBody = {
  errors: null,
  rates: [
    {
      rate: [
        {
          months: { month: [{ value: 150, number: 1, short: "Jan", long: "January" }] },
          meals: 80,
          county: "Bernalillo",
          city: "Albuquerque",
          standardRate: "false",
        },
      ],
    },
  ],
  state: "NM",
  year: 2025,
};

const calcBody = {
  hits: {
    total: { value: 42, relation: "eq" },
    hits: [
      { _id: "1", _source: { labor_category: "Program Manager", current_price: 100 } },
      { _id: "2", _source: { labor_category: "Program Manager", current_price: 200 } },
      { _id: "3", _source: { labor_category: "Program Manager", current_price: 150 } },
    ],
  },
};

/** Route a request by URL so parallel labor/travel lookups resolve correctly. */
function routingFetcher(): { fetcher: GsaFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: GsaFetcher = async (url) => {
    calls.push(url);
    if (url.includes("/travel/perdiem/")) return jsonResponse(200, perDiemBody);
    if (url.includes("/acquisition/calc/")) return jsonResponse(200, calcBody);
    throw new Error(`unexpected url ${url}`);
  };
  return { fetcher, calls };
}

const auditCreate = vi.fn(async () => ({}));

function fakeContext(gsa?: GsaClient): PricingToolContext {
  const prisma = {
    mcpAuditLog: { create: auditCreate },
  } as unknown as PrismaLikeClient;
  return {
    ctx: {
      tokenId: "tok-test",
      tokenFp: "0123456789abcdef",
      consultingFirmId: "11111111-1111-1111-1111-111111111111",
      tier: "CORE",
    },
    serverName: "proposal-mcp",
    serverVersion: "0.1.0",
    prisma,
    logger: createStderrLogger("proposal-mcp-test", "error"),
    gsa,
  };
}

function parse(result: { content: Array<{ type: "text"; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0]!.text) as PricingTemplatePayload;
}

describe("generate_pricing_template — GSA enrichment (no DB, no network)", () => {
  it("emits placeholders unchanged when no GSA client and no enrichment requested", async () => {
    const result = await handleGeneratePricingTemplate({ contract_type: "FFP" }, fakeContext());
    expect(result.isError).toBeFalsy();
    const p = parse(result);
    expect(p.travel_lines).toHaveLength(1);
    expect(p.travel_lines[0]!.perTripCost).toBeNull();
    expect(p.travel_lines[0]!.description).toContain("placeholder");
    expect(p.labor_categories.every((l) => l.directRate === null)).toBe(true);
    expect(p.data_sources).toEqual([]);
  });

  it("prices a travel line from live Per Diem rates", async () => {
    const { fetcher } = routingFetcher();
    const gsa = new GsaClient({ apiKey: "TEST_KEY", fetcher });
    const result = await handleGeneratePricingTemplate(
      {
        contract_type: "FFP",
        travel_locations: [
          { city: "Albuquerque", state: "NM", year: 2025, trips: 2, travelers: 1, nights: 3, days: 4 },
        ],
      },
      fakeContext(gsa)
    );
    const p = parse(result);
    expect(p.travel_lines).toHaveLength(1);
    const line = p.travel_lines[0]!;
    // (150*3 + 80*4) * 1 traveler = 450 + 320 = 770 per trip; * 2 trips = 1540
    expect(line.perTripCost).toBe(770);
    expect(line.extendedCost).toBe(1540);
    expect(line.perDiem!.source).toBe("gsa_perdiem_v2");
    expect(line.perDiem!.lodgingRate).toBe(150);
    expect(line.perDiem!.mealsRate).toBe(80);
    expect(p.data_sources.some((s) => s.includes("Per Diem"))).toBe(true);
  });

  it("fills labor directRate from CALC median when benchmarks requested", async () => {
    const { fetcher } = routingFetcher();
    const gsa = new GsaClient({ apiKey: "TEST_KEY", fetcher });
    const result = await handleGeneratePricingTemplate(
      { contract_type: "T_AND_M", labor_categories: ["Program Manager"], include_labor_benchmarks: true },
      fakeContext(gsa)
    );
    const p = parse(result);
    expect(p.labor_categories).toHaveLength(1);
    const row = p.labor_categories[0]!;
    expect(row.directRate).toBe(150); // median of 100/150/200
    expect(row.benchmark!.source).toBe("gsa_calc_v3");
    expect(row.benchmark!.matchCount).toBe(42);
    expect(p.data_sources.some((s) => s.includes("CALC"))).toBe(true);
  });

  it("degrades to an unpriced travel line (not an error) when Per Diem fails", async () => {
    const failFetcher: GsaFetcher = async () => jsonResponse(500, { error: "boom" });
    const gsa = new GsaClient({ apiKey: "TEST_KEY", fetcher: failFetcher });
    const result = await handleGeneratePricingTemplate(
      { contract_type: "FFP", travel_locations: [{ city: "Albuquerque", state: "NM" }] },
      fakeContext(gsa)
    );
    expect(result.isError).toBeFalsy(); // template still produced
    const p = parse(result);
    expect(p.travel_lines[0]!.perTripCost).toBeNull();
    expect(p.travel_lines[0]!.perDiem).toBeNull();
    expect(p.data_sources.some((s) => s.toLowerCase().includes("failed"))).toBe(true);
  });

  it("notes a missing GSA client when travel locations are supplied without one", async () => {
    const result = await handleGeneratePricingTemplate(
      { contract_type: "FFP", travel_locations: [{ city: "Albuquerque", state: "NM" }] },
      fakeContext(undefined)
    );
    const p = parse(result);
    expect(p.travel_lines).toHaveLength(1);
    expect(p.travel_lines[0]!.description).toContain("placeholder");
    expect(p.data_sources.some((s) => s.includes("no GSA client"))).toBe(true);
  });
});
