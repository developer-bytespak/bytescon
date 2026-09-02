/**
 * Audit-log writer for every MCP tool invocation.
 *
 * One row per call, no exceptions (CLAUDE.md §6.4). Writes to the
 * `mcp_audit_log` table. Failures on the success path throw; failures
 * on an already-failing tool path are swallowed at the call site so
 * the audit issue does not mask the original tool error.
 *
 * Input is hashed using canonical JSON (recursive sorted keys) so the
 * same input always produces the same hash regardless of property
 * iteration order.
 */
import crypto from "node:crypto";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

// "validation_error" marks a tools/call rejected by the SDK against the
// registered Zod shape BEFORE the handler ran (see install-validation-audit.ts).
export type AuditOutcome =
  | "ok"
  | "tool_error"
  | "auth_error"
  | "rate_limited"
  | "validation_error";

export interface AuditEntry {
  serverName: string;
  serverVersion: string;
  toolName: string;
  tenantId: string;
  userId?: string | undefined;
  tokenFp: string;
  inputHash: string;
  outputBytes: number;
  durationMs: number;
  outcome: AuditOutcome;
  correlationId?: string | undefined;
  clientInfo?: Record<string, unknown> | undefined;
}

export async function writeAuditEntry(entry: AuditEntry): Promise<void> {
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
        clientInfo: (entry.clientInfo ?? null) as never,
      },
    });
  } catch (err) {
    logger.error("audit log write failed", {
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

export function hashInput(input: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(input)), "utf8")
    .digest("hex");
}
