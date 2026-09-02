/**
 * opportunity-mcp gateway resource module.
 *
 * Exports the metadata and tool list the multiplexed gateway needs to mount
 * opportunity-mcp as the primary `/mcp` resource. The single-resource HTTP
 * entry (server-http.ts via app.ts) is unchanged and remains the live
 * deployment; this module simply re-exposes the same 13-tool suite, identity,
 * resource name, and `/mcp` mount in the uniform shape the gateway consumes.
 *
 * makeTools(prisma, logger) returns the registrar list; the opportunity tools
 * read only { ctx, serverName, serverVersion } from the per-request context the
 * gateway threads in, so prisma/logger are accepted for a uniform suite
 * signature but unused here.
 */
import type { Logger, PrismaLikeClient, ResourceToolRegistrar, ApiTokenTier } from "@bytescon/mcp-shared";
import { SERVER_NAME, SERVER_VERSION, RESOURCE_NAME, MOUNT_PATH } from "./app.js";
import { registerSearchOpportunities } from "./tools/search-opportunities.js";
import { registerGetOpportunityDetail } from "./tools/get-opportunity-detail.js";
import { registerGetBidDecision } from "./tools/get-bid-decision.js";
import { registerListComplianceGaps } from "./tools/list-compliance-gaps.js";
import { registerLookupRecipient } from "./tools/lookup-recipient.js";
import { registerListClients } from "./tools/list-clients.js";
import { registerGetPipelineSummary } from "./tools/get-pipeline-summary.js";
import { registerGetMarketTrends } from "./tools/get-market-trends.js";
import { registerForecastRevenue } from "./tools/forecast-revenue.js";
import { registerListSetAsides } from "./tools/list-set-asides.js";
import { registerListAgenciesByNaics } from "./tools/list-agencies-by-naics.js";
import { registerListPastPerformance } from "./tools/list-past-performance.js";
import { registerGetPastPerformanceDetail } from "./tools/get-past-performance-detail.js";
import { registerTriggerEnrichment } from "./tools/trigger-enrichment.js";

export { SERVER_NAME, SERVER_VERSION, RESOURCE_NAME, MOUNT_PATH };

/** opportunity-mcp has no server-wide minimum tier (per-tool gating only). */
export const MIN_TIER: ApiTokenTier | undefined = undefined;

/** Build the 14 opportunity tool registrars for the gateway. */
export function makeTools(_prisma: PrismaLikeClient, _logger: Logger): ResourceToolRegistrar[] {
  return [
    registerSearchOpportunities,
    registerGetOpportunityDetail,
    registerGetBidDecision,
    registerListComplianceGaps,
    registerLookupRecipient,
    registerListClients,
    registerGetPipelineSummary,
    registerGetMarketTrends,
    registerForecastRevenue,
    registerListSetAsides,
    registerListAgenciesByNaics,
    registerListPastPerformance,
    registerGetPastPerformanceDetail,
    registerTriggerEnrichment,
  ];
}

export const resource = {
  name: SERVER_NAME,
  version: SERVER_VERSION,
  resourceName: RESOURCE_NAME,
  mountPath: MOUNT_PATH,
  minTier: MIN_TIER,
  makeTools,
};
