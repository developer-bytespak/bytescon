# opportunity-mcp v0.1 — Threat Model

Threat surfaces specific to this server and the mitigations applied. References CLAUDE.md §6.3.

## Trust boundaries

| Boundary | Trusted side | Untrusted side |
|---|---|---|
| MCP transport | this server process | host LLM (Claude Desktop, etc.) and any client invoking it |
| Database | this server process | none (read-only on opportunities, append-only on mcp_audit_log) |
| Tool output | this server process | the calling LLM that receives the text |

The host LLM is treated as semi-trusted: it cannot mint tokens or escalate scope, but it may pass adversarial inputs (prompt injection bait) or chain tool outputs back into prompts that affect other tools.

## Threats and mitigations

### 1. Prompt injection via opportunity content

**Threat.** Free-text fields on `opportunities` (title, description, agency) can contain attacker-controlled strings (e.g., a SAM.gov notice intentionally crafted to override the host LLM's instructions when read aloud).

**Mitigation.**
- All free-text fields passed through `sanitize()` in `tools/search-opportunities.ts`: strip control characters, cap at 2,000 chars per field.
- Tool output is wrapped in a JSON envelope, not embedded as raw prose, so the host LLM consumes it as data rather than instructions.
- Response cap of 8 KB default, 32 KB hard ceiling, limits blast radius.

### 2. Tool poisoning

**Threat.** A malicious actor modifying the tool description or schema at runtime to trick the host LLM into invoking it with sensitive data.

**Mitigation.**
- Tool description and schema are static, declared in `tools/search-opportunities.ts` and `schemas/search-opportunities.ts`, committed to git, reviewed at PR.
- No dynamic tool registration. No tool descriptions loaded from user-controlled storage.

### 3. Confused deputy

**Threat.** The MCP server runs with database credentials. A request could attempt to escalate by influencing the server to perform writes outside its declared scope, or read across tenants.

**Mitigation.**
- The server has only the rights of its bearer token. No platform-admin path.
- Every Prisma query in this server filters by `consultingFirmId: ctx.consultingFirmId` where `ctx` is resolved once at startup from the bearer token.
- The bearer token resolves to exactly one tenant; switching tenants requires a different token in a different process.

### 4. Cross-tenant leakage

**Threat.** A bug in the WHERE clause exposes another tenant's opportunities.

**Mitigation.**
- Tenant filter is the first clause in every `where` object.
- Mandatory integration test (`tests/tenant-isolation.test.ts`) calls the handler with Tenant A's token and asserts zero rows from Tenant B's opportunities.
- A future ESLint rule rejects raw Prisma queries in `mcp/` that do not reference `consultingFirmId` (CLAUDE.md §6.3 row "Cross-tenant leakage"). Tracked as v0.2 work.

### 5. Token exfiltration via logs

**Threat.** Bearer token leaking into log output or audit rows.

**Mitigation.**
- Logger never receives the raw token. The startup path passes only `tokenFp` (16 hex chars of SHA-256(token)) to log/audit subsystems.
- Audit row stores `tokenFp` only.
- `.env` is git-ignored. `.env.example` ships placeholder only.

### 6. Untrusted upstream MCP servers

**Threat.** This server depends on or chains to a third-party MCP server that returns adversarial data.

**Mitigation.**
- This server consumes no third-party MCP servers. Only consumes the in-house Postgres database.
- If a future tool needs a third-party MCP, sandboxing + allowlist required per CLAUDE.md §6.3.

### 7. Audit-log tampering

**Threat.** Attacker modifies or deletes audit rows to hide activity.

**Mitigation.**
- Table is append-only at the application layer. Updates and deletes are blocked at the database role level (v0.2 work — currently relies on application-level discipline).
- Audit write failures on the success path throw, surfacing the issue immediately.
- Retention: 18 months online, then cold storage (CLAUDE.md §6.4).

### 8. Replay / token theft

**Threat.** Stolen bearer token replayed against a different host.

**Mitigation.**
- Tokens are revocable (set `revokedAt` in `api_tokens`).
- Tokens are expirable (`expiresAt` checked on every resolve).
- Rotation cadence: 90 days per CLAUDE.md §6.1.
- Token never logged. Token fingerprint in audit makes after-the-fact correlation possible.

## Known unaddressed risks (v0.1)

| Risk | Plan |
|---|---|
| No per-tenant rate limiting | v0.2: sliding-window counters in Redis (CLAUDE.md §6.2 tier caps) |
| No database-level role enforcement on `mcp_audit_log` | v0.2: split DB roles, deny UPDATE/DELETE on audit table |
| stdio transport keeps token in process env, readable by other local processes with same user | acceptable for v0.1 single-user demo; HTTP/OAuth in v0.2 |
| Test DB is shared with dev DB | v0.2: dedicated test DB in CI |

## Sign-off

- v0.1: built 2026-05-24, T-8 to VETS26. Self-reviewed.
- Production sign-off: pending John per CLAUDE.md §8.2 (no production ship before lifecycle day 61 without explicit approval; stdio demo is exempt).
