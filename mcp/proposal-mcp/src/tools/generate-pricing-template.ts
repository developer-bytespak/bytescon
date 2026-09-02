/**
 * `generate_pricing_template` tool handler.
 *
 * PURE generator: no LLM call and no domain DB writes (the mandatory
 * mcp_audit_log row is still written, per suite contract). Emits a
 * structured pricing template whose labor, indirect, ODC, and travel
 * sections are the canonical shapes for the CostVolume JSON columns
 * (laborCategoriesJson and siblings), so a future backend writer can
 * persist a completed template directly.
 *
 * The only DB read is the optional tenant-scoped opportunity prefill
 * when opportunity_id is supplied.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  McpToolError,
  registerTool,
  sanitize,
  type HandlerResult,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";
import { asProposalDb } from "../lib/db.js";
import { runTool } from "../lib/tool-runner.js";
import { GsaClient } from "../lib/gsa-client.js";
import {
  generatePricingTemplateInputShape,
  type ContractTypeT,
  type GeneratePricingTemplateInputT,
  type LaborCategoryTemplateRow,
  type PricingTemplateOpportunityPrefill,
  type PricingTemplatePayload,
  type TravelLineTemplateRow,
  type TravelLocationT,
} from "../schemas/generate-pricing-template.js";

/** Context for this tool: the standard handler context plus an optional GSA client. */
export interface PricingToolContext extends ToolHandlerContext {
  /**
   * GSA data client for live Per Diem / CALC enrichment. Optional: when absent
   * (e.g. older callers, unit tests of pure generation) the tool emits the
   * original placeholder behavior unchanged.
   */
  gsa?: GsaClient;
}

const TOOL_NAME = "generate_pricing_template";

const TOOL_DESCRIPTION =
  "Generate a structured JSON pricing template for a cost volume: labor category rows, " +
  "indirect rate placeholders, ODC and travel line placeholders, and a basis-of-estimate " +
  "checklist. Nothing is written to the database. Optionally prefills title and estimated " +
  "value from a tenant-visible opportunity via opportunity_id. Can fold in live GSA data: " +
  "pass travel_locations to price travel lines from GSA Per Diem (lodging + M&IE), and set " +
  "include_labor_benchmarks to fill labor directRates from GSA CALC+ median ceiling rates.";

const TEMPLATE_VERSION = "proposal-mcp/0.1.0";

const DEFAULT_LABOR_CATEGORIES = [
  "Program Manager",
  "Senior Subject Matter Expert",
  "Analyst",
] as const;

const CONTRACT_TYPE_NOTES: Record<ContractTypeT, string> = {
  FFP:
    "Firm fixed price: price each labor row at a fully burdened rate, roll fee into the " +
    "loaded rate, and carry risk contingency in the basis of estimate.",
  T_AND_M:
    "Time and materials: provide ceiling hours per labor category with fully burdened " +
    "hourly rates; materials and ODCs are billed at cost plus the material handling rate.",
  CPFF:
    "Cost plus fixed fee: keep direct costs, indirect rates, and the fixed fee amount " +
    "separate; cite the provisional billing rate agreement for each indirect rate.",
};

const BASIS_OF_ESTIMATE_CHECKLIST = [
  "Confirm labor category mapping against the solicitation's required skill mix",
  "Document the basis for each direct labor rate (payroll actuals, salary survey, or contract history)",
  "Apply current provisional indirect rates and cite the rate agreement or DCAA correspondence",
  "Price option periods with documented escalation assumptions",
  "Reconcile total proposed price against the government estimated value when one is published",
  "Verify ODC and travel estimates against FAR 31.205 allowability rules",
  "Cross check labor hours against the technical approach staffing plan",
  "Record every assumption in the cost narrative",
];

/**
 * Build the labor rows. When benchmarks are requested AND a GSA client is
 * available, each row's directRate is filled from the live CALC+ median ceiling
 * rate for that category and a `benchmark` block is attached. A failed or empty
 * lookup degrades to the placeholder row (directRate null) — never an error.
 */
async function buildLaborRows(
  categories: string[],
  wantBenchmarks: boolean,
  gsa: GsaClient | undefined,
  sources: string[],
  log: ToolHandlerContext["logger"]
): Promise<LaborCategoryTemplateRow[]> {
  const baseRow = (category: string): LaborCategoryTemplateRow => ({
    category: sanitize(category, 80),
    level: null,
    hours: 0,
    directRate: null,
    escalationPct: 0,
    extendedCost: null,
  });

  if (!wantBenchmarks || !gsa) {
    return categories.map(baseRow);
  }

  let anyHit = false;
  let anyFail = false;
  const rows = await Promise.all(
    categories.map(async (category) => {
      const row = baseRow(category);
      try {
        const bench = await gsa.getLaborRateBenchmark(category, { pageSize: 50, sampleLimit: 0 });
        if (bench) {
          anyHit = true;
          row.directRate = bench.medianPrice;
          row.benchmark = {
            source: "gsa_calc_v3",
            keyword: bench.keyword,
            matchCount: bench.total,
            medianRate: bench.medianPrice,
            minRate: bench.minPrice,
            maxRate: bench.maxPrice,
          };
        } else {
          row.benchmark = null;
        }
      } catch (err) {
        anyFail = true;
        row.benchmark = null;
        log.warn("CALC labor benchmark lookup failed; leaving directRate null", {
          category,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return row;
    })
  );

  if (anyHit) sources.push("GSA CALC+ v3 ceiling rates (labor directRate = median match)");
  if (anyFail) sources.push("GSA CALC+ lookup failed for one or more categories; those directRates left null");
  return rows;
}

/**
 * Build the travel rows from live GSA Per Diem rates. Per-trip estimate =
 * (lodgingRate * nights + mealsRate * days) * travelers, summed over trips for
 * extendedCost. A failed/standard-rate lookup still emits a row (perTripCost
 * null) with a note — never an error. Returns the placeholder row when no
 * locations are supplied or no GSA client is available.
 */
async function buildTravelRows(
  locations: TravelLocationT[] | undefined,
  gsa: GsaClient | undefined,
  sources: string[],
  log: ToolHandlerContext["logger"]
): Promise<TravelLineTemplateRow[]> {
  const placeholder: TravelLineTemplateRow = {
    description: "Travel placeholder, replace with actual trips or remove",
    trips: 0,
    travelers: 0,
    perTripCost: null,
    extendedCost: null,
  };

  if (!locations || locations.length === 0) return [placeholder];
  if (!gsa) {
    sources.push("Travel locations supplied but no GSA client configured; emitting placeholder travel line");
    return [placeholder];
  }

  const currentYear = new Date().getUTCFullYear();
  let anyHit = false;
  let anyFail = false;

  const rows = await Promise.all(
    locations.map(async (loc): Promise<TravelLineTemplateRow> => {
      const trips = loc.trips ?? 1;
      const travelers = loc.travelers ?? 1;
      const nights = loc.nights ?? 1;
      const days = loc.days ?? nights + 1;
      const year = loc.year ?? currentYear;
      const cityState = `${sanitize(loc.city, 80)}, ${loc.state.toUpperCase()}`;

      try {
        const pd = await gsa.getPerDiemRates(loc.city, loc.state, year);
        anyHit = true;
        const lodging = pd.maxLodging;
        const meals = pd.mealsRate;
        // Per-trip cost only when both rates are known (city-specific rate).
        const perTripCost =
          lodging !== null && meals !== null
            ? Math.round((lodging * nights + meals * days) * travelers * 100) / 100
            : null;
        const extendedCost = perTripCost !== null ? Math.round(perTripCost * trips * 100) / 100 : null;
        return {
          description: pd.isStandardRate
            ? `Travel to ${cityState} (GSA standard CONUS rate — set lodging/M&IE manually)`
            : `Travel to ${cityState} (GSA Per Diem FY${pd.year})`,
          trips,
          travelers,
          perTripCost,
          extendedCost,
          perDiem: {
            source: "gsa_perdiem_v2",
            city: pd.city,
            state: pd.state,
            year: pd.year,
            isStandardRate: pd.isStandardRate,
            lodgingRate: lodging,
            mealsRate: meals,
            nights,
            days,
          },
        };
      } catch (err) {
        anyFail = true;
        log.warn("Per Diem lookup failed; emitting unpriced travel row", {
          city: loc.city,
          state: loc.state,
          err: err instanceof Error ? err.message : String(err),
        });
        return {
          description: `Travel to ${cityState} (GSA Per Diem unavailable — price manually)`,
          trips,
          travelers,
          perTripCost: null,
          extendedCost: null,
          perDiem: null,
        };
      }
    })
  );

  if (anyHit) sources.push("GSA Per Diem v2 lodging + M&IE rates (travel line per-trip estimate)");
  if (anyFail) sources.push("GSA Per Diem lookup failed for one or more locations; those travel lines left unpriced");
  return rows;
}

export async function handleGeneratePricingTemplate(
  input: GeneratePricingTemplateInputT,
  context: PricingToolContext
): Promise<HandlerResult> {
  return runTool(TOOL_NAME, input, context, async () => {
    let opportunity: PricingTemplateOpportunityPrefill | null = null;

    if (input.opportunity_id) {
      const db = asProposalDb(context.prisma);
      const opp = await db.opportunity.findFirst({
        where: {
          consultingFirmId: context.ctx.consultingFirmId,
          id: input.opportunity_id,
        },
        select: {
          id: true,
          title: true,
          agency: true,
          naicsCode: true,
          setAsideType: true,
          estimatedValue: true,
          responseDeadline: true,
        },
      });
      if (!opp) {
        throw new McpToolError(
          "TOOL_ERROR",
          `opportunity not found or not accessible in this tenant: ${input.opportunity_id}`
        );
      }
      opportunity = {
        id: opp.id,
        title: sanitize(opp.title, 300),
        agency: sanitize(opp.agency, 200),
        naics: opp.naicsCode,
        set_aside: opp.setAsideType,
        estimated_value: opp.estimatedValue === null ? null : Number(opp.estimatedValue.toString()),
        response_deadline: opp.responseDeadline.toISOString(),
      };
    }

    const categories =
      input.labor_categories && input.labor_categories.length > 0
        ? input.labor_categories
        : [...DEFAULT_LABOR_CATEGORIES];

    const dataSources: string[] = [];

    // Live GSA enrichment runs in parallel; both degrade to placeholders on
    // failure so the template is always produced.
    const [laborRows, travelRows] = await Promise.all([
      buildLaborRows(
        categories,
        input.include_labor_benchmarks === true,
        context.gsa,
        dataSources,
        context.logger
      ),
      buildTravelRows(input.travel_locations, context.gsa, dataSources, context.logger),
    ]);

    const payload: PricingTemplatePayload = {
      template_version: TEMPLATE_VERSION,
      scenario_name: "Base",
      contract_type: input.contract_type,
      contract_type_notes: CONTRACT_TYPE_NOTES[input.contract_type],
      opportunity,
      labor_categories: laborRows,
      indirect_rates: {
        fringePct: null,
        overheadPct: null,
        gaPct: null,
        feePct: null,
      },
      odc_lines: [
        {
          description: "ODC placeholder, replace with actual line items or remove",
          quantity: 0,
          unitCost: null,
          extendedCost: null,
        },
      ],
      travel_lines: travelRows,
      total_proposed_price: null,
      basis_of_estimate_checklist: [...BASIS_OF_ESTIMATE_CHECKLIST],
      data_sources: dataSources,
    };
    return payload;
  });
}

export function registerGeneratePricingTemplate(
  server: McpServer,
  context: PricingToolContext
): void {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: generatePricingTemplateInputShape,
    handler: async (input) => handleGeneratePricingTemplate(input, context),
  });
}
