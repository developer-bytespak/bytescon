# Bytescon MCP Suite

Model Context Protocol servers that expose Bytescon intelligence to LLM hosts (Claude Desktop, Claude Code, Cursor, third-party agents).

This folder is **isolated** from `backend/` and `frontend/` per `CLAUDE.md` §2. Code here may import from the backend's Prisma client and shared utilities, but does not modify any backend route, service, or schema field. The two schema additions required by spec §6.4 (`mcp_audit_log`, `api_tokens`) are additive only and are documented in each server's README.

## Servers

| Name | Status | Transport | Tools (count) | Tier | Spec Reference |
|---|---|---|---|---|---|
| `opportunity-mcp` | v0.4.0 active | stdio, http | 14 (search, detail, bid decision, pipeline, market trends, clients, compliance gaps, recipient, revenue forecast, set-asides, agencies by NAICS, past performance list/detail, trigger enrichment) | core | CLAUDE.md §4.4 |
| `knowledge-mcp` | v0.1.0 active | stdio | 4 (FAR clause, DFARS clause, agency pattern, clause search) | core | CLAUDE.md §4.3 |
| `proposal-mcp` | v0.1.0 active | stdio | 5 (compliance matrix, matrix requirements, bid guidance, adherence score, pricing template) | core | CLAUDE.md §4.3 |
| `carrier-mcp` | v0.1.0 active | stdio | 3 (carrier lookup, compliance score, name search) | core | CLAUDE.md §4.3 |
| `bytescon-core-mcp` | v0.1.0 active | stdio | 4 (deliverables, billing status, usage summary, users) | pro | CLAUDE.md §4.3 |

Suite updated 2026-06-11: all five roadmap servers are now implemented. `mcp/shared/` hosts the
common plumbing (`@bytescon/mcp-shared`: auth, audit, sanitize, response caps, stdio bootstrap)
consumed by the four newer servers; `opportunity-mcp` predates it and migrates in a later pass.
Per-server tool lists, auth model, audit behavior, and known limitations live in each server's
README and THREAT_MODEL.

## Suite Contract

Every server obeys CLAUDE.md §4.1:

1. Stateless per call. State lives in Postgres or Redis.
2. Single responsibility per server. No cross-domain tools.
3. No tool count cap (owner decision 2026-07-03) — keep servers lean, but add tools as long as they operate without error.
4. Response cap: 8 KB default, 32 KB hard.
5. Independent semver.
6. Audit log on every tool call (table `mcp_audit_log`).
7. Tenant-scoped auth on every tool call.

## Known suite-wide limitations

1. **Validation-rejected calls now write an audit row.** (Fixed.) The MCP SDK validates
   tool input against the registered schema before the handler runs, so a call rejected at
   validation returns a structured error to the host. `@bytescon/mcp-shared` now wraps the
   server's tools/call handler (`installValidationAudit`, called from the stdio bootstrap and
   from opportunity-mcp's HTTP path) so that a validation-rejected call writes an
   `mcp_audit_log` row with status `validation_error` (tool name, `token_fp`, server
   name/version, latency; never the raw arguments) and the host still sees the same
   structured error. A valid call still produces exactly one row, and an audit-write failure
   never changes the host response. The advertised tool JSON schemas are unchanged.
2. **CI enforces `DATABASE_URL`.** DB-backed integration suites (tenant isolation, audit
   assertions) gate on `DATABASE_URL`. When `CI` is set and `DATABASE_URL` is missing the
   suites now fail loudly (naming the missing var) instead of skipping silently; locally they
   still skip but emit a visible warning. The `mcp` job in `.github/workflows/ci.yml` provides
   a Postgres service container and exports `DATABASE_URL`, so the suites run for real in CI.

## Canonical inventory

See `registry.json` for the machine-readable list. Update on every server add, version bump, or status change.
