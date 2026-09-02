/**
 * Stdio bootstrap convenience mirroring opportunity-mcp/src/server.ts.
 *
 * Boot sequence (identical to opportunity-mcp v0.3):
 *   1. Read Bytescon_MCP_TOKEN from env (CLAUDE.md section 6.1: no fallback default).
 *   2. Resolve to a single tenant via api_tokens (CLAUDE.md section 4.4 auth).
 *   3. Optionally enforce a server-wide minimum tier.
 *   4. Instantiate McpServer and register tools.
 *   5. Connect the stdio transport.
 *   6. Install SIGTERM/SIGINT handlers that disconnect Prisma and exit 0.
 *
 * On missing or invalid token the process exits non-zero so Claude
 * Desktop / Claude Code surface the failure immediately.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { meetsTier, resolveBearerToken, type ApiTokenTier } from "./auth.js";
import { installValidationAudit } from "./install-validation-audit.js";
import { createStderrLogger, type Logger } from "./logger.js";
import { createPrismaClient, disconnectPrisma, type PrismaLikeClient } from "./prisma-client.js";
import type { ToolHandlerContext } from "./register-tool.js";

/**
 * A function that registers one or more tools on the server. Matches the
 * registerXxx(server, opts) convention used throughout opportunity-mcp.
 */
export type ToolRegistrar = (server: McpServer, context: ToolHandlerContext) => void;

/** Options for {@link bootstrapStdioServer}. */
export interface BootstrapStdioOptions {
  /** Server name (for example "knowledge-mcp"); used for McpServer identity, logs, and audit rows. */
  name: string;
  /** Server semver string; written to every audit row. */
  version: string;
  /** Tool registrars invoked in order with the shared {@link ToolHandlerContext}. */
  tools: ReadonlyArray<ToolRegistrar>;
  /** Injected Prisma client; defaults to {@link createPrismaClient}. */
  prisma?: PrismaLikeClient | undefined;
  /** Injected logger; defaults to createStderrLogger(name). */
  logger?: Logger | undefined;
  /** Optional server-wide minimum tier; boot fails when the token tier is below it. */
  minTier?: ApiTokenTier | undefined;
}

/**
 * Boot a stdio MCP server using the suite's standard sequence.
 *
 * Exits the process with code 1 (after logging to stderr) when
 * Bytescon_MCP_TOKEN is missing, invalid, revoked, expired, or below
 * `minTier`. Call from a server entry point and attach a `.catch()`
 * that logs and exits non-zero, mirroring opportunity-mcp.
 *
 * @param options - Server identity, tool registrars, and optional injected
 *   prisma/logger/minTier.
 * @returns The connected McpServer instance.
 */
export async function bootstrapStdioServer(options: BootstrapStdioOptions): Promise<McpServer> {
  const logger = options.logger ?? createStderrLogger(options.name);

  const token = process.env.Bytescon_MCP_TOKEN;
  if (!token) {
    logger.error("Bytescon_MCP_TOKEN missing", { service: options.name });
    process.exit(1);
  }

  const prisma = options.prisma ?? createPrismaClient();

  const ctx = await resolveBearerToken(prisma, token);
  if (!ctx) {
    logger.error("Bytescon_MCP_TOKEN invalid, revoked, or expired", { service: options.name });
    process.exit(1);
  }

  if (options.minTier && !meetsTier(ctx.tier, options.minTier)) {
    logger.error("Bytescon_MCP_TOKEN tier below server minimum", {
      service: options.name,
      required_tier: options.minTier,
      actual_tier: ctx.tier,
      token_fp: ctx.tokenFp,
    });
    process.exit(1);
  }

  logger.info("MCP server starting", {
    service: options.name,
    version: options.version,
    tenant_id: ctx.consultingFirmId,
    token_fp: ctx.tokenFp,
    tier: ctx.tier,
  });

  const server = new McpServer({
    name: options.name,
    version: options.version,
  });

  const toolContext: ToolHandlerContext = {
    ctx,
    serverName: options.name,
    serverVersion: options.version,
    prisma,
    logger,
  };
  for (const register of options.tools) {
    register(server, toolContext);
  }

  // Audit tools/call rejected by Zod validation BEFORE the handler runs
  // (CLAUDE.md section 4.1 item 6). Must be installed after registration,
  // once the SDK has wired its tools/call handler.
  installValidationAudit(server, {
    tenantId: ctx.consultingFirmId,
    tokenFp: ctx.tokenFp,
    serverName: options.name,
    serverVersion: options.version,
    prisma,
    logger,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("MCP server shutting down", { service: options.name, signal });
    await disconnectPrisma(prisma).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP server connected to stdio transport", {
    service: options.name,
    tenant_id: ctx.consultingFirmId,
  });

  return server;
}
