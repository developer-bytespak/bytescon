/**
 * Common tool-invocation envelope for knowledge-mcp.
 *
 * Mirrors the opportunity-mcp handler discipline exactly, factored once:
 *   1. correlation id + start timestamp + canonical input hash
 *   2. per-call auth guard (valid resolved context, CORE tier)
 *   3. tool body produces a JSON payload
 *   4. response caps (8 KB warn, 32 KB hard) via capJsonResponse
 *   5. exactly one mcp_audit_log row per invocation, success or failure
 *   6. errors return structured isError responses, never throw
 *
 * Audit on the success path throws on write failure (surfaces
 * immediately); on the error path the audit write is best-effort so it
 * never masks the original tool error.
 */
import crypto from "node:crypto";
import {
  capJsonResponse,
  hashInput,
  isMcpToolError,
  writeAuditEntry,
  type AuditOutcome,
  type HandlerResult,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";
import { guardAuth } from "./guard.js";

/**
 * Execute one tool invocation with the suite's standard envelope.
 *
 * @param toolName - snake_case tool name for logs and the audit row.
 * @param input - Validated tool input (already parsed by the SDK).
 * @param opts - Shared handler context (tenant ctx, prisma, logger, identity).
 * @param body - Pure tool logic; receives a correlation id, returns the
 *   JSON-serializable response payload.
 * @returns MCP HandlerResult; isError true with a structured message on failure.
 */
export async function runTool(
  toolName: string,
  input: unknown,
  opts: ToolHandlerContext,
  body: (correlationId: string) => Promise<unknown>
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);
  const { logger, prisma, ctx } = opts;

  logger.info("tool invoked", {
    correlation_id: correlationId,
    tenant_id: ctx?.consultingFirmId,
    tool_name: toolName,
    token_fp: ctx?.tokenFp,
  });

  try {
    guardAuth(ctx);

    const payload = await body(correlationId);
    const { text, outputBytes } = capJsonResponse(payload, { logger, correlationId });

    const durationMs = Date.now() - startedAt;
    await writeAuditEntry(
      prisma,
      {
        serverName: opts.serverName,
        serverVersion: opts.serverVersion,
        toolName,
        tenantId: ctx.consultingFirmId,
        tokenFp: ctx.tokenFp,
        inputHash,
        outputBytes,
        durationMs,
        outcome: "ok",
        correlationId,
      },
      logger
    );

    logger.info("tool ok", {
      correlation_id: correlationId,
      tenant_id: ctx.consultingFirmId,
      tool_name: toolName,
      latency_ms: durationMs,
      outcome: "ok",
    });

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    const outcome: AuditOutcome =
      isMcpToolError(err) && err.code === "AUTH_ERROR" ? "auth_error" : "tool_error";

    logger.error("tool error", {
      correlation_id: correlationId,
      tenant_id: ctx?.consultingFirmId,
      tool_name: toolName,
      latency_ms: durationMs,
      outcome,
      err: message,
    });

    // Best-effort audit on the error path; never overwrite the tool error
    // with an audit-write error. When the context itself is invalid the
    // tenant id may not be a UUID and this write will fail; that failure
    // is logged and swallowed.
    await writeAuditEntry(
      prisma,
      {
        serverName: opts.serverName,
        serverVersion: opts.serverVersion,
        toolName,
        tenantId: ctx?.consultingFirmId ?? "",
        tokenFp: ctx?.tokenFp ?? "",
        inputHash,
        outputBytes: 0,
        durationMs,
        outcome,
        correlationId,
      },
      logger
    ).catch((auditErr: unknown) => {
      logger.error("audit write also failed on error path", {
        correlation_id: correlationId,
        original_err: message,
        audit_err: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    });

    return { isError: true, content: [{ type: "text", text: `Tool error: ${message}` }] };
  }
}
