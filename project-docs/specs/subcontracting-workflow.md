# Subcontracting Workflow (SCW) — As-Built Spec

**Purpose:** Explain how Bytescon helps a small business win work as a *subcontractor*: find primes that win similar work, show how those primes subcontract, find someone to contact, draft an outreach email, and surface subcontracting leads. This replaces the lost `SUBCONTRACTING_WORKFLOW_SPEC.md`, which code comments still cite.

**Status: as-built spec reconstructed from code on 2026-11-03; original lost. If this and the code disagree, the code wins.**

## Simple version

Some contracts are better won as a helper (a "sub") to a bigger company (a "prime") than alone. For one opportunity, Bytescon looks at public award history and ranks up to 10 primes that keep winning that kind of work at that agency. It shows how those primes have subcontracted in the past and who to contact there. It can write a draft email to a prime, but a person must review it, and approving it never sends it. Separately, a Subcontracting page collects posted sub leads from SBA and SAM.gov, and a Prime Contacts page keeps every contact it has ever seen.

---

## 1. Where the original spec's numbering came from

Code comments cite `SUBCONTRACTING_WORKFLOW_SPEC.md` by section. The section map below comes from those citations:

| Spec ref | What code says it covered | Cited in |
|---|---|---|
| §2 / §2.2 | Principle: "cite the data source" (citation strings in the UI) | `services/scw/likelyPrimes.ts`, `components/scw/SubcontractingPath.tsx` |
| §2.3 | Principle: weighted-sum confidence, "never return a confidence value without the decomposition" | `services/scw/confidence.ts`, `SubcontractingPath.tsx` |
| §2.5 | Principle: "no silent failures" (every null field gets a warning) | `likelyPrimes.ts`, `subawardAnalysis.ts`, `confidence.ts` |
| §2.7 | Principle: approval does NOT send email | `components/scw/OutreachDraftModal.tsx` |
| §3 SCW-1…SCW-6 | The six phases (see section 2) | all SCW files |
| §4 | Data model (`ScwSubawardAnalysis`) | `prisma/schema.prisma` comment |
| §5 | HTTP routes | `routes/scw.ts` header |
| §6 Phase 4 / Phase 5 | Build phases: Phase 4 = read-only Subcontracting Path + 7-day subaward cache; Phase 5 = outreach drafting modal | `subawardAnalysis.ts`, `SubcontractingPath.tsx`, `OutreachDraftModal.tsx` |

Comments also cite `docs/scw/data-layer-introspection.md` §9 (risk "R4"). **That file does not exist in the repo either.** What R4 says is recoverable from the comments: USAspending's `/api/v2/subawards/` endpoint does not return sub-recipient set-aside flags, NAICS, size, or UEI, so any SDVOSB/small-business subaward percentage cannot be computed.

---

## 2. The SCW phases (label → code)

`SCW-` appears on 52 lines (53 occurrences) across 16 files in backend/src, frontend/src and mcp. Breakdown: SCW-1 ×13, SCW-2 ×7, SCW-3 ×1, SCW-4 ×16, SCW-5 ×10, SCW-6 ×5 (including "SCW-6.1" ×1), and one bare "SCW-" in `backend/src/gb106/README.md` (it refers to "SCW-email objects that are not yet in `schema.prisma`").

| Phase | What it is | Main code | Status |
|---|---|---|---|
| **SCW-1** Likely Prime Identifier | Rank the top 10 primes for an opportunity by a 5-part confidence score | `backend/src/services/scw/likelyPrimes.ts`, `backend/src/services/scw/confidence.ts` | Built |
| **SCW-2** Subaward History Analysis | For one prime: total subaward $, average sub size, sample size; SDVOSB/small-business/NAICS fields ship as `null` with warnings | `backend/src/services/scw/subawardAnalysis.ts` | Built (partial data, see §6) |
| **SCW-3** Prime contact | Only one mention: "SCW-3 will add a UI affordance to switch" the primary contact (`likelyPrimes.ts`). **(inferred)** SCW-3 was prime contact sourcing and selection. No SCW-3-labelled code exists; contact display is done inside SCW-1, and a contact switcher is not built. | `likelyPrimes.ts` `buildContact()` | Partial / not built |
| **SCW-4** Outreach Generator | LLM-drafted email to a prime, fact-checked, saved as a draft that needs human review | `backend/src/services/scw/outreachGenerator.ts`, `recipientEmailResolver.ts`, `frontend/src/components/scw/OutreachDraftModal.tsx` | Built |
| **SCW-5** Notification System | In-app "Subcontracting Inbox" of BID SUB opportunities (live query, v1). SMS and email digest NOT shipped | `backend/src/services/scw/notifications.ts`, `frontend/src/components/scw/ScwInbox.tsx` | v1 only |
| **SCW-6** Subcontracting Path UI | Section on the opportunity detail page showing SCW-1 primes, breakdowns, SCW-2 panel, and the Draft Outreach button | `frontend/src/components/scw/SubcontractingPath.tsx`, mounted in `frontend/src/pages/OpportunityDetail.tsx` | Built |

Not labelled SCW but part of the same feature area (the Subcontracting and Prime Contacts pages):

| Piece | Main code |
|---|---|
| Subcontracting leads (SBA SUBNet + SAM.gov set-asides) | `backend/src/routes/subcontracting.ts`, `backend/src/services/subnetScraper.ts`, `frontend/src/pages/SubcontractingPage.tsx` |
| Perpetual prime-contact pool | `backend/src/services/scw/subcontractContacts.ts`, `backend/src/routes/subcontractingContacts.ts`, `frontend/src/pages/PrimeContactsPage.tsx` |
| Federal prime SBLO directory seed | `backend/src/services/scw/primeDirectorySeed.ts`, `backend/src/data/primeSbloDirectory.ts` |
| Lead expiry / purge | `backend/src/services/scw/subcontractExpiry.ts`, `backend/src/workers/subcontractMaintenanceWorker.ts` |
| Contact enrichment providers | `backend/src/services/contactProviders/` (`samPocProvider.ts`, `clayProvider.ts`) |
| Older agency-level teaming outreach ("Phase E") | `backend/src/services/teamingOutreachService.ts` via `POST /api/agency/draft-outreach` |

---

## 3. User flow

1. **Dashboard.** `ScwInbox` (SCW-5) shows BID SUB opportunities that qualify (see section 8). It renders nothing when empty. Each row links to `/opportunities/:id#scw`.
2. **Opportunity detail.** `SubcontractingPath` (SCW-6) has `id="scw"` in every render state and scrolls into view when the URL hash is `#scw`. It calls `GET /api/scw/opportunities/:id/primes`.
   - It shows the top 5 primes, and "Show all" shows up to 10.
   - Clicking "Confidence X.XX" expands the 5-component breakdown, the citation, and a `SubawardAnalysisPanel` (SCW-2, `GET /api/scw/primes/:identifier/subaward-analysis`). The identifier is the UEI when known, otherwise the prime name.
   - Missing data is shown as text, not hidden: "Contact not on file" with a SAM.gov entity-search link, "SDVOSB status unverified", and similar.
   - Buttons: **Draft Outreach** (enabled) opens `OutreachDraftModal`. **Add to Capture Plan** is disabled ("Coming in v2 (capture-plan integration)"). "View History" is not rendered.
   - With no primes, the page says: "No historical primes found in USAspending for this NAICS + agency over the past 5 years…"
3. **Outreach modal** (SCW-4). The user picks an outreach type (`cold_first_touch`, `warm_follow_up`, `urgent_deadline_driven`) and pastes a capability statement (required, inline in v1). They then generate. The modal shows the draft, `factsCited`, the recipient email with a verification badge (`verified` / `probable` / `unknown`), and the review checklist. **Approve draft** is enabled only after every checklist item is ticked. Approving calls `PATCH /api/scw/outreach/drafts/:id/approve`. The user copies the text into their own email client. Copy writes `Subject: …` plus the body to the clipboard.
4. **Subcontracting page** (`/partners/subcontracting`). "Sync from SUBNet" calls `POST /api/subcontracting/sync`, which runs in the background and returns at once. The list shows an expiry pill (`active` / `expiring_soon` / `expired`). Per-row actions: **Save to pipeline** and **Dismiss** (the browser prompts for a reason).
5. **Prime contacts page** (`/partners/contacts`). This page searches and filters the contact pool and shows stats. It can delete a contact or run **Prune**. Source labels: `sba_subnet` → "SBA SUBNet", `sam_setaside` → "SAM.gov", `manual` → "Added manually", `dla_captains_of_industry` → "DLA directory", `dod_csp_prime_directory` → "DoD CSP directory".

Navigation: `frontend/src/navigation.ts` lists "Teaming", "Subcontracting" and "Prime contacts" as tabs of the `/partners` hub, each tagged `module: 'teaming_suite'`.

---

## 4. HTTP API

All routers use `authenticateJWT`, `enforceTenantScope`, `requireActiveBase`, `requireAddon('teaming_suite')`. Responses use `{ success, data }`.

### `/api/scw` (`backend/src/routes/scw.ts`)

| Method + path | Does | Notes |
|---|---|---|
| `GET /opportunities/:opportunityId/primes` | `findLikelyPrimes` → up to 10 `LikelyPrime` | 404 if the opportunity belongs to another tenant |
| `GET /primes/:identifier/subaward-analysis` | `analyzeSubawards` | `:identifier` is treated as a UEI if it matches `/^[A-Z0-9]{12}$/` (after uppercasing), otherwise as a URL-encoded name. `?lookbackYears` is clamped to 1–10, default 3. The data is platform-wide (not tenant-scoped), but a JWT is still required. |
| `POST /outreach/draft` | `draftScwOutreach` | Body: `opportunityId`, `primeUei` or `primeName`, `outreachType`, `tenantCapabilityStatement` (all validated) |
| `GET /outreach/drafts` | List the tenant's drafts, newest first, max 100 | Filters: `?opportunityId`, `?requiresHumanReview=true|false`. There is a frontend client (`scwApi.listOutreachDrafts`), but no page calls it. |
| `PATCH /outreach/drafts/:id/approve` | Sets `requiresHumanReview=false`, `humanApprovedAt`, `humanApprovedById`; writes an `APPROVAL` audit event | **Does not send.** The server does not check the checklist; only the UI enforces it. |
| `GET /notifications/inbox` | `getNotificationInbox` | `?limit` is clamped to 1–100, default 25 |

### `/api/subcontracting` (`backend/src/routes/subcontracting.ts`)

| Method + path | Does |
|---|---|
| `GET /opportunities` | List with filters `search`, `naicsCode`, `setAside`, `agency`, `status`, `limit` (max 200), `offset`. Hides `DISMISSED` unless `status` or `includeDismissed=true` is given. Hides rows more than 7 days past their deadline unless `includeExpired=true`. Adds `expiryState` to each row. |
| `GET /stats` | Total, counts by set-aside, OPEN count |
| `POST /sync` | Responds immediately. Runs in the background via `setImmediate`. See section 5. |
| `POST /opportunities` | Manual add (`title` and `primeContractor` required). Calls `captureContact` with `source: 'manual'`. |
| `DELETE /opportunities/:id` | Hard delete |
| `POST /opportunities/:id/save-to-pipeline` | In one transaction: creates an `Opportunity` titled `"<title> (sub to <prime>)"` (source `MANUAL`; deadline defaults to now + 30 days), creates a `BidPursuit` (`IDENTIFIED`), and sets the lead to `SAVED`. Returns 409 `ALREADY_SAVED` on repeat. |
| `POST /opportunities/:id/dismiss` | A reason is required (otherwise 422). Sets `DISMISSED`, `dismissedReason`, `dismissedAt`. |

### `/api/subcontracting/contacts` (`backend/src/routes/subcontractingContacts.ts`)

This router is mounted *before* `/subcontracting` in `server.ts`, so it matches first.

| Method + path | Does |
|---|---|
| `GET /` | Search across `primeContractor`, `contactName`, `contactEmail`. Filters: `agency`, `naicsCode`, `prime`, `source`. Ordered by `lastSeenAt desc`. |
| `GET /stats` | Total, distinct primes, top 10 agencies, top 10 NAICS, counts by source |
| `DELETE /:id` | Delete one contact |
| `POST /prune` | `pruneContacts({ consultingFirmId })` |

---

## 5. Data sources

| Source | Used for | Code | Notes |
|---|---|---|---|
| `winners_award_stage` (USAspending prime awards, filled by Winners Intel) | SCW-1 ranking, SCW-2 totals, SCW-4 prime stats | `likelyPrimes.ts`, `subawardAnalysis.ts`, `outreachGenerator.ts` | **Only filled when `ENABLE_WINNERS_INTEL=true`** (see `winners-intel.md`). If it is empty, SCW-1 returns `[]`. |
| `winners_subaward_stage` | SCW-2 and the subaward-propensity component | same | Only name, amount, date and description are populated (see section 6) |
| `recipient_profiles` (SAM entity cache) | SDVOSB exclusion, business size, cached contacts | `likelyPrimes.ts` via `readCachedContacts()` in `services/recipientProfileService.ts` | |
| SBA SUBNet (HTML scrape) | Sub leads | `subnetScraper.ts` `fetchSubnetOpportunities()` | URL `https://legacy.sba.gov/federal-contracting/contracting-guide/prime-subcontracting/subcontracting-opportunities` (moved 2026-09). Up to 3 pages. NAICS filter matches the exact code, 4-digit prefix, or 2-digit sector. Logs an error if 0 results. |
| SAM.gov Opportunities API | Sub/teaming leads ("Open Solicitation — Teaming Opportunity") | `fetchSamSetAsideBroad()` | Last 120 days, `ptype=p,k,r,s`, `limit=100`. With NAICS: one request per code, **first 5 codes only**. Without NAICS: filters to 10 set-aside codes (`SBA, SBP, 8A, 8AN, HZC, HZS, SDVOSBC, SDVOSBS, WOSB, EDWOSB`). Key: the firm's `samApiKey` (decrypted), else `SAM_API_KEY`. |
| USAspending `search/spending_by_award` | Fills empty `estimatedValue` with the median award per NAICS over the last 365 days | `enrichValueFromUsaSpending()` | Up to 10 NAICS, 200 rows |
| Baked prime SBLO directory | Seeds the contact pool on each sync | `data/primeSbloDirectory.ts` (generated from `backend/data-sources/prime-sblo-directory.csv` by `backend/scripts/genPrimeSbloDirectory.mjs`) | 35 rows: 18 `dla_captains_of_industry`, 17 `dod_csp_prime_directory`. Refreshed by hand because both publishers return 403 to non-browser clients. |
| SAM.gov entity POCs / Clay | Recipient email for SCW-4 | `contactProviders/` | See section 9 |

**Sync flow** (`POST /api/subcontracting/sync`):
1. The NAICS list is the union of `naicsCodes` across the tenant's active `ClientCompany` rows.
2. SUBNet, SAM and the value lookup run in parallel. If NAICS-filtered SUBNet returns nothing, it re-fetches unfiltered.
3. Each lead is upserted by `externalId` (`sba-subnet-<slug>` or `sam-setaside-<noticeId>`), then `captureContact()` runs.
4. If `PRIME_DIRECTORY_SEED_ENABLED` (default **true**), `seedPrimeDirectoryContacts()` runs.
5. An `UPDATE` audit event is written with counts.

---

## 6. SCW-1 and SCW-2 rules

### SCW-1 `findLikelyPrimes({ opportunityId, consultingFirmId })`
- Loads the opportunity scoped to the tenant (`NotFoundError` otherwise). Returns `[]` if it has no NAICS or no agency.
- Agency match: the first dotted segment of `Opportunity.agency` + `%`, ILIKE'd against `agencyToptierName`.
- Pass 1: group `winners_award_stage` by `recipientName` with the same NAICS, matching agency, `awardDate >= now − 5 years`. Order by count, then dollars. **LIMIT 50.**
- Grouping is by **name**, because UEI coverage was "381 / 11,222 rows" when written. UEI = `MAX(recipientUei)` per name.
- Pass 2: load `RecipientProfile` by UEI. **Primes known to be SDVOSB are excluded.** Primes with no profile are kept, with warning "SDVOSB status unverified…".
- Pass 3: subaward stats per name in the same window.
- Score (`confidence.ts`, weights must sum to 1.0, checked when the module loads):

| Component | Weight | Raw score | Component confidence |
|---|---|---|---|
| `awardFrequency` | 0.30 | count / top count | 1.0 if ≥5, 0.75 if ≥3, 0.5 if ≥2, else 0.3 |
| `awardRecency` | 0.20 | `0.5^(years/2)` (2-year half-life) | 1.0 if date known |
| `dollarVolume` | 0.15 | log10 ratio to the top value | 1.0 if ≥$10M, 0.75 ≥$1M, 0.5 ≥$100K, else 0.3 |
| `subawardPropensity` | 0.20 | sub$/award$ shrunk toward prior 0.30 with `SUBSPEND_PRIOR_DOLLARS = 50_000_000` | `min(1, n/30)`; 0 if no rows |
| `sdvosbGoalGap` | 0.15 | `0.5 + gap/6` vs 3.0% goal | **Always 0 today**: `hasGoalData` is hard-coded `false` |

- `composeConfidence` **drops components with confidence 0 from both numerator and denominator** and reports `coverage` (the share of weight that was scored). `topReasons` = the top 3 by weighted × confidence.
- Output is sorted by composite and cut to the top 10. Each prime gets a `citation` string ("Based on past awards in NAICS … USAspending V2 corpus.").
- Contact `source`: `recipient_profiles_cache`, or `manual_research_required`. `sam_gov_live` is in the type but never produced.

### SCW-2 `analyzeSubawards({ primeUei?, primeName?, lookbackYears=3 })`
- Cache key `primeKey` = `uei:<UEI>` or `name:<UPPERCASE NAME>`, unique with `lookbackYears`. TTL is **7 days** (`ScwSubawardAnalysis.expiresAt`).
- Computed: `totalSubawardDollars`, `averageSubSize`, `sampleSize` (`distinctSubs` is logged only).
- Always `null`: `smallBusinessSubAwardPercent`, `sdvosbSubAwardPercent`, `topNaicsSubbed`. `sdvosbGoalGap.underPressure` is always `false` and `source: 'unknown'`. A warning explains why on every call.
- Lookback caveat: Winners Intel pulls only a **24-month** window, so SCW-1's 5-year and SCW-2's 3-year lookbacks only find older rows that are still in the staging table (for example, IDVs with old award dates). **(inferred)**: in practice the window is about 24 months.

---

## 7. SCW-4 outreach drafting rules (approval never sends)

`draftScwOutreach()` in `outreachGenerator.ts`:

1. Validation: needs `primeUei` or `primeName` and a non-empty `tenantCapabilityStatement`. The opportunity is loaded scoped to the tenant.
2. Prime stats: 5-year NAICS + agency window from `winners_award_stage`. **If `pastAwardsCount === 0`, it throws `ValidationError`** ("cannot ground an outreach").
3. SCW-2 analysis (3 years) is loaded for subaward facts.
4. A structured **FACTS** JSON block is built, with numbers pre-formatted (for example `$854.0M`). The SDVOSB goal and actual are included **only if** `underPressure` is true. Today it never is, so the SDVOSB angle never appears.
5. LLM call through `generateWithRouter` with task `TEAMING_OUTREACH`, `maxTokens 1500`, `temperature 0.4`. One variant per call. The spec's "three variants" is deferred to a v2 re-roll button.
6. The system prompt requires: use only FACTS, quote numbers verbatim, no placeholders, a generic salutation if there is no contact name, 150–250 words, ask for a "15-minute introductory call", return JSON `{subject, salutation, body, closing, factsCited[]}`.
7. **Fact-check** (`factCheckOrThrow`). Any failure throws `ValidationError`, and the user must re-roll:
   - every `$…[KMB]` token in the body must appear in FACTS or `factsCited`;
   - every 2–4 digit integer (except 1900–2099) must appear in FACTS or `factsCited`;
   - if there is no contact name, the salutation must not match `Mr./Ms./Mrs./Dr./Mx. Name`.
8. Review checklist: 5 standard items, plus an SDVOSB item, plus recipient-email items (GB-104).
9. Saved as `ScwOutreachDraft` with `requiresHumanReview: true`. An `LLM_INFERENCE` audit event (`llmTask: 'scw_outreach_draft'`, `promptHash` = sha256 of system + user prompt) is written.
10. **No send path exists.** `sentAt` is "always null in v1". Approve only flips the review flags. `autoSendBlocked` is returned to the UI, but nothing consumes it for sending.

Differences from the older `teamingOutreachService.ts` ("Phase E", `POST /api/agency/draft-outreach`, also gated `teaming_suite`):
- That service **deducts 1 proposal token** after success. SCW-4 does not charge tokens.
- It picks a contact role (SBLO / OSDBU / Capture Manager) from the teaming-fit score.
- It does not persist a draft or run a fact-check.

---

## 8. SCW-5 notifications (v1 = in-app only)

`getNotificationInbox({ consultingFirmId, limit=25 (max 100) })` is a **live query with no persistence and no "acknowledged" state**:
- Opportunity in the tenant, `responseDeadline >= now + 5 days`, and at least one `BidDecision` with `recommendation = 'BID_SUB'` (produced by `backend/src/engines/decisionResolver.ts`).
- It fetches `limit × 2` candidates and runs `findLikelyPrimes` for each, sequentially. It keeps the opportunity only if some prime has `composite >= 0.6`.
- It returns the top 3 primes, `winProbability` (`probabilityScore`), `netExpectedValue`, and `ctaUrl` `/opportunities/<id>#scw`.

**Header claims vs code:**
- The header lists "tenant has SDVOSB cert and the opportunity's set-aside matches" as a trigger. **The code does not check either.**
- The header says SMS and the weekly digest "are scaffolded with TODO comments below". **There are no TODO comments.** The file has only a prose "Deferred to follow-up" block.

**Not shipped:**
- **Email digest.** The intended design was to extend `backend/src/workers/watchlistDigestWorker.ts` with a daily pass that calls `getNotificationInbox()` and sends HTML from `brandedEmailTemplates`.
- **Twilio SMS.** The intended rules were max 1 SMS per tenant per 24h, sent when `daysRemaining < 10` and confidence `>= 0.75`, using the existing Twilio integration (`backend/src/services/smsService.ts` exists). It was skipped because "the rate-limiting + opt-in flow needs operator UX that doesn't yet exist".

`ScwInbox` refetches with `staleTime` 60s and on window focus, and shows 5 rows by default.

---

## 9. Contact sourcing rules

**Three different contact paths. Don't mix them up.**

1. **Contact pool (`SubcontractContact`)** comes from lead POCs plus the SBLO directory.
   - `captureContact()` is a best-effort, per-tenant upsert keyed on `dedupeKey`: `email:<lowercased>` if the email is valid, else `name:<prime-slug>|<name-slug>`. No name and no valid email → not captured.
   - Repeat sightings bump `timesSeen` and `lastSeenAt`. "Latest non-null wins" for fields. `hasValidEmail` can only go up, never down.
   - It never throws: it logs and returns `null`.
   - Contacts outlive their opportunity: `lastOpportunityId` is deliberately not a foreign key.
2. **SCW-1 display contact** comes from `RecipientProfile.contactsJson` (via `readCachedContacts`). It uses the first row with a name, email or phone, else `profile.phone`, else `manual_research_required`.
3. **SCW-4 recipient email (GB-104)** is gated by `SCW_EMAIL_ENRICHMENT_ENABLED` (default **off**; read straight from `process.env` in `recipientEmailResolver.ts`, even though `config.scw.emailEnrichmentEnabled` also exists).
   - When on: it uses cached contacts. If none has an email and a UEI is known, it calls `enrichContacts(uei)` once. Provider errors become "no email".
   - `resolveRecipientEmail()` ranks `verified` > `probable` > `unknown`, then prefers named contacts.

**"Probable" rule.** Only `verified` may ever auto-send (`canAutoSend`). Everything else needs a human to confirm the address.
- SAM.gov POCs → `probable` if an email is present, else `unknown` (`samPocProvider.ts`).
- Clay → `verified` only when `emailStatus` is `valid`, `deliverable` or `verified`. Invalid, undeliverable or bounced → `unknown`. Otherwise `probable`.
- Missing or unknown provider status → `probable`, never `verified`.
- The directory corpus header says: "never mark them `verified` and never auto-send to them (GB-104)", and any outbound use must meet CAN-SPAM.

**Clay comes last.** In `contactProviders/index.ts` the registry order is `[samPocProvider, clayProvider]`. `getDefaultProvider()` returns the **first available** provider:
- `sam_poc` needs `SAM_API_KEY`.
- Clay needs `CLAY_ENRICHMENT_ENABLED` and `CLAY_API_KEY` (optional `CLAY_BASE_URL`, default `https://api.clay.com/v3`, path `/enrich/contacts`).
- This is **not a cascade**. If SAM is available and returns no contacts, Clay is not tried. Clay is the default only when SAM is unavailable.
- `clayProvider.ts` calls itself "a wiring foundation, not a live integration". The request and response shapes are unconfirmed.
- Results are capped at 50 and written to `RecipientProfile.contactsJson`.

---

## 10. Data model (Prisma)

| Model / table | Scope | Key fields | Notes |
|---|---|---|---|
| `ScwSubawardAnalysis` / `scw_subaward_analyses` | Platform-wide cache | `primeKey`, `lookbackYears` (unique together), `totalSubawardDollars`, `averageSubSize`, `sampleSize`, `smallBusinessPercent`, `sdvosbPercent`, `topNaicsSubbed`, `sdvosbGoalGap` (JSON), `dataQuality` (JSON), `expiresAt` | 7-day TTL. Schema comment: `underPressure=true when gap > 0.5%` (not implemented, since the gap is never computed). |
| `ScwOutreachDraft` / `scw_outreach_drafts` | Tenant | `opportunityId` (cascade), `primeUei`, `primeName`, `outreachType` (string), `subject`, `body`, `salutation`, `closing`, `factsCited`, `reviewChecklist`, `requiresHumanReview` (default true), `humanApprovedAt`, `humanApprovedById`, `sentAt`, `recipientEmail`, `emailVerificationStatus` (enum `verified`/`probable`/`unknown`, default `unknown`), `emailSource`, `llmProvider`, `llmModel`, `tokensUsed` | |
| `SubcontractOpportunity` / `subcontract_opportunities` | Tenant | `status` (string: `OPEN`/`SAVED`/`DISMISSED`), `externalId` **(globally `@unique`)**, `savedOpportunityId`, `dismissedReason`, `dismissedAt`, `scrapedAt` | Purged 7 days after the deadline |
| `SubcontractContact` / `subcontract_contacts` | Tenant | unique `(consultingFirmId, dedupeKey)`, `source`, `timesSeen`, `firstSeenAt`, `lastSeenAt`, `hasValidEmail`, `lastOpportunityId`, `lastOpportunityTitle` | Perpetual. Pruned for junk or staleness. |

The SCW services also read `WinnersAwardStage`, `WinnersSubawardStage`, `RecipientProfile`, `Opportunity`, `BidDecision` and `ConsultingFirm`.

---

## 11. Background jobs

`subcontractMaintenanceWorker.ts`, BullMQ queue `subcontract-maintenance`, job `daily-maintenance`, cron `30 3 * * *` (03:30 UTC). Started unconditionally in `server.ts`.
1. **Capture sweep**: every lead with a contact email or name → `captureContact()`. The sweep does **not** pass `source`, so the existing source is kept.
2. **Purge**: `deleteMany` of leads with `responseDeadline < now − 7 days` (`EXPIRY_GRACE_DAYS`). Leads with a null deadline are never purged.
3. **Prune** contacts across all firms:
   - junk = no name AND (no email OR `hasValidEmail=false`);
   - stale = `timesSeen <= 1` AND `lastSeenAt` older than 18 months (`DEFAULT_STALE_MONTHS`, using 30-day months).

`triggerSubcontractMaintenance()` runs it by hand.

Expiry states (`subcontractExpiry.ts`): `expired` if the deadline has passed, `expiring_soon` if it is within 7 days (`EXPIRING_SOON_DAYS`), else `active`. A null or invalid deadline counts as `active`.

---

## 12. Gating and config

| Gate | Effect |
|---|---|
| `requireActiveBase` | 402 `PLAN_REQUIRED` without an active base plan |
| `requireAddon('teaming_suite')` | 403 `ADDON_REQUIRED` on `/api/scw`, `/api/subcontracting`, `/api/subcontracting/contacts`, `/api/teaming`, and `POST /api/agency/draft-outreach` |
| `teaming_suite` add-on (`backend/src/config/addons.ts`) | "Teaming & Subcontracting", $49/mo ($42 annual), `tokensPerMonth: 5`. Alias `teaming_finder` → `teaming_suite`. |
| `SCW_EMAIL_ENRICHMENT_ENABLED` | Default off. SCW-4 recipient email lookup. |
| `PRIME_DIRECTORY_SEED_ENABLED` | Default on. Directory seeding on sync. |
| `SAM_API_KEY` | SAM leads fallback key and `sam_poc` provider availability |
| `CLAY_ENRICHMENT_ENABLED`, `CLAY_API_KEY`, `CLAY_BASE_URL` | Clay provider |
| `ENABLE_WINNERS_INTEL` | Indirect: without it the winners tables are never filled, so SCW-1, SCW-2 and SCW-4 have no data |
| `USASPENDING_BASE_URL` | Default `https://api.usaspending.gov/api/v2` |

---

## 13. Tests

Unit tests next to each service in `backend/src/services/scw/`: `confidence`, `likelyPrimes`, `outreachGenerator`, `primeDirectorySeed`, `recipientEmailResolver`, `subawardAnalysis`, `subcontractContacts`, `subcontractExpiry`. Also `contactProviders/clayProvider.test.ts`. There is no test file for `notifications.ts` or `routes/scw.ts`.

---

## 14. What's missing / known gaps

- **Lost references.** `SUBCONTRACTING_WORKFLOW_SPEC.md` and `docs/scw/data-layer-introspection.md` are cited but absent.
- **SDVOSB signal is dead.** `sdvosbGoalGap` always scores 0 and `underPressure` is always false. The proposed fixes (SAM enrichment or the BigQuery `usaspending` mirror) are not built.
- **Subaward data is thin.** Since USAspending removed bulk subaward search (about 2026-05), `subRecipientUei`, set-aside flags, size and NAICS are always null or `unknown`.
- **SCW-3 contact switcher** is not built. **Add to Capture Plan** is disabled. **View History** is hidden.
- **SCW-5:** no acknowledgement or persistence, no email digest, no SMS. The SDVOSB/set-aside trigger in the header is not enforced. The inbox runs `findLikelyPrimes` per candidate on every dashboard load, which could be slow for large tenants **(inferred)**.
- **No send path.** Approval only flags. The server does not enforce the checklist on approve. Nothing lists past drafts in the UI.
- **Capability statement** is inline only. A lookup by `tenantCapabilityStatementId` is "v2".
- **`SubcontractOpportunity.externalId` is globally unique, but leads are per tenant.** When a second tenant syncs the same SUBNet or SAM notice, the upsert updates the first tenant's row (title, value, deadline, description, `scrapedAt`) and creates nothing for the second tenant. The second tenant then never sees that lead, but its contact is still captured.
- ✅ Fixed 2026-11-04 (B25): frontend `STATUS_OPTIONS` in `SubcontractingPage.tsx` are now `OPEN`, `SAVED`, `DISMISSED`, the statuses the backend sets.
- **Stale header comments.** `SubcontractingPath.tsx` says "Draft Outreach" is disabled "pointing at Phase 5", but it is enabled. `subnetScraper.ts` still names `eweb1.sba.gov/subnet` in its top comment.
- **Contact providers are not a cascade.** Clay is only reached when `SAM_API_KEY` is unset.
- **SCW-4 charges no proposal tokens**, unlike the Phase E teaming outreach. **(inferred)** This may be intentional.
