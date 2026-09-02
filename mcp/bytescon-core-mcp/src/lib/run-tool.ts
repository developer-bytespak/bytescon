/**
 * Per-tool execution wrapper for bytescon-core-mcp.
 *
 * Centralizes the suite contract so the four tool handlers contain only
 * query logic:
 *   - correlation id + invocation logging
 *   - tier gate: every tool on this server requires tier PRO or higher
 *     (defense in depth on top of the boot-time minTier gate, and the
 *     unit-testable surface for the tier-rejection tests)
 *   - response caps (8 KB default warn, 32 KB hard error) via shared
 *   - exactly one mcp_audit_log row per invocation, success or failure;
 *     on the failure path the audit write is best-effort so the original
 *     tool error is never masked
 *   - structured `isError: true` responses, never protocol exceptions
 */
import crypto from "node:crypto";
import {
  capJsonResponse,
  hashInput,
  isMcpToolError,
  requireTier,
  writeAuditEntry,
  type ApiTokenTier,
  type AuditOutcome,
  type HandlerResult,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";

/** Minimum tier for every tool on this server (DESIGN.md workstream 5). */
export const REQUIRED_TIER: ApiTokenTier = "PRO";

/**
 * Run one tool invocation under the suite contract.
 *
 * @param toolName - snake_case tool name for logs and the audit row.
 * @param input - The validated tool input (hashed into the audit row).
 * @param context - Shared handler context (tenant ctx, prisma, logger, identity).
 * @param fn - Query logic; returns the JSON-serializable payload.
 * @returns MCP HandlerResult; `isError: true` on any failure.
 */
export async function runTool(
  toolName: string,
  input: unknown,
  context: ToolHandlerContext,
  fn: (correlationId: string) => Promise<unknown>
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
    requireTier(context.ctx, REQUIRED_TIER);

    const payload = await fn(correlationId);
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
      output_bytes: outputBytes,
    });

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    const isAuth = isMcpToolError(err) && err.code === "AUTH_ERROR";
    const outcome: AuditOutcome = isAuth ? "auth_error" : "tool_error";

    context.logger.error("tool error", {
      correlation_id: correlationId,
      tenant_id: context.ctx.consultingFirmId,
      tool_name: toolName,
      latency_ms: durationMs,
      outcome,
      err: message,
    });

    // Best-effort audit on the error path; never overwrite the tool
    // error with an audit-write error.
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

    const label = isAuth ? "Auth error" : "Tool error";
    return {
      isError: true,
      content: [{ type: "text", text: `${label}: ${message}` }],
    };
  }
}
