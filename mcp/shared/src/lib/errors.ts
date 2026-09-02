/**
 * Typed errors for MCP tool handlers.
 *
 * Extracted verbatim from opportunity-mcp v0.3 (src/lib/errors.ts).
 * Tool handlers convert these into `{ isError: true, content: [...] }`
 * responses rather than throwing protocol exceptions, so the host LLM
 * can recover and explain (CLAUDEmcp.md rule 3).
 */

/** Stable machine-readable error codes, mapped to audit outcomes by callers. */
export type McpErrorCode =
  | "AUTH_ERROR"
  | "VALIDATION_ERROR"
  | "TOOL_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

/**
 * Base error for all MCP tool failures. Carries a stable code plus an
 * optional structured details bag for diagnostics.
 */
export class McpToolError extends Error {
  public readonly code: McpErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  constructor(code: McpErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.details = details;
  }
}

/** Raised when the resolved token context is missing required privileges. */
export class McpAuthError extends McpToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("AUTH_ERROR", message, details);
    this.name = "McpAuthError";
  }
}

/** Raised when tool input fails validation beyond what Zod enforces. */
export class McpValidationError extends McpToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, details);
    this.name = "McpValidationError";
  }
}

/** Type guard for McpToolError, usable in catch blocks on `unknown`. */
export function isMcpToolError(value: unknown): value is McpToolError {
  return value instanceof McpToolError;
}
