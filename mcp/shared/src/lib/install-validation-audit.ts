/**
 * Validation-rejection audit wrapper (CLAUDE.md section 4.1 item 6:
 * "audit log on every tool call").
 *
 * The MCP SDK validates a tools/call argument object against the tool's
 * registered Zod shape BEFORE the registered tool handler runs. When that
 * validation fails the SDK throws an McpError(InvalidParams) inside its
 * CallToolRequest handler, catches it, and returns a structured
 * CallToolResult ({ isError: true, content: [...] }) to the host. The tool
 * handler never executes, so the per-tool audit path in run-tool.ts /
 * each handler never fires and NO mcp_audit_log row is written. That is the
 * suite-wide gap this module closes.
 *
 * Approach: after all tools are registered, wrap the server's underlying
 * tools/call request handler. The wrapper calls the original handler
 * unchanged, then inspects the result. On the validation-rejection path it
 * writes ONE audit row with outcome "validation_error" and returns the
 * SAME result object unchanged, so the host-visible response is identical.
 * On every other path (success, denial, tool error, unknown tool) it does
 * nothing extra: those are already audited inside the per-tool handler, so
 * a valid call still produces EXACTLY ONE row.
 *
 * The tool's advertised input JSON Schema is never touched: we do not
 * re-register tools or relax shapes, we only observe the dispatch result.
 *
 * Audit-write failures never reach the call path (mirrors audit.ts: the
 * write is best-effort here and any error is swallowed after logging), so
 * an audit problem can never change what the host sees or crash the call.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hashInput, writeAuditEntry } from "./audit.js";
import type { Logger } from "./logger.js";
import type { PrismaLikeClient } from "./prisma-client.js";

/**
 * Stable marker the SDK puts in the text of a CallToolResult produced when
 * tools/call arguments fail Zod validation. Sourced from the installed SDK
 * (server/mcp.js -> validateToolInput): it throws
 *   McpError(InvalidParams, "Input validation error: Invalid arguments for
 *   tool <name>: <detail>")
 * whose Error.message is "MCP error -32602: Input validation error: ...",
 * and the outer catch turns that message into the result text verbatim. We
 * match the "Input validation error:" segment (distinct from the SDK's
 * "Output validation error:" marker) to tell a schema-validation rejection
 * apart from a normal tool-handler error (whose text the suite prefixes with
 * "Tool error:").
 */
const SDK_VALIDATION_ERROR_MARKER = "Input validation error:";

/** Method literal for the JSON-RPC tools/call request. */
const TOOLS_CALL_METHOD = "tools/call";

/** Context needed to write a validation-rejection audit row. */
export interface ValidationAuditContext {
  /** Tenant id (consultingFirmId) resolved from the bearer token at boot/request. */
  tenantId: string;
  /** 16-char token fingerprint; never the raw token. */
  tokenFp: string;
  /** Server name written to the audit row. */
  serverName: string;
  /** Server version written to the audit row. */
  serverVersion: string;
  /** Shared Prisma client used for the audit write. */
  prisma: PrismaLikeClient;
  /** Logger used when the audit write fails. */
  logger: Logger;
}

/**
 * The low-level request-handler value stored in the SDK Server's private
 * `_requestHandlers` map: it receives the parsed request plus an `extra`
 * bag and resolves to a JSON-RPC result. Typed minimally here so the one
 * cast below has a precise target instead of `any`.
 */
type RawRequestHandler = (request: ToolsCallRequest, extra: unknown) => Promise<unknown>;

/** The shape of the parsed tools/call request we read (name only). */
interface ToolsCallRequest {
  params?: { name?: unknown; arguments?: unknown };
}

/** Minimal structural view of a CallToolResult we inspect after dispatch. */
interface CallToolResultLike {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

/**
 * The single SDK-internals boundary. The high-level McpServer wraps a
 * low-level Server (its `.server` property) whose `_requestHandlers` is a
 * Map keyed by method literal. Neither is part of the SDK's public typed
 * surface, so this one cast reaches them; everything else in this module is
 * fully typed. The cast is contained and commented per CLAUDE.md.
 */
function getToolsCallHandlerSlot(
  server: McpServer
): { handlers: Map<string, RawRequestHandler>; current: RawRequestHandler | undefined } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lowLevel = (server as any).server as {
    _requestHandlers?: Map<string, RawRequestHandler>;
  };
  const handlers = lowLevel?._requestHandlers;
  if (!(handlers instanceof Map)) {
    return { handlers: new Map(), current: undefined };
  }
  return { handlers, current: handlers.get(TOOLS_CALL_METHOD) };
}

/** True when a dispatch result is the SDK's Zod validation-rejection result. */
function isValidationRejection(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const r = result as CallToolResultLike;
  if (r.isError !== true || !Array.isArray(r.content)) return false;
  const firstText = r.content.find((c) => typeof c?.text === "string")?.text;
  return typeof firstText === "string" && firstText.includes(SDK_VALIDATION_ERROR_MARKER);
}

/**
 * Install the validation-rejection audit wrapper on an McpServer.
 *
 * Call this AFTER all tools have been registered (so the SDK has installed
 * its tools/call handler) and after the boot/request auth context is known.
 * Wrapping is idempotent per server instance.
 *
 * When a tools/call is rejected by Zod validation, exactly one
 * mcp_audit_log row is written with outcome "validation_error": the tool
 * name comes from the request params, the tenant id and token fingerprint
 * from `ctx`, and a latency measured around the dispatch. Raw arguments are
 * never persisted (only the canonical input hash). The original SDK result
 * is returned unchanged, so the host sees the identical structured error.
 *
 * @param server - The McpServer whose tools/call handler is wrapped.
 * @param ctx - Audit context (tenant, fingerprint, identity, prisma, logger).
 * @returns Nothing; the server's tools/call handler is wrapped in place.
 */
export function installValidationAudit(server: McpServer, ctx: ValidationAuditContext): void {
  const { handlers, current } = getToolsCallHandlerSlot(server);
  if (!current) {
    // No tools registered (or an unexpected SDK shape); nothing to wrap.
    ctx.logger.warn("validation audit: no tools/call handler found, wrapper not installed", {
      service: ctx.serverName,
    });
    return;
  }

  const wrapped: RawRequestHandler = async (request, extra) => {
    const startedAt = Date.now();
    const result = await current(request, extra);
    if (!isValidationRejection(result)) {
      return result;
    }

    const durationMs = Date.now() - startedAt;
    const toolName =
      typeof request?.params?.name === "string" ? request.params.name : "unknown";

    // Best-effort audit: a write failure here must never change the
    // host-visible response or crash the call path (mirrors audit.ts).
    await writeAuditEntry(
      ctx.prisma,
      {
        serverName: ctx.serverName,
        serverVersion: ctx.serverVersion,
        toolName,
        tenantId: ctx.tenantId,
        tokenFp: ctx.tokenFp,
        // Hash the rejected arguments object; raw arguments are never stored.
        inputHash: hashInput(request?.params?.arguments),
        outputBytes: 0,
        durationMs,
        outcome: "validation_error",
        correlationId: undefined,
      },
      ctx.logger
    ).catch((auditErr: unknown) => {
      ctx.logger.error("validation audit write failed", {
        service: ctx.serverName,
        tool_name: toolName,
        tenant_id: ctx.tenantId,
        audit_err: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    });

    // Return the SAME structured error the SDK produced, unchanged.
    return result;
  };

  handlers.set(TOOLS_CALL_METHOD, wrapped);
}
