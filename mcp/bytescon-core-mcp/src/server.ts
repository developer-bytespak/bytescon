#!/usr/bin/env node
/**
 * bytescon-core-mcp v0.1.0, stdio entry point.
 *
 * Tenant core and admin data, READ-ONLY (4 tools): list_deliverables,
 * get_billing_status, get_usage_summary, list_users.
 *
 * Boot sequence (via @bytescon/mcp-shared bootstrapStdioServer, identical
 * to opportunity-mcp v0.3):
 *   1. Read Bytescon_MCP_TOKEN from env (no fallback default).
 *   2. Resolve to a single tenant via api_tokens.
 *   3. Enforce the server-wide minimum tier PRO (DESIGN.md workstream 5);
 *      each tool additionally re-checks the tier per call.
 *   4. Register tools and connect the stdio transport.
 *
 * On missing, invalid, or under-tier token the process exits non-zero so
 * Claude Desktop / Claude Code surface the failure immediately.
 */
import { bootstrapStdioServer, createStderrLogger } from "@bytescon/mcp-shared";
import { REQUIRED_TIER } from "./lib/run-tool.js";
import { registerListDeliverables } from "./tools/list-deliverables.js";
import { registerGetBillingStatus } from "./tools/get-billing-status.js";
import { registerGetUsageSummary } from "./tools/get-usage-summary.js";
import { registerListUsers } from "./tools/list-users.js";

const SERVER_NAME = "bytescon-core-mcp";
const SERVER_VERSION = "0.1.0";

const logger = createStderrLogger(SERVER_NAME);

bootstrapStdioServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
  minTier: REQUIRED_TIER,
  logger,
  tools: [
    registerListDeliverables,
    registerGetBillingStatus,
    registerGetUsageSummary,
    registerListUsers,
  ],
}).catch((err: unknown) => {
  logger.error("MCP server crashed", {
    service: SERVER_NAME,
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
