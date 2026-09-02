# bytescon-core-mcp v0.1.0, Threat Model

Threat surfaces specific to this server and the mitigations applied. Adapted
from the opportunity-mcp threat model (same six core threats plus audit and
replay), with per-server notes for the tenant core-data domain. References
CLAUDE.md section 6.3.

## Trust boundaries

| Boundary | Trusted side | Untrusted side |
|---|---|---|
| MCP transport | this server process | host LLM (Claude Desktop, etc.) and any client invoking it |
| Database | this server process | none (read-only on core tables, append-only on mcp_audit_log) |
| Tool output | this server process | the calling LLM that receives the text |

The host LLM is semi-trusted: it cannot mint tokens or escalate scope, but it
may pass adversarial inputs or chain tool outputs back into prompts.

This server handles HIGHER-SENSITIVITY data than opportunity-mcp: personnel
records (names, roles, optionally emails), billing state, and spend data.
That is why the whole server sits behind the PRO tier gate.

## Threats and mitigations

### 1. Prompt injection via stored content

**Threat.** Free-text fields on document_requirements (title, description),
subscription_plans (name), users (names, role), and api_usage_logs (provider)
can contain attacker-influenced strings.

**Mitigation.**
- All free-text fields pass through the shared `sanitize()` (strip control
  chars 0x00-0x1F and 0x7F, cap field length).
- Output is a JSON envelope, consumed as data, not prose instructions.
- Response caps (8 KB default, 32 KB hard) limit blast radius.

### 2. Tool poisoning

**Threat.** Runtime modification of tool descriptions or schemas to trick the
host LLM.

**Mitigation.** Descriptions and Zod schemas are static, committed to git,
reviewed at PR. No dynamic tool registration; nothing loaded from
user-controlled storage.

### 3. Confused deputy

**Threat.** Escalation through the server's DB credentials: cross-tenant
reads or out-of-scope writes.

**Mitigation.**
- The server holds only the rights of its bearer token, resolved once at boot
  to exactly one `consultingFirmId`.
- Every query filters by `consultingFirmId` from the resolved context as the
  first WHERE clause; tool arguments can never supply a tenant id.
- The model surface in `src/lib/db.ts` exposes only read methods (findMany,
  findUnique, findFirst, count, groupBy); there is no code path that writes a
  business table.

### 4. Cross-tenant leakage

**Threat.** A WHERE-clause bug exposes another firm's deliverables, billing,
usage, or staff roster.

**Mitigation.**
- Tenant filter first in every `where` object.
- Mandatory two-firm isolation tests (`tests/tenant-isolation.test.ts`) cover
  all four tools, including the attempt to pivot through another tenant's
  `client_company_id` filter value.
- Future suite-wide ESLint rule for consultingFirmId in mcp/ queries remains
  v0.2 work.

### 5. PII over-exposure (server-specific)

**Threat.** User emails and personnel data leaking to a host LLM that does
not need them.

**Mitigation.**
- Emails are EXCLUDED from `list_users` output by default; the
  `include_emails` flag is tier-gated PRO+ and the omission is asserted by a
  dedicated privacy test (field absent, not null).
- passwordHash, email verification state, and reset-token relations are never
  selected.
- Billing output never includes Stripe customer or subscription ids, nor any
  payment-method data; there are no Stripe API calls at all.

### 6. Token exfiltration via logs

**Threat.** Bearer token leaking into log output or audit rows.

**Mitigation.**
- The raw token never reaches the logger or the audit writer; only the
  16-char fingerprint of its SHA-256 hash does.
- `.env` is git-ignored; `.env.example` ships placeholders only.

### 7. Audit-log tampering

**Threat.** Modifying or deleting audit rows to hide activity.

**Mitigation.**
- Append-only at the application layer; DB-role enforcement (REVOKE
  UPDATE/DELETE) is v0.2 suite work.
- Success-path audit failures throw immediately; error-path audit failures
  are logged without masking the tool error.

### 8. Replay / token theft

**Threat.** A stolen PRO/VAULT token replayed elsewhere. Higher impact here
than on opportunity-mcp because this server exposes personnel and billing
data.

**Mitigation.**
- Tokens are revocable (`revokedAt`) and expirable (`expiresAt`), checked on
  every resolve; rotation cadence 90 days per CLAUDE.md section 6.1.
- Tier gate enforced at boot AND per call, so a downgraded (re-minted CORE)
  token loses access without a server restart on the call path.
- Token fingerprint in every audit row enables after-the-fact correlation.

## Known unaddressed risks (v0.1)

| Risk | Plan |
|---|---|
| No per-tenant rate limiting | v0.2: Redis sliding-window counters per tier |
| No DB-role enforcement on mcp_audit_log | v0.2: audit-writer role, REVOKE UPDATE/DELETE |
| stdio keeps token in process env | acceptable v0.1 single-user; HTTP/OAuth in v0.2 |
| Test DB shared with dev DB | v0.2: dedicated test DB in CI |
| No write tools, so no HITL gates yet | any future write tool requires the spec section 6.5 interrupt flow before shipping |

## Sign-off

- v0.1.0: built 2026-06-11 as MCP suite v0.2 workstream 5. Self-reviewed;
  47 tests green including tenant isolation, tier gate, audit, and privacy
  assertions.
- Production sign-off: pending John per CLAUDE.md section 8.2.
