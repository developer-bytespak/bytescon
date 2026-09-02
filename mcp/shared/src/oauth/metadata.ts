/**
 * Discovery metadata documents.
 *
 *  - Protected Resource Metadata (RFC 9728): tells the client which
 *    authorization server protects this MCP resource.
 *  - Authorization Server Metadata (RFC 8414): advertises the authorize /
 *    token / registration endpoints, S256-only PKCE, and public-client
 *    (token_endpoint_auth_method "none") support.
 */
import type { OAuthUrls } from "./config.js";

export const MCP_SCOPE = "mcp";

/**
 * RFC 9728 protected-resource metadata for this MCP resource.
 *
 * @param urls - Resolved deployment URLs (resource, issuer).
 * @param resourceName - Human-readable name advertised as `resource_name`
 *   (server-specific, e.g. "Bytescon opportunity intelligence (MCP)").
 */
export function protectedResourceMetadata(urls: OAuthUrls, resourceName: string): Record<string, unknown> {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [MCP_SCOPE],
    resource_name: resourceName,
  };
}

export function authorizationServerMetadata(urls: OAuthUrls): Record<string, unknown> {
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorizeEndpoint,
    token_endpoint: urls.tokenEndpoint,
    registration_endpoint: urls.registrationEndpoint,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}
