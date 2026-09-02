/**
 * opportunity-mcp HTTP application factory.
 *
 * Builds the Express app (CORS, health, the MCP Streamable HTTP endpoint, and
 * the optional embedded OAuth authorization server) WITHOUT binding a port, so
 * tests can mount it on an ephemeral port. server-http.ts is the thin entry
 * that calls createApp() and listens.
 *
 * The generic HTTP + OAuth 2.1 machinery now lives in @bytescon/mcp-shared; this
 * module is the opportunity-mcp binding: it supplies the server identity, the
 * resource name, the default '/mcp' mount, the 13 tool registrars, and the
 * local Prisma/logger singletons so OAuth token resolution and the validation
 * audit hit the same database the tools use. Behavior is byte-identical to the
 * pre-extraction app: when no OAuth signing key is configured OAuth is fully
 * inert and a raw api_tokens Bearer token works exactly as before.
 */
import {
  createApp as createSharedApp,
  type OAuthConfig,
  type HttpToolRegistrar,
} from "@bytescon/mcp-shared";
import type { Express } from "express";
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
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import type { PrismaLikeClient } from "@bytescon/mcp-shared";

export const SERVER_NAME = "opportunity-mcp";
export const SERVER_VERSION = "0.4.0";

/** Human-readable name advertised in RFC 9728 protected-resource metadata. */
export const RESOURCE_NAME = "Bytescon opportunity intelligence (MCP)";

/** Mount path this resource is served at (unchanged from v0.4). */
export const MOUNT_PATH = "/mcp";

/**
 * The 13-tool opportunity-mcp suite, in registration order. The shared
 * bootstrap threads a per-request ToolHandlerContext into each registrar; the
 * opportunity tools read only { ctx, serverName, serverVersion } from it.
 */
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
  registerListPastPerformance,
  registerGetPastPerformanceDetail,
];

export interface CreateAppOptions {
  /** Inject an explicit OAuth config (tests). Defaults to loadOAuthConfig(). */
  oauth?: OAuthConfig;
}

export interface CreatedApp {
  app: Express;
  oauthConfig: OAuthConfig;
}

export function createApp(opts: CreateAppOptions = {}): CreatedApp {
  const { app, oauthConfig } = createSharedApp({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    resourceName: RESOURCE_NAME,
    mountPath: MOUNT_PATH,
    tools: TOOLS,
    prisma: prisma as unknown as PrismaLikeClient,
    logger,
    ...(opts.oauth ? { oauth: opts.oauth } : {}),
  });
  return { app, oauthConfig };
}
