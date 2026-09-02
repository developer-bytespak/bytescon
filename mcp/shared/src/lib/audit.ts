/**
 * Audit-log writer for every MCP tool invocation. Extracted from
 * opportunity-mcp v0.3 (src/lib/audit.ts) with the Prisma client and
 * logger injected.
 *
 * One row per call, no exceptions (CLAUDE.md section 6.4). Writes to the
 * `mcp_audit_log` table. Failures on the success path throw; failures on
 * an already-failing tool path are swallowed at the call site so the
 * audit issue does not mask the original tool error.
 *
 * Input is hashed using canonical JSON (recursive sorted keys) so the
 * same input always produces the same hash regardless of property
 * iteration order.
 */
import crypto from "node:crypto";
import { createStderrLogger, type Logger } from "./logger.js";
import type { PrismaLikeClient } from "./prisma-client.js";

/**
 * Audit outcome values written to mcp_audit_log.outcome.
 *
 * "validation_error" marks a tools/call that the SDK rejected against the
 * registered Zod shape BEFORE the tool handler ran, so it is distinct from
 * "tool_error" (handler ran and failed) and "auth_error" (handler ran and
 * denied). See {@link installValidationAudit}.
 */
export type AuditOutcome =
  | "ok"
  | "tool_error"
  | "auth_error"
  | "rate_limited"
  | "validation_error";

/** One mcp_audit_log row (camelCase Prisma field names). */
export interface AuditEntry {
  serverName: string;
  serverVersion: string;
  toolName: string;
  /** Tenant id (consultingFirmId) resolved from the bearer token, never from tool args. */
  tenantId: string;
  userId?: string | undefined;
  /** 16-char token fingerprint; never the raw token. */
  tokenFp: string;
  /** 64-char canonical SHA-256 of the tool input, from {@link hashInput}. */
  inputHash: string;
  outputBytes: number;
  durationMs: number;
  outcome: AuditOutcome;
  correlationId?: string | undefined;
  clientInfo?: Record<string, unknown> | undefined;
}

let fallbackLogger: Logger | undefined;

function auditLogger(provided: Logger | undefined): Logger {
  if (provided) return provided;
  fallbackLogger ??= createStderrLogger("mcp-shared");
  return fallbackLogger;
}

/**
 * Write exactly one audit row for a tool invocation.
 *
 * On the success path callers let the thrown error surface immediately.
 * On an error path callers attach `.catch()` so the original tool error
 * is never overwritten by an audit-write error.
 *
 * @param prisma - Injected Prisma client (or mock).
 * @param entry - The audit row to append.
 * @param logger - Logger used when the write fails. Defaults to an
 *   internal "mcp-shared" stderr logger.
 * @returns Resolves when the row is written.
 * @throws The underlying Prisma error when the write fails.
 */
export async function writeAuditEntry(
  prisma: PrismaLikeClient,
  entry: AuditEntry,
  logger?: Logger
): Promise<void> {
  try {
    await prisma.mcpAuditLog.create({
      data: {
        serverName: entry.serverName,
        serverVersion: entry.serverVersion,
        toolName: entry.toolName,
        tenantId: entry.tenantId,
        userId: entry.userId ?? null,
        tokenFp: entry.tokenFp,
        inputHash: entry.inputHash,
        outputBytes: entry.outputBytes,
        durationMs: entry.durationMs,
        outcome: entry.outcome,
        correlationId: entry.correlationId ?? null,
        clientInfo: entry.clientInfo ?? null,
      },
    });
  } catch (err) {
    auditLogger(logger).error("audit log write failed", {
      err: err instanceof Error ? err.message : String(err),
      server_name: entry.serverName,
      tool_name: entry.toolName,
      tenant_id: entry.tenantId,
      correlation_id: entry.correlationId,
    });
    throw err;
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize(obj[key]);
  }
  return sorted;
}

/**
 * Canonical SHA-256 of a tool input: keys are recursively sorted before
 * JSON serialization, so the same logical input always produces the same
 * hash regardless of property iteration order.
 *
 * @param input - The validated tool input object.
 * @returns 64-char lowercase hex digest for mcp_audit_log.input_hash.
 */
export function hashInput(input: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(input)), "utf8")
    .digest("hex");
}
