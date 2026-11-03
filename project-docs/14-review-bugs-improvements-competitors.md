# Bytescon Review: Bugs, Improvements, Automation and Competitors

**Prepared:** 2026-11-03 · **Code version:** `main` @ `9aafe2d`

## How sure is this?

- **Bugs:** every bug listed was confirmed by reading the code (file and line given). Items marked
  **✔ re-checked** were independently re-verified a second time before writing. Nothing here is a guess.
- **Competitors:** every fact comes from the vendor's own website or a published news source, checked on
  2026-11-03, with links. Prices and features change, so treat them as correct *as of that date*.
  Anything we could not confirm is marked **(unverified)**. Security certifications are what each vendor
  *claims*; they were not checked against government registries.
- Some vendor sites blocked automated reading (BGOV, BidNet, G2, Capterra); for those we used search-result
  summaries of their pages and say so.

## Contents
1. [What are the issues/bugs in the system?](#1-what-are-the-issuesbugs-in-the-system)
2. [What can we improve?](#2-what-can-we-improve)
3. [What is manual now that we can automate?](#3-what-is-manual-now-that-we-can-automate)
4. [Who are Bytescon's competitors?](#4-who-are-bytescons-competitors)
5. [What are competitors doing that we are missing?](#5-what-are-competitors-doing-that-we-are-missing)

---

## 1. What are the issues/bugs in the system?

### Concise answer

The app works, but there are **5 serious problems**, **13 medium bugs** and about **10 small ones**.

The 5 serious ones:
1. **Uploaded files disappear.** They are saved on the server's own disk, which is wiped whenever the server sleeps or redeploys — several times a day on the current free plan. *(Fixed in code 2026-11-03; needs a storage bucket connected on Render — see [15-fix-report-uploaded-files-lost.md](15-fix-report-uploaded-files-lost.md).)*
2. **The server falls asleep.** On Render's free plan the backend sleeps when nobody is using it, so the daily SAM.gov sync, AI agents, reminders and emails stop running.
3. **One failed add-on payment locks the whole account.** If a $29 add-on payment fails, the customer loses access to the $99 base plan they paid for, and paying the add-on does not unlock it.
4. **You cannot remove a team member.** There is no "remove user" button or API, so a departed employee keeps access and their seat can never be reused.
5. **Subcontracting leads are overwritten between firms.** When two firms sync the same lead, the second firm overwrites the first firm's copy and never sees the lead itself.

### Detailed answer

#### 🔴 Serious

| # | Problem | What the user sees | Evidence | Status |
|---|---------|--------------------|----------|--------|
| B1 | **Uploads stored on local disk** | Uploaded documents vanish after the server restarts | `backend/src/middleware/upload.ts` uses `multer.diskStorage`; Render free plan has no persistent disk; Render logs show the backend restarting 6 times on 2026-11-02 | ✔ re-checked · **fixed in code 2026-11-03** (needs bucket settings) — [report](15-fix-report-uploaded-files-lost.md) |
| B2 | **Free hosting plan sleeps** | Daily jobs, AI agents, reminders and emails don't run while asleep; first visitor waits ~1 minute | Render: `bytescon-api`, `bytescon-redis` on plan `free`; logs show a 42-hour sleep (Oct 31 → Nov 1). Free Redis also keeps no data | ✔ re-checked |
| B3 | **Add-on payment failure locks the base plan** | Every paid page returns "plan required"; paying the add-on doesn't fix it; lasts until the next base-plan invoice | `services/stripeService.ts:1172-1191` marks *all* the firm's subscriptions PAST_DUE without checking which subscription failed; the success handler (`:1238`) does check | ✔ re-checked |
| B4 | **No way to remove or deactivate a team member** | Ex-employees keep access; seats are never freed, so a Core firm (3 seats) can get stuck | No route sets `isActive=false` or deletes a user; seat count `middleware/tierGate.ts:69-75` counts all users | ✔ re-checked |
| B5 | **Subcontracting leads overwritten across firms** | Second firm never gets leads the first firm already has | `SubcontractOpportunity.externalId` is globally `@unique`; upsert at `routes/subcontracting.ts:137` | ✔ re-checked |

#### 🟠 Medium

| # | Problem | What it means | Evidence | Status |
|---|---------|---------------|----------|--------|
| B6 | **AI agents are not truly opt-in** | The website says every agent is opt-in, but agents woken by events run for every firm, and ignore the firm's chosen autonomy level and AI budget | `services/agents/outbox.ts` creates runs for all subscribed agents; `dispatch.ts:108` only checks "enabled" for scheduled runs | ✔ re-checked |
| B7 | **A demoted admin keeps admin powers for up to 8 hours** | Changing someone from Admin to Consultant doesn't log them out; they can still change billing, API keys, branding | `routes/rbac.ts:77-119` never revokes tokens; `requireRole` trusts the role inside the login token (`middleware/auth.ts:152-160`); 8h token lifetime | Confirmed |
| B8 | **Any customer's admin can run the platform-wide model test** | Any firm admin can start a 5–30-minute backtest using the platform's data quota and reload the *global* scoring curve used for all firms | `routes/backtest.ts:23` uses `requireRole('ADMIN')`, not the existing `requirePlatformAdmin` | ✔ re-checked |
| B9 | **Agents miss repeated changes** | If a deliverable is rejected, fixed and rejected again, the contract agent never hears about the second rejection (same for pursuits moving back and forth) | Event keys like `contractEvents.ts:118` (`…:${from}->${to}`) never repeat; events are never deleted | Confirmed |
| B10 | **Some agent events are duplicated on retry** | A retried request starts extra agent runs | Dedupe keys contain `Date.now()`: `teamingEvents.ts:59`, `proposalEvents.ts:70`, `financeEvents.ts:111` | ✔ re-checked |
| B11 | **Proposal and Pricing agents miss two event types** | They don't recognise "extraction completed" and "amendment recorded" events, so they re-check the whole firm instead of the one item | Handlers check `'ExtractionJob'`/`'Amendment'` but events carry `'SolicitationExtractionJob'`/`'AmendmentRevision'` (`proposalAgentHandler.ts:372`, `pricingAgentHandler.ts:98`) | ✔ re-checked |
| B12 | **Owner/demo firm can hit free-tier limits** | The owner account may be blocked from inviting users or adding a 6th client while all features look unlocked | `middleware/tierGate.ts:21-46` ignores owner-comp when a Subscription row exists | Confirmed |
| B13 | **Some background jobs have no failure alerts** | If the hourly source sync, 15-minute saved-search alerts or milestone reminders break, nobody is told | `server.ts:482-497` attaches monitoring to every worker except `section6Worker` and GB-107 | Confirmed |
| B14 | **Knowledge search link goes to "page not found"** | Clicking a "Capability narrative" result opens a 404 | `services/knowledge/knowledgeSearch.ts:117` links to `/capability-narratives`, which doesn't exist (real page: `/library/capability`) | ✔ re-checked |
| B15 | **Flow-down clauses can never be shared with partners** | The backend supports it, but the screen never sends the "share" flag, and the partner portal never shows them | `frontend/src/services/erpApi.ts:180-181`; `routes/erp.ts:822-839` | Confirmed |
| B16 | **Security defaults that fail quietly** | If Redis is down, logged-out sessions keep working; rate limits are per server; if the encryption key is ever missing, secrets are stored as plain text without error | `services/tokenRevocation.ts`; `server.ts` rate limiter; `utils/fieldCrypto.ts` (key *is* set in production today) | Confirmed |
| B17 | **Possible double calibration** | If the "probability calibration" setting is ever turned on, win scores may be adjusted twice | `specs/scoring-and-win-probability.md` §10; setting is off today | Confirmed (dormant) |
| B18 | **Scoring factor explanations may all show "neutral"** | The explanation looks up factor names the engine never writes | `scoreExplanation.deriveFactors` | Likely (see scoring spec) |

#### 🟢 Small

| # | Problem | Evidence |
|---|---------|----------|
| B19 | New firm holidays ignored by agents until the server restarts | `services/agents/workingCalendar.ts:20-41` caches forever |
| B20 | Deadlines after ~8 pm Eastern counted one working day late | `services/milestones/workingDays.ts` uses UTC dates |
| B21 | Partner-portal contract picker silently stops at 100 contracts | frontend asks 200, backend caps 100 (`routes/contractManagement.ts:156`) |
| B22 | CRM agency cards count offices they don't list | `routes/crm.ts:191`, `frontend/src/pages/Crm.tsx:206` |
| B23 | False "nightly-backup silent" alert emails (the backup script no longer exists) | `services/jobHealth.ts:110-113`, `routes/opsHeartbeat.ts` |
| B24 | Every 8(a) set-aside is blocked for every client (no 8(a) field on clients) | `specs/scoring-and-win-probability.md` §10 |
| B25 | Subcontract status menu offers "Closed"/"Awarded" which the backend never sets | `specs/subcontracting-workflow.md` |
| B26 | Winners Intel can only be switched on by editing the database | `prisma/schema.prisma:217-221` (no screen or API) |
| B27 | Feedback page shows internal wording ("investor-pitch traction snapshot") to customers | `frontend/src/pages/Feedback.tsx` |
| B28 | Settings still asks for a SAM.gov key while a banner says it's built in | `frontend/src/pages/Settings.tsx`, `FirstLoginBanner` |

#### ✅ Already fixed (2026-11-03)
- Qualification agent read win probabilities 100× too small (80% → 0.8%) — commit `e4c27b0`.
- Proposal agent panel crash from a renamed field; agent warnings shown from the whole firm instead of the item viewed — commit `ed3c5eb`.

#### Checked and clean
Tenant isolation in every API route, client-portal and partner-portal access checks, Stripe checkout/refund handling,
all 9 agents' screen-to-server data contracts, and 72 discovery API paths were reviewed and found correct.

---

## 2. What can we improve?

### Concise answer

1. **Make it production-ready:** paid hosting plan, cloud file storage (S3/R2), error tracking (Sentry), and a separate test server.
2. **Fix the bugs above**, starting with billing lockout, team offboarding and cross-firm leads.
3. **Earn security credentials** customers ask for: SOC 2, CMMC Level 2, FedRAMP Moderate Equivalency, GovCloud hosting option. Most competitors already advertise these.
4. **Close the biggest feature gaps** versus competitors (see section 5): Word add-in, government contact database, GSA eBuy / contract-vehicle opportunities, Salesforce/HubSpot sync.
5. **Lean into what makes Bytescon unique:** multi-client workspaces, white-label client portal, post-award finance and a low published price — almost no competitor has these together.

### Detailed answer

#### A. Platform and reliability
| Improvement | Why | Effort |
|-------------|-----|--------|
| Upgrade `bytescon-api` and `bytescon-redis` to Render paid plans (~$7 + ~$10/month; confirm on Render's pricing page) | Jobs run on schedule, no cold starts, Redis keeps data | Small (dashboard) |
| Move uploads to S3 or Cloudflare R2 | Files survive restarts and redeploys | Medium (code) |
| Sentry error tracking (backend + frontend) | Find out about crashes before customers report them | Small |
| Staging server + separate Neon database branch | Test with real keys without touching production | Medium |
| Shared (Redis) rate limiting; decide fail-closed for token revocation | Security holds with more than one server | Small |
| Harden the backend Docker image (non-root, no dev packages) | Smaller attack surface | Small |
| Commit hosting config (`render.yaml`) and a deploy step in CI | Infrastructure is reproducible and reviewed | Small |
| Database backup policy (Neon point-in-time restore window) and a tested restore | Today backups rely entirely on Neon defaults | Small |

#### B. Security and compliance (customers' buying requirement)
Competitors that advertise certifications Bytescon lacks: Procurement Sciences (FedRAMP Moderate Authorized, SOC 2 Type 2), GovDash, pWin.ai, Unanet, Deltek Costpoint, VisibleThread (FedRAMP Moderate Equivalency), GovSignals and AutogenAI Federal (FedRAMP High), Vultron and GovEagle (CMMC L2 claims). Bytescon's landing page lists SOC 2 and CMMC L2 as "in progress". Suggested order: **SOC 2 Type II → CMMC L2 alignment → FedRAMP Moderate Equivalency → optional GovCloud/single-tenant hosting.**

#### C. Product
- Finish half-built features: subcontracting SMS/weekly digest, Unanet/Deltek accounting connectors, flow-down sharing, Winners Intel on/off switch.
- Decide on features switched off by default: Matching v2, Agency View v2, Platform Onboarding, client match emails, numeric fit score.
- Add a team-member "Deactivate" button and a "Platform admin" area for owner-only actions (backtest, owner grants, MFA resets).
- Connect `bytescon.com` to the app (DNS currently doesn't answer).

#### D. Engineering quality
- Backend lint and test-coverage gates in CI; dependency/security scanning; end-to-end browser tests.
- Fix the one flaky test (`intelligenceAgent.integration.test.ts`).
- Keep `project-docs/specs/` up to date as the design record (the original spec files were lost).

---

## 3. What is manual now that we can automate?

### Concise answer

**Automate now (safe):** fitting each firm's score calibration (it's a button today but already safety-checked), the Winners Intel on/off switch (needs a database edit today), nightly state & municipal sync (a button today), team offboarding, the onboarding data refresh job (written but never switched on), and alerts for new beta requests (nobody sees them today).

**Automate partly (system prepares, human approves):** recording win/loss outcomes (pre-fill from award data), sending outreach emails after approval, invoice payment status from accounting, retraining the "Who Wins" model monthly.

**Keep manual on purpose:** submitting bids, signing documents, filing grants, approving invoices, agent decisions. The code deliberately requires a human for these, and that is a selling point.

### Detailed answer

**Legend:** 🟢 automate fully · 🟡 system prepares, human approves · 🔒 keep human by design

| # | Manual today | Who does it | Evidence | Recommendation |
|---|--------------|-------------|----------|----------------|
| 1 | Fitting a firm's own score calibration | Firm admin clicks a button | `routes/scoringIntel.ts:120-133`; the fit already rejects itself if not better (`tenantCalibration.ts:220-262`) | 🟢 Run nightly and whenever it goes stale |
| 2 | Turning on Winners Intel for a firm | Developer edits database | `prisma/schema.prisma:217-221`, only reader `winnersIntel/resolver.ts:141` | 🟢 Admin switch in Settings, audit-logged |
| 3 | State & municipal sync | Firm user clicks "Sync" | `routes/stateMunicipal.ts:217-235`; status kept only in memory | 🟢 Nightly per-firm job, saved status |
| 4 | Removing a team member | Developer edits database | No route (see B4) | 🟢 Deactivate button + token revocation |
| 5 | Onboarding data freshness job | Never runs (option not passed) | `server.ts:403-409` mounts GB-106 without `freshness` | 🟢 Pass the option (one line) |
| 6 | Beta access requests | Nobody — they are saved but never shown | `routes/beta.ts:50-71` | 🟢 Notify admin + list page, or remove |
| 7 | Platform backtest & global calibration refresh | Firm admin (should be platform owner) | `routes/backtest.ts` ("switch to a BullMQ job in v2") | 🟢 Background job, platform-admin only |
| 8 | One-off Winners Intel refresh | Developer script | `scripts/triggerWinnersIntelRefresh.ts` | 🟢 "Run now" button for platform admin |
| 9 | Production reference data (NAICS, FAR, legal) seed | Developer script | `prisma/scripts/seedProd.ts` | 🟢 Run automatically on deploy |
| 10 | Recording bid outcomes (won/lost) | Firm user | `routes/submissions.ts:300-345` | 🟡 Pre-fill from award notices / USAspending; human confirms |
| 11 | Training the "Who Wins" model | Developer on a server | `prisma/scripts/buildWhoWins.ts` | 🟡 Monthly training job; human activates |
| 12 | Sending outreach emails (teaming, subcontracting) | User copies text into their own email | `routes/scw.ts:199-203` | 🟡 "Send from connected mailbox" after approval |
| 13 | Marking invoices paid | Finance user | `routes/contractFinance.ts:703-713` | 🟡 Suggest "paid" from QuickBooks sync; human confirms |
| 14 | SAM.gov API key renewal | Firm admin | `routes/firm.ts:199-211` | 🟡 Remind before expiry; alert on rejection |
| 15 | Secret rotation (Stripe webhook, JWT, encryption key) | Operator | `stripeWebhookRotationReminderWorker.ts`; single key version in `fieldCrypto.ts` | 🟡 Keep human; add key versioning and reminders |
| 16 | Owner / lifetime account grants; MFA break-glass reset | Developer (database / raw API) | `entitlementService.ts:65,83`; `routes/auth.ts:1323` | 🟡 Platform-admin screens, audit-logged |
| 17 | Real SAM/UEI/CAGE registration progress | Firm user | `gb106/routes/onboarding.routes.ts` | 🟡 Auto-detect from the SAM entity API |
| 18 | Submitting a proposal / attesting AI content | Firm user | `routes/submissionWorkspace.ts`, `proposalAttestation` tests | 🔒 Keep |
| 19 | Sending documents for e-signature | User with signing permission | `routes/esign.ts:1-10` ("THE HUMAN GATE") | 🔒 Keep |
| 20 | Filing on Grants.gov | Authorised representative | `routes/grants.ts:5-8` ("by design") | 🔒 Keep |
| 21 | Submitting invoices to WAWF/IPP | Finance approver | `routes/contractFinance.ts:565-568`; Finance agent forbids it | 🔒 Keep (could add an export file) |
| 22 | Agent decisions (bid, approve, pay, sign) | Firm admin | `registry.ts` (`allowlistedActionKeys: []`), section 7 audit tests | 🔒 Keep — "AI suggests, humans decide" |
| 23 | Template moderation; platform admin list | Platform owner | `middleware/platformAdmin.ts` | 🔒 Keep |

Note: production database migrations **already run automatically** at every backend start (confirmed in Render logs: "No pending migrations to apply").

---

## 4. Who are Bytescon's competitors?

### Concise answer

About **30 active competitors** in five groups:

- **All-in-one AI GovCon platforms (closest rivals):** GovDash, Procurement Sciences / Awarded AI (now owns HigherGov and Rogue), CLEATUS, GovEagle, Sweetspot, SamSearch, Unanet (CRM + ERP + ProposalAI), Deltek (GovWin IQ + Costpoint + ProPricer).
- **Discovery & market intelligence:** Deltek GovWin IQ, GovTribe, HigherGov, GovSpend (with Fedmine), Bloomberg Government, Govly, Federal Compass, FedScout, TechnoMile GovSearch, Fed-Spend, Gov Contract Finder.
- **AI proposal writing:** pWin.ai (took over Vultron's customers in April 2026), VisibleThread, AutogenAI, GovSignals, Rohirrim, Civio.
- **Back-office / ERP for contractors:** Deltek Costpoint, Unanet ERP, JAMIS Prime, PROCAS, QuickBooks + DCAA add-ons.
- **State & local only:** GovSpend, BidNet Direct (Periscope), Starbridge, Civic IQ, Pursuit.
- **Commercial RFP tools (indirect):** Responsive (RFPIO), Loopio, Inventive AI.

**Closest threats to Bytescon's consultant positioning:** **GovEagle** (separate client workspaces for proposal consultants), **CLEATUS** (one organization holding multiple companies), **Federal Compass** (consultant–client collaboration), and **HigherGov** (consultant page and team pricing).

### Detailed answer

#### Recent market moves (all confirmed)
| Date | Event | Source |
|------|-------|--------|
| 2021-08 | GovExec bought GovTribe; GovSpend bought Fedmine; mdf commerce bought Periscope (BidNet) | [ExecutiveGov](https://www.executivegov.com/articles/govexec-acquires-govtribe-to-expand-services-for-government-contractors), [BusinessWire](https://www.businesswire.com/news/home/20210811005058/en/), [BusinessWire](https://www.businesswire.com/news/home/20210811005871/en/) |
| 2021-06 | Xait bought Privia (product now discontinued) | [Xait](https://www.xait.com/press-releases/xait-acquires-privia-to-ramp-up-in-the-government-contracting-market) |
| 2024-01 | Deltek bought ProPricer | [Deltek](https://www.deltek.com/company/news/deltek-acquires-propricer/) |
| 2025-02 | Unanet bought Contraqer (now "GovIntel") | [GovConWire](https://www.govconwire.com/2025/02/unanet-acquires-contraqer-boost-govcon-growth) |
| 2026-01 | GovDash raised $30M Series B | [SiliconANGLE](https://siliconangle.com/2026/01/15/govdash-secures-30m-expand-ai-driven-government-contracting-software/) |
| 2026-02 | Procurement Sciences bought Rogue AI | [Procurement Sciences](https://www.procurementsciences.com/blog/rogue-acquisition) |
| 2026-03 | Procurement Sciences got FedRAMP Moderate Authorization | [Press release](https://digital-release.wowktv.com/business/press-releases/cision/20260313PH09946/procurement-sciences-achieves-fedramp-moderate-authorization) |
| 2026-04-29 | pWin.ai took over Vultron.ai's customer base | [ExecutiveBiz](https://www.executivebiz.com/articles/pwinai-vultronai-customer-base), [Business Wire via Rutland Herald](https://www.rutlandherald.com/news/business/pwin-ai-acquires-vultron-ai-customer-portfolio-cementing-its-ai-proposal-platform-leadership-across-the/article_c03d3d8a-7371-5b61-803f-8a6cfb27c807.html) |
| 2026-05-20 | Procurement Sciences bought HigherGov | [Press release](https://digital-release.kxan.com/business/press-releases/cision/20260520PH61147/procurement-sciences-acquires-highergov-creating-the-largest-ai-powered-growth-platform-in-government-contracting), [Orange Slices](https://orangeslices.ai/a-new-era-in-govcon-procurement-sciences-acquires-highergov/) |

#### Competitor table

Bytescon for comparison: **$99/month Core, $199/month All Access, $2,500 lifetime; 14-day free trial; multi-client + white-label + client portal; post-award finance.**

| Competitor | Group | Who it's for | Published price | Multi-client / consultant support | Website |
|------------|-------|--------------|-----------------|-----------------------------------|---------|
| **GovDash** | All-in-one AI | Contractors of all sizes | Quote only | No (Enterprise has "segregated divisions") | [govdash.com](https://www.govdash.com/pricing) |
| **Procurement Sciences / Awarded AI** | All-in-one AI | Small business → top-100 primes | Quote only | Not stated | [procurementsciences.com](https://www.procurementsciences.com/) |
| **HigherGov** (Procurement Sciences) | Discovery & intel | Small business → enterprise | **$500/yr (1 user), $2,500/yr (10 users)**, free trial | Consultants page, team pricing; no client workspaces | [highergov.com/pricing](https://www.highergov.com/pricing/) |
| **CLEATUS** | All-in-one AI | Small/mid businesses, consultants | **$39–$78/user/month** (annual); higher tiers quote; 7-day trial | **Yes, partly** — one Organization with multiple Companies | [cleat.ai/pricing](https://cleat.ai/pricing) |
| **GovEagle** | AI capture & proposal | Contractors, **proposal consultants** | Quote only | **Yes** — "Set up the client workspace", client materials kept separated | [goveagle.com](https://goveagle.com/industry/proposal-consultants) |
| **Sweetspot** | All-in-one AI | BD / capture / proposal teams | Quote only | No | [sweetspot.so](https://sweetspot.so/) |
| **SamSearch** | Discovery + proposal | Small business, enterprise, consultants | Quote only | Consultants named as audience; no client workspaces described | [samsearch.co](https://www.samsearch.co/pricing) |
| **Unanet** (CRM, ERP, ProposalAI) | All-in-one + ERP | Project-based contractors | Quote only | No | [unanet.com](https://unanet.com/crm-for-government-contracting) |
| **Deltek** (GovWin IQ, Costpoint, ProPricer) | All-in-one + ERP | Mid/large contractors | Quote only (third-party estimates ~$13K–$119K/yr for GovWin) | No | [deltek.com/govwin](https://www.deltek.com/en/govwin) |
| **GovTribe** (GovExec) | Discovery & intel | Small/mid businesses, research & consulting | **$1,900–$2,100/seat/yr**, 7-day trial | No client workspaces | [govtribe.com/pricing](https://govtribe.com/pricing) |
| **GovSpend** (+ Fedmine) | Discovery & intel (state/local first) | Vendors selling to government | Quote only | No | [govspend.com](https://govspend.com/govspend-platform/) |
| **Bloomberg Government** | Policy + contracting intel | BD and government-affairs teams | Quote only | No | [about.bgov.com](https://about.bgov.com/bgov-for-federal-business-development/) |
| **Govly** | Contract-vehicle marketplace | Resellers, OEMs, integrators | Free plan; paid quote | No | [govly.com](https://www.govly.com/pricing) |
| **Federal Compass** | Discovery + CRM | Contractors; consultant solution | Quote only | **Partly** — notes/tasks shared with clients | [federalcompass.com](https://www.federalcompass.com/solutions-consultant) |
| **FedScout** | Discovery | New/small contractors | **Free / $20 / $100 / $500 per month**; iOS & Android apps | No | [fedscout.com/pricing](https://www.fedscout.com/pricing) |
| **TechnoMile GovSearch** | Contacts + CRM | BD and marketing teams | Quote only | No | [technomile.com](https://technomile.com/products/govsearchai-suite/govsearch/) |
| **Fed-Spend** | Discovery (AI-native) | Small contractors | Free / $49 / $199 per month | Not stated | [fed-spend.com/pricing](https://fed-spend.com/pricing) |
| **Gov Contract Finder** | Discovery (AI-native) | Small business | Free / $99 / $299 per month | No | [govcontractfinder.com/pricing](https://govcontractfinder.com/pricing) |
| **pWin.ai** (absorbed Vultron) | AI proposal | Capture & proposal teams; Shipley partner | Quote only | Not stated | [pwin.ai](https://www.pwin.ai/) |
| **VisibleThread** | Compliance & proposal AI | Large contractors → small teams | Quote, annual per user; free trial | Not stated | [visiblethread.com](https://visiblethread.com/pricing/) |
| **AutogenAI** | AI proposal | Enterprise bid teams, consultancies | Quote only | Not stated | [autogenai.com/federal](https://www.autogenai.com/federal) |
| **GovSignals** | AI proposal (defense) | Defense contractors | Flat annual fee | Not stated | [govsignals.ai](https://www.govsignals.ai/pricing) |
| **Rohirrim** | AI proposal | Contractors, consulting firms | Quote only | Not stated | [carahsoft.com/rohirrim](https://www.carahsoft.com/rohirrim) |
| **Civio** | AI RFP response | Gov sellers | (unverified) | (unverified) | [g2.com/sellers/civio](https://www.g2.com/sellers/civio) |
| **JAMIS Prime** | ERP | Federal contractors | Quote only | No | [jamis.com](https://www.jamis.com/) |
| **PROCAS** | DCAA accounting | Small contractors | Quote | No | [procas.com](https://www.procas.com/dcaa-compliant-accounting/) |
| **BidNet Direct** (Periscope) | State & local bids | SLED vendors | Free tier; ~$599–$1,999/yr (third-party) | No | [bidnetdirect.com](https://www.bidnetdirect.com/) |
| **Starbridge** | State & local (AI) | Enterprise SLED sales | Quote only | No | [starbridge.ai](https://starbridge.ai/) |
| **Civic IQ / Pursuit** | State & local (AI) | SLED sales teams | Quote / credit-based | No | [civiciq.com](https://civiciq.com/), [pursuit.us](https://www.pursuit.us/) |
| **Responsive, Loopio, Inventive AI** | Commercial RFP tools | Enterprise sales teams | Quote | No | [responsive.io](https://www.responsive.io/), [loopio.com](https://loopio.com/pricing/), [inventive.ai](https://www.inventive.ai/) |
| SAM.gov, USAspending.gov | Free government sites | Everyone | Free | — | [sam.gov](https://sam.gov), [usaspending.gov](https://www.usaspending.gov) |

Defunct or exiting: **Privia** (discontinued after the Xait acquisition), **Vultron** (customers moved to pWin.ai).

#### Where Bytescon stands
- **Bytescon's clearest advantages:**
  - managing **many client companies** in one workspace, with **white-label branding** and a **client portal**;
  - **post-award finance** (DCAA timekeeping, invoicing);
  - a **calibrated win probability** with a Bid Prime / Bid Sub / No Bid call;
  - a **low published price** ($99/month).

  No competitor checked combines these.
- **Closest on multi-client:** GovEagle, CLEATUS, Federal Compass. GovEagle is the most direct threat (consultant-specific, but quote-priced, reportedly $30K–$100K+ per year per a [job posting](https://www.workatastartup.com/jobs/88320)).
- **Cheaper than Bytescon:** FedScout, Fed-Spend, Gov Contract Finder, CLEATUS's data tier. All four are discovery-focused, without post-award finance.

---

## 5. What are competitors doing that we are missing?

### Concise answer

The **top 10 gaps**, each offered by several competitors:

1. **Security certifications and government hosting** — FedRAMP (Moderate Equivalency or higher), SOC 2 Type II, CMMC L2, GovCloud or single-tenant hosting.
2. **Microsoft Word add-in** — draft and check compliance inside Word.
3. **Government contact database** — 1–2 million buyer and industry contacts.
4. **More opportunity sources** — GSA eBuy, contract-vehicle task orders, PIEE, DLA DIBBS, SBIR/STTR.
5. **CRM sync** — two-way with Salesforce and HubSpot, plus Zapier.
6. **Document library sync** — SharePoint and Google Drive.
7. **AI review of proposals** — AI "pink team" checks for compliance, hallucination and citations.
8. **AI watchers** — AI that triages every new saved-search hit and monitors news and the web.
9. **Pricing depth** — a labor-rate database, auto-generated work breakdown and basis of estimate, and ready-made cost-volume formats.
10. **Post-award extras** — CPARS tracking, and AI reading of contract modifications.

**Manual (service) offerings** some competitors add:
- analyst-verified forecasts (GovWin's 150+ analysts);
- managed pipeline-building services (Civic IQ, Starbridge);
- coaching (FedScout);
- "pipeline or refund" guarantees (Pursuit).

### Detailed answer

**Legend:** ⚙️ automatic (software feature) · 🧑 manual (human service) · ⚙️🧑 both

| # | Missing in Bytescon | Type | Who offers it | Sources | Suggested action |
|---|--------------------|------|---------------|---------|------------------|
| G1 | **FedRAMP Moderate Equivalency / Authorization, SOC 2 Type II, CMMC L2, GovCloud or single-tenant hosting** | 🧑 (audit) + ⚙️ (hosting) | Procurement Sciences, GovDash, pWin.ai, Unanet, Deltek, VisibleThread, GovSignals, AutogenAI, GovEagle | [govdash.com/security](https://www.govdash.com/security), [Unanet FedRAMP](https://unanet.com/erp-for-govcon/fedramp), [visiblethread.com/pricing](https://visiblethread.com/pricing/) | Start SOC 2 Type II now; plan CMMC L2 and FedRAMP Moderate Equivalency |
| G2 | **Word / Office add-in** (draft, check compliance, insert cited content in Word) | ⚙️ | GovDash, pWin.ai, GovEagle, Awarded AI, Deltek Costpoint Proposals | [govdash.com/proposal](https://www.govdash.com/proposal), [pwin.ai](https://www.pwin.ai/), [Deltek](https://www.deltek.com/products/erp/costpoint/proposals/) | Build a Word add-in on top of the existing proposal workspace |
| G3 | **Government buyer & industry contact database** | ⚙️ (data) | GovTribe (1.1M+), Federal Compass (2M+), HigherGov, GovSpend/Fedmine, TechnoMile, CLEATUS, Starbridge | [govtribe.com](https://www.govtribe.com/), [federalcompass.com](https://www.federalcompass.com/) | License or build from SAM/FPDS contracting-officer data; Bytescon's CRM today holds only user-entered contacts |
| G4 | **GSA eBuy, contract-vehicle task orders, PIEE, DLA DIBBS, SBIR/STTR** | ⚙️ | Govly (40+ vehicles), GovTribe Pro (eBuy), HigherGov, GovDash, CLEATUS, SamSearch, Sweetspot | [govly.com](https://www.govly.com/), [govtribe.com/pricing](https://govtribe.com/pricing), [cleat.ai/pricing](https://cleat.ai/pricing) | Add DIBBS and SBIR adapters first (public); eBuy needs customer credentials or email import |
| G5 | **Two-way Salesforce / HubSpot sync, Zapier** | ⚙️ | GovTribe, GovSpend, Govly, SamSearch, Sweetspot, GovDash, Starbridge, HigherGov (Zapier) | [govtribe.com](https://www.govtribe.com/), [govspend.com](https://govspend.com/govspend-platform/) | Add a Salesforce/HubSpot connector to the existing integrations framework |
| G6 | **SharePoint / Google Drive library sync** | ⚙️ | GovDash, VisibleThread, Sweetspot, GovEagle, Inventive | [govdash.com](https://www.govdash.com/), [visiblethread.com](https://visiblethread.com/) | Sync the capability, past-performance and template libraries |
| G7 | **AI proposal review** (AI pink/red team, hallucination and citation checks, page-level sources) | ⚙️ | pWin.ai, Procurement Sciences, VisibleThread, GovDash | [pwin.ai](https://www.pwin.ai/), [procurementsciences.com](https://www.procurementsciences.com/) | Add an AI reviewer to the existing color-team rounds; humans still approve |
| G8 | **AI triage of new opportunities and agents that watch the web** | ⚙️ | GovTribe (pursue/partner/weak sorting), Sweetspot (Agentic Monitors), GovDash (scheduled agents), GovSpend | [govtribe.com](https://www.govtribe.com/), [sweetspot.so](https://sweetspot.so/) | Extend the Opportunity agent to label each new match |
| G9 | **Labor-rate database, price-to-win, auto WBS/BOE, cost-volume formats** | ⚙️ | HigherGov, GovWin, GovDash Pricer, Deltek ProPricer (100+ formats), CLEATUS | [deltek.com/propricer](https://www.deltek.com/products/propricer/), [govdash.com/pricer](https://www.govdash.com/pricer) | Add a labor-rate benchmark (e.g. from GSA CALC data) and BOE fields to the pricing workspace |
| G10 | **CPARS tracking; AI reading of contract modifications** | ⚙️ | GovDash Contract, Procurement Sciences | [govdash.com/contract](https://www.govdash.com/contract) | Add CPARS fields and AI extraction to contract mods (human confirms) |
| G11 | **RFI / sources-sought response mode** | ⚙️ | pWin.ai (RFI Accelerator), VisibleThread, Rogue | [pwin.ai](https://www.pwin.ai/) | Reuse the proposal drafter for short responses |
| G12 | **Pre-RFP signals from budgets and public meetings** | ⚙️ / 🧑 | GovSpend (meeting transcripts), Govly (budget docs), Starbridge, Civic IQ, Fedmine (Exhibit 53), GovWin (analysts) | [govspend.com](https://govspend.com/govspend-platform/), [govspend.com/fedmine-platform](https://govspend.com/fedmine-platform/) | Start with agency budget documents (public) |
| G13 | **Contract-vehicle intelligence** (who holds which vehicle, remaining ceiling) | ⚙️ | FedScout, GovTribe (4,126 vehicles), Fedmine, Govly | [fedscout.com](https://www.fedscout.com/), [govtribe.com](https://www.govtribe.com/) | Derive from FPDS/USAspending IDV data already ingested |
| G14 | **Native iOS / Android apps** | ⚙️ | FedScout, Gov Contract Finder | [fedscout.com](https://www.fedscout.com/) | Low priority — Bytescon's installable web app covers approvals |
| G15 | **Shipley templates / methodology** | ⚙️ | pWin.ai (Shipley's exclusive AI partner), Unanet (Shipley-compatible gates) | [shipleywins.com](https://www.shipleywins.com/news/ai-powered-proposals-shipleys) | Offer Shipley-style gate templates in gate reviews |
| G16 | **Outbound email sequences / sending from the app** | ⚙️ | Starbridge, Civic IQ | [starbridge.ai](https://starbridge.ai/) | "Send after approval" from a connected mailbox (see section 3, #12) |
| G17 | **Free read-only / "flex" seats** | Pricing | SamSearch, GovDash | [samsearch.co/pricing](https://www.samsearch.co/pricing), [govdash.com/pricing](https://www.govdash.com/pricing) | Free viewer seats would suit consultants' clients |
| G18 | **Canadian tenders** | ⚙️ | GovWin, SamSearch | [deltek.com/govwin](https://www.deltek.com/en/govwin) | Optional |
| G19 | **Analyst-verified forecasts and intelligence** | 🧑 | Deltek GovWin IQ (150+ analysts) | [deltek.com/govwin](https://www.deltek.com/en/govwin) | Not realistic to copy; Bytescon's honest "forecast vs confirmed" labels are a fair alternative |
| G20 | **Managed services** (pipeline building, coaching, guarantees) | 🧑 | Civic IQ (managed pipeline), Starbridge (outbound agency), FedScout (coaching), Pursuit ("$1M pipeline in 90 days or refund") | [pursuit.us](https://www.pursuit.us/1m-guarantee), [fedscout.com](https://www.fedscout.com/) | Bytescon's customers *are* consultants — partner with them rather than compete |

#### What Bytescon already has that competitors advertise
MCP connection for AI assistants, public API, amendment tracking, compliance matrix, AI drafting with human sign-off, teaming recommendations,
state & local and grants coverage. These are on par, not gaps.

#### Suggested priority
1. **Security credentials (G1):** without them, larger buyers can't use Bytescon for sensitive (CUI) work.
2. **Word add-in (G2) and AI review (G7):** this is where proposal writers spend their time.
3. **Contacts (G3), new sources (G4) and CRM sync (G5):** the most visible discovery gaps.
4. **Pricing depth (G9) and post-award extras (G10):** these build on Bytescon's finance strength.
