/**
 * Typed errors for MCP tool handlers.
 *
 * Tool handlers convert these into `{ isError: true, content: [...] }`
 * responses rather than throwing protocol exceptions, so the host LLM
 * can recover and explain (CLAUDE.md §5.2).
 */

export type McpErrorCode =
  | "AUTH_ERROR"
  | "VALIDATION_ERROR"
  | "TOOL_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

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

export class McpAuthError extends McpToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("AUTH_ERROR", message, details);
    this.name = "McpAuthError";
  }
}

export class McpValidationError extends McpToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, details);
    this.name = "McpValidationError";
  }
}

export function isMcpToolError(value: unknown): value is McpToolError {
  return value instanceof McpToolError;
}
