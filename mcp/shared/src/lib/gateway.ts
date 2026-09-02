/**
 * Multiplexed MCP gateway app factory.
 *
 * Builds ONE Express app that serves N MCP resources over HTTP behind ONE
 * embedded OAuth 2.1 authorization server. Each resource is mounted under its
 * own path with its own OAuth resource/audience, so an access token minted for
 * one resource cannot be replayed against another (audience isolation, enforced
 * per-resource by {@link createResourceMcpRouter}).
 *
 * Composition:
 *   - CORS (permissive, mirrors the single-resource app)
 *   - `/health` and `/mcp/health` probes (container + namespaced uptime checks)
 *   - the ONE authorization server router (mounted at the default `/mcp` prefix,
 *     so opportunity-mcp's existing `/mcp/oauth/*` connector keeps working)
 *   - each resource's router (PRM + MCP transport)
 *
 * When OAuth is disabled (no signing key), the AS router is not mounted and the
 * resources fall back to raw api_tokens Bearer auth, exactly as the
 * single-resource server does.
 */
import express, { type Request, type Response, type NextFunction, type Express } from "express";
import { createAuthorizationServerRouter } from "../oauth/router.js";
import { createResourceMcpRouter, type ResourceToolRegistrar } from "../oauth/resource-router.js";
import { DEFAULT_MOUNT_PATH, type OAuthConfig } from "../oauth/config.js";
import { type ApiTokenTier } from "./auth.js";
import { createStderrLogger, type Logger } from "./logger.js";
import type { PrismaLikeClient } from "./prisma-client.js";

/** One MCP resource to mount on the gateway. */
export interface ResourceSpec {
  /** Server name; used for McpServer identity, logs, and audit rows. */
  name: string;
  /** Server semver string; written to every audit row. */
  version: string;
  /** Human-readable resource name advertised in PRM (`resource_name`). */
  resourceName: string;
  /** Mount path this resource is served at (e.g. `/knowledge/mcp`). */
  mountPath: string;
  /** Tool registrars invoked in order with the per-request ToolHandlerContext. */
  tools: ReadonlyArray<ResourceToolRegistrar>;
  /** Optional per-request minimum tier; a lower-tier token is rejected with 403. */
  minTier?: ApiTokenTier | undefined;
}

/** Options for {@link createGatewayApp}. */
export interface CreateGatewayAppOptions {
  /** The resources to multiplex. */
  resources: ReadonlyArray<ResourceSpec>;
  /** Resolved OAuth config shared by the AS and every resource. */
  oauthConfig: OAuthConfig;
  /** Prisma client shared across the gateway. */
  prisma: PrismaLikeClient;
  /** Logger; defaults to createStderrLogger("mcp-gateway"). */
  logger?: Logger | undefined;
}

/** Result of {@link createGatewayApp}: the unbound Express app. */
export interface CreatedGatewayApp {
  app: Express;
  oauthConfig: OAuthConfig;
  prisma: PrismaLikeClient;
  logger: Logger;
}

/**
 * Build the multiplexed gateway Express app without binding a port.
 *
 * @param opts - The resources, the shared OAuth config, prisma, and logger.
 * @returns The unbound app plus the shared config/prisma/logger.
 */
export function createGatewayApp(opts: CreateGatewayAppOptions): CreatedGatewayApp {
  const logger = opts.logger ?? createStderrLogger("mcp-gateway");
  const prisma = opts.prisma;
  const oauthConfig = opts.oauthConfig;
  const app = express();

  // ── CORS ──────────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    next();
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ── Health probe ────────────────────────────────────────────────────────
  // /health is the container healthcheck; /mcp/health is the namespaced probe
  // the edge proxy can route to the gateway (the bare /health may be claimed by
  // the SPA upstream).
  const health = (_req: Request, res: Response): void => {
    res.json({
      status: "ok",
      service: "mcp-gateway",
      oauth: oauthConfig.enabled,
      resources: opts.resources.map((r) => r.mountPath),
    });
  };
  app.get("/health", health);
  app.get(`${DEFAULT_MOUNT_PATH}/health`, health);

  // ── The ONE authorization server (resource-agnostic), mounted once ──────
  if (oauthConfig.enabled) {
    app.use(
      createAuthorizationServerRouter(oauthConfig, {
        prisma,
        mountPath: DEFAULT_MOUNT_PATH,
        // Bind issued audiences to the actual served resources, so a token from
        // the OAuth flow for /knowledge/mcp is minted with that aud (and is
        // therefore accepted there and rejected at /mcp). Without this the AS
        // would hard-pin every aud to /mcp and break OAuth for the other 4.
        servedMountPaths: opts.resources.map((r) => r.mountPath),
      })
    );
    logger.info("OAuth authorization server enabled", {
      base_url: oauthConfig.baseUrl || "(derived from request)",
      resource_count: opts.resources.length,
    });
  } else {
    logger.info("OAuth authorization server disabled (no MCP_OAUTH_SIGNING_KEY); raw Bearer tokens only");
  }

  // ── Each resource's router (PRM + MCP transport) ────────────────────────
  for (const resource of opts.resources) {
    app.use(
      createResourceMcpRouter({
        name: resource.name,
        version: resource.version,
        resourceName: resource.resourceName,
        mountPath: resource.mountPath,
        tools: resource.tools,
        prisma,
        logger,
        oauthConfig,
        ...(resource.minTier ? { minTier: resource.minTier } : {}),
      })
    );
    logger.info("gateway resource mounted", {
      service: resource.name,
      version: resource.version,
      mount_path: resource.mountPath,
      min_tier: resource.minTier ?? null,
    });
  }

  return { app, oauthConfig, prisma, logger };
}
