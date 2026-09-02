#!/usr/bin/env node
/**
 * @bytescon/mcp-gateway HTTP entry point.
 *
 * One multiplexed Express process that serves ALL 5 Bytescon MCP servers over
 * the MCP Streamable HTTP transport behind ONE embedded OAuth 2.1 authorization
 * server, each under its own path with its own OAuth resource/audience:
 *
 *   opportunity  -> /mcp            (resource https://host/mcp)
 *   knowledge    -> /knowledge/mcp
 *   proposal     -> /proposal/mcp

 *   bytescon-core   -> /core/mcp       (tier PRO)
 *   bytescon-all    -> /all/mcp        (ALL 27 tools; no minTier so a CORE token
 *                                    can connect — the PRO bytescon-core tools
 *                                    self-gate per call and tier-deny CORE)
 *
 * The authorization server lives at the historical /mcp/oauth/* paths (so
 * opportunity-mcp's existing live web connector is unaffected) and mints tokens
 * whose `aud` is the requested resource; each resource verifies the token's
 * audience against its OWN URL, so a token minted for one resource cannot be
 * replayed against another (cross-resource audience isolation).
 *
 * Per-request Bearer auth resolves a tenant per call; no startup token. When
 * MCP_OAUTH_SIGNING_KEY is unset OAuth is inert and raw api_tokens Bearer
 * tokens work against every resource, exactly as each single server does.
 */
import http from "node:http";
import { createRequire } from "node:module";
import {
  createGatewayApp,
  loadOAuthConfig,
  createPrismaClient,
  disconnectPrisma,
  createStderrLogger,
  type ResourceSpec,
  type PrismaLikeClient,
  type Logger,
} from "@bytescon/mcp-shared";
import { resource as opportunityResource } from "@bytescon/opportunity-mcp/resource";
import { resource as knowledgeResource } from "@bytescon/knowledge-mcp/resource";
import { resource as proposalResource } from "@bytescon/proposal-mcp/resource";
import { resource as bytesconCoreResource } from "@bytescon/bytescon-core-mcp/resource";

const SERVICE = "mcp-gateway";

/** This gateway's own semver, sourced from its package.json (kept in sync). */
const GATEWAY_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

const logger: Logger = createStderrLogger(SERVICE);
const prisma: PrismaLikeClient = createPrismaClient();
const oauthConfig = loadOAuthConfig();

/** A server's exported resource module shape. */
interface ResourceModule {
  name: string;
  version: string;
  resourceName: string;
  mountPath: string;
  minTier?: "CORE" | "PRO" | "VAULT" | undefined;
  makeTools: (prisma: PrismaLikeClient, logger: Logger) => ResourceSpec["tools"];
}

/**
 * Build each server's tool array ONCE and turn it into a ResourceSpec. The same
 * tool array is reused by the aggregate `/all/mcp` resource below, so we don't
 * re-run makeTools a second time.
 */
function toResourceSpec(mod: ResourceModule): ResourceSpec {
  return {
    name: mod.name,
    version: mod.version,
    resourceName: mod.resourceName,
    mountPath: mod.mountPath,
    tools: mod.makeTools(prisma, logger),
    ...(mod.minTier ? { minTier: mod.minTier } : {}),
  };
}

const opportunitySpec = toResourceSpec(opportunityResource);
const knowledgeSpec = toResourceSpec(knowledgeResource);
const proposalSpec = toResourceSpec(proposalResource);
const bytesconCoreSpec = toResourceSpec(bytesconCoreResource);

const perServerSpecs: ResourceSpec[] = [
  opportunitySpec,
  knowledgeSpec,
  proposalSpec,
  bytesconCoreSpec,
];

/**
 * AGGREGATE single-connector resource: ALL tools from all servers under one
 * path, so a subscriber adds ONE URL for everything. The per-server tool arrays
 * built above are reused directly (no double-build). minTier is UNDEFINED so a
 * CORE token can connect and list/use the CORE tools; the bytescon-core PRO tools
 * self-gate per call (run-tool.ts requireTier) and tier-deny a CORE caller.
 */
const aggregateTools: ResourceSpec["tools"] = [
  ...opportunitySpec.tools,
  ...knowledgeSpec.tools,
  ...proposalSpec.tools,
  ...bytesconCoreSpec.tools,
];

const aggregateSpec: ResourceSpec = {
  name: "bytescon-all",
  version: GATEWAY_VERSION,
  resourceName: "Bytescon — all tools (MCP)",
  mountPath: "/all/mcp",
  tools: aggregateTools,
  // minTier intentionally omitted (undefined): CORE may connect; PRO tools self-gate.
};

const resources: ResourceSpec[] = [...perServerSpecs, aggregateSpec];

const { app } = createGatewayApp({ resources, oauthConfig, prisma, logger });

const port = parseInt(process.env.MCP_HTTP_PORT ?? "3002", 10);
const httpServer = http.createServer(app);

httpServer.listen(port, "0.0.0.0", () => {
  logger.info("MCP gateway listening", {
    service: SERVICE,
    port,
    oauth_enabled: oauthConfig.enabled,
    resources: resources.map((r) => ({ service: r.name, mount_path: r.mountPath })),
  });
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info("MCP gateway shutting down", { service: SERVICE, signal });
  httpServer.close();
  await disconnectPrisma(prisma).catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
