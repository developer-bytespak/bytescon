# opportunity-mcp v0.4

Federal opportunity intelligence + portfolio surface for the Bytescon (Bytescon) platform, exposed via the Model Context Protocol.

**Status:** active
**Transport:** stdio (`dist/server.js`) + streamable HTTP (`dist/server-http.js`, per-request bearer auth, optional embedded OAuth 2.1)
**Tool count:** 13 (exceeds the prior 12-tool soft cap — see Known limitations)
**Tests:** 104/104 passing (unit + integration)

## Purpose

Lets any MCP-aware host (Claude Desktop, Claude Code, Cursor, custom agents) query the calling tenant's opportunity pipeline, portfolio, market trends, and federal recipient data. Data is scoped to one tenant per process via a bearer token resolved at startup.

## Tools

| Tool | Tenant-scoped | Purpose |
|---|---|---|
| `search_opportunities` | yes | Search active opportunities by keyword/NAICS/set-aside/posted-after. Cursor-paginated. |
| `get_opportunity_detail` | yes | Full record for one opportunity by id. |
| `get_bid_decision` | yes | Decision-engine output for one opp: GO/NO_GO, win probability, fit / market / risk scores. |
| `list_compliance_gaps` | yes | Open compliance gaps blocking a bid decision. |
| `lookup_recipient` | no¹ | Public SAM.gov/USAspending profile of a federal contractor by UEI. |
| `list_clients` | yes | The tenant's client companies + performance KPIs. |
| `get_pipeline_summary` | yes | Stage counts, conversion ratios, won/open dollar totals. |
| `get_market_trends` | yes | Per-NAICS volume + pricing + linear-slope trend over a trailing window. |
| `forecast_revenue` | yes | Monte Carlo revenue forecast (expected/p10/p50/p90 per month) over the active pipeline, optional portfolio health summary. |
| `list_set_asides` | yes | Canonical set-aside values with live counts of the tenant's open opportunities per value. |
| `list_agencies_by_naics` | yes² | Agencies ranked by the tenant's opportunity count for one NAICS, with avg value, set-aside mix, and global award-profile rates. |
| `list_past_performance` | yes | The tenant's structured past-performance records (prior contracts / CPARS history), most-recent first, with client company name when present. |
| `get_past_performance_detail` | yes | Full record for one past-performance entry by id, including scope summary and CPARS link. |

¹ Federal recipient data is public-domain. The tool still requires a valid token so every call is audit-logged with tenant attribution.
² Opportunity aggregates are tenant-scoped; the joined `agency_award_profiles` rates are global reference data (no tenant data crosses the join).

### `forecast_revenue` input

| Field | Type | Required | Constraints |
|---|---|---|---|
| `months_ahead` | integer | no | 1-24, default 6 |
| `include_portfolio_health` | boolean | no | default false; adds diversification (NAICS/agency HHI, set-aside distribution) and risk indicators |

Simulations are capped server-side at 1,000 per call for latency. The forecast math is a local port of `backend/src/services/revenueForecaster.ts` (`forecastRevenue` + `getPortfolioHealth`), not an import: the backend service module pulls in the backend logger and database config, which sit outside this package's `rootDir` and write to stdout, which would corrupt the stdio transport. Model constants (option-year factor 2.5, time-to-award discount, 30 percent sub revenue share, lognormal sigma 0.2, 5 percent unscored floor, recompete boost) are kept identical to the backend.

### `list_set_asides` input

| Field | Type | Required | Constraints |
|---|---|---|---|
| `include_zero_counts` | boolean | no | default true; when false, canonical values with zero open opportunities are omitted |

Output maps each canonical filter value (the same enum `search_opportunities` accepts) to its stored database value and a live count of the tenant's ACTIVE opportunities. Stored values that do not map to a canonical value are listed under `other`.

### `list_agencies_by_naics` input

| Field | Type | Required | Constraints |
|---|---|---|---|
| `naics` | string | yes | exactly 6 digits |
| `top_n` | integer | no | 1-50, default 10 |

Ranks agencies by the tenant's total opportunity count for the NAICS (any status, so history informs the ranking) and reports the ACTIVE subset as `open_count`. Joins `agency_award_profiles` (global) for `small_biz_rate` and `sdvosb_rate` when a profile row exists for the agency name.

### `list_past_performance` input

| Field | Type | Required | Constraints |
|---|---|---|---|
| `client_company_id` | string | no | 1-64 chars; restrict to records tied to one client (from `list_clients`) |
| `is_current` | boolean | no | optional filter, NO default; omit to return all records (incl. completed/expired), pass true/false to filter on the current flag |
| `limit` | integer | no | 1-100, default 25 |

Records are returned most-recent first (`createdAt DESC, id DESC`), tenant-scoped to the caller's firm. `is_current` is an explicit filter with no default: a no-arg call returns the firm's full set — including the completed/expired contracts that are exactly what proposals cite — and `where.isCurrent` is applied only when the caller passes `true` or `false`. Fetches `limit + 1` to set a `truncated` flag when more records exist than the limit. Each row includes the client company name when the record is tied to one.

### `get_past_performance_detail` input

| Field | Type | Required | Constraints |
|---|---|---|---|
| `id` | string | yes | 1-64 chars; the record id from `list_past_performance` |

Returns the single record only if it belongs to the calling firm; otherwise a `tool_error` "not found or not accessible in this tenant" response, consistent with `get_opportunity_detail` / `get_bid_decision`.

### `search_opportunities` — input

| Field | Type | Required | Constraints |
|---|---|---|---|
| `keyword` | string | yes | 1-200 chars, matched against title/description/agency (case-insensitive) |
| `naics` | string | no | exactly 6 digits |
| `set_aside` | enum | no | `SDVOSB`, `VOSB`, `8A`, `WOSB`, `HUBZONE`, `TOTAL_SMALL_BUSINESS`, `UNRESTRICTED` |
| `posted_after` | string | no | ISO 8601 datetime with offset |
| `limit` | integer | no | 1-50, default 10 |
| `cursor` | string | no | Opaque pagination cursor returned as `next_cursor` from the previous page |

### `search_opportunities` — output

```json
{
  "count": 3,
  "next_cursor": "eyJkIjoiMjAyNi0wNi0xNVQxNzowMDowMC4wMDBaIiwiaSI6Ii4uLiJ9",
  "results": [
    {
      "id": "uuid",
      "title": "sanitized title",
      "agency": "sanitized agency",
      "naics": "541330",
      "set_aside": "SDVOSB",
      "posted_date": "2026-05-01T00:00:00.000Z",
      "response_deadline": "2026-06-15T17:00:00.000Z",
      "score": 0.74,
      "url": "https://sam.gov/..."
    }
  ]
}
```

Pagination uses keyset cursors on `(response_deadline ASC, id ASC)` — stable under concurrent inserts (no offset drift). Pass `next_cursor` back as `cursor` to walk pages. A `null` value indicates the last page. Bogus cursors are silently treated as "no cursor" and return the first page.

Free-text fields are sanitized: control characters stripped, length capped at 2,000 chars per field (prompt-injection mitigation; see THREAT_MODEL.md §1).

## Auth model

Bearer token authentication via the `Bytescon_MCP_TOKEN` environment variable. At startup:

1. SHA-256 the raw token.
2. Look up the resulting hash in `api_tokens.tokenHash`.
3. Verify the row is not revoked and not expired.
4. Cache the resolved `consultingFirmId`, tier, and 16-char fingerprint for the process lifetime.
5. Exit non-zero on missing or invalid token.

Stdio is single-user single-tenant by design; one process serves one consulting firm and resolves its token once at startup.

The HTTP transport instead resolves a Bearer token on **every** request, so one server serves many tenants. As of v0.4 that Bearer token may be either a raw `api_tokens` value (unchanged) or an OAuth 2.1 access token issued by the server's own embedded authorization server, which lets Claude's web/remote connector sign in without a manually pasted token in the host config. OAuth is opt-in per deployment and fully backward compatible — see **[OAUTH.md](./OAUTH.md)** for the full design, the discovery endpoints, and the env vars (`MCP_OAUTH_SIGNING_KEY`, `MCP_PUBLIC_BASE_URL`). When `MCP_OAUTH_SIGNING_KEY` is unset the OAuth layer is inert and the HTTP server behaves exactly as it did in v0.3.

## Audit behavior

Every tool invocation writes exactly one row to `mcp_audit_log` with:

- `server_name`, `server_version`, `tool_name`
- `tenant_id` (the resolved `consultingFirmId`)
- `token_fp` (first 16 hex chars of SHA-256(token); never the token itself)
- `input_hash` (SHA-256 of canonicalized input JSON; sorted keys, recursive)
- `output_bytes`, `duration_ms`
- `outcome`: `ok`, `tool_error`, `auth_error`, `rate_limited`
- `correlation_id` (UUID per invocation)

Audit failures on the success path throw and propagate. Audit failures on an already-failing tool call are swallowed to avoid masking the original error.

## Local setup (Linux/Mac/WSL)

```bash
cd /path/to/govcon/app/mcp/opportunity-mcp
npm install
npm run prisma:generate
cp .env.example .env
# edit .env: set DATABASE_URL and Bytescon_MCP_TOKEN
npm run build
npm run start:stdio
```

## Local setup (Windows PowerShell)

```powershell
cd C:\path\to\govcon\app\mcp\opportunity-mcp
npm install
npm run prisma:generate
Copy-Item .env.example .env
# edit .env: set DATABASE_URL and Bytescon_MCP_TOKEN
npm run build
npm run start:stdio
```

## Minting a token

Use the typed mint script — it generates 256 bits of entropy, hashes correctly for the runtime resolver, and prints the raw token exactly once.

```bash
DATABASE_URL="postgresql://..." \
npm run mint-token -- \
  --firm-id <consulting_firm_uuid> \
  --name "Acme MCP demo" \
  --tier CORE \
  --expires-in-days 90
```

Output:

```json
{
  "tokenId": "...",
  "firmId": "...",
  "firmName": "Acme Corp",
  "tokenName": "Acme MCP demo",
  "tier": "CORE",
  "createdAt": "2026-05-28T...",
  "expiresAt": "2026-08-26T...",
  "rawToken": "L4yqUrv0jYgpssPLHuXIwxgK_zAjhfA0vftuLRGPXvE",
  "hint": "Save this raw token NOW — the server stores only the hash."
}
```

Set `Bytescon_MCP_TOKEN` in the MCP host config to the `rawToken` value.

> The direct-SQL recipe from v0.1/v0.2 is deprecated. Use the mint script — it matches the runtime's hash function exactly and avoids accidental tier/expiry typos.

## Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "opportunity-mcp": {
      "command": "node",
      "args": ["/path/to/govcon/app/mcp/opportunity-mcp/dist/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://bytescon_user:<password>@localhost:5432/bytescon_platform",
        "Bytescon_MCP_TOKEN": "<raw-token-from-mint-script>",
        "NODE_ENV": "production",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

## Running tests

Tests run against whatever `DATABASE_URL` points at (isolated `bytescon_test` DB,
or the shared dev DB during suite-wide builds). The original fixtures prefix
every row with `mcp-test-<runid>-`; the v0.3 fixtures (`tests/fixtures-v03.ts`)
prefix with `opportunity-mcp-test-<runid>-` so parallel test runs from sibling
MCP servers on a shared database never collide. Both clean up in `afterAll`.

```bash
# One-time: create the test DB and push schema
docker exec bytescon_postgres psql -U bytescon_user -d bytescon_platform \
  -c "CREATE DATABASE bytescon_test;"
DATABASE_URL="postgresql://...@.../bytescon_test" \
  npx prisma db push --schema=../../backend/prisma/schema.prisma --skip-generate

# Run the suite
DATABASE_URL="postgresql://...@.../bytescon_test" npm test
```

Tests skip integration cases cleanly if `DATABASE_URL` is unset, so unit tests still run in CI without a live database.

## Version history

| Version | Date | Notes |
|---|---|---|
| 0.1.0 | 2026-05-24 | Initial stdio release. One tool. Bearer auth. |
| 0.2.0 | 2026-05-27 | +4 tools: `get_opportunity_detail`, `get_bid_decision`, `list_compliance_gaps`, `lookup_recipient`. |
| 0.3.0 | 2026-05-28 | +3 tools: `list_clients`, `get_pipeline_summary`, `get_market_trends`. Cursor pagination on `search_opportunities`. `mint-token` script. Integration tests against isolated `bytescon_test` DB (34/34 passing). |
| 0.3.0 (suite update) | 2026-06-11 | +3 tools: `forecast_revenue`, `list_set_asides`, `list_agencies_by_naics` (11 total). Registered on both stdio and HTTP transports. Suite now 62/62 tests. Version stays 0.3.0: the v0.2 suite design targeted 0.3.0 as the shipped version for the 11-tool server. |
| 0.4.0 | 2026-06-13 | Embedded OAuth 2.1 authorization server on the HTTP transport (RFC 9728 / 8414 / 7591 + PKCE S256) so Claude's web/remote connector can sign in by pasting its Bytescon API token. Stateless signed-JWT clients/codes/tokens; no new database tables. Raw Bearer tokens still work unchanged; OAuth is inert without `MCP_OAUTH_SIGNING_KEY`. Redirect-host allowlist, refresh-token rotation, RFC 8707 `invalid_target`, and fail-closed prod base URL added in the adversarial-review pass. Suite now 104/104 tests. See OAUTH.md. |
| 0.4.0 (suite update) | 2026-06-26 | +2 tools: `list_past_performance`, `get_past_performance_detail` (13 total), exposing the firm's structured past-performance records (`past_performance_records`) tenant-scoped. Registered on stdio, HTTP, and the gateway resource. Exceeds the prior 12-tool soft cap. |

## Known limitations

- HTTP transport supports per-request bearer auth and (as of v0.4) an embedded OAuth 2.1 / PKCE authorization server; see OAUTH.md. The OAuth consent model is paste-your-api-token, not a full federated IdP login.
- No rate limiting yet. Tier-based limits land with the HTTP hardening pass.
- Response cap: 8 KB warning, 32 KB hard ceiling on `search_opportunities`; per-tool ceilings on the others (8-16 KB).
- `get_market_trends` and `list_agencies_by_naics` read the tenant's matching opps into memory before grouping; switch to SQL aggregates when any tenant exceeds ~50k matching rows.
- `forecast_revenue` is Monte Carlo and therefore non-deterministic run to run (percentiles move a few percent at 1,000 simulations). It duplicates the backend forecaster's model constants; keep the two in sync when the model changes (see the build note above).
- Demo capture (`demo.mp4`) is a manual follow-up; not produced by automated build.
- The suite now exposes 13 tools, past the earlier 12-tool soft cap. The cap is a documentation guideline only (not enforced in code); revisit it if any MCP host starts truncating the advertised tool list.
