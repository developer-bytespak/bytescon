/**
 * `retrieve_agency_pattern` tool.
 *
 * Returns AgencyAwardProfile matches (global table: avg award value,
 * small business rate, SDVOSB rate, and related rates) plus the top
 * NAICS codes by opportunity count for the matched agency string.
 *
 * The NAICS aggregate runs across the platform opportunity pool WITHOUT
 * a tenant filter, deliberately: it returns ONLY NAICS codes and counts
 * (a global market statistic), never titles, ids, descriptions, or any
 * other tenant row content, so no tenant data can leak (DESIGN.md
 * workstream 2). A valid token is still required for the call itself.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerTool,
  sanitize,
  type HandlerResult,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";
import { escapeLike } from "../lib/escape-like.js";
import { knowledgeClient, type KnowledgePrismaClient } from "../lib/knowledge-prisma.js";
import { runTool } from "../lib/run-tool.js";
import {
  retrieveAgencyPatternInputShape,
  type RetrieveAgencyPatternInputT,
} from "../schemas/retrieve-agency-pattern.js";

const TOOL_NAME = "retrieve_agency_pattern";

const TOOL_DESCRIPTION =
  "Retrieve award-pattern intelligence for an agency by name or fragment, for example " +
  "Veterans or Department of Energy. Returns matching agency award profiles (average " +
  "award value, small business rate, SDVOSB rate, women owned rate, HUBZone rate, total " +
  "awards, typical NAICS) plus the top NAICS codes by opportunity count across the " +
  "platform opportunity pool. NAICS figures are global counts only, no tenant data.";

const MAX_PROFILE_MATCHES = 5;
const TOP_NAICS_COUNT = 10;

/**
 * Pure handler for retrieve_agency_pattern; testable without an McpServer.
 *
 * @param input - Validated tool input.
 * @param opts - Shared handler context.
 * @returns HandlerResult with profile matches and top NAICS counts.
 */
export async function handleRetrieveAgencyPattern(
  input: RetrieveAgencyPatternInputT,
  opts: ToolHandlerContext
): Promise<HandlerResult> {
  return runTool(TOOL_NAME, input, opts, async () => {
    const db: KnowledgePrismaClient = knowledgeClient(opts.prisma);
    const agency = input.agency.trim();
    const agencyPattern = escapeLike(agency);

    const profiles = await db.agencyAwardProfile.findMany({
      where: { agencyName: { contains: agencyPattern, mode: "insensitive" } },
      orderBy: { agencyName: "asc" },
      take: MAX_PROFILE_MATCHES,
    });

    const naicsGroups = await db.opportunity.groupBy({
      by: ["naicsCode"],
      where: {
        agency: { contains: agencyPattern, mode: "insensitive" },
        naicsCode: { not: "" },
      },
      _count: { naicsCode: true },
      orderBy: { _count: { naicsCode: "desc" } },
      take: TOP_NAICS_COUNT,
    });

    return {
      query: agency,
      profile_match_count: profiles.length,
      profile_matches: profiles.map((p) => ({
        agency_name: sanitize(p.agencyName),
        avg_award_value: p.avgAwardValue,
        small_biz_rate: p.smallBizRate,
        sdvosb_rate: p.sdvosbRate,
        women_owned_rate: p.womenOwnedRate,
        hubzone_rate: p.hubzoneRate,
        total_awards: p.totalAwards,
        typical_naics: p.typicalNaics,
        last_refreshed_at: p.lastRefreshedAt.toISOString(),
      })),
      top_naics_by_opportunity_count: naicsGroups.map((g) => ({
        naics: g.naicsCode,
        opportunity_count: g._count.naicsCode,
      })),
      note:
        "Agency award profiles are global reference data. NAICS opportunity counts are " +
        "aggregates across the platform opportunity pool, counts only, no tenant rows exposed.",
    };
  });
}

/**
 * Register retrieve_agency_pattern on the server (ToolRegistrar shape for
 * bootstrapStdioServer).
 */
export function registerRetrieveAgencyPattern(
  server: McpServer,
  context: ToolHandlerContext
): void {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: retrieveAgencyPatternInputShape,
    handler: (input) => handleRetrieveAgencyPattern(input as RetrieveAgencyPatternInputT, context),
  });
}
