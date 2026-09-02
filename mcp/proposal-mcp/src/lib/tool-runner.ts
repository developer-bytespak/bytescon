/**
 * Per-invocation tool runner shared by every proposal-mcp tool.
 *
 * Mirrors the opportunity-mcp handler skeleton exactly: correlation id,
 * canonical input hash, success-path audit write (throws on failure),
 * best-effort error-path audit write (never masks the original tool
 * error), structured isError responses, suite response caps via
 * capJsonResponse (8 KB warn, 32 KB hard).
 *
 * Outcome mapping: McpAuthError -> "auth_error", everything else on the
 * error path -> "tool_error".
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

/**
 * Run one tool invocation with the suite's standard logging, caps, and
 * audit behavior.
 *
 * @param toolName - snake_case tool name written to logs and audit rows.
 * @param input - The validated tool input (hashed for the audit row).
 * @param context - Tool handler context from bootstrap (ctx, prisma, logger).
 * @param execute - Async function producing the JSON-serializable payload.
 * @returns A HandlerResult; isError true when execute or the caps throw.
 */
export async function runTool(
  toolName: string,
  input: unknown,
  context: ToolHandlerContext,
  execute: () => Promise<unknown>
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);

  context.logger.info("tool invoked", {
    correlation_id: correlationId,
    tenant_id: context.ctx.consultingFirmId,
    tool_name: toolName,
    token_fp: context.ctx.tokenFp,
  });

  try {
    const payload = await execute();
    const { text, outputBytes } = capJsonResponse(payload, {
      logger: context.logger,
      correlationId,
    });

    const durationMs = Date.now() - startedAt;
    await writeAuditEntry(
      context.prisma,
      {
        serverName: context.serverName,
        serverVersion: context.serverVersion,
        toolName,
        tenantId: context.ctx.consultingFirmId,
        tokenFp: context.ctx.tokenFp,
        inputHash,
        outputBytes,
        durationMs,
        outcome: "ok",
        correlationId,
      },
      context.logger
    );

    context.logger.info("tool ok", {
      correlation_id: correlationId,
      tenant_id: context.ctx.consultingFirmId,
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

    context.logger.error("tool error", {
      correlation_id: correlationId,
      tenant_id: context.ctx.consultingFirmId,
      tool_name: toolName,
      latency_ms: durationMs,
      outcome,
      err: message,
    });

    // Best-effort audit on the error path; never overwrite the tool error
    // with an audit-write error.
    await writeAuditEntry(
      context.prisma,
      {
        serverName: context.serverName,
        serverVersion: context.serverVersion,
        toolName,
        tenantId: context.ctx.consultingFirmId,
        tokenFp: context.ctx.tokenFp,
        inputHash,
        outputBytes: 0,
        durationMs,
        outcome,
        correlationId,
      },
      context.logger
    ).catch((auditErr: unknown) => {
      context.logger.error("audit write also failed on error path", {
        correlation_id: correlationId,
        original_err: message,
        audit_err: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    });

    return { isError: true, content: [{ type: "text", text: `Tool error: ${message}` }] };
  }
}
