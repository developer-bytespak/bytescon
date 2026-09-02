/**
 * Input schema and payload types for the `generate_pricing_template` tool.
 *
 * Contract type values follow the backend CostVolume.contractType comment
 * convention (FFP, T_AND_M) plus CPFF per the v0.2 design. T_AND_M means
 * time and materials.
 *
 * The labor row, indirect rate, ODC, and travel shapes are the canonical
 * shapes for the CostVolume JSON columns (laborCategoriesJson,
 * indirectRatesJson, odcLinesJson, travelLinesJson). The backend defines
 * those columns but has no writer yet (verified 2026-06-11: the only
 * repo reference is schema.prisma), so this server defines the canonical
 * shape, using camelCase row keys to match backend JSON conventions
 * (for example BidDecision.explanationJson.credibleInterval).
 */
import { z } from "zod";

export const ContractTypeEnum = z.enum(["FFP", "T_AND_M", "CPFF"]);
export type ContractTypeT = z.infer<typeof ContractTypeEnum>;

/** One travel destination to price with live GSA Per Diem rates. */
export const travelLocationShape = z.object({
  city: z.string().min(1).max(80).describe("Destination city, e.g. \"Albuquerque\"."),
  state: z
    .string()
    .min(2)
    .max(2)
    .describe("Two-letter US state/territory code, e.g. \"NM\"."),
  year: z
    .number()
    .int()
    .min(2015)
    .max(2100)
    .optional()
    .describe("GSA fiscal year for the rate. Defaults to the current year."),
  trips: z.number().int().min(0).max(1000).optional().describe("Number of trips. Default 1."),
  travelers: z.number().int().min(0).max(1000).optional().describe("Travelers per trip. Default 1."),
  nights: z.number().int().min(0).max(366).optional().describe("Lodging nights per trip. Default 1."),
  days: z.number().int().min(0).max(366).optional().describe("M&IE days per trip. Default = nights + 1."),
});
export type TravelLocationT = z.infer<typeof travelLocationShape>;

export const generatePricingTemplateInputShape = {
  opportunity_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Optional opportunity ID (UUID). When given, prefills title, NAICS, set-aside, and estimated value from the tenant-visible opportunity."
    ),
  contract_type: ContractTypeEnum.default("FFP").describe(
    "Contract type for the template: FFP (firm fixed price), T_AND_M (time and materials), or CPFF (cost plus fixed fee). Default FFP."
  ),
  labor_categories: z
    .array(z.string().min(1).max(80))
    .max(20)
    .optional()
    .describe(
      "Optional labor category names, up to 20 entries of up to 80 characters. Defaults to a standard three-row starter set when omitted or empty."
    ),
  travel_locations: z
    .array(travelLocationShape)
    .max(20)
    .optional()
    .describe(
      "Optional travel destinations. Each is priced with live GSA Per Diem lodging + M&IE rates (requires DATA_GOV_API_KEY); a per-trip estimate is computed and added as a travel line. Omit for the placeholder travel line."
    ),
  include_labor_benchmarks: z
    .boolean()
    .optional()
    .describe(
      "When true, fills each labor row's directRate from a live GSA CALC+ median ceiling rate matched by category name (no key required). Default false."
    ),
};

export const GeneratePricingTemplateInput = z.object(generatePricingTemplateInputShape);
export type GeneratePricingTemplateInputT = z.infer<typeof GeneratePricingTemplateInput>;

/** GSA CALC+ benchmark attached to a labor row when benchmarks are requested. */
export interface LaborCategoryBenchmark {
  source: "gsa_calc_v3";
  keyword: string;
  /** Total matching CALC ceiling-rate records. */
  matchCount: number;
  medianRate: number;
  minRate: number;
  maxRate: number;
}

/** One labor row, the canonical CostVolume.laborCategoriesJson element. */
export interface LaborCategoryTemplateRow {
  category: string;
  level: string | null;
  hours: number;
  directRate: number | null;
  escalationPct: number;
  extendedCost: number | null;
  /** Present only when include_labor_benchmarks was set and CALC returned data. */
  benchmark?: LaborCategoryBenchmark | null;
}

/** Canonical CostVolume.indirectRatesJson shape. */
export interface IndirectRatesTemplate {
  fringePct: number | null;
  overheadPct: number | null;
  gaPct: number | null;
  feePct: number | null;
}

/** One ODC row, the canonical CostVolume.odcLinesJson element. */
export interface OdcLineTemplateRow {
  description: string;
  quantity: number;
  unitCost: number | null;
  extendedCost: number | null;
}

/** GSA Per Diem detail attached to a travel row priced from live rates. */
export interface TravelLinePerDiem {
  source: "gsa_perdiem_v2";
  city: string;
  state: string;
  year: number;
  /** True when GSA had no city-specific rate (standard CONUS applies). */
  isStandardRate: boolean;
  /** Max nightly lodging rate (USD), or null for standard CONUS. */
  lodgingRate: number | null;
  /** M&IE daily rate (USD), or null for standard CONUS. */
  mealsRate: number | null;
  nights: number;
  days: number;
}

/** One travel row, the canonical CostVolume.travelLinesJson element. */
export interface TravelLineTemplateRow {
  description: string;
  trips: number;
  travelers: number;
  perTripCost: number | null;
  extendedCost: number | null;
  /** Present only for rows priced from a GSA Per Diem lookup. */
  perDiem?: TravelLinePerDiem | null;
}

/** Opportunity prefill block, null when no opportunity_id was supplied. */
export interface PricingTemplateOpportunityPrefill {
  id: string;
  title: string;
  agency: string;
  naics: string;
  set_aside: string;
  estimated_value: number | null;
  response_deadline: string;
}

/** Payload returned by generate_pricing_template. */
export interface PricingTemplatePayload {
  template_version: string;
  scenario_name: string;
  contract_type: ContractTypeT;
  contract_type_notes: string;
  opportunity: PricingTemplateOpportunityPrefill | null;
  labor_categories: LaborCategoryTemplateRow[];
  indirect_rates: IndirectRatesTemplate;
  odc_lines: OdcLineTemplateRow[];
  travel_lines: TravelLineTemplateRow[];
  total_proposed_price: number | null;
  basis_of_estimate_checklist: string[];
  /**
   * Notes about live GSA data that was (or could not be) folded in. Empty when
   * no Per Diem / CALC enrichment was requested.
   */
  data_sources: string[];
}
