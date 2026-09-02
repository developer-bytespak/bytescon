/**
 * proposal-mcp gateway resource module.
 *
 * Exports the metadata and tool list the multiplexed gateway needs to mount
 * this server as one HTTP resource. Mirrors src/server.ts (the stdio entry):
 * the same five proposal tools, the same CORE minimum tier. The gateway threads
 * a per-request ToolHandlerContext into each registrar; makeTools only returns
 * the registrar list (prisma/logger accepted for a uniform suite signature).
 */
import type { Logger, PrismaLikeClient, ResourceToolRegistrar, ApiTokenTier } from "@bytescon/mcp-shared";
import { GsaClient } from "./lib/gsa-client.js";
import type { PricingToolContext } from "./tools/generate-pricing-template.js";
import { registerGetComplianceMatrix } from "./tools/get-compliance-matrix.js";
import { registerListMatrixRequirements } from "./tools/list-matrix-requirements.js";
import { registerGetBidGuidance } from "./tools/get-bid-guidance.js";
import { registerGetAdherenceScore } from "./tools/get-adherence-score.js";
import { registerGeneratePricingTemplate } from "./tools/generate-pricing-template.js";

export const SERVER_NAME = "proposal-mcp";
export const SERVER_VERSION = "0.1.0";

/** Human-readable name advertised in RFC 9728 protected-resource metadata. */
export const RESOURCE_NAME = "Bytescon proposal assembly (MCP)";

/** Mount path this resource is served at on the gateway. */
export const MOUNT_PATH = "/proposal/mcp";

/** Minimum tier for every proposal tool. */
export const MIN_TIER: ApiTokenTier = "CORE";

/**
 * Build the proposal tool registrars for the gateway.
 *
 * Constructs one GsaClient from DATA_GOV_API_KEY (logging a warning when the
 * key is unset, matching the stdio server) and injects it into the pricing
 * tool's per-request context. The other four tools are unchanged.
 */
export function makeTools(_prisma: PrismaLikeClient, logger: Logger): ResourceToolRegistrar[] {
  const gsa = new GsaClient({ apiKey: process.env.DATA_GOV_API_KEY });
  if (!gsa.hasApiKey()) {
    logger.warn(
      "DATA_GOV_API_KEY is not set; generate_pricing_template Per Diem travel pricing will be unavailable (CALC labor benchmarks still work)",
      { service: SERVER_NAME }
    );
  }
  return [
    registerGetComplianceMatrix,
    registerListMatrixRequirements,
    registerGetBidGuidance,
    registerGetAdherenceScore,
    (server, context) =>
      registerGeneratePricingTemplate(server, { ...context, gsa } as PricingToolContext),
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
