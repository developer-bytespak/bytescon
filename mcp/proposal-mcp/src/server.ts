#!/usr/bin/env node
/**
 * proposal-mcp v0.1 stdio entry point.
 *
 * Boot sequence is delegated to @bytescon/mcp-shared bootstrapStdioServer,
 * which mirrors opportunity-mcp exactly:
 *   1. Read Bytescon_MCP_TOKEN from env (no fallback default).
 *   2. Resolve to a single tenant via api_tokens; exit non-zero on failure.
 *   3. Enforce the server-wide minimum tier (CORE).
 *   4. Register tools and connect the stdio transport.
 *   5. SIGTERM/SIGINT disconnect Prisma and exit 0.
 */
import { bootstrapStdioServer, createStderrLogger } from "@bytescon/mcp-shared";
import { GsaClient } from "./lib/gsa-client.js";
import { registerGetComplianceMatrix } from "./tools/get-compliance-matrix.js";
import { registerListMatrixRequirements } from "./tools/list-matrix-requirements.js";
import { registerGetBidGuidance } from "./tools/get-bid-guidance.js";
import { registerGetAdherenceScore } from "./tools/get-adherence-score.js";
import { registerGeneratePricingTemplate } from "./tools/generate-pricing-template.js";

const SERVER_NAME = "proposal-mcp";
const SERVER_VERSION = "0.1.0";

const logger = createStderrLogger(SERVER_NAME);

async function main(): Promise<void> {
  // GSA data client for live pricing enrichment. DATA_GOV_API_KEY is NOT
  // required to boot: Per Diem lookups return a structured error (caught by the
  // pricing tool, which degrades to placeholders), and CALC labor rates work
  // anonymously. One api.data.gov key spans all GSA APIs; it is NOT a SAM key.
  const gsa = new GsaClient({ apiKey: process.env.DATA_GOV_API_KEY });
  if (!gsa.hasApiKey()) {
    logger.warn(
      "DATA_GOV_API_KEY is not set; generate_pricing_template Per Diem travel pricing will be unavailable (CALC labor benchmarks still work). Set it to enable live travel rates."
    );
  }

  await bootstrapStdioServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    minTier: "CORE",
    logger,
    tools: [
      registerGetComplianceMatrix,
      registerListMatrixRequirements,
      registerGetBidGuidance,
      registerGetAdherenceScore,
      (server, context) => registerGeneratePricingTemplate(server, { ...context, gsa }),
    ],
  });
}

main().catch((err: unknown) => {
  logger.error("MCP server crashed", {
    service: SERVER_NAME,
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
