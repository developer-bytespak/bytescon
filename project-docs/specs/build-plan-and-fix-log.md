# Build Plan and Fix Log — Decoder for Labels in Code Comments

**Purpose:** Code comments cite labels like `§6.2C`, `Section 5 Module 9`, `GB-104`, `FIX-1`, `SCW-4`, `P1-3` and `Phase 2B.6`. The documents that defined them (`FIXES.md`, `PROMPT.md`, `SUBCONTRACTING_WORKFLOW_SPEC.md`, `.ai/WINNERS_INTEL_SPEC.md`, an older numbered `CLAUDE.md`, and the section "briefs") were never committed. This file decodes each label scheme from the code that uses it, so you know what a label refers to and where its code lives.

**Status: as-built spec reconstructed from code on 2026-11-03; original lost. If this and the code disagree, the code wins.**

## Simple version

The original builder tagged each piece of work with a short code and wrote those codes into comments, but the lists explaining the codes are gone. This file rebuilds those lists by reading the code. There are several separate numbering schemes, and some reuse the same numbers for different things (for example, "§6.3" can mean a build-plan section or an old CLAUDE.md rule). For each label you get what it covers, the main files, and whether it is built, behind a flag, or only partly done. When a label is ambiguous, read the words next to it in the comment.

---

## 0. How widely each label is used

Counted with `grep -rF` over `backend/src`, `frontend/src` and `mcp` (excluding `node_modules`). Counts are lines; test files are included.

| Pattern | Lines | Files | Notes |
|---|---:|---:|---|
| `§` | 1090 | 476 | 1169 numbered `§N…` occurrences. The section 4–8 ranges dominate: §4.x 20, §5.x 110, §6.x 306, §7.x 375, §8.x 286 (by subsection, see section 4 of this doc) |
| `Section 4` | 34 | 29 | Mostly "Section 4 #N" fix items |
| `Section 5` | 64 | 43 | Mostly "Section 5 Module N" |
| `Section 6` | 36 | 17 | Mostly `workers/section6Worker.ts` logs and "Section 6 weight" |
| `Section 7` | 31 | 21 | Agent runtime ("Section 7 is complete") |
| `Section 8` | 24 | 7 | Includes false positives "Section 889" (FAR) and "Section 8(a)" |
| `Module ` | 31 | 24 | Module 2, 8, 8D, 8E, 9 |
| `GB-10` | 118 | 62 | GB-101 … GB-107 |
| `FIX-` | 56 | 31 | FIX-1, 2, 3, 5, 6. **FIX-4 appears only in `frontend/.eslintrc.cjs`**, outside `src` |
| `SCW-` | 52 | 16 | See `subcontracting-workflow.md` |
| `Phase ` | 50 | 35 | Mixed: planning phases plus ordinary English ("Phase selection") |
| `P1-` | 33 | 22 | P1-1, P1-2, P1-2b, P1-3, P1-5 |
| `Piece ` | 0 | 0 | Not used. Only the field name `pieceOfTheActionId` (PIID) exists. |

Other document-qualified `§` references:

| Reference | Count | Meaning |
|---|---:|---|
| `CLAUDE.md §` | 26 | An **older numbered CLAUDE.md**. The current `CLAUDE.md` has no numbered sections (headings: Layout, Run locally, Test before committing, Rules, Git). |
| `spec §` | 28 | Mostly the SCW and Winners Intel specs |
| `SUBCONTRACTING_WORKFLOW_SPEC.md §` | 9 | |
| `PROMPT §` / `PROMPT.md §` | 4 + 4 | |
| `FIXES.md` | 12 | Plus the bare `FIX-N` labels |
| `WINNERS_INTEL_SPEC` | 0 in `src` | 1 in `backend/prisma/schema.prisma` |

**Collision warning.** Bare `§5.2`, `§6.1`, `§6.3`, `§6.4`, `§7.2`, `§7.3` and `§8.2` each belong to more than one scheme: the build plan, old CLAUDE.md rules, PROMPT.md, the SCW spec, and the Winners Intel spec. Use the words around the label:
- "CLAUDE.md §6.3" = an old tenant-isolation / input-sanitising rule.
- Plain "§6.3A" = build-plan Requirements Intelligence.
- "spec §7.3" in `winnersIntel/render.ts` = the Winners Intel 12K token cap.
- "§7.3" in agent code = the Compliance Agent.

---

## 1. Tables per scheme

### 1.1 Build plan sections (`§5`–`§8`, "Section N")

| Label | Covers | Main files | Status |
|---|---|---|---|
| Section 4 #2–#9 | A numbered fix list (see 1.2) | see 1.2 | Built |
| Section 5 Module 2/8/9 | Registration and certs; post-award contracts; contract finance | see 1.3 | Built |
| §5.1 Stage 1–10 | Capture lifecycle stages | see section 4 | Built (stages 1, 3, 4, 5, 6, 7, 10 cited; 2, 8, 9 never cited) |
| §5.2 | Bid/no-bid scorecard, gate reviews, notifications, proposal/pricing/past-performance workspaces | `routes/qualification.ts`, `routes/gateReviews.ts`, `routes/notifications.ts`, `services/scorecardScoring.ts` | Built |
| §6.1–§6.4 | Discovery, scoring intelligence, requirements intelligence, milestones | `routes/discovery.ts`, `routes/scoringIntel.ts`, `routes/requirementsIntel.ts`, `routes/milestones.ts`, `workers/section6Worker.ts`, `frontend/src/components/section6/` | Built |
| §7.0–§7.9 | Agent runtime plus nine domain agents | `backend/src/services/agents/` (`registry.ts`, `runService.ts`, `outbox.ts`, `scheduler.ts`, …), `frontend/src/components/section7/` | Built. Tests assert all 9 agents are `implemented` (`agentRuntime.unit.test.ts`). |
| §8 / §8.1–§8.5 | CRM, ERP/finance, partner portal, public API/knowledge, RBAC/SSO/integrations | `routes/crm.ts`, `routes/erp.ts`, `routes/partnerPortal.ts`, `routes/publicApi/v1.ts`, `routes/sso.ts`, `services/rbac/permissions.ts`, `backend/src/audit/section8*.test.ts` | Built (an "§8 FINAL ACCEPTANCE" audit suite exists) |

### 1.2 "Section 4 #N" (numbered fixes)

| Item | What it fixed | Files | Status |
|---|---|---|---|
| #1 | Not cited anywhere | — | Unknown |
| #2 | `GET /api/opportunities` hides seeded demo rows by default (`includeDemo=true` to show). Only render a government-source link when a valid external URL exists. | `backend/src/routes/opportunities.ts`, `frontend/src/lib/samUrl.ts`, `pages/OpportunityDetail.tsx` | Built |
| #3 | Shared progress UX for synchronous AI operations (Analyze Solicitation, Generate Outline) | `frontend/src/hooks/useAiJobProgress.ts`, `components/AiProgressIndicator.tsx` | Built |
| #4 | Compliance audit log records submission creation (atomic with the insert) and decisions | `routes/submissions.ts`, `routes/decision.ts`, `routes/pursuits.ts`, `services/complianceStateMachine.ts` | Built |
| #5 | Reap backtest runs orphaned in RUNNING; prune old runs | `workers/backtestReaper.ts`, `workers/opsWatchdogWorker.ts` | Built |
| #6 | Distinguish a calibration curve that is FITTED from one that is applied | `routes/backtest.ts`, `services/calibrationStatus.ts` | Built |
| #7 | Billing page must not show internal/config text when billing is unconfigured | `frontend/src/components/StripeCheckout.test.tsx` (test only) | Built (inferred from test) |
| #8 | "Log Submission" disabled until required dropdowns are populated | `frontend/src/pages/Submissions.tsx` | Built |
| #9 | Revenue forecast transforms never throw; the chart degrades gracefully | `frontend/src/lib/forecastChart.ts`, `components/charts/RevenueForecast.tsx` | Built |
| "Section 4 auth review" | Stop sending `Bearer null` (token read from the same storage key) | `frontend/src/lib/authToken.ts` | Built |

`frontend/src/pages/Rewards.tsx` has a JSX comment "Section 4: Rewards Ledger". That is a page section, not this scheme.

### 1.3 "Section 5 Module N"

| Module | Covers | Main files | Status |
|---|---|---|---|
| 2 | Registration / Certification / Insurance; expiry classification and health rollup | `routes/registration.ts`, `services/registrationHealth.ts`, `frontend/src/pages/Registration.tsx` | Built |
| 8 | Post-award contract management (Contracts page) | `routes/contractManagement.ts`, `frontend/src/pages/Contracts.tsx` | Built |
| 8D | Decimal-safe contract modification math | `services/contractModification.ts` | Built |
| 8E | Deliverable transition validation and derived OVERDUE | `services/deliverableStatus.ts` | Built |
| 9 | Contract finance: funding ledger, burn, timekeeping | `routes/contractFinance.ts`, `services/contractFinance.ts`, `frontend/src/components/ContractFinanceTab.tsx`, `pages/Timekeeping.tsx` | Built |

`services/setAsideEligibility.ts` also matches "Module". **(inferred)** That match is incidental.

### 1.4 GB-10x (see section 3)

| Label | Covers | Status |
|---|---|---|
| GB-101 / GB-102 | Matching v2 opportunity↔client scorer; PSC code | **Flagged** `MATCHING_V2_ENABLED` (default `0` in production, `1` elsewhere) |
| GB-103 | Client match notification emails | **Flagged** `CLIENT_NOTIFICATIONS_ENABLED` (default false) |
| GB-104 | Recipient email + verification gating for outreach | **Flagged** `SCW_EMAIL_ENRICHMENT_ENABLED` (default off) |
| GB-105 | Agency View v2 | **Flagged** `VITE_AGENCY_VIEW_V2_ENABLED` (frontend) |
| GB-106 | Platform and vehicle onboarding module | Built, mounted at `/api/onboarding` |
| GB-107 | SAM.gov description enrichment | Built; idles with no SAM key |

### 1.5 FIX-N (see section 2)

| Label | Covers | Status |
|---|---|---|
| FIX-1 | Honest 3-band fit score + outcome-logging flywheel | Built; numeric score flagged off |
| FIX-2 | Teaming partner CRM + graph ("the ownable moat") + partner recommender | Built |
| FIX-3 | MFA (TOTP), audit-log CSV export, public Trust & Security page | Built |
| FIX-4 | Frontend ESLint burndown | Partial (rule disabled; `--max-warnings=241`) |
| FIX-5 | Activation funnel, retention cohorts, north-star metric | Built (platform admin only) |
| FIX-6 | COGS gross margin + human-in-the-loop proposal attestation | Built |

### 1.6 SCW-N

Full detail is in `subcontracting-workflow.md`. Summary: SCW-1 likely primes (built), SCW-2 subaward analysis (built, partial data), SCW-3 contact switcher (**(inferred)**, not built), SCW-4 outreach drafts (built; approval never sends), SCW-5 in-app inbox (v1 only; SMS and digest not shipped), SCW-6 Subcontracting Path UI (built).

### 1.7 P1-N ("failure integrity": never fabricate a number)

| Label | Covers | Main files | Status |
|---|---|---|---|
| P1-1 | A failed computation is typed `status: 'FAILED'` and carries no number; it is excluded downstream | `engines/probabilityEngine.ts`, `workers/scoringWorker.ts`, `workers/enrichmentWorker.ts`, `types/index.ts` | Built |
| P1-2 | DB/query error is a real failure, not a neutral 0.5 agency score | `engines/agencyProfiler.ts`, `engines/competitiveDensity.ts` | Built |
| P1-2b | USAspending API/parse or count-query failure surfaces (BullMQ retries) instead of "no data" | `services/usaSpending.ts` | Built |
| P1-3 | Malformed AI response in document analysis throws instead of returning a 0.5 placeholder | `services/documentAnalysis.ts` | Built |
| P1-4 | Not cited anywhere | — | Unknown |
| P1-5 | Reap document jobs orphaned at `IN_PROGRESS`/`EXTRACTING` by a crash | `services/orphanRecovery.ts` (wired in `server.ts`) | Built |

### 1.8 "Phase …"

See section 5.

### 1.9 PROMPT.md references

| Ref | Meaning | File |
|---|---|---|
| PROMPT.md §2.2 | Federal-portal email aesthetic (navy chrome, gold) | `services/watchlistDigestEmail.ts` |
| PROMPT.md §6.2 | Probability fingerprint / anti-constant regression test | `engines/probabilityEngine.test.ts` |
| PROMPT.md §6.3 | ECE uses equal-mass binning by default | `services/backtest/metrics.ts` |
| PROMPT §7 | "Frozen surface" (the Stripe webhook is not modified) | `workers/stripeWebhookRotationReminderWorker.ts` |
| PROMPT §8.1 #8 | SAM.gov set-aside enum audit (`mapSetAside`) | `services/samApi.ts` |
| PROMPT §8.1 #10 | Stripe webhook secret rotation reminder worker | `workers/stripeWebhookRotationReminderWorker.ts` |

### 1.10 Old numbered CLAUDE.md references

| Ref | Meaning (from context) | Where |
|---|---|---|
| §4.1, §4.3, §4.4 | MCP server rules: registry table, auth via `api_tokens` | `mcp/README.md`, `mcp/opportunity-mcp/src/server.ts` |
| §5.2 | Not resolved from code | — |
| §5.3 | Required structured log fields (timestamp, level, service, …) | `mcp/opportunity-mcp/src/lib/logger.ts` |
| §6.1 | No fallback defaults in code for sensitive values | MCP token code |
| §6.2 | Not resolved from code | — |
| §6.3 | Cross-tenant leakage rule; strip control characters and cap input length | MCP tools, compliance agent |
| §6.4 | Retention rule | `mcp/` |
| §7.2 | Mandatory tenant-isolation test | tests |
| §8.2 | No production ship before lifecycle day 61 without explicit approval | `mcp/` |
| §12 | Not resolved from code | — |

**(inferred)** The current `CLAUDE.md` does not restate these rules.

---

## 2. FIX-1 … FIX-6

The source is `FIXES.md` (lost). Everything below is read from code.

### FIX-1 — Honest 3-band fit score + outcome-logging flywheel
- **Problem (from code comment):** the win probability "is NOT yet calibrated against real WON/LOST outcomes (calibration collapsed real scores to ~0 and is disabled)". A precise "72/100" implies accuracy the model has not earned.
- **Fix, part 1: 3-band signal.** `backend/src/utils/scoreTier.ts` `scoreTier()` returns:
  - `STRONG` if p ≥ 0.55;
  - `MODERATE` if p ≥ 0.30;
  - `WEAK` otherwise;
  - `UNSCORED` if null.
  The frontend mirror is `frontend/src/utils/fitTier.ts`. The raw number is gated by `SHOW_NUMERIC_FIT_SCORE` (`config.scoring.showNumericFitScore`, default **false**).
- **Fix, part 2: flywheel.**
  - `GET /api/submissions/pending-outcomes` (`routes/submissions.ts`) lists pursued bids past their deadline with no WON/LOST yet.
  - Logging the **first** outcome per submission grants `OUTCOME_LOGGING_REWARD_TOKENS` proposal tokens (`config.scoring.outcomeLoggingRewardTokens`, default **0**, i.e. off).
  - The nudge appears in `frontend/src/pages/Submissions.tsx`.
- Also cited by: the FIX-5 north-star metric (`routes/firm.ts`) and the teaming recommender's transparent breakdown (`routes/teaming.ts`).

### FIX-2 — Teaming Partner CRM + Graph ("the ownable moat")
- Activates the previously dormant `Partner` and `TeamingArrangement` models. The aim is to capture each firm's real teaming activity, which public award data cannot provide.
- `routes/teaming.ts` (`/api/teaming`, gated `teaming_suite`):
  - reads are open to any member; writes are ADMIN-only;
  - `GET /graph`: per-partner arrangements, role mix, agencies, teamed value, and win/loss joined to `SubmissionRecord.outcome`;
  - `GET /recommend/:opportunityId`: explainable partner ranking (NAICS 0–40, set-aside 0–25, capability 0–25, track record 0–10).
- Frontend: `frontend/src/pages/Teaming.tsx`, `components/TeamingRecommender.tsx`.

### FIX-3 — MFA (TOTP) and security artifacts
- `backend/src/services/mfaService.ts`: TOTP via `otpauth`, issuer `Bytescon`, SHA1, 6 digits, 30s period. The secret is encrypted at rest by the caller (`fieldCrypto`). Recovery codes are bcrypt-hashed. MFA is opt-in.
- Routes in `routes/auth.ts`:
  - `GET /mfa/status`;
  - `POST /mfa/enroll`, `/mfa/enroll/verify`, `/mfa/verify`, `/mfa/disable` (rate-limited where relevant; `rejectScopedToken`);
  - `POST /mfa/reset` (platform admin).
- "Quick win": `GET /api/firm/audit-log/export` (ADMIN), a CSV of the firm's audit trail.
- Public page `frontend/src/pages/TrustSecurity.tsx`. UI: `components/MfaSettings.tsx`.

### FIX-4 — ESLint burndown (frontend)
- The only reference is in `frontend/.eslintrc.cjs`. `react/no-unescaped-entities` "accounted for ~80 of the ~88 FIX-4 burndown errors" and was turned off "per owner (2026-07-03)".
- `@typescript-eslint/no-explicit-any` is off. `no-unused-vars` is a warning.
- `npm run lint` runs with `--max-warnings=241`, so a warnings budget remains.
- The backend has no ESLint config.
- **Status: partial.** The errors were cleared by disabling a rule, and the warnings were not burned down.

### FIX-5 — Activation funnel and retention
- `GET /api/firm/platform/funnel` (platform admin) in `routes/firm.ts`:
  - funnel: signed up → first opportunity scored → first bid decision → first proposal draft → first outcome logged;
  - signup-month retention cohorts (active in the last 30 days);
  - north star: outcomes logged per week over 8 weeks.
- It is derived from existing timestamps with no event table. Firms with `isTest` are excluded.
- UI: `frontend/src/pages/PlatformMetrics.tsx`. Test: `routes/firm.platformFunnel.test.ts`.

### FIX-6 — COGS margin + human-in-the-loop attestation
- **COGS:** `GET /api/firm/platform/cogs-margin` (platform admin; `?days` 1–90, default 30). It computes per-tenant gross margin as subscription revenue minus LLM cost from `api_usage_logs`, normalised to monthly. **LLM COGS only.** BigQuery and infrastructure costs are not included. UI: `frontend/src/pages/PlatformCogs.tsx`.
- **Attestation** (`services/proposalAttestation.ts`):
  - `PROPOSAL_ATTESTATION_VERSION = 'v1-2026-07'`, with a fixed responsibility statement.
  - A content hash pins the attestation to the exact draft, so regenerating the draft makes the attestation STALE.
  - Routes in `routes/proposalAssist.ts`: `GET /:opportunityId/attestation`, `POST /:opportunityId/attest`, `GET /:opportunityId/final-pdf` (the final export is gated on attestation).
  - Follow-up: per-section LLM self-rated confidence, with low-confidence sections flagged on DRAFT renders (`services/proposalDraftService.ts`, `services/proposalPdfBuilder.ts`). UI: `components/ProposalAttestationPanel.tsx`.

---

## 3. GB-101 … GB-107

| Label | Count | What it is | Main files | Gate / status |
|---|---:|---|---|---|
| GB-101 | 6 | Matching v2: corrected opportunity↔client relevance/fit scorer (`scoreOpportunityForClient`) | `engines/matchingV2.ts`, `services/opportunityMatcher.ts`, `config/config.ts` (`matching.v2Enabled`) | `MATCHING_V2_ENABLED`: default `'0'` in production, `'1'` otherwise |
| GB-102 | 6 | The PSC-code half of Matching v2. Agency View "top PSC" validates `pscCode` end to end. | `engines/matchingV2.ts`, `routes/agency.ts` | Same flag as GB-101 |
| GB-103 | 10 | Client match notification emails (service, renderer, BullMQ worker) with a CAN-SPAM footer address | `services/clientMatchNotificationService.ts`, `services/clientMatchNotificationEmail.ts`, `workers/clientMatchNotificationWorker.ts`, `routes/jobs.ts` | `CLIENT_NOTIFICATIONS_ENABLED` default false; `CAN_SPAM_POSTAL_ADDRESS` |
| GB-104 | 17 | Recipient email + verification status for outreach. Only `verified` may auto-send; `probable`/`unknown` need a human. | `services/scw/recipientEmailResolver.ts`, `services/scw/outreachGenerator.ts`, `services/contactProviders/*`, `data/primeSbloDirectory.ts`, `frontend/src/components/scw/OutreachDraftModal.tsx` | `SCW_EMAIL_ENRICHMENT_ENABLED` default off. There is no send path at all. |
| GB-105 | 7 | Agency View v2: analytical drill-down profile | `routes/agency.ts`, `frontend/src/pages/AgencyView.tsx` | `VITE_AGENCY_VIEW_V2_ENABLED` |
| GB-106 | 32 | Platform and vehicle onboarding module (SAM, UEI, CAGE, VetCert, GSA MAS, OASIS+ …), scored and gated by prerequisites. The README says it was regenerated after the original zip was lost. | `backend/src/gb106/` (`mount.gb106.ts`, `logic/`, `services/`, `data/onboarding.seed.ts`, `DATA_SOURCES.md`), `middleware/onboardingTenant.ts`, `frontend/src/gb106/`, `pages/PlatformOnboarding.tsx` | Built. Mounted in `server.ts` at `/api/onboarding` behind `authenticateJWT`, `enforceTenantScope`, `resolveOnboardingTenant`. The frontend panel suggests `VITE_PLATFORM_ONBOARDING_ENABLED`. |
| GB-107 | 43 | SAM.gov `noticedesc` description enrichment: clause, evaluation-factor and requirement extraction into `ComplianceMatrix`/`MatrixRequirement`; Redis daily budget (default 900/day) | `backend/src/gb107/` (`mount.gb107.ts`, `enrichmentService.gb107.ts`, `samDescriptionClient.gb107.ts`, `matrixWriter.gb107.ts`, `rateLimiter.gb107.ts`, `config.gb107.ts`, `README.md`) | Built. Uses `SAM_GOV_API_KEY`, falling back to `SAM_API_KEY`. With no key it skips gracefully. |

---

## 4. Sections 4–8 subsection map

Counts are occurrences of `§N.N[X]` (exact subsection, not including children).

### §4 (13 bare, §4.1 ×1, §4.3 ×4, §4.4 ×2)
- Bare `§4` appears in agent code and tests: "§4 — the HTTP surface itself", "human-control guarantees… at PROPOSE and at ACT_WITH_GUARDRAILS", "§4/§6 — secure document download". **(inferred)** This is a per-brief "section 4" inside the Section 7 agent briefs (autonomy/human control), not a top-level build-plan section.
- `§4.1`, `§4.3` and `§4.4` are **old CLAUDE.md** MCP rules (see 1.10).

### §5 (23 bare)
| Sub | Count | Covers | Main files |
|---|---:|---|---|
| §5.1 Stage 1 | 3 | Saved monitoring profiles | `routes/monitoringProfiles.ts`, `services/opportunityFilters.ts`, `services/discovery/profileAlerts.ts` |
| §5.1 Stage 3 | 15 | Bid qualification, win probability with RAW/CALIBRATED/FALLBACK labelling, incumbent + competitor capture evidence | `routes/qualification.ts`, `routes/captureEvidence.ts`, `services/captureEvidence.ts`, `components/WinProbabilityPanel.tsx`, `pages/Qualification.tsx` |
| §5.1 Stage 4 | 8 | Teaming partner↔opportunity matching; agreement/NDA/workshare tracker and draft | `services/partnerMatch.ts`, `services/teamingAgreementDraft.ts`, `components/TeamingAgreements.tsx` |
| §5.1 Stage 5 | 4 | Proposal workspace, responsibility matrix, AI section drafting | `routes/proposal.ts`, `services/proposalSectionDraft.ts` |
| §5.1 Stage 6 | 5 | Pricing and rate build-up | `routes/pricing.ts`, `services/pricingCalc.ts` |
| §5.1 Stage 7 | 5 | Submission management and readiness | `routes/submissionWorkspace.ts`, `services/submissionReadiness.ts` |
| §5.1 Stage 10 | 5 | Past-performance library and relevance | `routes/pastPerformanceLibrary.ts`, `services/pastPerformanceRelevance.ts` |
| §5.2 | 33 | Bid/No-Bid scorecard, gate reviews, in-app notifications feed, plus the companion slices of stages 5/6/10 | `services/scorecardScoring.ts`, `routes/gateReviews.ts`, `services/gateReviewWorkflow.ts`, `routes/notifications.ts`, `services/notificationService.ts`, `routes/complianceMatrix.ts` |
| §5.3 | 1 | Old CLAUDE.md log-field rule | `mcp/opportunity-mcp/src/lib/logger.ts` |

Bare `§5` refers to "the §5 state machine" (idempotent same-status transitions) and to Submission Workspace validation. **(inferred)** This is Section 5's submission/compliance state machine.

### §6 (35 bare). Worker: `backend/src/workers/section6Worker.ts`. UI: `frontend/src/components/section6/`, `pages/Discovery.tsx`
| Sub | Count | Covers |
|---|---:|---|
| §6.1A | 26 | Official-feed source adapters (state/local, `OpportunitySourceConfig`) |
| §6.1B | 12 | Agency forecasts; ambiguous matches stay `REVIEW_REQUIRED` |
| §6.1C | 4 | Re-compete detection (`recompeteDetection.ts`) |
| §6.1D | 8 | Notice classification (pre-solicitation kinds) |
| §6.1E | 13 | Capability match (`capabilityMatch.ts`) |
| §6.1F | 10 | Set-aside eligibility (`setAsideEligibility.ts`) |
| §6.1G | 17 | Saved-profile alerts (`profileAlerts.ts`) |
| §6.1H | 2 | Opportunity Discovery page |
| §6.2A | 5 | Score factor breakdown / explanation (`scoreExplanation.ts`) |
| §6.2B | 5 | Per-contractor historical calibration (`tenantCalibration.ts`) |
| §6.2C | 10 | Incumbent retention ("no denominator, no percentage" rule) |
| §6.2D | 8 | Competitor mapping and its labelling rule (`evidenceStats.ts`, `awardHistoryAdapter.ts`) |
| §6.2E | 7 | Price sensitivity (`pricingSensitivity.ts`) |
| §6.2F | 6 | Capability gaps and partner recommendations (`capabilityGap.ts`) |
| §6.2G | 4 | Portfolio expected value (`portfolioValue.ts`) |
| §6.2H | 12 | Confidence intervals (`services/scoring/confidenceInterval.ts`) |
| §6.3A | 17 | Canonical requirements extraction (`routes/requirementsIntel.ts`) |
| §6.3B | 3 | Section L↔M mapping (`lmMapping.ts`) |
| §6.3C | 2 | Clause obligations ("not legal advice") |
| §6.3D | 5 | Standing document library (`standingDocuments.ts`, `DocumentLibrary.tsx`) |
| §6.3E | 4 | Pre-submission validation (`preSubmissionValidation.ts`) |
| §6.3F | 7 | Requirement workflow states (`requirementWorkflow.ts`) |
| §6.3G | 3 | Document expiry vs period of performance (`documentExpiry.ts`) |
| §6.4A | 5 | Connected milestone timeline (reuses records) (`milestoneService.ts`) |
| §6.4B | 18 | Deterministic amendment diff and recheck (`amendmentRecheck.ts`) |
| §6.4C | 5 | Working-backward schedule, 13-phase default template (`scheduleGenerator.ts`, `workingDays.ts`) |
| §6.4D | 7 | Reminder engine and escalations (`milestones/reminderEngine.ts`, `reminders/reminderPolicy.ts`) |

Totals including the lettered sub-items above: §6.1 ×100, §6.2 ×63, §6.3 ×56, §6.4 ×52. These totals also include old-CLAUDE.md and PROMPT.md hits such as "CLAUDE.md §6.3".

### §7 (6 bare). Agent runtime: `backend/src/services/agents/`; acceptance tests `section7Acceptance.audit.test.ts`, `section7Runtime.audit.test.ts`
| Sub | Count | Covers | Folder |
|---|---:|---|---|
| §7.0 | 50 | Shared runtime: `AgentContext`/`AgentResult` contract, transactional outbox, one queue/worker | `agents/registry.ts`, `runService.ts`, `outbox.ts`, `scheduler.ts`, `workers/agentWorker.ts` |
| §7.1 | 50 | CONTRACT_ADMINISTRATION agent (emits `CONTRACT_AWARDED`, option watch, funding bands) | `agents/contract/` |
| §7.2 | 46 | OPPORTUNITY agent (owns `PURSUIT_STAGE_CHANGED`) | `agents/opportunity/` |
| §7.3 | 41 | COMPLIANCE agent (owns `EXTRACTION_COMPLETED`, `AMENDMENT_RECORDED`) | `agents/compliance/` |
| §7.4 | 31 | QUALIFICATION agent | `agents/qualification/` |
| §7.5 | 36 | TEAMING agent (acts on `BID_DECISION_RECORDED` = BID) | `agents/teaming/` |
| §7.6 | 26 | PRICING agent (`buildAwardBenchmark`) | `agents/pricing/` |
| §7.7 | 25 | PROPOSAL agent (capability library retrieval, pinned prompt names) | `agents/proposal/` |
| §7.8 | 26 | FINANCE agent (aging buckets split from 90+) | `agents/finance/` |
| §7.9 | 38 | INTELLIGENCE agent; "As of §7.9 ALL NINE domain agents are implemented" | `agents/intelligence/` |

UI panels are in `frontend/src/components/section7/`.

### §8 (35 bare). Acceptance suite: `backend/src/audit/section8*.test.ts` (agent boundary, duplication, lifecycle, RBAC, security, tenant sentinel, token class)
| Sub | Count | Covers | Main files |
|---|---:|---|---|
| §8.1 | 30 | GovCon CRM: agency contacts, interactions, follow-ups, relationship strength; partner portal access granted from CRM. (Also collides with "PROMPT §8.1 #8/#10".) | `routes/crm.ts`, `services/crm/relationshipStrength.ts`, `services/crm/followUpReminders.ts` |
| §8.2 | 35 | ERP / contract finance: task-order tier, budget vs actual, incurred-cost audit package, subcontractor invoice posting, resource allocation | `routes/erp.ts`, `services/erp/auditPackage.ts`, `services/erp/budgetVsActual.ts`, `services/erp/subcontractPosting.ts` |
| §8.2.4 | 2 | Contract invoice PDF | `services/erp/contractInvoicePdf.ts` |
| §8.3 | 45 | Partner portal: external partner access, personnel evidence, deliverable↔partner attribution, revocation and re-invite | `routes/partnerPortal.ts`, `services/partnerPortal/partnerAccess.ts`, `routes/personnel.ts` |
| §8.4 | 61 | Public REST API (shares the `api_tokens` table; `deliveryInterface`), cross-asset knowledge search, signature pad, resume upload, personnel evidence for the Proposal Agent | `routes/publicApi/v1.ts`, `routes/knowledge.ts`, `routes/mcp.ts` |
| §8.5 | 78 | Roles and permissions (`API_TOKEN_MANAGE` etc.), SSO discovery and enforcement, integrations, provider webhooks (raw body), e-sign | `services/rbac/permissions.ts`, `middleware/permissions.ts`, `routes/rbac.ts`, `routes/sso.ts`, `routes/integrations.ts`, `routes/integrationWebhooks.ts`, `routes/esign.ts` |

Note: `§8.2` also appears as an old CLAUDE.md "production sign-off" rule in `mcp/`.

---

## 5. "Phase N" items: built vs still deferred

| Label | Where | Status |
|---|---|---|
| Phase 1 (BigQuery inserts append-only) | `services/bigquery/ingestionService.ts` | As written; "once we have enough data" upgrade **deferred** |
| Phase 1d (backtest `evaluateFrom` date) | `services/backtest/historicalBacktest.ts` | Built |
| Phase 1.5 (mint MCP token script) | `mcp/opportunity-mcp/.env.example` | Built (`scripts/mint-mcp-token.ts` referenced) |
| Phase 2 (production BigQuery service-account key) | `config/bigquery.ts` | **Deferred (inferred)**: comment only |
| Phase 2 (Grants pipeline) | `routes/grants.ts`, `frontend/src/services/api.ts` | Built |
| Phase 2B.2 / 2B.2c / 2B.2d, 2B.5, 2B.6, Agency Phase A, Phase 2C | Winners Intel | See `winners-intel.md` section 6. 2B.6 is built; 2B.5 was removed; **2B.2d recompete heuristic and batch pruning are deferred** |
| Phase 4B (branded email sending via SendGrid/SES) | `services/brandedEmailTemplates.ts` | Comment says future, but `services/emailService.ts` now imports these templates, so **likely built (inferred)**; the comment is stale |
| Phase 5D (compliance-gap source attribution + AI clause extraction) | `services/complianceGapAnalysis.ts` | Built |
| Phase D (teaming-fit score) / Phase E (teaming outreach) | `services/teamingSuggester.ts`, `services/teamingOutreachService.ts` | Built |
| SCW spec §6 Phase 2 / 4 / 5 | `services/scw/likelyPrimes.test.ts` ("Phase 2 exit criteria"), `subawardAnalysis.ts`, `SubcontractingPath.tsx`, `OutreachDraftModal.tsx` | Phase 4 (read-only path) built; Phase 5 (outreach) built. **Deferred:** "Add to Capture Plan" (v2), "View History", three-variant drafts, SCW-5 SMS and digest |
| OASIS+ Phase II | `gb106/` | Not a build phase; it is a GSA contract vehicle name |

---

## 6. Unresolved

- **FIX-4** is cited only in `frontend/.eslintrc.cjs`. **P1-4** and **Section 4 #1** are never cited; they may have existed in the lost docs.
- **Stages 2, 8, 9 of §5.1** are not cited anywhere.
- **Old CLAUDE.md §5.2, §6.2 and §12** could not be decoded from context.
- **Bare §4 and bare §5** refer to sub-sections of the lost briefs **(inferred)**; their exact titles are unknown.
- **Status "Built"** means code and tests exist in `main`. It does not mean the feature is enabled in production; check the env flags listed in sections 1.4 and 3 and the `ENABLE_*` flags.
