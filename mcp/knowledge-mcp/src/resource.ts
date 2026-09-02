/**
 * knowledge-mcp gateway resource module.
 *
 * Exports the metadata and tool list the multiplexed gateway needs to mount
 * this server as one HTTP resource. Mirrors src/server.ts (the stdio entry):
 * the same four knowledge tools, the same CORE minimum tier. The gateway
 * threads a per-request ToolHandlerContext into each registrar, so makeTools
 * only needs to return the registrar list; prisma/logger are accepted for a
 * uniform signature across the suite (knowledge tools read prisma from the
 * per-request context, so they are unused here).
 */
import type { Logger, PrismaLikeClient, ResourceToolRegistrar, ApiTokenTier } from "@bytescon/mcp-shared";
import { KNOWLEDGE_MIN_TIER } from "./lib/guard.js";
import { registerRetrieveFarClause } from "./tools/retrieve-far-clause.js";
import { registerRetrieveDfarsClause } from "./tools/retrieve-dfars-clause.js";
import { registerRetrieveAgencyPattern } from "./tools/retrieve-agency-pattern.js";
import { registerSearchClauses } from "./tools/search-clauses.js";

export const SERVER_NAME = "knowledge-mcp";
export const SERVER_VERSION = "0.1.0";

/** Human-readable name advertised in RFC 9728 protected-resource metadata. */
export const RESOURCE_NAME = "Bytescon knowledge / FAR-DFARS (MCP)";

/** Mount path this resource is served at on the gateway. */
export const MOUNT_PATH = "/knowledge/mcp";

/** Minimum tier for every knowledge tool. */
export const MIN_TIER: ApiTokenTier = KNOWLEDGE_MIN_TIER;

/** Build the knowledge tool registrars for the gateway. */
export function makeTools(_prisma: PrismaLikeClient, _logger: Logger): ResourceToolRegistrar[] {
  return [
    registerRetrieveFarClause,
    registerRetrieveDfarsClause,
    registerRetrieveAgencyPattern,
    registerSearchClauses,
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
