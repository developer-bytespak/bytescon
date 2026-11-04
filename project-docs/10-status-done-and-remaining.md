# Status and go-live plan

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

## 3. Going live

**This is the one place for everything needed to launch:** your decisions and tasks, the order, the rehearsal, the
costs and the first two weeks. The code that blocked launch is finished (B1, B3–B8, B13, B14, B23, B27–B29, R11 and
the staging code); what's left is setup only you can do. You've chosen to do it later, together with staging and the
deploy. Never paste keys or passwords in chat; enter them in the dashboards yourself. Claude can prepare the exact
values that aren't secret.

### 3.1 Order

1. Make the decisions (3.3). Do S1 as soon as you can.
2. Create the accounts: Cloudflare, Sentry, a Stripe account for Bytescon, the domain.
3. Do the staging steps (3.5) and the production settings (3.4: T1, T5–T7, T11, T12). T3 is applied through S3.
4. Tell Claude staging is live. Claude runs `npm run flavour:check` on it (doc 20 §2a), the staging checks (doc 20 §6) and the rehearsal (3.6), and switches to
   committing on `staging`.
5. Do T2 and T4 (Stripe rehearsal, then live keys), T8 and T9.
6. Beta, then public launch.

### 3.2 Suggested dates

These only hold if you start on the date below. Each task takes 10–30 minutes.

| When | Claude | You |
|------|--------|-----|
| Mon 9 – Fri 13 Nov 2026 | Support setup; prepare values | Decisions, accounts, S1 |
| Mon 16 – Fri 20 Nov | Run the rehearsal on staging, repeat key steps on production, practise a database restore | Render upgrade, staging services, domains, email domain, settings |
| Mon 23 – Fri 27 Nov (Thanksgiving 26 Nov) | Fix whatever the rehearsal finds; watch monitoring | Invite 3–5 friendly beta firms |
| **Beta: Mon 30 Nov 2026** | Daily check of errors, jobs and payments for 2 weeks | Talk to beta firms weekly |
| **Public launch: mid-December 2026**, after 2 calm beta weeks | | Open sign-ups and remove the beta cap |

### 3.3 Decisions only you can make

| # | Decision | Why it matters | Recommendation |
|---|----------|----------------|----------------|
| D1 | The domain | Customers, emails and Stripe receipts should come from your own domain, not `vercel.app` / `onrender.com` | `bytescon.com`: `app.` and `api.` for production, `staging.` and `api-staging.` for staging |
| D2 | File storage: Cloudflare R2 or AWS S3 | Needed so uploads survive (B1) | R2 now; S3 later if FedRAMP/CMMC hosting comes first (doc 15) |
| D3 | Beta first, or straight to public | A beta catches real-world problems with low risk | Beta first. The code has a beta-slot cap (`MAX_BETA_SLOTS`) and a beta NDA |
| D4 | Launch prices | Stripe charges what the code says ($99 Core, $199 All Access, add-ons $29–$79) | Confirm or change before Stripe goes live |
| D5 | Should an agent on OBSERVE still raise alerts? The code header says no; a test says yes, "because an escalation is how a human is told" | Decides whether a firm can silence an agent completely | Keep alerts on: agents never act alone either way, and silence could hide a real deadline |
| D6 | Scoring: turn on `PROBABILITY_RENORMALIZE_ABSENT` in production, and should the live decision keep its extra steps (recompete, Bayesian, set-aside)? | Both move the score customers see. Inputs now match across paths; these steps still differ | Sample-test about 8 opportunities on staging first, then re-score, as the setting's own note requires |
| S7 | Who can use staging (`STAGING_ALLOWED_EMAILS`) | Nobody else can sign in or receive email there | e.g. `@bytesplatform.com` |

### 3.4 Production tasks

| # | Task | Where | Notes |
|---|------|-------|-------|
| T1 | **Storage bucket**, plus the `UPLOADS_S3_*` settings on `bytescon-api` | Cloudflare → Render | The lost-uploads fix does nothing until this is done: every restart still deletes uploaded files. Steps in [doc 15 §5](15-fix-report-uploaded-files-lost.md#5-whats-needed-to-switch-it-on-in-production-owner-) |
| T2 | **Stripe test key** in local `backend/.env`, for the fake-card rehearsal | Stripe (test mode) | Billing checks end to end ([doc 16 §4](16-billing-one-subscription.md#4-verification-results-2026-11-03)) |
| T3 | **Upgrade Render:** `bytescon-api` → Standard, `bytescon-redis` → a paid Key Value plan; `bytescon-mcp` → Starter if MCP connectors are offered | Render | Fixes B2: the free server sleeps, so jobs, agents and emails stop, and free Redis keeps no data. Applied through S3 |
| T4 | **Stripe live:** live secret key, plus a webhook to `https://<api domain>/api/webhooks/stripe` and its signing secret (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) | Stripe → Render | Only after the T2 rehearsal passes |
| T5 | **Domain:** add the app domain in Vercel and the API domain in Render, then set `APP_URL`, `FRONTEND_URL` and `PUBLIC_APP_URL` on Render and `VITE_API_URL` on Vercel | Vercel, Render, DNS | Claude prepares the exact values once D1 is decided |
| T6 | **Email:** verify the sending domain in SendGrid, then set `SENDGRID_API_KEY` and `EMAIL_FROM=noreply@<domain>` | SendGrid → Render | Without it, verify, reset and invite emails land in spam or aren't sent |
| T7 | **Monitoring:** `SENTRY_DSN`, `OPS_HEARTBEAT_TOKEN`, `ALERT_WEBHOOK_URL`, `METRICS_SECRET`, `PLATFORM_ADMIN_EMAIL` (where alerts go), `PLATFORM_ADMIN_EMAILS` (Bytescon operators allowed into platform-only areas) | Sentry → Render | Missing as of 2026-11-03. Until set, job alerts only reach the logs and nobody can use model tests or template approval |
| T8 | **Database backups:** confirm the Neon plan's restore window | Neon | Then Claude rehearses a restore |
| T9 | **Vercel plan:** Hobby is for non-commercial use, so check the plan before charging customers | Vercel | Pro is about $20/user/month (confirm on vercel.com) |
| T10 | **Staging:** the steps in 3.5 | Several | Test every change before customers see it |
| T11 | **Check `SAM_API_KEY` is set** on `bytescon-api` | Render | The app promises "no API key needed" for SAM.gov; that's only true with this key |
| T12 | **Add `FIELD_ENCRYPTION_KEY`** (R2 below). Never change or remove it once set | Render | Otherwise sensitive fields are stored as plain text |

### 3.5 Staging steps (T10)

The settings for S3 and how staging works are in [doc 20](20-environments-staging-and-production.md).

| # | Step | Where |
|---|------|-------|
| S1 | Create the Neon branch `staging` and copy its connection string. **Do this before any customer data exists**, because a branch copies whatever is there | Neon |
| S2 | Create the R2 bucket `bytescon-uploads-staging` and an access token | Cloudflare |
| S3 | Tell Claude you're starting (Claude creates the `staging` git branch). Then Render → Blueprints → connect the repo, check the preview and enter the staging settings. **Applying `render.yaml` also upgrades production to paid plans (T3)**, so do it when you're ready for that cost | Render |
| S4 | Stripe test mode: add a webhook to `https://api-staging.<domain>/api/webhooks/stripe` and copy its secret | Stripe |
| S5 | Assign `staging.<domain>` to the `staging` branch, set the Preview variables `VITE_API_URL=https://api-staging.<domain>` and `VITE_APP_ENV=staging`, and turn on Deployment Protection for previews | Vercel |
| S6 | Add the `staging` and `api-staging` DNS records | DNS provider |
| S7 | Decide the staff list (3.3) | — |
| S8 | Protect `main`: require CI, no direct pushes. Render doesn't wait for CI today, so a failed run can still deploy | GitHub |

Claude can do S3 and S5 through the CLIs if you prefer, but only on your go-ahead, because they create paid services
and change settings.

### 3.6 Rehearsal before beta

The whole customer journey, first on **staging** (doc 20), then the key steps on production with Stripe in test mode:
1. **Sign up and onboard:**
   - sign up;
   - verify the email;
   - accept the Terms;
   - set up MFA;
   - add a client company.
2. **Pay:**
   - subscribe to Core with a test card;
   - add an add-on (one charge);
   - fail a renewal, then pay it;
   - cancel.
3. **Files:** upload an RFP, restart the server, and download it again (proves T1).
4. **Daily work:**
   - sync federal, state and subcontracting leads;
   - score an opportunity;
   - build a compliance matrix;
   - generate a proposal draft.
5. **Team:** invite a team member, then deactivate them.
6. **Agents and monitoring:** check an agent run respects opt-in (after B6), and that Sentry and the heartbeat receive events.
7. **Backups:** restore the database to a copy and confirm the data is there.

Every step passes → beta. Any step fails → fix on staging, then repeat that step.

From go-live on, every change goes **staging first, then production** (doc 20 §4).

### 3.7 Monthly running cost (approximate, confirm before buying)

| Item | Plan | ~ per month |
|------|------|-------------|
| Render `bytescon-api` | Standard (2 GB RAM, 1 CPU) | $25 |
| Render `bytescon-redis` | Starter Key Value | ~$10 |
| Render `bytescon-mcp` | Starter (only if MCP connectors are offered) | $7 |
| Render workspace | Hobby is $0; Pro ($25) only for team seats and more bandwidth | $0–25 |
| Vercel frontend | Pro, for commercial use | ~$20 |
| Cloudflare R2 | 10 GB free, then per GB | ~$0–2 |
| Neon Postgres, Sentry, SendGrid | Free tiers may be enough for the beta; check limits | $0+ |
| AI (OpenAI/Claude) | Usage-based, capped by firm budgets (B6 fixed) | varies |
| **Total before AI usage** | | **≈ $60–90** |

Render prices are from third-party trackers (Nov 2026) and Render's changelog; confirm on render.com/pricing.

Staging adds about $7 a month (doc 20 §7).

### 3.8 First two weeks after go-live

- **Daily:** check Sentry errors, the job-health page, Stripe payments and webhook failures, and agent spend.
- **Weekly:** talk to each beta firm, and fix top issues within the week.
- **Rollback:** Vercel and Render both keep previous deploys. Roll back from their dashboards; database migrations
  only add, so a code rollback is safe.

## 4. Remaining work (prioritised)

### 🔴 Must do before real production

| # | Item | Why it matters | Where |
|---|------|----------------|-------|
| R1 | ~~Move uploads to object storage~~ ✅ code done 2026-11-03 — **still needs a bucket + `UPLOADS_S3_*` settings on Render** to take effect | Files were saved only to local disk; Render disks are wiped on restart → uploaded documents were lost | `backend/src/services/fileStorage.ts`; see [15-fix-report-uploaded-files-lost.md](15-fix-report-uploaded-files-lost.md) |
| R2 | **Add `FIELD_ENCRYPTION_KEY` to production** | Without it, sensitive fields are silently stored as plain text | `backend/src/utils/fieldCrypto.ts`, `.env.prod.example` |
| R3 | Add other missing prod settings: `OPS_HEARTBEAT_TOKEN`, `SENTRY_DSN`, `METRICS_SECRET`, `SAM_GOV_API_KEY`, `ALERT_*` | Monitoring and alerts silently off | `backend/.env.prod.example` |
| R4 | ✅ **Done 2026-11-04 (B6):** respect agent opt-in for event runs | Event runs now start only for agents the firm switched on — [doc 21](21-agents-opt-in.md) | `services/agents/outbox.ts`, `dispatch.ts` |
| R5 | Backend Docker image: multi-stage, non-root, no dev dependencies; run migrations on deploy | Security and image size | `backend/Dockerfile` |

### 🟠 Should do soon

| # | Item | Where |
|---|------|-------|
| R6 | Shared Redis store for rate limits (so limits hold across instances) | `backend/src/server.ts`, route limiters |
| R7 | Decide fail-open vs fail-closed for token revocation when Redis is down | `services/tokenRevocation.ts` |
| R8 | Test SSO RS256/JWKS against a real identity provider | `services/sso/idTokenVerifier.ts` |
| R9 | SCW-5: SMS and weekly digest for subcontracting notifications | `services/scw/notifications.ts` |
| R10 | Unanet and Deltek accounting adapters (currently stubs) | `services/integrations/accounting/` |
| R11 | ✅ **`render.yaml` committed 2026-11-04** (production and staging; not applied until the owner connects it — doc 20). CI covers `main` and `staging`; deploys stay Render's auto-deploy | repo root, `.github/workflows/` |
| R12 | ~~Add tests for carry-forward / status-subject~~ ✅ done in `ed3c5eb` | `services/agents/` |
| R12b | Frontend tests fail on Node 26 (`localStorage` built-in shadows jsdom in `authToken.test.ts`); pin Node 24 locally (`.nvmrc`) or fix the test setup | `frontend/src/lib/authToken.test.ts` |
| R12c | Backend tests fail now and then in full runs (3 of 6 passed on 2026-11-05): timeouts under load, unexplained 404s, and the intelligence isolation test — [doc 27 §4](27-spec-gap-bugs-fixed.md) | `services/agents/intelligence/` |
| R12d | ~~Subcontracting leads shared between firms~~ ✅ fixed 2026-11-03: lead id is unique per firm — see [17-subcontracting-leads-per-firm.md](17-subcontracting-leads-per-firm.md) | `prisma/schema.prisma`, `services/scw/subcontractLeads.ts` |
| R12e | ✅ **Done 2026-11-04 (B6):** agent event runs now use the firm's autonomy, retries, timeout and schedule token budget | `services/agents/outbox.ts` |
| R12f | ✅ **Done 2026-11-04 (B11):** Proposal and Pricing recognise the event entity types — [doc 26](26-remaining-bugs-fixed.md) | `services/agents/triggerEntities.ts` |
| R12g | ✅ **Done 2026-11-04 (B10):** a retried request no longer starts extra agent runs — [doc 26](26-remaining-bugs-fixed.md) | `services/agents/*Events.ts` |
| R12h | ✅ **Done 2026-11-04 (B17):** a score is calibrated once — [doc 26](26-remaining-bugs-fixed.md) | `engines/probabilityEngine.ts` |

More gaps (smaller) are listed at the end of each spec in [specs/](specs/README.md).

**Fixed 2026-11-04:** team members can be deactivated/reactivated; only active members use seats; a deactivated member's sessions end at once (B4) — see [18-remove-team-members.md](18-remove-team-members.md).

**Fixed 2026-11-04:** the bugs in the specs' known-gaps lists (agents, scoring, subcontracting, Winners Intel) — see [27-spec-gap-bugs-fixed.md](27-spec-gap-bugs-fixed.md).

**Fixed 2026-11-04:** the remaining review bugs B9–B12, B15, B17–B22 and B24–B26 — see [26-remaining-bugs-fixed.md](26-remaining-bugs-fixed.md). **Still open:** B1 and B2 (need the setup in §3) and B16 (needs a decision from the owner, in doc 26).

**Built 2026-11-04:** staging code (internal-only locks, banner, seed, `render.yaml`, CI). The hosted staging needs owner steps S1–S8 — see [20-environments-staging-and-production.md](20-environments-staging-and-production.md). One test, `submissionWorkspace` deadline reminders, failed once in a full run and passed on 3 solo runs and the next full run; cause not found, watch CI.

**Fixed 2026-11-04:** customer-facing rough edges: internal wording on the Feedback page (B27), SAM.gov text on Discovery that contradicted "no key needed" (B28), a search link that opened "page not found" (B14) — see [25-customer-facing-rough-edges.md](25-customer-facing-rough-edges.md).

**Fixed 2026-11-04:** every background job now alerts on failure and is watched for going silent, per job (B13); the false daily "nightly backup" alert is gone (B23) — see [24-job-alerts-and-backup-noise.md](24-job-alerts-and-backup-noise.md).

**Fixed 2026-11-04:** the platform-wide model test (`/api/admin/backtest`) is for Bytescon operators only, not every firm admin (B8) — see [23-backtest-platform-operators-only.md](23-backtest-platform-operators-only.md).

**Fixed 2026-11-04:** a role change applies on the next request, and ends the person's sessions; members with granular roles (Finance, Viewer, …) can sign in (B7) — see [22-role-changes-apply-at-once.md](22-role-changes-apply-at-once.md).

**Fixed 2026-11-04:** AI agents are truly opt-in. Event-triggered runs only start for agents the firm switched on, follow its chosen level and stop at its AI budget (B6) — see [21-agents-opt-in.md](21-agents-opt-in.md).

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
| `brandedEmailTemplates.ts`: "Phase 4B will hook into sending" | Already wired into email sending |
| Code references `PROMPT.md`, `FIXES.md`, `docs/WHO_WINS_MODEL.md`, `.ai/WINNERS_INTEL_SPEC.md` | Not in the repo |

## 5. Numbers at a glance

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
