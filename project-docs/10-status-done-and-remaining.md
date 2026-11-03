# Status: What Is Done and What Is Remaining

**Snapshot:** 2026-11-03, `main` @ `ed3c5eb`.

## Simple version

🏠 **The house is built and furnished.** Almost every room works. Before inviting lots of guests (real paying
customers at scale), a few things need finishing: a **safe storage room for files**, some **missing settings**
for the live server, a few **features that are switched off**, and some **notes that are out of date**.

---

## 1. Overall progress

| Area | Status |
|------|--------|
| Accounts, roles, MFA, SSO | ✅ Done (SSO not tested with a live identity provider) |
| Billing, plans, add-ons, tokens | ✅ Done |
| Discovery (federal, grants, civilian, state/local, commercial US) | ✅ Done |
| Scoring, calibration, backtest, decisions | ✅ Done (some improvements behind flags) |
| Pipeline, qualification, gate reviews | ✅ Done |
| Compliance matrix, clauses, amendments, registration | ✅ Done |
| Proposal, pricing, submission | ✅ Done |
| Teaming, partners, partner portal, e-sign | ✅ Done (e-sign needs DocuSign connected) |
| Contracts, ERP tools, finance, DCAA timekeeping | ✅ Done |
| CRM | ✅ Done |
| 9 AI agents + runtime ("Section 7") | ✅ Done |
| Enterprise features: invoicing, public API, SSO, permissions ("Section 8") | ✅ Done |
| MCP servers + gateway + OAuth | ✅ Done |
| Client portal, branding, custom domains | ✅ Done |
| Landing page, trust page, onboarding | ✅ Done |
| File storage for production | 🟡 Code done (bucket-backed); bucket not yet connected in production |
| Infrastructure as code / deploy pipeline | ⛔ Not done |

### Internal build-plan labels you will see in code comments

The spec documents themselves are **not in the repo**; only their numbers appear in comments.

| Label | Meaning | State |
|-------|---------|-------|
| Section 4 (#2–#6) | Hardening items | ✅ |
| Section 5 (Modules 2, 8, 9; §5.1, §5.2) | Core product: registration, contracts, finance, win-probability, pricing, pipeline | ✅ |
| Section 6 (§6.1–6.4) | Discovery & intelligence | ✅ |
| Section 7 (§7.0–7.9) | Agent runtime + 9 agents | ✅ |
| Section 8 (§8.1–8.5) | CRM follow-ups, invoicing, portal tokens, public API, SSO/permissions | ✅ |
| GB-101…107 | Drop-in modules (Matching v2, client notifications, prime directory, Agency View v2, onboarding, SAM description enrichment) | ✅ built; 101/102, 103, 105, 106 behind flags |
| FIX-1…6 | Fixes (honest fit score, MFA, lint burndown, COGS margin) | ✅ |
| SCW-1…6 | Subcontracting workflow | ✅ except SCW-5 (only v1) |
| "Piece 3" | Object storage | 🟡 code done, bucket not connected |

## 2. Completed recently (git history highlights)

- Initial full-stack port (2026-08-28) → MCP suite → CI green → new landing page and "Obsidian" theme.
- Switched email from Resend to **SendGrid**; persisted bearer token for cross-site production.
- **State & Municipal** module; multi-jurisdiction discovery; separate federal vs state pipelines.
- Real **Terms of Service v2.0** and **Beta NDA v2.0**.
- **Grants** Phase 2 application pipeline and Grants.gov filing path.
- **Civilian programs** (E-Rate, Rural Health).
- Penalty engine, client deliverables/documents, client portal, pricing PDF (late October).
- US commercial tender adapters (Delaware, LA RAMP, Montgomery County MD); international ones removed (2026-10-31).

### Agent reporting clean-up (committed 2026-11-03, `ed3c5eb`)
- Agent escalations scoped to the subject being viewed (contract, proposal, pursuit) instead of the whole firm; runtime escalations (budget exhausted, timed out) still shown.
- Compliance agent files event runs under the opportunity rather than replacing the firm-wide report.
- Event-triggered Finance/Intelligence runs **carry forward** sections they skipped instead of blanking them.
- Notifications page polls every 20 s; proposal-agent field names aligned with the backend (fixed a panel crash).
- Covered by new unit tests and a finance integration test. Full suites: backend 4,320/4,320, frontend 850/850 on Node 24.

## 3. Remaining work (prioritised)

### 📋 Owner to-do (deferred — "we will do it later")

| # | Task | Why | How |
|---|------|-----|-----|
| T1 | **Set up a Cloudflare R2 bucket for uploads** and add the `UPLOADS_S3_*` settings to Render `bytescon-api` | The code fix for lost uploads (R1) is live but does nothing until a bucket is connected; until then every restart still deletes uploaded files | Steps in [15-fix-report-uploaded-files-lost.md §5](15-fix-report-uploaded-files-lost.md#5-whats-needed-to-switch-it-on-in-production-owner-action). Choose AWS S3 instead if FedRAMP/CMMC hosting is on the near roadmap — the code works with either |
| T2 | **Add a Stripe test-mode secret key** (`sk_test_…`) to local `backend/.env` (never paste it in chat) | Lets the one-subscription billing change be checked end-to-end with fake cards; the code and automated tests are done | [16-billing-one-subscription.md §4](16-billing-one-subscription.md#4-verification-results-2026-11-03) |

### 🔴 Must do before real production

| # | Item | Why it matters | Where |
|---|------|----------------|-------|
| R1 | ~~Move uploads to object storage~~ ✅ code done 2026-11-03 — **still needs a bucket + `UPLOADS_S3_*` settings on Render** to take effect | Files were saved only to local disk; Render disks are wiped on restart → uploaded documents were lost | `backend/src/services/fileStorage.ts`; see [15-fix-report-uploaded-files-lost.md](15-fix-report-uploaded-files-lost.md) |
| R2 | **Add `FIELD_ENCRYPTION_KEY` to production** | Without it, sensitive fields are silently stored as plain text | `backend/src/utils/fieldCrypto.ts`, `.env.prod.example` |
| R3 | Add other missing prod settings: `OPS_HEARTBEAT_TOKEN`, `SENTRY_DSN`, `METRICS_SECRET`, `SAM_GOV_API_KEY`, `ALERT_*` | Monitoring and alerts silently off | `backend/.env.prod.example` |
| R4 | **Respect agent opt-in for event runs** | Website promises opt-in; event runs currently start for every firm | `services/agents/outbox.ts`, `dispatch.ts` |
| R5 | Backend Docker image: multi-stage, non-root, no dev dependencies; run migrations on deploy | Security and image size | `backend/Dockerfile` |

### 🟠 Should do soon

| # | Item | Where |
|---|------|-------|
| R6 | Shared Redis store for rate limits (so limits hold across instances) | `backend/src/server.ts`, route limiters |
| R7 | Decide fail-open vs fail-closed for token revocation when Redis is down | `services/tokenRevocation.ts` |
| R8 | Test SSO RS256/JWKS against a real identity provider | `services/sso/idTokenVerifier.ts` |
| R9 | SCW-5: SMS and weekly digest for subcontracting notifications | `services/scw/notifications.ts` |
| R10 | Unanet and Deltek accounting adapters (currently stubs) | `services/integrations/accounting/` |
| R11 | Commit IaC (`render.yaml`) and a deploy job in CI | repo root, `.github/workflows/` |
| R12 | ~~Add tests for carry-forward / status-subject~~ ✅ done in `ed3c5eb` | `services/agents/` |
| R12b | Frontend tests fail on Node 26 (`localStorage` built-in shadows jsdom in `authToken.test.ts`); pin Node 24 locally (`.nvmrc`) or fix the test setup | `frontend/src/lib/authToken.test.ts` |
| R12c | `intelligenceAgent.integration.test.ts` tenant-isolation test failed once under full-suite load, then passed 4 times — likely flaky | `services/agents/intelligence/` |
| R12d | ~~Subcontracting leads shared between firms~~ ✅ fixed 2026-11-03: lead id is unique per firm — see [17-subcontracting-leads-per-firm.md](17-subcontracting-leads-per-firm.md) | `prisma/schema.prisma`, `services/scw/subcontractLeads.ts` |
| R12e | **Agent event runs ignore firm settings:** besides opt-in (R4), they always use PROPOSE autonomy and default retries/timeout, and skip the firm's schedule token budget | `services/agents/outbox.ts` |
| R12f | **Proposal and Pricing agents miss two events:** they check entity types `'ExtractionJob'`/`'Amendment'`, but events carry `'SolicitationExtractionJob'`/`'AmendmentRevision'`, so those runs fall back to a firm-wide sweep | `proposal/proposalAgentHandler.ts:372`, `pricing/pricingAgentHandler.ts:98` |
| R12g | **Duplicate agent events on retries:** `BID_DECISION_RECORDED`, `PROPOSAL_SECTION_APPROVED`, `TIME_ENTRY_SUBMITTED` dedupe keys include `Date.now()` | `teamingEvents.ts:59`, `proposalEvents.ts:70`, `financeEvents.ts:111` |
| R12h | Possible double calibration if `ENABLE_PROBABILITY_CALIBRATION` is turned on (latent; flag off) | see `specs/scoring-and-win-probability.md` §10 |

More gaps (smaller) are listed at the end of each spec in [specs/](specs/README.md).

**Fixed 2026-11-04:** team members can be deactivated/reactivated; only active members use seats; a deactivated member's sessions end at once (B4) — see [18-remove-team-members.md](18-remove-team-members.md).

**Fixed 2026-11-03:** billing — base plan and add-ons are one Stripe subscription (one charge); a failed add-on charge no longer locks the account (B3); see [16-billing-one-subscription.md](16-billing-one-subscription.md).

**Fixed 2026-11-03:** the Qualification agent read stored win probabilities 100× too small (0.8 → 0.8%); see `specs/scoring-and-win-probability.md` §10.
| R13 | Data-retention and PII-deletion policy | new |

### 🟡 Nice to have / tidy-up

| # | Item |
|---|------|
| R14 | Backend lint in CI; enforce test coverage; dependency/security scanning; end-to-end browser tests |
| R15 | Decide on flags that are off by default: Matching v2, probability renormalisation, client match emails, numeric fit score, Agency View v2, Platform Onboarding |
| R16 | Winners Intel Phase 2B.5 (per-award UEI enrichment); BigQuery production service account (Phase 2) |
| R17 | Semantic (AI) search — today knowledge search is plain text matching, no embeddings |
| R18 | Real commit messages (recent ones are "Last", "Add", "Push++") |
| R19 | SOC 2 / CMMC Level 2 work (landing page says "in progress") |

### 📝 Documentation drift to fix

| Doc says | Reality |
|----------|---------|
| README: legal docs are placeholders | Real ToS v2.0 and NDA v2.0 exist |
| README: email via Resend | Email is SendGrid (some code comments still say Resend) |
| README: `frontend/.env.prod.example` | File does not exist |
| `mcp/README.md` / `registry.json`: carrier-mcp, 30 tools | No carrier-mcp exists; gateway serves 4 servers / 27 tools |
| Some MCP READMEs: "stdio only; HTTP/OAuth in v0.2" | HTTP + OAuth already work through the gateway |
| Settings has a "SAM.gov API key" section | Banner says SAM data is built in — check whether the setting is still needed |
| `brandedEmailTemplates.ts`: "Phase 4B will hook into sending" | Already wired into email sending |
| Feedback page mentions "investor-pitch traction snapshot" | Internal wording visible to customers |
| Code references `PROMPT.md`, `FIXES.md`, `docs/WHO_WINS_MODEL.md`, `.ai/WINNERS_INTEL_SPEC.md` | Not in the repo |

## 4. Numbers at a glance

| Thing | Count |
|-------|-------|
| Database models | 215 (131 enums) |
| Migrations | 6 |
| Backend source files / test files | ~447 / ~206 |
| Frontend source files / test files | ~212 / ~67 |
| MCP test files | ~45 |
| Frontend pages | ~90 |
| Background queues | ~20 |
| AI agents | 9 (+1 internal) |
| MCP tools | 27 |
| Discovery adapters | 20 |
| Commits | 46 (2026-08-28 → 2026-10-31) |
