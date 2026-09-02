# proposal-mcp v0.1 Threat Model

Threat surfaces specific to this server and the mitigations applied.
Adapted from opportunity-mcp's threat model; references CLAUDE.md section 6.3.

## Trust boundaries

| Boundary | Trusted side | Untrusted side |
|---|---|---|
| MCP transport | this server process | host LLM (Claude Desktop, etc.) and any client invoking it |
| Database | this server process | none (read-only on proposal tables, append-only on mcp_audit_log) |
| Tool output | this server process | the calling LLM that receives the text |

The host LLM is treated as semi-trusted: it cannot mint tokens or
escalate scope, but it may pass adversarial inputs (prompt injection
bait) or chain tool outputs back into prompts that affect other tools.

## Threats and mitigations

### 1. Prompt injection via proposal content

**Threat.** Free-text fields on matrix_requirements (section,
requirementText) and the JSON columns compliance_matrices.bidGuidanceJson
and adherence_scores.blockersJson contain text extracted from
solicitation documents and LLM pipeline output. A hostile solicitation
or poisoned upload could embed instructions aimed at the host LLM.

**Mitigation.**
- All free-text fields pass through the shared `sanitize()` (control
  character strip, per-field caps; requirement text capped at 300 chars
  in list output).
- JSON columns pass through `sanitizeJsonDeep()` (src/lib/sanitize-json.ts):
  every string leaf sanitized, recursion depth, array length, and object
  key count bounded.
- Tool output is wrapped in a JSON envelope, not embedded as raw prose.
- Response caps of 8 KB default and 32 KB hard limit blast radius.

### 2. Tool poisoning

**Threat.** A malicious actor modifying tool descriptions or schemas at
runtime to trick the host LLM.

**Mitigation.**
- Tool descriptions and schemas are static, declared in src/tools and
  src/schemas, committed to git, reviewed at PR.
- No dynamic tool registration; no descriptions loaded from
  user-controlled storage.

### 3. Confused deputy

**Threat.** The server runs with database credentials; a request could
try to escalate to writes outside the declared scope or reads across
tenants.

**Mitigation.**
- The server performs no domain writes at all. The pricing template
  generator is pure; the only write is the mcp_audit_log append.
- Every tenant-scoped Prisma query filters by
  `consultingFirmId: ctx.consultingFirmId`, resolved once at startup
  from the bearer token. Requirement queries scope through the parent
  matrix relation so the tenant filter is structurally always present.
- The bearer token resolves to exactly one tenant; switching tenants
  requires a different token in a different process.

### 4. Cross-tenant leakage

**Threat.** A bug in a WHERE clause exposes another tenant's compliance
matrix, bid guidance, or adherence data, all of which are
competition-sensitive.

**Mitigation.**
- Tenant filter is the first clause in every where object; opportunity
  ids supplied by the host are never treated as tenancy proof.
- Mandatory integration tests (tests/tenant-isolation.test.ts) seed two
  firms and assert zero cross-contamination through all five tools,
  including the pricing-template prefill path.
- The future suite-wide ESLint rule rejecting unscoped Prisma queries in
  mcp/ (tracked v0.2) covers this server too.

### 5. Token exfiltration via logs

**Threat.** Bearer token leaking into log output or audit rows.

**Mitigation.**
- The logger never receives the raw token; only the 16-hex-char
  fingerprint reaches log and audit subsystems (enforced in
  @bytescon/mcp-shared auth helpers).
- Audit rows store token_fp only; asserted by tests/audit-log.test.ts.
- .env is git-ignored; .env.example ships placeholders only.

### 6. Untrusted upstream MCP servers

**Threat.** This server depends on or chains to a third-party MCP server
returning adversarial data.

**Mitigation.**
- This server consumes no third-party MCP servers and no external APIs.
  Only the in-house Postgres database.
- If a future tool needs a third-party MCP, sandboxing plus allowlist
  required per CLAUDE.md section 6.3.

### 7. Audit-log tampering

**Threat.** Attacker modifies or deletes audit rows to hide activity.

**Mitigation.**
- Append-only at the application layer; database-role enforcement
  (REVOKE UPDATE/DELETE) is v0.2 suite work.
- Audit write failures on the success path throw, surfacing immediately;
  error-path audit failures are logged with both errors.

### 8. Replay / token theft

**Threat.** Stolen bearer token replayed against a different host.

**Mitigation.**
- Tokens are revocable (revokedAt) and expirable (expiresAt), both
  checked on every resolve.
- Rotation cadence 90 days per CLAUDE.md section 6.1.
- Token never logged; the fingerprint in audit rows enables
  after-the-fact correlation.

## Per-server notes

- bidGuidanceJson originates from the platform's LLM pipeline over
  solicitation text. It is double-untrusted (LLM output over untrusted
  input) and therefore always deep-sanitized; this server never feeds it
  back into any generation step.
- generate_pricing_template emits only deterministic placeholder
  structures and sanitized prefill fields; it cannot echo attacker
  content beyond the sanitized opportunity title and agency.

## Known unaddressed risks (v0.1)

| Risk | Plan |
|---|---|
| No per-tenant rate limiting | v0.2: sliding-window counters in Redis |
| No database-level role enforcement on mcp_audit_log | v0.2: split DB roles, deny UPDATE/DELETE |
| stdio transport keeps token in process env | acceptable v0.1 single-user; HTTP/OAuth in v0.2 |
| Test DB shared with dev DB | v0.2: dedicated test DB in CI |

## Sign-off

- v0.1: built 2026-06-11 on branch feat/mcp-suite-v0.2. Self-reviewed.
- Production sign-off: pending John per CLAUDE.md section 8.2 (no
  production ship before lifecycle day 61 without explicit approval;
  stdio use is exempt).
