# Non-Functional Requirements

**Simple version:** Functional requirements say *what* the system does. Non-functional requirements say
*how well* it must do it — is it **safe**, **fast**, **reliable**, **private**, **easy to watch and fix**?

Status: ✅ in place · 🟡 partial · ⛔ missing.

---

## 1. Security — "Only the right people can see and do things"

| ID | Requirement | How it's done | Status |
|----|-------------|---------------|--------|
| NFR-SEC-1 | Strong sign-in tokens | JWT; production refuses to start with a default or short (<32 char) secret; 8-hour default expiry | ✅ |
| NFR-SEC-2 | Logged-out tokens stop working | Per-user "not valid before" cut-off in Redis | 🟡 fails **open** if Redis is down |
| NFR-SEC-3 | Two-factor sign-in | TOTP; secret encrypted; recovery codes hashed | ✅ opt-in |
| NFR-SEC-4 | Company single sign-on | OIDC; links by issuer+subject, not email alone | 🟡 not tested against a live identity provider |
| NFR-SEC-5 | Passwords stored safely | bcrypt | ✅ |
| NFR-SEC-6 | Sensitive fields encrypted at rest | AES-256-GCM field encryption for API keys, MFA secrets, integration tokens | 🟡 silently stores **plain text** if `FIELD_ENCRYPTION_KEY` is missing, and that variable is missing from the production template |
| NFR-SEC-7 | Least privilege | 7 roles, ~25 permissions; unknown role = no permissions; extra grants can only add | ✅ |
| NFR-SEC-8 | Separate identities | Firm, client-portal and partner-portal tokens are different classes and can't be swapped | ✅ (regression tested) |
| NFR-SEC-9 | Web hardening | Helmet (CSP + HSTS in production), CORS allow-list incl. verified custom domains | ✅ |
| NFR-SEC-10 | Abuse protection | Global rate limit (500 / 15 min default) + stricter limits on login, register, MFA, portals | 🟡 in-memory, so limits are per server instance |
| NFR-SEC-11 | Safe outbound calls | SSRF guard on firm-provided AI endpoints; host allow-list | ✅ |
| NFR-SEC-12 | Webhooks are genuine | Stripe raw-body signature check | ✅ |
| NFR-SEC-13 | Security regressions caught | Dedicated regression and "Section 8" audit test suites (IDOR, token class, tenant sentinel, agent boundary) | ✅ |
| NFR-SEC-14 | Dependency / vulnerability scanning in CI | — | ⛔ |
| NFR-SEC-15 | Certifications | SOC 2 and CMMC Level 2 mapping "in progress" per landing page | ⛔ roadmap |

## 2. Privacy & multi-tenancy — "Firms never see each other's data"

| ID | Requirement | Status |
|----|-------------|--------|
| NFR-TEN-1 | Every data query scoped to the firm (`consultingFirmId`). | ✅ |
| NFR-TEN-2 | AI response cache keys include the tenant, so cached answers can't leak. | ✅ (tested) |
| NFR-TEN-3 | Shared templates are anonymised and moderated before other firms see them. | ✅ |
| NFR-TEN-4 | Customer data is not used to train AI models (public promise). | ✅ policy |
| NFR-TEN-5 | MCP tools are tenant-scoped, size-capped, and audited by token fingerprint (not raw input). | ✅ |
| NFR-TEN-6 | General data-retention / PII purge policy. | ⛔ only subcontract-board data is purged |

## 3. Reliability — "It keeps working and doesn't lose things"

| ID | Requirement | Status |
|----|-------------|--------|
| NFR-REL-1 | Business events for agents are written in the same transaction as the business change (transactional outbox). | ✅ |
| NFR-REL-2 | Agent runs are idempotent (one run per agent per event/schedule slot). | ✅ |
| NFR-REL-3 | Failed jobs retry with backoff; dead events go to a dead-letter state. | ✅ |
| NFR-REL-4 | Stuck runs/documents are reaped automatically. | ✅ |
| NFR-REL-5 | Stripe webhooks are processed exactly once. | ✅ |
| NFR-REL-6 | AI outages fall back to another provider and alert the admin (max once / 30 min). | ✅ |
| NFR-REL-7 | Graceful shutdown on SIGTERM/SIGINT. | ✅ |
| NFR-REL-8 | Uploaded files survive restarts/redeploys. | ⛔ stored on local disk; object storage (S3/R2) not built |
| NFR-REL-9 | Database backups. | 🟡 relies on Neon in production; nightly backup script lives outside the repo and only reports a heartbeat |

## 4. Observability — "We can see when something breaks"

| ID | Requirement | Status |
|----|-------------|--------|
| NFR-OBS-1 | Structured logs (winston + HTTP logs). | ✅ |
| NFR-OBS-2 | Error tracking (Sentry backend + frontend). | ✅ when DSN set |
| NFR-OBS-3 | Metrics (Prometheus at `/api/metrics`, optional secret). | ✅ |
| NFR-OBS-4 | Dead-man's switch for 13 scheduled jobs + hourly watchdog. | ✅ |
| NFR-OBS-5 | Ops alerts by email/webhook/SMS, throttled. | ✅ |
| NFR-OBS-6 | Product analytics (PostHog). | ✅ when key set |
| NFR-OBS-7 | Health check endpoint (DB ping). | ✅ |

## 5. Performance & scalability — "It's quick, even with many users"

| ID | Requirement | Status |
|----|-------------|--------|
| NFR-PERF-1 | Heavy work runs in background queues (≈20 BullMQ queues), not in web requests. | ✅ |
| NFR-PERF-2 | AI answers cached 7 days in Redis when safe. | ✅ |
| NFR-PERF-3 | Cheap AI model for extraction tasks, premium model for writing. | ✅ |
| NFR-PERF-4 | Static assets cached 30 days; gzip; `index.html` never cached. | ✅ |
| NFR-PERF-5 | External APIs respected (SAM.gov daily budget, 2 s spacing, halt on 429). | ✅ |
| NFR-PERF-6 | Upload limit 50 MB; API timeouts 180 s through nginx. | ✅ |
| NFR-PERF-7 | Horizontal scaling of API instances. | 🟡 rate limits and some caches are per-instance |

## 6. Cost control — "AI bills don't explode"

| ID | Requirement | Status |
|----|-------------|--------|
| NFR-COST-1 | Every AI call logged with tokens and estimated cost. | ✅ |
| NFR-COST-2 | Per-run, per-schedule-period and per-plan AI limits checked **before** calling the provider. | ✅ |
| NFR-COST-3 | Per-tenant gross margin view for operators. | ✅ |
| NFR-COST-4 | Most agents use zero AI tokens (pure rules and math). | ✅ |

## 7. Trust & explainability — "It shows its work and never pretends"

| ID | Requirement | Status |
|----|-------------|--------|
| NFR-TRUST-1 | Scores show their factors and calibration source (RAW / CALIBRATED / FALLBACK). | ✅ |
| NFR-TRUST-2 | "Not enough data" is shown instead of a fake number. | ✅ |
| NFR-TRUST-3 | Humans approve every consequential action. | ✅ |
| NFR-TRUST-4 | Every mutating API call is audited; audit exportable. | ✅ |
| NFR-TRUST-5 | Human-verified agent output is never overwritten by an agent. | ✅ |

## 8. Compliance (legal/regulatory)

| ID | Requirement | Status |
|----|-------------|--------|
| NFR-LEG-1 | Versioned Terms of Service and Beta NDA acceptance. | ✅ (ToS v2.0, NDA v2.0) |
| NFR-LEG-2 | CAN-SPAM postal address and unsubscribe in emails. | ✅ |
| NFR-LEG-3 | DCAA-style timekeeping and incurred-cost evidence. | ✅ |

## 9. Usability & accessibility

| ID | Requirement | Status |
|----|-------------|--------|
| NFR-UX-1 | Accessibility lint rules (jsx-a11y). | ✅ |
| NFR-UX-2 | Works on phones for approvals (PWA). | ✅ |
| NFR-UX-3 | Dark theme with native dark form controls. | ✅ |
| NFR-UX-4 | Old URLs keep working (18 legacy redirects). | ✅ |

## 10. Maintainability

| ID | Requirement | Status |
|----|-------------|--------|
| NFR-MNT-1 | TypeScript type-check in CI for backend and frontend. | ✅ |
| NFR-MNT-2 | Automated tests (~206 backend, ~67 frontend, ~45 MCP test files). | ✅ |
| NFR-MNT-3 | Frontend lint with a warning ratchet (≤241). | ✅ |
| NFR-MNT-4 | Backend lint in CI. | ⛔ |
| NFR-MNT-5 | Test-coverage gate. | ⛔ configured but not enforced |
| NFR-MNT-6 | End-to-end browser tests. | ⛔ |
| NFR-MNT-7 | Clear commit messages. | ⛔ recent commits are "Last", "Add", "Push++" |
