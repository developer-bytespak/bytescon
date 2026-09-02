# proposal-mcp v0.1.0

Bytescon proposal assembly MCP server (stdio). Read-only access to the
tenant's compliance matrices, matrix requirements, bid guidance, and
adherence scores, plus one pure pricing-template generator. Part of the
Bytescon MCP suite; consumes the shared plumbing in
[`@bytescon/mcp-shared`](../shared/README.md).

## Purpose

Lets an MCP host (Claude Desktop, Claude Code) inspect proposal
compliance state for the calling tenant and scaffold cost-volume pricing
without going through the platform UI. v0.1 is deliberately read-only
with one pure generator:

- LLM-backed `build_compliance_matrix` and `extract_section_l_m` are
  DEFERRED to v0.2. MCP servers in this suite stay LLM-free; generation
  belongs to the backend workers, the MCP layer only reads their output.
- The only write this server ever performs is the mandatory
  `mcp_audit_log` row on every tool call.

## Tools (5)

| Tool | Kind | Description |
|---|---|---|
| `get_compliance_matrix` | read | One opportunity's matrix plus paginated requirement rows (section, section type, text, mandatory flag, status, FAR reference). |
| `list_matrix_requirements` | read | Cross-matrix requirement listing with filters: `opportunity_id`, `section_type` (INSTRUCTION, EVALUATION, CLAUSE, CERTIFICATION), `mandatory_only`, `status`. Paginated, returns total count. |
| `get_bid_guidance` | read | The stored `bidGuidanceJson` (evaluation criteria, win strategy, red flags) from the tenant's matrix, deep-sanitized and capped. |
| `get_adherence_score` | read | AdherenceScore rows for one opportunity, newest first, whole-proposal and per-section scopes, including sanitized blockers. |
| `generate_pricing_template` | pure | Structured pricing template: labor rows, indirect rate placeholders, ODC and travel lines, basis-of-estimate checklist. No DB writes. Optional tenant-scoped opportunity prefill. |

## Auth model

Identical to opportunity-mcp:

- `Bytescon_MCP_TOKEN` (env) is resolved once at boot against `api_tokens`
  by SHA-256 hash. Missing, unknown, revoked, or expired tokens exit the
  process non-zero.
- The resolved `consultingFirmId` is the FIRST clause of every
  tenant-scoped WHERE. Tool arguments are never trusted as tenancy
  signals; an opportunity id from another tenant simply does not match.
- Server minimum tier: CORE (every valid token qualifies; the tier gate
  is enforced at boot via `minTier`).

## Audit behavior

Every tool call that reaches the handler writes exactly one
`mcp_audit_log` row (server_name, server_version, tool_name, tenant_id,
token_fp, input_hash, output_bytes, duration_ms, outcome,
correlation_id), success or failure. Known suite-wide limitation: calls
rejected by SDK input validation never reach the handler and therefore
write no audit row (no data access occurs on that path); a shared-lib
fix is queued, see mcp/README.md.
Success-path audit failures throw; error-path audit failures are logged
and swallowed so they never mask the original tool error. Responses are
capped at 8 KB (warn) and 32 KB (hard error). All free-text and JSON
column output is sanitized (control-char strip, per-field caps, bounded
JSON depth and width).

## Setup

```powershell
cd C:\Projects\Gov-ConV2\mcp\proposal-mcp
npm install
npm run build        # tsc only; uses the backend-generated Prisma client at runtime
Copy-Item .env.example .env   # then fill Bytescon_MCP_TOKEN
node dist/server.js
```

Prerequisite: the backend Prisma client must be generated
(`npx prisma generate --schema=backend/prisma/schema.prisma` from the
repo root). `@bytescon/mcp-shared` locates it automatically; override with
`Bytescon_PRISMA_CLIENT_PATH` if the layout is nonstandard.

### Claude Desktop config

```json
{
  "mcpServers": {
    "proposal-mcp": {
      "command": "node",
      "args": ["C:\\Projects\\Gov-ConV2\\mcp\\proposal-mcp\\dist\\server.js"],
      "env": {
        "DATABASE_URL": "postgresql://bytescon_user:bytescon_pass@localhost:5432/bytescon_platform",
        "Bytescon_MCP_TOKEN": "your-token-here",
        "NODE_ENV": "production",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

## Tests and smoke

```powershell
$env:DATABASE_URL = "postgresql://bytescon_user:bytescon_pass@localhost:5432/bytescon_platform"
npm test                 # vitest: validation, handler, tenant isolation, audit assertions
./scripts/smoke.ps1      # JSON-RPC handshake + tools/list + two tools/call over stdio
```

Integration tests seed their own two-firm fixtures with ids prefixed
`proposal-mcp-test-<runid>-` and clean up in afterAll, so parallel test
runs from sibling servers on the shared dev DB never collide. Tests skip
cleanly when DATABASE_URL is unset.

## Build vs buy (decision dated 2026-06-11)

Built in-house. The tools are thin tenant-scoped reads over our own
Postgres schema plus one deterministic generator; there is no commercial
MCP server for a proprietary compliance-matrix schema, and the suite's
auth, audit, and sanitization contract (CLAUDEmcp.md) requires owning
the data path. Dependencies are limited to the suite baseline
(@modelcontextprotocol/sdk, zod, winston) plus @bytescon/mcp-shared.

## Design decisions and downscopes (v0.1)

- LLM-backed matrix generation and Section L/M extraction deferred to
  v0.2 (see Purpose above).
- `generate_pricing_template` defines the canonical shapes for the
  CostVolume JSON columns (`laborCategoriesJson`, `indirectRatesJson`,
  `odcLinesJson`, `travelLinesJson`). Verified 2026-06-11: the backend
  declares those columns in schema.prisma but has no writer yet, so this
  server's template is the reference shape (camelCase row keys, matching
  backend JSON conventions such as `explanationJson.credibleInterval`).
  A future backend writer can persist a completed template directly.
- `section_type` is a plain String column in Prisma; the input enum
  (INSTRUCTION, EVALUATION, CLAUSE, CERTIFICATION) reflects the values
  the backend extraction pipeline writes. Rows with other values are
  still returned by unfiltered queries.

## Known limitations

| Limitation | Plan |
|---|---|
| stdio transport only | HTTP/SSE with OAuth 2.1 + PKCE in v0.2 |
| No per-tenant rate limiting | Redis sliding-window counters in v0.2 |
| No DB-level append-only enforcement on mcp_audit_log | v0.2 dedicated audit-writer role |
| Tests share the dev database | dedicated test DB in CI in v0.2 |
| Requirement text capped at 300 chars in list output | full-text fetch tool or per-row detail tool if needed in v0.2 |

## Version history

- 0.1.0 (2026-06-11): initial release. Five tools, tenant isolation and
  audit tests, smoke script. Built on @bytescon/mcp-shared 0.1.0.
