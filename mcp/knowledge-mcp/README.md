# knowledge-mcp v0.1.0

Bytescon FAR/DFARS/agency compliance knowledge MCP server (stdio transport).

## Purpose

Read-only regulatory knowledge for the Bytescon suite: the platform's FAR
and DFARS clause catalogs (global tables `far_clauses` and `dfars_clauses`)
and agency award patterns (`agency_award_profiles` plus a counts-only NAICS
aggregate over the platform opportunity pool). The host LLM uses these tools
to ground compliance answers in catalog data instead of model memory.

Out of scope (proposal domain, see proposal-mcp): `far_clause_applicabilities`,
compliance matrices, and any tenant-scoped compliance tie-ins.

## Tools (4)

| Tool | Input | Output |
|---|---|---|
| `retrieve_far_clause` | `code` (for example `52.219-14`; `FAR ` prefix tolerated; partial codes allowed) | Full catalog row on exact match, otherwise up to 5 prefix/substring suggestions. Includes a `data_completeness` note when the stored text is summary-level. |
| `retrieve_dfars_clause` | `code` (for example `252.204-7012`; `DFARS ` prefix tolerated) | Same contract as `retrieve_far_clause` against `dfars_clauses` (narrower column set per schema). |
| `retrieve_agency_pattern` | `agency` (name or fragment, min 2 chars) | Up to 5 `agency_award_profiles` matches (avg award value, small business rate, SDVOSB rate, women owned rate, HUBZone rate, total awards, typical NAICS) plus top 10 NAICS by opportunity count. NAICS figures are global counts only, never tenant row content. |
| `search_clauses` | `keyword` (2-100 chars), `source` (`FAR` or `DFARS`, optional), `limit` (1-25, default 10) | Case-insensitive substring matches across code, title, summary, and text on both catalogs, with summary excerpts and tags. |

### Downscope decision: search_clauses replaces semantic_search

The suite spec named a `semantic_search` tool. v0.1 has no embedding
infrastructure (no vector store, no embedding model dependency is allowed by
the suite dependency rules), so this server deliberately ships ILIKE keyword
search instead. The tool description tells the host LLM it is substring
search. Semantic retrieval is future work that belongs alongside a real
embedding pipeline, not a hand-rolled approximation.

## Auth model

- Tier required: CORE (lowest). Any valid, unrevoked, unexpired
  `Bytescon_MCP_TOKEN` row in `api_tokens` works.
- The token is resolved once at process start (stdio model). Boot exits
  non-zero when the token is missing, invalid, revoked, expired, or below
  tier CORE.
- The catalog tables are global, but every tool call still re-checks the
  resolved context (`guardAuth`) before touching the database; malformed
  contexts produce a structured auth error and outcome `auth_error` in the
  audit log. Tests prove global reads are unreachable without a valid token.
- The raw token is never logged or persisted; only the 16-char SHA-256
  fingerprint appears in logs and audit rows.

## Audit behavior

Every tool invocation writes exactly one `mcp_audit_log` row (server_name
`knowledge-mcp`, server_version, tool_name, tenant_id, token_fp, input_hash,
output_bytes, duration_ms, outcome, correlation_id). Success-path audit
failures throw; error-path audit writes are best-effort so they never mask
the original tool error. Outcomes used: `ok`, `tool_error`, `auth_error`.

## Seed data

`far_clauses` and `dfars_clauses` ship empty. Seed them once per database:

```powershell
Get-Content scripts/seed-clause-catalog.sql -Raw |
  docker exec -i bytescon_postgres psql -U bytescon_user -d bytescon_platform
```

The seed is idempotent (ON CONFLICT DO NOTHING) and sourced ONLY from
in-repo data:

- `backend/prisma/seeds/far/clauses.json` (52 FAR clauses)
- `backend/prisma/seeds/far/dfars.json` (15 DFARS clauses)
- `backend/src/services/complianceGapAnalysis.ts` CLAUSE_LIBRARY (2 FAR
  clauses absent from the JSON catalog: 52.225-5 and 52.232-33, with
  plainLanguage mapped to summary)

Total: 54 FAR + 15 DFARS rows. No clause text is generated from model
memory; the `text` column carries the marker
`[Summary-level entry, full clause text not yet ingested]` and tools emit a
matching `data_completeness` note. Regenerate the SQL from the in-repo
sources with `npm run seed:generate`.

## Local setup

```powershell
npm install
npm run build
# seed the catalog (see above), then:
./scripts/smoke.ps1
```

Environment contract (see `.env.example`): `DATABASE_URL`,
`Bytescon_MCP_TOKEN`, `MCP_LOG_LEVEL`, `NODE_ENV`. The backend-generated
Prisma client is located automatically by `@bytescon/mcp-shared`; run
`npx prisma generate --schema=backend/prisma/schema.prisma` from the repo
root if it is missing, or set `Bytescon_PRISMA_CLIENT_PATH`.

### Claude Desktop / Claude Code config

```json
{
  "mcpServers": {
    "knowledge-mcp": {
      "command": "node",
      "args": ["C:\\Projects\\Gov-ConV2\\mcp\\knowledge-mcp\\dist\\server.js"],
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

## Tests

`npm test` (vitest). 50 tests: per-tool input validation (unit), handler
happy paths and suggestion/empty paths (integration against the seeded
catalog), the counts-only no-leak guarantee for agency patterns, audit row
assertions per tool, and the auth requirement tests (unknown/revoked/short
token rejection plus malformed-context refusal with `auth_error` outcome).
Integration tests run against the local dev database, skip cleanly when
`DATABASE_URL` is unset, prefix every fixture id with
`knowledge-mcp-test-<run id>-`, and clean up in afterAll. Catalog seed rows
are read but never modified.

## Build vs buy (2026-06-11)

Build. The clause catalog, its column semantics (set-aside triggers,
flow-down thresholds, blocking prerequisites), and the agency award
profiles are platform-proprietary tables already maintained in this repo;
no vendor MCP server exposes them. Off-the-shelf regulation search
products (for example acquisition.gov scrapers or commercial FAR APIs)
would add an external dependency without covering the platform-specific
applicability metadata this server exists to serve. Shared plumbing
(auth, audit, caps, bootstrap) is consumed from `@bytescon/mcp-shared`
rather than rebuilt.

## Version history

- 0.1.0 (2026-06-11): initial release. 4 tools, CORE tier, seed catalog
  script, 50 tests, smoke script.

## Known limitations

- Substring search only; no semantic search (downscope note above).
- Clause text is summary-level; full official text not yet ingested.
  Tools say so explicitly via `data_completeness`.
- Catalog coverage is the 69 clauses present in repo seed data, not the
  full FAR/DFARS corpus.
- stdio transport only; token resolved once per process (HTTP/OAuth is
  suite v0.2 work).
- No per-tenant rate limiting (suite v0.2).
- Tests share the dev database (dedicated test DB is suite v0.2 work).
