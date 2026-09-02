/**
 * Per-resource MCP router for the multiplexed gateway.
 *
 * A gateway hosts ONE authorization server (see
 * {@link createAuthorizationServerRouter}) and N resources, each served under
 * its own mount path with its own OAuth resource/audience. This factory builds
 * one such resource: an Express router that handles
 *
 *   (a) `<mountPath>`  the MCP Streamable HTTP transport (a per-request fresh
 *       McpServer with the resource's tools, a per-request minTier 403 gate,
 *       the shared validation audit, and a stateless transport), authenticating
 *       the Bearer credential via resolveAccessToken pinned to THIS resource's
 *       URL so an access token minted for a sibling resource is rejected here;
 *   (b) `GET /.well-known/oauth-protected-resource<mountPath>`  this resource's
 *       RFC 9728 protected-resource metadata.
 *
 * The audience isolation is the security-critical property: because
 * resolveAccessToken passes `aud = <this resource URL>` to verifyJwt, a token
 * whose `aud` claim names a different resource fails verification and the
 * request is rejected (401) here, even though the SAME authorization server
 * minted it. Raw api_tokens Bearer tokens (the pre-OAuth path) are unaffected
 * and continue to work against every resource.
 *
 * This is a 1:1 lift of the MCP-endpoint half of the single-resource
 * createApp, parameterized by mount path / resource name / tools / minTier.
 */
import crypto from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer as McpServerType } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveAccessToken } from "./resolve.js";
import { resolveUrls, DEFAULT_MOUNT_PATH, type OAuthConfig } from "./config.js";
import { protectedResourceMetadata } from "./metadata.js";
import { wwwAuthenticateChallenge } from "./router.js";
import { installValidationAudit } from "../lib/install-validation-audit.js";
import { meetsTier, type ApiTokenTier } from "../lib/auth.js";
import { createStderrLogger, type Logger } from "../lib/logger.js";
import type { PrismaLikeClient } from "../lib/prisma-client.js";
import type { ToolHandlerContext } from "../lib/register-tool.js";

/**
 * A function that registers one or more tools on the server. Matches the
 * registerXxx(server, context) convention used throughout the suite.
 */
export type ResourceToolRegistrar = (server: McpServerType, context: ToolHandlerContext) => void;

/** Options for {@link createResourceMcpRouter}. */
export interface ResourceMcpRouterOptions {
  /** Server name; used for McpServer identity, logs, and audit rows. */
  name: string;
  /** Server semver string; written to every audit row. */
  version: string;
  /** Human-readable resource name advertised in PRM (`resource_name`). */
  resourceName: string;
  /** Mount path this MCP resource is served at (e.g. `/knowledge/mcp`). */
  mountPath: string;
  /** Tool registrars invoked in order with the per-request {@link ToolHandlerContext}. */
  tools: ReadonlyArray<ResourceToolRegistrar>;
  /** Optional per-request minimum tier; a lower-tier token is rejected with 403. */
  minTier?: ApiTokenTier | undefined;
  /** Prisma client shared across the gateway. */
  prisma: PrismaLikeClient;
  /** Logger; defaults to createStderrLogger(name). */
  logger?: Logger | undefined;
  /** Resolved OAuth config (shared by the whole gateway). */
  oauthConfig: OAuthConfig;
}

/** Normalize a mount path to a single leading slash and no trailing slash. */
function normalizeMount(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return DEFAULT_MOUNT_PATH;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Build the per-resource router: its RFC 9728 PRM plus the MCP transport,
 * authenticated against this resource's own audience.
 *
 * @param opts - Server identity, resource name, mount path, tools, minTier,
 *   the shared prisma/logger, and the shared OAuth config.
 * @returns An Express router to mount on the gateway app.
 */
export function createResourceMcpRouter(opts: ResourceMcpRouterOptions): Router {
  const serverName = opts.name;
  const serverVersion = opts.version;
  const mountPath = normalizeMount(opts.mountPath);
  const logger = opts.logger ?? createStderrLogger(serverName);
  const prisma = opts.prisma;
  const oauthConfig = opts.oauthConfig;
  const router = Router();

  // ── This resource's RFC 9728 protected-resource metadata ────────────────
  router.get(
    `/.well-known/oauth-protected-resource${mountPath}`,
    (req: Request, res: Response) => {
      res.json(protectedResourceMetadata(resolveUrls(oauthConfig, req, mountPath), opts.resourceName));
    }
  );

  // ── MCP endpoint ─────────────────────────────────────────────────────────
  router.all(mountPath, express.json(), async (req: Request, res: Response) => {
    const correlationId = crypto.randomUUID();
    const urls = resolveUrls(oauthConfig, req, mountPath);

    const authHeader = String(req.headers["authorization"] ?? "");
    const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!rawToken) {
      if (oauthConfig.enabled) {
        res.setHeader("WWW-Authenticate", wwwAuthenticateChallenge(urls.prmUrl));
      }
      res.status(401).json({ error: "Unauthorized", code: "MISSING_TOKEN" });
      return;
    }

    // Audience isolation: the resource passed here pins the access token's `aud`
    // to THIS resource. A token minted for a sibling resource (different aud)
    // fails verifyJwt and is rejected as INVALID_TOKEN below.
    const ctx = await resolveAccessToken(prisma, rawToken, oauthConfig, urls.resource);
    if (!ctx) {
      if (oauthConfig.enabled) {
        res.setHeader("WWW-Authenticate", wwwAuthenticateChallenge(urls.prmUrl, "invalid_token"));
      }
      logger.warn("MCP HTTP: invalid or revoked token", {
        correlation_id: correlationId,
        resource: urls.resource,
        token_prefix: rawToken.slice(0, 8),
      });
      res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN" });
      return;
    }

    // Per-request tier gate: the HTTP path resolves a tenant per request, so the
    // server minimum is enforced here. A token below the minimum is rejected
    // before any tool runs.
    if (opts.minTier && !meetsTier(ctx.tier, opts.minTier)) {
      logger.warn("MCP HTTP: token tier below server minimum", {
        correlation_id: correlationId,
        resource: urls.resource,
        tenant_id: ctx.consultingFirmId,
        token_fp: ctx.tokenFp,
        required_tier: opts.minTier,
        actual_tier: ctx.tier,
      });
      res.status(403).json({ error: "Forbidden", code: "INSUFFICIENT_TIER" });
      return;
    }

    logger.info("MCP HTTP: request", {
      correlation_id: correlationId,
      method: req.method,
      resource: urls.resource,
      tenant_id: ctx.consultingFirmId,
      token_fp: ctx.tokenFp,
      tier: ctx.tier,
    });

    const server = new McpServer({ name: serverName, version: serverVersion });
    const toolContext: ToolHandlerContext = {
      ctx,
      serverName,
      serverVersion,
      prisma,
      logger,
    };
    for (const register of opts.tools) {
      register(server, toolContext);
    }

    installValidationAudit(server, {
      tenantId: ctx.consultingFirmId,
      tokenFp: ctx.tokenFp,
      serverName,
      serverVersion,
      prisma,
      logger,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = new StreamableHTTPServerTransport({} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await server.connect(transport as any);

    res.on("finish", () => {
      server.close().catch(() => undefined);
    });

    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error("MCP HTTP: transport error", {
        correlation_id: correlationId,
        resource: urls.resource,
        tenant_id: ctx.consultingFirmId,
        err: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  return router;
}
