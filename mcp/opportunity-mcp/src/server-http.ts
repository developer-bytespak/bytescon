#!/usr/bin/env node
/**
 * opportunity-mcp HTTP/SSE entry point (v0.4).
 *
 * Thin launcher: delegates to the shared bootstrapHttpServer, which builds the
 * Express app (see app.ts for the opportunity-mcp binding) and binds the port.
 * The app implements the MCP Streamable HTTP transport plus an embedded OAuth
 * 2.1 authorization server (RFC 9728 / RFC 8414 / RFC 7591 + PKCE) so remote
 * connectors can sign in. Each request carries its own Bearer credential and
 * resolves to a tenant; no startup token required.
 *
 * Endpoints:
 *   POST   /mcp                          JSON-RPC over HTTP (standard MCP)
 *   GET    /mcp                          SSE stream (streaming clients)
 *   DELETE /mcp                          close session (stateless: always 200)
 *   GET    /health                       Docker / Caddy probe
 *   GET    /.well-known/oauth-*          OAuth discovery (when OAuth enabled)
 *   POST   /mcp/oauth/{register,token}   OAuth endpoints (when OAuth enabled)
 *   GET/POST /mcp/oauth/authorize        OAuth consent (when OAuth enabled)
 */
import { bootstrapHttpServer, type HttpToolRegistrar, type PrismaLikeClient } from "@bytescon/mcp-shared";
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
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";

const TOOLS: HttpToolRegistrar[] = [
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
  // Registered on stdio since v0.3 but previously missing here — the HTTP
  // and stdio inventories are now identical.
  registerListPastPerformance,
  registerGetPastPerformanceDetail,
  // GB-107
  registerTriggerEnrichment,
];

bootstrapHttpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
  resourceName: RESOURCE_NAME,
  mountPath: MOUNT_PATH,
  tools: TOOLS,
  prisma: prisma as unknown as PrismaLikeClient,
  logger,
});
