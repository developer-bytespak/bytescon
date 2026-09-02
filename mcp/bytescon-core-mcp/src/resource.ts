/**
 * bytescon-core-mcp gateway resource module.
 *
 * Exports the metadata and tool list the multiplexed gateway needs to mount
 * this server as one HTTP resource. Mirrors src/server.ts (the stdio entry):
 * the same four read-only tools, the same PRO minimum tier. The gateway
 * enforces minTier per request (403) before any tool runs, and each tool
 * additionally re-checks PRO per call. makeTools only returns the registrar
 * list (prisma/logger accepted for a uniform suite signature).
 */
import type { Logger, PrismaLikeClient, ResourceToolRegistrar, ApiTokenTier } from "@bytescon/mcp-shared";
import { REQUIRED_TIER } from "./lib/run-tool.js";
import { registerListDeliverables } from "./tools/list-deliverables.js";
import { registerGetBillingStatus } from "./tools/get-billing-status.js";
import { registerGetUsageSummary } from "./tools/get-usage-summary.js";
import { registerListUsers } from "./tools/list-users.js";

export const SERVER_NAME = "bytescon-core-mcp";
export const SERVER_VERSION = "0.1.0";

/** Human-readable name advertised in RFC 9728 protected-resource metadata. */
export const RESOURCE_NAME = "Bytescon tenant core / admin (MCP)";

/** Mount path this resource is served at on the gateway. */
export const MOUNT_PATH = "/core/mcp";

/** Minimum tier for every bytescon-core tool (PRO). */
export const MIN_TIER: ApiTokenTier = REQUIRED_TIER;

/** Build the bytescon-core tool registrars for the gateway. */
export function makeTools(_prisma: PrismaLikeClient, _logger: Logger): ResourceToolRegistrar[] {
  return [
    registerListDeliverables,
    registerGetBillingStatus,
    registerGetUsageSummary,
    registerListUsers,
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
