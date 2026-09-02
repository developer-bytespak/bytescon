# opportunity-mcp — Embedded OAuth 2.1 (HTTP transport)

As of v0.4 the HTTP transport (`dist/server-http.js`) embeds a small OAuth 2.1
authorization server that implements the [MCP authorization
spec](https://modelcontextprotocol.io/specification) so a remote/web connector
(claude.ai, Claude Desktop's "Add connector") can sign in on its own, instead
of the operator pasting a raw API token into a local host config.

The design goal was to add this **without** a new backend service, a new
database table, or any change to `backend/` or `frontend/`. Everything lives in
`mcp/opportunity-mcp/src/oauth/` plus two root infra files (`Caddyfile`,
`docker-compose.prod.yml`).

## TL;DR

- OAuth is **off** unless `MCP_OAUTH_SIGNING_KEY` (>= 32 chars) is set. When off,
  the HTTP server behaves exactly as in v0.3 (raw Bearer `api_tokens` only, no
  discovery endpoints, no `WWW-Authenticate` challenge).
- The user proves identity by **pasting their existing Bytescon API token** on
  the consent page. The OAuth layer is a transport wrapper over the same
  credential; it issues no new long-lived authority.
- Clients, authorization codes, access tokens, and refresh tokens are all
  **stateless HS256-signed JWTs**. No new tables. Authorization codes are
  additionally tracked in an in-memory single-use ledger so a code cannot be
  replayed.
- Every access token embeds `sub = api_tokens.id` and the `/mcp` path
  re-resolves that row on **every** request, so revocation and expiry of the
  underlying token are honored immediately regardless of the JWT's own lifetime.
- Raw `api_tokens` (opaque base64url, no dots) and JWTs (three dot-separated
  parts) are unambiguous, so both auth styles coexist with no precedence
  guesswork.

## The handshake

This is the standard MCP authorization discovery flow. Claude drives it
automatically once the user adds `https://bytescon.com/mcp` as a connector.

```
1. POST /mcp  (no token)
   -> 401  WWW-Authenticate: Bearer resource_metadata="https://bytescon.com/.well-known/oauth-protected-resource/mcp"

2. GET /.well-known/oauth-protected-resource/mcp        (RFC 9728)
   -> { resource, authorization_servers: [ "https://bytescon.com" ], ... }

3. GET /.well-known/oauth-authorization-server          (RFC 8414)
   -> { authorization_endpoint, token_endpoint, registration_endpoint,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"], ... }

4. POST /mcp/oauth/register   { redirect_uris, client_name }   (RFC 7591)
   -> 201 { client_id, ... }            # client_id is a signed JWT (typ dcr+jwt)

5. GET  /mcp/oauth/authorize?response_type=code&client_id=...&redirect_uri=...
        &code_challenge=...&code_challenge_method=S256&state=...&scope=mcp
   -> 200 HTML consent page (paste API token)

6. POST /mcp/oauth/authorize  (form: the params above + api_token)
   -> 302 redirect_uri?code=<signed code+jwt>&state=...

7. POST /mcp/oauth/token
        grant_type=authorization_code&code=...&redirect_uri=...
        &code_verifier=...&client_id=...
   -> 200 { access_token, token_type: "Bearer", expires_in, refresh_token, scope }

8. POST /mcp   Authorization: Bearer <access_token>
   -> 200  (tool calls proceed; token resolves to the tenant)
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource` and `…/mcp` | RFC 9728 protected-resource metadata |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata (bare path only) |
| POST | `/mcp/oauth/register` | RFC 7591 dynamic client registration |
| GET | `/mcp/oauth/authorize` | Render the paste-token consent page |
| POST | `/mcp/oauth/authorize` | Validate the pasted token, issue an authorization code |
| POST | `/mcp/oauth/token` | `authorization_code` and `refresh_token` grants |
| GET | `/mcp/health` | Liveness probe that also reports `{ "oauth": true|false }` |

The authorization-server metadata is served **only** at the bare well-known
path: its `issuer` is the base origin, which is RFC 8414 §3.3-consistent only at
the non-suffixed location, and PRM already advertises `authorization_servers =
[base]` so well-behaved clients fetch it there. A `/mcp`-suffixed AS document
would return an `issuer` that disagrees with its fetch URL, which strict
validators reject.

All OAuth endpoints are only mounted when OAuth is enabled. Caddy routes the
four `/.well-known/oauth-*` discovery paths and everything under `/mcp/*` (which
covers `/mcp/oauth/*`) to the mcp service. `/mcp/health` is reachable through the
same `/mcp/*` matcher, so an external uptime probe can read the `oauth` flag
without hitting the SPA (the bare `/health` is routed to the frontend by Caddy).

## Token model

One HMAC key (SHA-256 of `MCP_OAUTH_SIGNING_KEY`) signs four token types, each
distinguished by its JWT `typ` header so one type can never be replayed as
another:

| Token | `typ` | TTL | Key claims |
|---|---|---|---|
| client_id (DCR) | `dcr+jwt` | none | `ru` (redirect_uris), `cn` (client_name) |
| authorization code | `code+jwt` | 60 s | `jti`, `sub` (api_tokens.id), `cc` (PKCE challenge), `ru`, `cid` (client fingerprint), `res` (audience), `scope` |
| access token | `at+jwt` | 1 h | `iss`, `aud`, `sub`, `fp`, `firm`, `tier`, `scope`, `jti` |
| refresh token | `rt+jwt` | 30 d | `iss`, `aud`, `sub`, `scope`, `jti` |

`sub` is always the `api_tokens.id`. The access/refresh tokens carry no secret
material; they are bearer credentials scoped by `aud` (the resource URL) and
re-validated against the database on use.

## Security properties

- **PKCE S256 is mandatory.** `authorize` rejects any request without
  `code_challenge` + `code_challenge_method=S256`; `token` recomputes the
  challenge from the `code_verifier` and rejects a mismatch. `plain` is not
  supported.
- **redirect_uri allowlist.** Registration only accepts `https://` URIs or
  `http://` on loopback (`localhost`, `127.0.0.1`, `::1`). External https hosts
  are further constrained by `MCP_OAUTH_REDIRECT_ALLOWLIST` (comma-separated
  exact host or subdomain; `*` = any). In production this defaults to
  `claude.ai,claude.com,anthropic.com`, which closes the open dynamic-client
  registration phishing surface (an attacker cannot register a hostile
  `redirect_uri` to siphon authorization codes). An empty allowlist is
  permissive (any https host, the pre-hardening behavior) but logs a warning for
  every external host that registers. Subdomain matching is suffix-safe:
  `claude.ai` matches `foo.claude.ai` but **not** `claude.ai.evil.com`. At
  `authorize` time the `redirect_uri` must additionally match one registered for
  the client; an unregistered `redirect_uri` renders a terminal error page and
  is **never** redirected to.
- **Consent shows the destination.** The paste-token consent page always renders
  the `redirect_uri` host ("access will be sent to: <host>") so the human can
  spot a hostile target before pasting a real API token. This is the trust
  checkpoint that backstops the allowlist regardless of how it is configured.
- **Resource indicators (RFC 8707).** When the `authorize` request carries a
  `resource` parameter, it is compared by origin to this server; a value naming a
  foreign resource is rejected with `error=invalid_target` instead of silently
  issuing a token for this resource. An omitted or unparseable value is treated
  leniently. The access-token `aud` is always pinned to this resource regardless.
- **Single-use codes and refresh-token rotation.** A code's `jti` is burned in an
  in-memory ledger on first redemption; a replay returns `invalid_grant`.
  Refresh tokens follow OAuth 2.1 rotation: the presented refresh `jti` is burned
  on use (separate ledger) and every grant mints a fresh refresh token, so a
  captured refresh token cannot be replayed. Expired jtis are evicted from both
  ledgers so they do not grow unbounded. (Codes also expire after 60 s on their
  own; refresh entries are retained for the token's 30 d lifetime.) The binding
  checks (redirect_uri, client_id, PKCE) run **before** the code jti is burned,
  so a malformed redemption cannot consume a code out from under the rightful
  holder.
- **No alg confusion.** Verification requires header `alg=HS256` and a
  constant-time signature compare; `alg=none` and any asymmetric alg are
  rejected before claims are read.
- **Audience binding.** Access tokens are minted with `aud` = the resource URL
  and verified against the resolved resource on every `/mcp` request, so a token
  minted for this resource cannot be presented elsewhere and accepted here under
  a different audience.
- **Revocation/expiry honored live.** `sub` is re-resolved to its `api_tokens`
  row on every request (`resolveTokenById`); a revoked or expired row yields 401
  even if the access-token JWT is still within its hour. Integration test:
  *"invalidates a live access token once the underlying api_token is revoked."*
- **Clock-skew guard.** Tokens with `iat` more than 120 s in the future are
  rejected.

## Backward compatibility

`resolveAccessToken` discriminates by shape: a value with exactly three
dot-separated parts is treated as a JWT and verified; anything else falls
through to `resolveBearerToken` (the v0.3 raw-token path). Raw `api_tokens` are
opaque base64url with no dots, so the two never collide. When
`MCP_OAUTH_SIGNING_KEY` is unset:

- no OAuth routes are mounted,
- no `WWW-Authenticate` challenge is emitted,
- `/mcp` accepts raw Bearer tokens exactly as before.

A deployment that never provisions a key is therefore identical to v0.3.

## Configuration

| Env var | Required | Effect |
|---|---|---|
| `MCP_OAUTH_SIGNING_KEY` | to enable OAuth | HMAC key source; must be >= 32 chars. A value set but shorter than 32 chars logs a warning and leaves OAuth **disabled** (so a truncated key is not mistaken for an intentional disable). Rotating it invalidates all outstanding OAuth tokens (raw api_tokens unaffected). |
| `MCP_PUBLIC_BASE_URL` | in production | Canonical origin (no trailing slash) for issuer/resource/endpoint URLs and the access-token audience. **Fail-closed:** when OAuth is enabled and `NODE_ENV=production`, startup throws if this is blank rather than deriving issuer/audience from the spoofable `Host` header. When blank in local/dev it is derived from the request. |
| `MCP_OAUTH_REDIRECT_ALLOWLIST` | no | Comma-separated external https redirect hosts allowed to register (exact host or subdomain; `*` = any). Empty = permissive with per-registration warnings. Loopback http is always allowed. Prod compose defaults it to `claude.ai,claude.com,anthropic.com`. |
| `MCP_HTTP_PORT` | no | HTTP bind port (default 3002). |

Generate a key with `openssl rand -base64 48`. In production it is set in
`.env.prod` (gitignored) and consumed by the `mcp` service in
`docker-compose.prod.yml`. `deploy.sh` smoke-tests `/mcp/health` for
`"oauth":true` and the AS discovery doc after each deploy, warning (non-fatally)
if OAuth came up disabled or unreachable.

## Connecting from Claude

Add a custom connector pointing at `https://bytescon.com/mcp`. Claude performs
the discovery flow above; the only manual step for the user is pasting their Gov
Bytescon API token on the consent page. The same token that works in a local
Claude Desktop config works here.

## Tests

`tests/oauth-unit.test.ts` (no DB) covers the JWT (incl. `alg:none` and
tamper rejection), PKCE S256, DCR client round-trip, the redirect allowlist
(permissive, strict host/subdomain, suffix-spoof rejection, wildcard), the
single-use code and refresh ledgers, config gating (allowlist parsing +
fail-closed-in-production throw), URL resolution, and metadata shape.
`tests/oauth-flow.test.ts` drives the full handshake against the real Express
app on an ephemeral port, plus the negatives: replayed code, wrong PKCE
verifier, unregistered redirect_uri, tampered access token, refresh grant,
**refresh-token rotation** (original rejected after one use, rotated token
works), **consent page shows the redirect host**, **`invalid_target`** on a
foreign resource indicator, and **live revocation** of the underlying
`api_tokens` row.

The whole opportunity-mcp suite is **104 tests, 0 skipped** when `DATABASE_URL`
points at a reachable Postgres (the integration tests skip cleanly, with a
visible warning, when it is unset).

## Limitations

- Consent is paste-your-api-token, not a federated IdP login. There is no
  per-user account concept beyond the firm's `api_tokens` row.
- No per-client rate limiting yet (shared with the HTTP hardening pass).
- The single-use code and refresh-token ledgers are in-process. The server runs
  as exactly one container (the fixed `container_name` in
  `docker-compose.prod.yml` blocks `--scale`), so this is sufficient today; a
  horizontally scaled deployment would need a shared store (Redis) for both jti
  ledgers before adding replicas.
