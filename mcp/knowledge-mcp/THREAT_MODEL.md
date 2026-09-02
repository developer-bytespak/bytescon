# knowledge-mcp v0.1 Threat Model

Threat surfaces specific to this server and the mitigations applied.
Adapted from opportunity-mcp's threat model (same suite contract,
CLAUDE.md section 6.3); per-server notes called out below.

## Trust boundaries

| Boundary | Trusted side | Untrusted side |
|---|---|---|
| MCP transport | this server process | host LLM (Claude Desktop, etc.) and any client invoking it |
| Database | this server process | none (read-only on far_clauses, dfars_clauses, agency_award_profiles, opportunities aggregate; append-only on mcp_audit_log) |
| Tool output | this server process | the calling LLM that receives the text |

The host LLM is treated as semi-trusted: it cannot mint tokens or escalate
scope, but it may pass adversarial inputs or chain tool outputs back into
prompts that affect other tools.

## Threats and mitigations

### 1. Prompt injection via catalog or profile content

**Threat.** Free-text fields (clause title, summary, text, agency names)
could carry adversarial strings. Per-server note: the clause catalog is
seeded from in-repo data reviewed at PR time, so the injection risk is
lower than for SAM.gov-ingested opportunity text, but the agency aggregate
touches `opportunities.agency` which IS externally ingested.

**Mitigation.**
- All free-text fields pass through the shared `sanitize()` (control-char
  strip, per-field length cap).
- Tool output is a JSON envelope, consumed as data, not prose instructions.
- Response caps: 8 KB default warn, 32 KB hard error (shared
  `capJsonResponse`).
- The NAICS aggregate returns only codes and counts, never free text from
  opportunity rows.

### 2. Tool poisoning

**Threat.** Runtime modification of tool descriptions or schemas to trick
the host LLM.

**Mitigation.** Tool names, descriptions, and Zod schemas are static,
committed to git, registered once at boot via `@bytescon/mcp-shared`
`registerTool`. No dynamic tool registration; nothing loaded from
user-controlled storage.

### 3. Confused deputy

**Threat.** The server runs with database credentials; a request could try
to induce out-of-scope reads or writes.

**Mitigation.**
- Only read paths exist for catalog/profile/aggregate data; the only write
  is the audit append.
- The server has only the rights of its bearer token; no platform-admin
  path.
- Per-server note: catalog tables are global by design (no tenant column
  in schema.prisma), so "scope" here means table allowlist, enforced by
  the typed `KnowledgePrismaClient` view which exposes exactly the reads
  this server needs.

### 4. Cross-tenant leakage

**Threat.** The NAICS aggregate runs over the all-tenant opportunity pool;
a bug could expose another tenant's rows.

**Mitigation.**
- The aggregate projects ONLY `naicsCode` and a count (groupBy), never
  ids, titles, descriptions, or values.
- Mandatory test (`tests/retrieve-agency-pattern.test.ts`) seeds tenant
  opportunities with secret titles and asserts the response contains
  neither the titles nor the ids, and that result rows carry exactly the
  keys `naics` and `opportunity_count`.
- Every call still requires a valid resolved token
  (`tests/auth-and-audit.test.ts`).

### 5. Token exfiltration via logs

**Threat.** Bearer token leaking into logs or audit rows.

**Mitigation.** The logger never receives the raw token; only the 16-char
SHA-256 fingerprint reaches log/audit subsystems (shared auth helper).
`.env` is git-ignored; `.env.example` ships placeholders only. Tests
assert the audit row carries the fingerprint, not the raw token.

### 6. Untrusted upstream MCP servers

**Threat.** Chaining to a third-party MCP server returning adversarial
data.

**Mitigation.** This server consumes no third-party MCP servers and no
external APIs; only the in-house Postgres database. Any future upstream
requires sandboxing plus allowlist per CLAUDE.md section 6.3.

### 7. Audit-log tampering

**Threat.** Attacker modifies or deletes audit rows to hide activity.

**Mitigation.** Append-only at the application layer; success-path audit
failures throw immediately. Database-role enforcement (deny
UPDATE/DELETE) is suite v0.2 work. Retention per CLAUDE.md section 6.4.

### 8. Replay / token theft

**Threat.** Stolen bearer token replayed elsewhere.

**Mitigation.** Tokens are revocable (`revokedAt`) and expirable
(`expiresAt`), both checked on every resolve; 90-day rotation cadence;
fingerprint in audit enables after-the-fact correlation. Tests cover
revoked and unknown token rejection.

### 9. Seed-data integrity (per-server)

**Threat.** Fabricated or tampered clause content presented as regulation.

**Mitigation.** `scripts/seed-clause-catalog.sql` is generated only from
in-repo reviewed sources (backend seed JSONs plus CLAUSE_LIBRARY); no
clause text is generated from model memory. The `text` column carries an
explicit summary-level marker, and tools emit a `data_completeness` note
directing users to acquisition.gov for authoritative wording.

## Known unaddressed risks (v0.1)

| Risk | Plan |
|---|---|
| No per-tenant rate limiting | suite v0.2: sliding-window counters in Redis |
| No database-level role enforcement on mcp_audit_log | suite v0.2: split DB roles, deny UPDATE/DELETE |
| stdio transport keeps token in process env | acceptable for v0.1 local use; HTTP/OAuth in v0.2 |
| Test DB shared with dev DB | suite v0.2: dedicated test DB in CI |
| Catalog covers 69 clauses, not the full corpus | full-text ingestion pipeline is future work |

## Sign-off

- v0.1: built 2026-06-11 on branch feat/mcp-suite-v0.2. Self-reviewed.
- Production sign-off: pending John per CLAUDE.md section 8.2.
