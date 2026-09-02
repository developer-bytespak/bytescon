/**
 * Thin Zod-to-MCP tool registration helper matching opportunity-mcp's
 * registration pattern: `server.tool(name, description, rawShape, cb)`.
 *
 * opportunity-mcp wraps each pure handler in a per-tool registerXxx()
 * function; this helper is the generic equivalent so sibling servers can
 * declare tools as data. Handlers stay pure functions (input + context)
 * so they are directly testable without an McpServer.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape, ZodTypeAny, objectOutputType } from "zod";
import type { ResolvedTokenContext } from "./auth.js";
import type { Logger } from "./logger.js";
import type { PrismaLikeClient } from "./prisma-client.js";

/**
 * Result shape returned by every tool handler. The SDK CallToolResult
 * type carries an open index signature; mirrored here so handler return
 * types satisfy McpServer.tool()'s callback.
 */
export interface HandlerResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Context threaded into every tool handler at registration time:
 * the tenant context resolved once at boot, the server identity for
 * audit rows, and the shared client and logger instances.
 */
export interface ToolHandlerContext {
  /** Tenant context resolved from Bytescon_MCP_TOKEN at boot. */
  ctx: ResolvedTokenContext;
  /** Server name written to every audit row. */
  serverName: string;
  /** Server version written to every audit row. */
  serverVersion: string;
  /** Shared Prisma client for queries and audit writes. */
  prisma: PrismaLikeClient;
  /** Server logger from {@link createStderrLogger}. */
  logger: Logger;
}

/** Inferred handler input type for a Zod raw shape. */
export type ShapeInput<Shape extends ZodRawShape> = objectOutputType<Shape, ZodTypeAny>;

/** Declarative tool definition consumed by {@link registerTool}. */
export interface ToolDefinition<Shape extends ZodRawShape> {
  /** Tool name, snake_case verb form (for example "retrieve_far_clause"). */
  name: string;
  /** Tool description shown to the host LLM. No em or en dashes. */
  description: string;
  /** Zod raw shape (NOT a composed z.object) per the SDK registration contract. */
  inputShape: Shape;
  /** Pure async handler. Must never throw; return `isError: true` instead. */
  handler: (input: ShapeInput<Shape>) => Promise<HandlerResult>;
}

/**
 * Register one tool on an McpServer using the suite's standard pattern.
 *
 * @param server - The McpServer instance from bootstrap.
 * @param def - Declarative tool definition (name, description, shape, handler).
 * @returns Nothing; the tool is registered on the server.
 */
export function registerTool<Shape extends ZodRawShape>(
  server: McpServer,
  def: ToolDefinition<Shape>
): void {
  const callback = async (input: unknown): Promise<HandlerResult> =>
    def.handler(input as ShapeInput<Shape>);
  // The SDK types its tool callback with a conditional ShapeOutput<Args>
  // that TypeScript cannot match from inside a generic helper (it stays
  // deferred), so the callback is cast at this single boundary. The SDK
  // still validates input against def.inputShape at runtime before the
  // callback runs; tests/register-tool.test.ts covers the behavior.
  server.tool(def.name, def.description, def.inputShape, callback as never);
}
