# bytescon-core-mcp v0.1.0

Bytescon tenant core and admin data MCP server. Read-only, stdio transport,
tier PRO. Part of the Bytescon MCP suite v0.2 build (DESIGN.md workstream 5).

## Purpose

Gives a host LLM (Claude Desktop, Claude Code) safe, tenant-scoped, read-only
access to the operational core of one consulting firm: client deliverables,
subscription and billing state, AI usage spend, and the firm's user roster.

This server performs ZERO writes to business tables. Because there are no
write tools, no human-in-the-loop gates are needed in v0.1; any future write
tool MUST go through the spec section 6.5 interrupt flow (explicit human
approval per mutation) before it ships.

## Tools (4)

| Tool | Inputs | Returns |
| --- | --- | --- |
| `list_deliverables` | `status?`, `due_before?` (ISO 8601 with offset), `client_company_id?`, `limit` (1-100, default 25), `offset` | The tenant's DocumentRequirement rows: title, description, due date, status, penalty amount and percent, submission timestamp. Ordered by due date ascending. Paginated, `total` carries the full match count. |
| `get_billing_status` | none | Subscription (status, billing cycle, current period, cancel flag, trial end) plus SubscriptionPlan (name, slug, prices, limits) plus invoice summary (count, latest invoice number, status, total USD). Database only: NO Stripe API calls, NO payment-method data, Stripe ids never selected. |
| `get_usage_summary` | `window_days` (1-365, default 30) | ApiUsageLog aggregates grouped by provider: call count, input and output tokens, estimated cost USD, plus totals, over the trailing window. |
| `list_users` | `include_emails` (default false, tier PRO+), `limit`, `offset` | The tenant's platform users: first name, last name, role, active flag, last login. Emails are EXCLUDED by default for privacy; `include_emails: true` requires tier PRO or higher. passwordHash and verification fields are never selected. |

## Auth model

- `Bytescon_MCP_TOKEN` (env, no fallback) is resolved once at boot against
  `api_tokens` by SHA-256 hash via `@bytescon/mcp-shared`. Revocation and expiry
  checked on every resolve.
- The resolved `consultingFirmId` scopes every query; it is the first WHERE
  clause and never comes from tool arguments.
- Server-wide minimum tier: PRO (CORE < PRO < VAULT). Enforced twice:
  1. at boot, `bootstrapStdioServer({ minTier: "PRO" })` exits non-zero on a
     CORE token;
  2. per tool call, `requireTier(ctx, "PRO")` converts under-tier calls into
     structured `isError` responses with an `auth_error` audit row (this is
     the layer the tier-gate tests exercise).
- `include_emails` on `list_users` is additionally tier-gated to PRO+.

## Audit behavior

Every tool invocation writes exactly one `mcp_audit_log` row: server_name,
server_version, tool_name, tenant_id, token_fp (16-char SHA-256 prefix, never
the raw token), input_hash (canonical JSON SHA-256), output_bytes, duration_ms,
outcome (`ok`, `tool_error`, `auth_error`), correlation_id. Success-path audit
failures throw; error-path audit failures are logged and never mask the
original tool error.

Response caps: 8 KB default (warn), 32 KB hard (error). All free-text DB
fields pass through the shared `sanitize()` (control-char strip, 2000-char
field cap) before reaching the host LLM.

## Environment

See `.env.example`. Contract identical to opportunity-mcp: `DATABASE_URL`,
`Bytescon_MCP_TOKEN`, `MCP_LOG_LEVEL`, `NODE_ENV`. Optional
`Bytescon_PRISMA_CLIENT_PATH` overrides the shared loader's discovery of the
backend-generated Prisma client.

## Local setup

```powershell
# 1. Backend Prisma client must be generated (from the repo root):
npx prisma generate --schema=backend/prisma/schema.prisma

# 2. Shared package must be built first:
cd mcp/shared; npm install; npm run build

# 3. This server:
cd ../bytescon-core-mcp
npm install
npm run build
npm test          # requires DATABASE_URL pointing at the dev DB
./scripts/smoke.ps1
```

### Claude Desktop config

```json
{
  "mcpServers": {
    "bytescon-core-mcp": {
      "command": "node",
      "args": ["C:\\Projects\\Gov-ConV2\\mcp\\bytescon-core-mcp\\dist\\server.js"],
      "env": {
        "DATABASE_URL": "postgresql://bytescon_user:bytescon_pass@localhost:5432/bytescon_platform",
        "Bytescon_MCP_TOKEN": "your-PRO-or-VAULT-token-here",
        "NODE_ENV": "production",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

## Tests

`tests/` runs against the shared dev database (skips cleanly when
DATABASE_URL is unset). Fixture rows are prefixed `bytescon-core-mcp-test-<runid>-`
so parallel suite workstreams never collide; cleanup runs in afterAll.
Coverage: input validation per schema, happy paths per tool, two-firm tenant
isolation across all four tools, CORE-tier rejection with auth_error audit
rows, audit-row assertions including the error path, and the privacy
assertion that emails are absent without `include_emails`.

## Build vs buy (2026-06-11)

Build. This server is a thin, audited, tenant-scoped read layer over the
platform's own Postgres; there is no third-party product that exposes our
DocumentRequirement, Subscription, ApiUsageLog, and User tables. Billing
status deliberately reads the local subscription and invoice tables instead
of the Stripe API: the official Stripe MCP server remains the right buy for
acting on Stripe objects themselves (refunds, payment links), which is out of
scope for this read-only server. No new dependencies beyond the approved
suite set; all plumbing comes from `@bytescon/mcp-shared`.

## Known limitations (v0.1.0)

- stdio transport only; HTTP plus OAuth 2.1 with PKCE is v0.2 suite work.
- No per-tenant rate limiting (v0.2: Redis sliding-window counters).
- Offset pagination only; keyset pagination if these tables grow hot.
- `get_billing_status` reflects the local DB, which may lag Stripe by one
  webhook cycle; it is a status read, not a source-of-truth reconciliation.
- Tests share the dev database (dedicated test DB is v0.2 CI work).
- mcp/registry.json registration is left to the suite orchestrator to avoid
  cross-workstream write conflicts on the shared file.

## Version history

- 0.1.0 (2026-06-11): initial release. Four read-only tools
  (list_deliverables, get_billing_status, get_usage_summary, list_users),
  tier PRO gate at boot and per call, email privacy flag, full audit, built
  on @bytescon/mcp-shared. 47 tests green against the local dev DB; smoke
  script green end to end.
