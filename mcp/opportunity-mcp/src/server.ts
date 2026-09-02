#!/usr/bin/env node
/**
 * opportunity-mcp v0.3 — stdio entry point.
 *
 * Boot sequence:
 *   1. Read Bytescon_MCP_TOKEN from env (CLAUDE.md §6.1: no fallback default).
 *   2. Resolve to a single tenant via api_tokens (CLAUDE.md §4.4 auth).
 *   3. Register tools.
 *   4. Connect stdio transport.
 *
 * On missing or invalid token the process exits non-zero so Claude
 * Desktop / Claude Code surface the failure immediately.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveBearerToken } from "./lib/auth.js";
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
import { disconnectPrisma } from "./lib/prisma.js";

const SERVER_NAME = "opportunity-mcp";
const SERVER_VERSION = "0.3.0";

async function main(): Promise<void> {
  const token = process.env.Bytescon_MCP_TOKEN;
  if (!token) {
    logger.error("Bytescon_MCP_TOKEN missing", { service: SERVER_NAME });
    process.exit(1);
  }

  const ctx = await resolveBearerToken(token);
  if (!ctx) {
    logger.error("Bytescon_MCP_TOKEN invalid, revoked, or expired", { service: SERVER_NAME });
    process.exit(1);
  }

  logger.info("MCP server starting", {
    service: SERVER_NAME,
    version: SERVER_VERSION,
    tenant_id: ctx.consultingFirmId,
    token_fp: ctx.tokenFp,
    tier: ctx.tier,
  });

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const toolOpts = { ctx, serverName: SERVER_NAME, serverVersion: SERVER_VERSION };
  registerSearchOpportunities(server, toolOpts);
  registerGetOpportunityDetail(server, toolOpts);
  registerGetBidDecision(server, toolOpts);
  registerListComplianceGaps(server, toolOpts);
  registerLookupRecipient(server, toolOpts);
  registerListClients(server, toolOpts);
  registerGetPipelineSummary(server, toolOpts);
  registerGetMarketTrends(server, toolOpts);
  registerForecastRevenue(server, toolOpts);
  registerListSetAsides(server, toolOpts);
  registerListAgenciesByNaics(server, toolOpts);
  registerListPastPerformance(server, toolOpts);
  registerGetPastPerformanceDetail(server, toolOpts);
  registerTriggerEnrichment(server, toolOpts);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP server connected to stdio transport", {
    service: SERVER_NAME,
    tenant_id: ctx.consultingFirmId,
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info("MCP server shutting down", { service: SERVER_NAME, signal });
  await disconnectPrisma().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err: unknown) => {
  logger.error("MCP server crashed", {
    service: SERVER_NAME,
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
