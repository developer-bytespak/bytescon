/**
 * @bytescon/mcp-shared
 *
 * Shared plumbing for the Bytescon MCP suite, extracted (copied, not
 * refactored) from opportunity-mcp v0.3. Consumed by sibling servers via
 * `"@bytescon/mcp-shared": "file:../shared"`.
 *
 * Modules:
 *   errors        typed McpToolError hierarchy and guard
 *   logger        winston stderr JSON logger factory
 *   sanitize      control-char strip and suite response caps
 *   prisma-client injected-client interface plus backend client loader
 *   auth          bearer token resolve, hash, fingerprint, tier gate
 *   audit         mcp_audit_log writer and canonical input hashing
 *   register-tool zod raw shape to McpServer.tool registration
 *   bootstrap     bootstrapStdioServer boot sequence convenience
 */

export {
  McpToolError,
  McpAuthError,
  McpValidationError,
  isMcpToolError,
  type McpErrorCode,
} from "./lib/errors.js";

export { createStderrLogger, type Logger } from "./lib/logger.js";

export {
  sanitize,
  capJsonResponse,
  SANITIZE_FIELD_CAP,
  MAX_RESPONSE_BYTES_DEFAULT,
  MAX_RESPONSE_BYTES_HARD,
  type CappedJson,
  type ResponseCapOptions,
} from "./lib/sanitize.js";

export {
  resolveBackendPrismaClientPath,
  loadPrismaClientConstructor,
  createPrismaClient,
  disconnectPrisma,
  PRISMA_CLIENT_PATH_ENV,
  type PrismaLikeClient,
  type PrismaClientConstructor,
  type PrismaApiTokenRecord,
  type PrismaAuditCreateData,
} from "./lib/prisma-client.js";

export {
  hashToken,
  tokenFingerprint,
  resolveBearerToken,
  resolveTokenById,
  meetsTier,
  requireTier,
  type ApiTokenTier,
  type ResolvedTokenContext,
} from "./lib/auth.js";

export {
  writeAuditEntry,
  hashInput,
  type AuditOutcome,
  type AuditEntry,
} from "./lib/audit.js";

export {
  registerTool,
  type HandlerResult,
  type ToolHandlerContext,
  type ToolDefinition,
  type ShapeInput,
} from "./lib/register-tool.js";

export {
  installValidationAudit,
  type ValidationAuditContext,
} from "./lib/install-validation-audit.js";

export { shouldSkipIntegrationTests } from "./lib/integration-gate.js";

export {
  bootstrapStdioServer,
  type BootstrapStdioOptions,
  type ToolRegistrar,
} from "./lib/bootstrap.js";

export {
  createApp,
  bootstrapHttpServer,
  type CreateHttpAppOptions,
  type CreatedHttpApp,
  type BootstrapHttpOptions,
  type BootstrapHttpResult,
  type HttpToolRegistrar,
} from "./lib/bootstrap-http.js";

// ── Multiplexed gateway (one AS + N resources) ────────────────────────────
export {
  createGatewayApp,
  type ResourceSpec,
  type CreateGatewayAppOptions,
  type CreatedGatewayApp,
} from "./lib/gateway.js";

export {
  createResourceMcpRouter,
  type ResourceMcpRouterOptions,
  type ResourceToolRegistrar,
} from "./oauth/resource-router.js";

// ── Embedded OAuth 2.1 authorization server (HTTP transport) ──────────────
export {
  loadOAuthConfig,
  makeOAuthConfig,
  resolveUrls,
  DEFAULT_MOUNT_PATH,
  type OAuthConfig,
  type OAuthUrls,
} from "./oauth/config.js";

export {
  protectedResourceMetadata,
  authorizationServerMetadata,
  MCP_SCOPE,
} from "./oauth/metadata.js";

export {
  createOAuthRouter,
  createAuthorizationServerRouter,
  wwwAuthenticateChallenge,
  type OAuthRouterOptions,
  type AuthorizationServerRouterOptions,
} from "./oauth/router.js";

export { resolveAccessToken, ACCESS_TOKEN_TYP } from "./oauth/resolve.js";

export {
  signJwt,
  verifyJwt,
  nowSec,
  base64urlEncode,
  base64urlDecodeToString,
  type JwtClaims,
  type JwtHeader,
  type VerifyOptions,
} from "./oauth/jwt.js";

export { computeS256Challenge, verifyPkceS256 } from "./oauth/pkce.js";

export {
  encodeClientId,
  decodeClientId,
  isAllowedRedirectUri,
  validateRedirectUris,
  clientFingerprint,
  isLoopbackRedirect,
  redirectHost,
  type RegisteredClient,
} from "./oauth/clients.js";

export {
  consumeCode,
  consumeRefresh,
  _resetUsedCodes,
  _resetUsedRefresh,
} from "./oauth/codes.js";

export {
  renderConsentPage,
  renderErrorPage,
  escapeHtml,
  type ConsentParams,
} from "./oauth/consent.js";
