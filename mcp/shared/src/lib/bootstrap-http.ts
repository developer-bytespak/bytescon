/**
 * Shared HTTP bootstrap for the Bytescon MCP suite.
 *
 * Builds the Express app (CORS, health, the MCP Streamable HTTP endpoint, and
 * the optional embedded OAuth 2.1 authorization server) WITHOUT binding a port,
 * so tests can mount it on an ephemeral port, and provides a thin launcher that
 * binds the port with graceful shutdown. A 1:1 port of opportunity-mcp v0.4's
 * app.ts + server-http.ts, parameterized by mount path, resource name, and the
 * server's tool registrars so sibling servers reuse it unchanged.
 *
 * Auth precedence on the MCP endpoint is handled by resolveAccessToken: an
 * OAuth-issued access token (JWT) is verified and re-resolved to its api_tokens
 * row; a raw api_tokens Bearer token continues to work unchanged. When no OAuth
 * signing key is configured, OAuth is fully inert and the server behaves exactly
 * as it did before this feature.
 */
import http from "node:http";
import express, { type Request, type Response, type NextFunction, type Express } from "express";
import { loadOAuthConfig, resolveUrls, DEFAULT_MOUNT_PATH, type OAuthConfig } from "../oauth/config.js";
import { createAuthorizationServerRouter } from "../oauth/router.js";
import { createResourceMcpRouter } from "../oauth/resource-router.js";
import { protectedResourceMetadata } from "../oauth/metadata.js";
import { type ApiTokenTier } from "./auth.js";
import { createStderrLogger, type Logger } from "./logger.js";
import { createPrismaClient, disconnectPrisma, type PrismaLikeClient } from "./prisma-client.js";
import type { ToolHandlerContext } from "./register-tool.js";
import type { McpServer as McpServerType } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * A function that registers one or more tools on the server. Matches the
 * registerXxx(server, context) convention used throughout the suite.
 */
export type HttpToolRegistrar = (server: McpServerType, context: ToolHandlerContext) => void;

/** Options for {@link createApp}. */
export interface CreateHttpAppOptions {
  /** Server name; used for McpServer identity, logs, and audit rows. */
  name: string;
  /** Server semver string; written to every audit row. */
  version: string;
  /** Human-readable resource name advertised in PRM (`resource_name`). */
  resourceName: string;
  /** Mount path the MCP resource is served at; defaults to `/mcp`. */
  mountPath?: string;
  /** Tool registrars invoked in order with the per-request {@link ToolHandlerContext}. */
  tools: ReadonlyArray<HttpToolRegistrar>;
  /** Optional per-request minimum tier; a lower-tier token is rejected with 403. */
  minTier?: ApiTokenTier | undefined;
  /** Injected logger; defaults to createStderrLogger(name). */
  logger?: Logger | undefined;
  /** Injected Prisma client; defaults to {@link createPrismaClient}. */
  prisma?: PrismaLikeClient | undefined;
  /** Inject an explicit OAuth config (tests). Defaults to loadOAuthConfig(). */
  oauth?: OAuthConfig | undefined;
}

/** Result of {@link createApp}: the unbound Express app and the resolved OAuth config. */
export interface CreatedHttpApp {
  app: Express;
  oauthConfig: OAuthConfig;
  /** Prisma client used by the app (the injected one, or a freshly created client). */
  prisma: PrismaLikeClient;
  /** Logger used by the app. */
  logger: Logger;
}

/** Normalize a mount path to a single leading slash and no trailing slash. */
function normalizeMount(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") return DEFAULT_MOUNT_PATH;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Build the Express app without binding a port.
 *
 * @param opts - Server identity, resource name, mount path, tool registrars,
 *   and optional injected logger/prisma/oauth/minTier.
 * @returns The unbound app plus the resolved OAuth config, prisma, and logger.
 */
export function createApp(opts: CreateHttpAppOptions): CreatedHttpApp {
  const serverName = opts.name;
  const serverVersion = opts.version;
  const mountPath = normalizeMount(opts.mountPath);
  const logger = opts.logger ?? createStderrLogger(serverName);
  const prisma = opts.prisma ?? createPrismaClient();
  const oauthConfig = opts.oauth ?? loadOAuthConfig();
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

  // ── Health probe ──────────────────────────────────────────────────────
  // Served at both /health (internal container healthcheck) and <mount>/health.
  // The bare /health is not routed to this service by the edge proxy (Caddy
  // sends it to the SPA), so external/uptime probes that need the MCP service's
  // status (including the oauth flag) must use the namespaced <mount>/health.
  const health = (_req: Request, res: Response): void => {
    res.json({ status: "ok", service: serverName, version: serverVersion, oauth: oauthConfig.enabled });
  };
  app.get("/health", health);
  app.get(`${mountPath}/health`, health);

  // ── Embedded OAuth authorization server (only when a key is configured) ─
  // The single-resource app composes the same building blocks the gateway uses:
  // the resource-agnostic AS router (mounted once) plus this server's resource
  // router. To preserve the pre-gateway external contract, the bare-path PRM
  // (`/.well-known/oauth-protected-resource`, no mount suffix) is also served
  // here; the resource router serves the mount-suffixed PRM.
  if (oauthConfig.enabled) {
    app.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
      res.json(protectedResourceMetadata(resolveUrls(oauthConfig, req, mountPath), opts.resourceName));
    });
    app.use(createAuthorizationServerRouter(oauthConfig, { prisma, mountPath }));
    logger.info("OAuth authorization server enabled", {
      base_url: oauthConfig.baseUrl || "(derived from request)",
    });
  } else {
    logger.info("OAuth authorization server disabled (no MCP_OAUTH_SIGNING_KEY); raw Bearer tokens only");
  }

  // ── MCP resource (PRM + Streamable HTTP transport) ──────────────────────
  app.use(
    createResourceMcpRouter({
      name: serverName,
      version: serverVersion,
      resourceName: opts.resourceName,
      mountPath,
      tools: opts.tools,
      prisma,
      logger,
      oauthConfig,
      ...(opts.minTier ? { minTier: opts.minTier } : {}),
    })
  );

  return { app, oauthConfig, prisma, logger };
}

/** Options for {@link bootstrapHttpServer}: app options plus the listen port. */
export interface BootstrapHttpOptions extends CreateHttpAppOptions {
  /** Port to bind; defaults to MCP_HTTP_PORT env var, then 3002. */
  port?: number;
}

/** Handle returned by {@link bootstrapHttpServer} for tests / programmatic shutdown. */
export interface BootstrapHttpResult {
  app: Express;
  httpServer: http.Server;
  oauthConfig: OAuthConfig;
  prisma: PrismaLikeClient;
  logger: Logger;
}

/**
 * Build the app and bind the port with SIGTERM/SIGINT graceful shutdown.
 *
 * 1:1 port of opportunity-mcp's server-http.ts. Reads MCP_HTTP_PORT (default
 * 3002) unless an explicit `port` is supplied, binds 0.0.0.0, and disconnects
 * the injected/created Prisma client on shutdown.
 *
 * @param opts - App options plus an optional explicit port.
 * @returns The app, the bound http.Server, and the resolved config/prisma/logger.
 */
export function bootstrapHttpServer(opts: BootstrapHttpOptions): BootstrapHttpResult {
  const port = opts.port ?? parseInt(process.env.MCP_HTTP_PORT ?? "3002", 10);
  const { app, oauthConfig, prisma, logger } = createApp(opts);
  const mountPath = normalizeMount(opts.mountPath);
  const httpServer = http.createServer(app);

  httpServer.listen(port, "0.0.0.0", () => {
    logger.info("MCP HTTP server listening", {
      service: opts.name,
      version: opts.version,
      port,
      endpoint: `http://0.0.0.0:${port}${mountPath}`,
      oauth_enabled: oauthConfig.enabled,
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("MCP HTTP server shutting down", { service: opts.name, signal });
    httpServer.close();
    await disconnectPrisma(prisma).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return { app, httpServer, oauthConfig, prisma, logger };
}
