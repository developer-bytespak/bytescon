/**
 * Per-call auth guard for knowledge-mcp tool handlers.
 *
 * The clause catalog and agency profiles are GLOBAL (not tenant-scoped)
 * tables, but reads still require a valid resolved token context: the
 * stdio bootstrap refuses to start without one, and every handler
 * re-checks the context shape before touching the database so a global
 * read can never execute from an unauthenticated or malformed context
 * (DESIGN.md workstream 2 auth requirement). Failures surface as
 * outcome "auth_error" in mcp_audit_log.
 */
import {
  McpAuthError,
  requireTier,
  type ApiTokenTier,
  type ResolvedTokenContext,
} from "@bytescon/mcp-shared";

const VALID_TIERS: ReadonlyArray<ApiTokenTier> = ["CORE", "PRO", "VAULT"];

/** Minimum tier for every knowledge-mcp tool (DESIGN.md workstream 2). */
export const KNOWLEDGE_MIN_TIER: ApiTokenTier = "CORE";

/**
 * Validate the resolved token context and enforce the server tier.
 *
 * @param ctx - Context resolved from Bytescon_MCP_TOKEN at boot.
 * @throws McpAuthError when the context is missing required fields,
 *   carries a malformed token fingerprint, has an unknown tier, or does
 *   not meet the CORE tier.
 */
export function guardAuth(ctx: ResolvedTokenContext | null | undefined): void {
  if (!ctx) {
    throw new McpAuthError("no resolved token context, a valid Bytescon_MCP_TOKEN is required");
  }
  if (!ctx.tokenId || typeof ctx.tokenId !== "string") {
    throw new McpAuthError("token context is missing tokenId, a valid Bytescon_MCP_TOKEN is required");
  }
  if (!ctx.consultingFirmId || typeof ctx.consultingFirmId !== "string") {
    throw new McpAuthError(
      "token context is missing the tenant id, a valid Bytescon_MCP_TOKEN is required"
    );
  }
  if (typeof ctx.tokenFp !== "string" || ctx.tokenFp.length !== 16) {
    throw new McpAuthError(
      "token context carries a malformed token fingerprint, a valid Bytescon_MCP_TOKEN is required"
    );
  }
  if (!VALID_TIERS.includes(ctx.tier)) {
    throw new McpAuthError(`token context carries an unknown tier: ${String(ctx.tier)}`);
  }
  requireTier(ctx, KNOWLEDGE_MIN_TIER);
}
