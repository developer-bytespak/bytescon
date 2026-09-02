#!/usr/bin/env node
/**
 * knowledge-mcp v0.1.0 stdio entry point.
 *
 * FAR/DFARS/agency compliance knowledge MCP server for the Bytescon
 * suite. Boots via @bytescon/mcp-shared bootstrapStdioServer: reads
 * Bytescon_MCP_TOKEN, resolves the tenant context against api_tokens,
 * registers the four knowledge tools, and connects the stdio transport.
 * Exits non-zero when the token is missing, invalid, revoked, expired,
 * or below tier CORE.
 */
import { bootstrapStdioServer, createStderrLogger } from "@bytescon/mcp-shared";
import { KNOWLEDGE_MIN_TIER } from "./lib/guard.js";
import { registerRetrieveAgencyPattern } from "./tools/retrieve-agency-pattern.js";
import { registerRetrieveDfarsClause } from "./tools/retrieve-dfars-clause.js";
import { registerRetrieveFarClause } from "./tools/retrieve-far-clause.js";
import { registerSearchClauses } from "./tools/search-clauses.js";

export const SERVER_NAME = "knowledge-mcp";
export const SERVER_VERSION = "0.1.0";

bootstrapStdioServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
  minTier: KNOWLEDGE_MIN_TIER,
  tools: [
    registerRetrieveFarClause,
    registerRetrieveDfarsClause,
    registerRetrieveAgencyPattern,
    registerSearchClauses,
  ],
}).catch((err: unknown) => {
  const logger = createStderrLogger(SERVER_NAME);
  logger.error("MCP server crashed", {
    service: SERVER_NAME,
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
