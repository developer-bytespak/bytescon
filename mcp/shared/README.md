# @bytescon/mcp-shared

Shared plumbing for the Bytescon MCP suite, extracted as copies from the proven
opportunity-mcp v0.3 code. Consumed by the new sibling servers (knowledge-mcp,
proposal-mcp, carrier-mcp, bytescon-core-mcp) via:

```json
"dependencies": {
  "@bytescon/mcp-shared": "file:../shared"
}
```

npm installs `file:` dependencies as symlinks (junctions on Windows), so the
package resolves to this folder at runtime. Run `npm run build` here first; the
package entry points (`main` and `types`) target `dist/`.

## Purpose

One audited implementation of the suite contract plumbing (CLAUDEmcp.md rules)
instead of five divergent copies:

- bearer token resolution against `api_tokens` (SHA-256 hash lookup, revocation
  and expiry checks, audit-safe 16-char fingerprint) plus the tier gate
- one `mcp_audit_log` row per tool call with canonical input hashing
- winston JSON logging, every level to stderr (stdout is the stdio transport)
- prompt-injection sanitization and the 8 KB default / 32 KB hard response caps
- Zod raw shape tool registration matching the opportunity-mcp pattern
- a `bootstrapStdioServer` convenience mirroring opportunity-mcp's boot sequence

## API

| Export | Kind | Description |
| --- | --- | --- |
| `createStderrLogger(serviceName, level?)` | function | Winston JSON logger, all levels to stderr, `service` default meta. |
| `Logger` | type | Re-export of `winston.Logger` for parameter typing. |
| `sanitize(text, maxLength?)` | function | Strip control chars 0x00-0x1F and 0x7F (replaced with spaces), cap at 2000 chars by default. Apply to every free-text DB field returned to the host LLM. |
| `capJsonResponse(payload, options?)` | function | JSON.stringify + UTF-8 byte measure; warns above the default cap (when given a logger), throws above the hard cap. Returns `{ text, outputBytes }`. |
| `SANITIZE_FIELD_CAP`, `MAX_RESPONSE_BYTES_DEFAULT`, `MAX_RESPONSE_BYTES_HARD` | constants | 2000 chars, 8192 bytes, 32768 bytes. |
| `hashToken(raw)` / `tokenFingerprint(raw)` | functions | SHA-256 hex of a raw token / first 16 hex chars for audit rows. |
| `resolveBearerToken(prisma, raw)` | function | Resolve a raw token to `ResolvedTokenContext` or null (unknown, revoked, expired, or too short). Fires a best-effort `lastUsedAt` update. |
| `meetsTier(actual, required)` / `requireTier(ctx, required)` | functions | Tier gate, CORE < PRO < VAULT. `requireTier` throws `McpAuthError` (code `AUTH_ERROR`). |
| `ApiTokenTier`, `ResolvedTokenContext` | types | Token tier union and resolved tenant context. |
| `writeAuditEntry(prisma, entry, logger?)` | function | Append one `mcp_audit_log` row. Throws on failure; on tool error paths attach `.catch()` so the original error is never masked. |
| `hashInput(input)` | function | Canonical SHA-256 (recursive sorted keys) for `input_hash`. |
| `AuditOutcome`, `AuditEntry` | types | `"ok" \| "tool_error" \| "auth_error" \| "rate_limited"` and the row shape. |
| `registerTool(server, def)` | function | Thin `server.tool(name, description, rawShape, cb)` wrapper taking a declarative `ToolDefinition`. |
| `HandlerResult`, `ToolHandlerContext`, `ToolDefinition`, `ShapeInput` | types | Handler return shape (`isError` pattern), per-tool context, declarative definition, inferred input. |
| `bootstrapStdioServer(options)` | function | Full boot sequence: env check, token resolve, optional `minTier` gate, register tools, connect stdio, SIGTERM/SIGINT shutdown. Exits non-zero on auth failure. |
| `BootstrapStdioOptions`, `ToolRegistrar` | types | Bootstrap options and the `(server, context) => void` registrar shape. |
| `createPrismaClient()` | function | Process-wide PrismaClient from the backend-generated client (see below). |
| `loadPrismaClientConstructor()` / `resolveBackendPrismaClientPath()` | functions | Lower-level loader pieces, exposed for diagnostics and tests. |
| `disconnectPrisma(client)` | function | Graceful shutdown helper. |
| `PrismaLikeClient`, `PrismaClientConstructor`, `PrismaApiTokenRecord`, `PrismaAuditCreateData`, `PRISMA_CLIENT_PATH_ENV` | types/constant | Minimal structural client interface used by all helpers, plus loader types and the override env var name. |
| `McpToolError`, `McpAuthError`, `McpValidationError`, `isMcpToolError`, `McpErrorCode` | classes/guard/type | Typed tool errors converted to `isError: true` responses by handlers. |

## Prisma client strategy

Every helper takes an injected client typed as the minimal structural interface
`PrismaLikeClient`, so unit tests inject mocks and no helper hard-codes a path
to the generated client.

For real servers, `createPrismaClient()` loads the backend-generated client:

1. If `Bytescon_PRISMA_CLIENT_PATH` is set, that exact path is required (absolute
   path to the generated client entry file or directory).
2. Otherwise the loader walks upward from this module's real on-disk location
   (npm `file:` installs are symlinks, which Node resolves to the real path
   inside the repo) and from `process.cwd()`, looking for
   `backend/node_modules/@prisma/client/index.js`.

This avoids the fragile fixed-depth relative import: opportunity-mcp's path
math assumes the `mcp/opportunity-mcp` depth and breaks for packages consumed
through `file:` (the import would resolve from the consumer's node_modules).
Verified end-to-end with a `file:` protocol consumer against the live dev DB
on 2026-06-11.

The backend client must already be generated. From the repo root:

```powershell
npx prisma generate --schema=backend/prisma/schema.prisma
```

Servers needing models beyond `apiToken` and `mcpAuditLog` should cast the
returned client to their own typed view, or pass their own generated client
`as unknown as PrismaLikeClient` to the shared helpers.

## Environment variables (read by this package)

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Prisma client | Same Postgres the backend uses. Required at runtime, no fallback. |
| `Bytescon_MCP_TOKEN` | `bootstrapStdioServer` | Raw bearer token, resolved once at boot. Required, no fallback. |
| `MCP_LOG_LEVEL` | `createStderrLogger` | Defaults to `info`. |
| `Bytescon_PRISMA_CLIENT_PATH` | prisma loader | Optional override, absolute path to the generated client. |
| `NODE_ENV` | `createPrismaClient` | Outside `production` the client is cached on globalThis. |

This is a library, not a server, so there is no `.env.example` here; each
server documents its own env contract.

## Build and test

```powershell
npm install
npm run build     # tsc -> dist/ (no prisma generate step needed here)
npm test          # vitest, unit tests with injected mock prisma, no DB required
```

## Build vs buy (2026-06-11)

Build. This package is pure extraction of in-repo, already-reviewed plumbing;
there is nothing to buy. Dependencies stay within the suite's approved set
(@modelcontextprotocol/sdk, zod, winston, typescript, vitest).

## Known limitations and follow-ups

- opportunity-mcp is NOT migrated to consume this package in this pass, per
  the v0.2 no-breaking-changes rule. It keeps its own copies of auth, audit,
  logger, sanitize, and prisma loading. Follow-up: refactor opportunity-mcp
  onto @bytescon/mcp-shared in a dedicated change with its full test suite as
  the safety net, then delete the duplicated lib files.
- `PrismaLikeClient` covers only what the shared helpers touch by design;
  it is not a general database abstraction.
- The tier gate and token resolution are stdio-era (resolve once at boot).
  HTTP transport with per-request resolution and OAuth 2.1 + PKCE remains
  v0.2+ work tracked in the suite threat models.

## Version history

- 0.2.0 (2026-06-12): close the suite-wide audit gap for validation-rejected
  tools/call. New `installValidationAudit(server, ctx)` wraps the server's
  tools/call handler so a call rejected by Zod validation (before the handler
  runs) writes one `mcp_audit_log` row with outcome `validation_error`
  (raw arguments never persisted); the stdio bootstrap installs it
  automatically. New audit outcome `validation_error`. New shared
  `shouldSkipIntegrationTests()` loud-fail gate: fails when `CI` is set and
  `DATABASE_URL` is missing, warns and skips locally.
- 0.1.0 (2026-06-11): initial extraction from opportunity-mcp v0.3 for the
  MCP suite v0.2 build. Helpers: logger factory, sanitize and response caps,
  token resolve and tier gate, audit writer and input hashing, tool
  registration, stdio bootstrap, injected-prisma loader.
