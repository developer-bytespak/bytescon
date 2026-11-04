# Winners Intel — As-Built Spec

**Purpose:** Explain the Winners Intel pipeline. It pulls recent federal prime awards (and some subawards) from USAspending, stages them in Postgres, distills them into per-agency and per-NAICS statistics, writes those as markdown "slice" files, and, for opted-in firms, injects the matching slices into the AI proposal-draft prompt. This replaces the lost `.ai/WINNERS_INTEL_SPEC.md`, which `prisma/schema.prisma` still cites.

**Status: as-built spec reconstructed from code on 2026-11-03; original lost. If this and the code disagree, the code wins.**

## Simple version

Once a week, Bytescon downloads about two years of public "who won which government contract" data. It turns that data into short summary pages: one for everything, one per big agency, and one per industry code. When a firm that has opted in asks Bytescon to draft a proposal, the summary pages that match the opportunity are added to the AI's instructions. That way the draft knows typical award sizes and who usually wins. The whole feature is off unless an operator turns it on, and the summary pages are stored on the server's local disk, which may be wiped on redeploy.

---

## 1. Files

| File | Role |
|---|---|
| `backend/src/workers/winnersIntelRefreshWorker.ts` | BullMQ worker and schedule. Also exports `triggerWinnersIntelRefresh()` for manual runs. |
| `backend/src/services/winnersIntel/refresh.ts` | Orchestrator `runWinnersIntelRefresh()`: pull → persist → subawards → enrich → distill → write → audit |
| `backend/src/services/winnersIntel/usaspendingPull.ts` | `pullPrimeAwardsWindow()` against `POST {USASPENDING_BASE_URL}/search/spending_by_award/` |
| `backend/src/services/winnersIntel/usaspendingSubawardPull.ts` | `pullSubawardsForPrime()` against `POST {base}/subawards/` |
| `backend/src/services/winnersIntel/awardEnrichment.ts` | `enrichTopAwards()` against `GET {base}/awards/<id>/` (Phase 2B.6) |
| `backend/src/services/winnersIntel/distill.ts` | `distillFromBatch()`: pure aggregation into `PrimeWinnerSlice` objects |
| `backend/src/services/winnersIntel/render.ts` | `renderGlobalSlice` / `renderAgencySlice` / `renderNaicsSlice`: markdown text |
| `backend/src/services/winnersIntel/sliceWriter.ts` | `writeSlices()`, `readManifest()`, `readSlice()`: disk I/O, atomic writes, sha256 |
| `backend/src/services/winnersIntel/resolver.ts` | `resolveWinnersContext()`: picks slices for one opportunity under a 12K-token cap |
| `backend/scripts/triggerWinnersIntelRefresh.ts` | Host-side one-off run. Forces `ENABLE_WINNERS_INTEL=true` and defaults `DATABASE_URL`/`REDIS_URL` to localhost. Its header calls this "the SCW Phase 2C activation". |
| `backend/src/services/winnersIntel/usaspendingPull.test.ts` | The only test file: NAICS/PSC extractor regression ("[object Object]" corruption) |

Spec section refs left in code: §4.1 (staging tables, in the schema comment), §5.2 step 4 (slice caps, `distill.ts`), §7.3 (12K-token cap, `render.ts`).

---

## 2. Pipeline

```
weekly cron (Sun 04:00 UTC) / manual trigger
  └─ runWinnersIntelRefresh()  refreshBatchId = randomUUID()
       1. Prime pull       24 months, 90-day windows, ≤25 pages × 100 rows each
       2. Persist          WinnersAwardStage upsert by usaspendingAwardId
       3. Subaward pull    top 1000 awards (this batch) by obligation, 3-wide
       4. Persist          WinnersSubawardStage upsert by usaspendingSubawardId
       5. Enrich           top 500 awards missing UEI/set-aside/competition, 2-wide
       6. Distill          rows WHERE refreshBatchId = this batch
       7. Render + write   uploads/winners/** + _manifest.json (atomic)
       8. Audit            one ComplianceLog row (entityType WINNERS_INTEL_REFRESH)
```

Steps 3–7 only run when `totalRowsUpserted > 0`. Failures in steps 5 and 6–7 are caught and logged, and the refresh still reports `COMPLETED`. Only an unexpected throw elsewhere gives `FAILED`. Window and page failures increment `partialFailureWindows`.

### 2.1 Prime awards (USAspending, 24 months)
- `WINDOW_MONTHS = 24`, `CHUNK_DAYS = 90` → about 9 windows. `MAX_PAGES_PER_WINDOW = 25`. Page size is 100, so at most about 22,500 rows per refresh.
- `award_type_codes: ['A','B','C','D']`: contracts only, no grants or loans.
- Sort is always `Award Amount`; the API rejects other sort fields. **Direction alternates**: even windows `desc`, odd windows `asc`. This captures both megavehicles and small awards. The global slice prints a "Sampling note" saying percentiles are not a random sample.
- Date priority for `awardDate`: `Award Date` → `Base Obligation Date` → `Last Modified Date` → `Period of Performance Start Date`.
- Set-aside is **not** a response field of this endpoint. A set-aside-filtered pass (the "Phase 2B.5" pull) was **removed 2026-05-26** because USAspending silently ignores the `type_set_aside` filter. It had stamped wrong values, for example "Lockheed Martin stamped HZC, $48B contract". The `setAsideTypeCodes` option still exists in `pullPrimeAwardsWindow` but nothing calls it.
- Persistence: `createMany({ skipDuplicates })` in batches of 500. Rows that were skipped then get a per-row `upsert`, which refreshes the fields and moves the row to the current `refreshBatchId`. Rows with an empty `usaspendingAwardId` are dropped.

### 2.2 Subawards
- The bulk `/search/spending_by_subaward/` endpoint returns 404 since about 2026-05. The replacement `/api/v2/subawards/` takes **one `award_id`**, so the code loops over the top `SUBAWARD_TOP_N = 1000` awards of this batch by `totalObligation`.
- `SUBAWARD_PARALLELISM = 3` (lowered from 5 after 56% socket hang-ups). Per prime: `maxPages: 10`, `limit: 100`, 30s timeout, 3 retries with backoff starting at 1s.
- **Only these fields come back**: id, subaward number, description, action date, amount, recipient name. `subRecipientUei`, `subRecipientParentUei`, state, `subNaics` and `subPscCode` are null. `subRecipientSize` is `'unknown'`. `subRecipientSetAsideFlags` are all `false`.
- A one-time join check logs `subaward → prime JOIN check FAILED` if the persisted `primeAwardId` values do not match any `usaspendingAwardId`.

### 2.3 Per-award enrichment (Phase 2B.6, shipped)
- `enrichTopAwards(refreshBatchId, 500)` targets the top 500 rows by obligation where any of `recipientUei`, `setAsideType`, `competitionExtent` or `numberOfOffersReceived` is null. It fetches `/awards/<id>/` and fills UEI, parent UEI, name, `type_set_aside`, `extent_competed` and `number_of_offers_received`. Only fields it actually finds are written.
- `PARALLELISM = 2` (lowered from 5 on 2026-05-26), 30s timeout, 3 retries. Failure logs are sampled at about 1% (`Math.random() < 0.01`).
- It runs **before** distill, so top-recipient tables show UEIs and set-asides for enriched rows.

### 2.4 Distillation (`distill.ts`)
- Streams the batch's rows with a page size of 1000. Dollars are summed as integer cents.
- Produces one `global` slice, plus:
  - **agency** slices: top `TOP_AGENCY_LIMIT = 30` agencies by obligation, `sliceKey` `agency:<toptierCode>`;
  - **NAICS** slices: NAICS with at least `MIN_AWARDS_FOR_NAICS_SLICE = 50` awards, top `TOP_NAICS_LIMIT = 400` by obligation, `sliceKey` `naics:<code>`.
- Each slice contains: award count, total obligation, value percentiles (p10/p25/p50/p75/p90/p99), competition profile, set-aside utilization (% of obligation; null set-aside is bucketed as `OPEN`), top 10 offices, top 10 recipients, top 5 place-of-performance states, average base-to-total ratio, and average period-of-performance months.
- The window in the manifest comes from the pull window passed by `refresh.ts`, not from the min/max dates in the data.

### 2.5 Rendering to markdown (`render.ts`)
- Each file starts with YAML-ish front matter (`slice`, `window`, `generated`, `refresh`).
- Headings: global "Federal Prime Award Patterns — Global Summary". Agency "`<name>` — Winning Patterns" (Volume & dollar, Set-aside utilization, Competition, Period of performance & pricing, Top awarding offices, Top recipients, Geographic concentration, Notes for proposal authors). NAICS "NAICS `<code>` — Winning Patterns".
- Honesty rules:
  - The competition section is hidden when there is no signal.
  - The UEI column is hidden when no recipient has a UEI.
  - If set-aside is ≥99.5% `OPEN`, it prints "Set-aside breakdown is **not available**…" instead of a fake 100% OPEN.
  - Dollars are rounded to K/M/B. Percentages are shown to one decimal.

### 2.6 Writing slices to disk (`sliceWriter.ts`)
- Root: `path.join(process.cwd(), 'uploads', 'winners')`. In the backend container this is `backend/uploads/winners/` (WORKDIR `/app`).
- Layout: `_global.md`, `by-department/<agencyToptierCode>.md`, `by-naics/<naics>.md`, `_manifest.json`.
- Each file is written to `<file>.tmp` and then renamed. The manifest is written last.
- Manifest entry fields: `sliceKey`, `filePath`, `sha256`, `bytes`, `estimatedTokens` (`ceil(chars/4)`), `generatedAt`, `sliceKind`, `agencyToptierCode`, `agencyToptierName`, `naics`.
- `readSlice()` re-hashes the file and **refuses to serve on a sha256 mismatch**.
- Old slice files are overwritten. Slices that drop out of the top-N are deleted once the new manifest is in place.

> **Storage risk — flag for operators.** `uploads/` is local disk. The `sliceWriter.ts` header says it relies on the `uploads_data` Docker volume "mounted in docker-compose.prod.yml". That file is **not in this repo**, and the backend now runs on Render (`bytescon-api`, per `CLAUDE.md`). The repo has no `render.yaml` defining a persistent disk. **(inferred)** On Render, `uploads/winners/` is lost on every redeploy or restart unless a persistent disk is attached. Every push to `main` auto-deploys.
>
> **Impact:** after a wipe, `readManifest()` returns null. The resolver logs "no manifest on disk; skipping injection" and returns null, so proposals silently generate **without** Winners Intel until the next Sunday refresh or a manual trigger. The staging tables in Postgres survive. However, there is no standalone "re-distill" entry point: `distillFromBatch` is only called from `runWinnersIntelRefresh`, so rebuilding the slices means a full USAspending re-pull. If the instance sleeps over Sunday 04:00 UTC, the repeat job may not fire **(inferred)**. `jobHealth.ts` flags `winners-intel-refresh` as stale after 170 hours.

### 2.7 Audit
`emitAuditRow()` writes one `ComplianceLog` row against the firm whose name contains "Bytes Platform":
- `entityType: 'WINNERS_INTEL_REFRESH'`, `entityId` = batch id, `toStatus` = `COMPLETED`/`FAILED`, `triggeredBy: 'system:winners-intel-worker'`.
- If no such firm exists, the audit row is skipped and a warning is logged.

---

## 3. Staging data model

Both tables are **platform-wide (no `consultingFirmId`)**, because the source data is public.

| Model / table | Unique key | Notable fields |
|---|---|---|
| `WinnersAwardStage` / `winners_award_stage` | `usaspendingAwardId` | `pieceOfTheActionId` (PIID), `recipientUei`, `recipientName`, `recipientParentUei`, `agencyToptierCode`/`Name`, `agencySubtierCode`, `awardingOfficeCode`, `fundingAgencyToptier`, `naics`, `pscCode`, `setAsideType`, `contractType`, `competitionExtent`, `numberOfOffersReceived`, `totalObligation`, `baseExercisedOptions`, `baseAndAllOptions`, period-of-performance dates, `awardDate`, `fiscalYear`, place/recipient state and country, `isRecompete` (default false), `refreshBatchId` |
| `WinnersSubawardStage` / `winners_subaward_stage` | `usaspendingSubawardId` | `primeAwardId` (a **logical** reference to `usaspendingAwardId`, deliberately not a foreign key), `subAmount`, `subActionDate`, `subRecipient*`, `subRecipientSize`, `subRecipientSetAsideFlags` (JSON), `subDescription`, `subNaics`, `subPscCode`, `refreshBatchId` |

**Other readers of these tables** (so a change here has a wide blast radius): `routes/agency.ts` (Agency View; reads `isRecompete`), `services/teamingSuggester.ts`, `services/teamingOutreachService.ts`, `services/recipientProfileService.ts`, and all of SCW (`services/scw/likelyPrimes.ts`, `subawardAnalysis.ts`, `outreachGenerator.ts`). See `subcontracting-workflow.md`.

---

## 4. Resolver: slice selection and the 12K token cap

`resolveWinnersContext({ agency, naicsCode }, consultingFirmId)` returns `ResolvedContext | null`.

1. **Gates**, all three required; otherwise it returns null (no behavior change):
   - `process.env.ENABLE_WINNERS_INTEL === 'true'` (case-insensitive);
   - `ConsultingFirm.winnersIntelOptIn === true` (a lookup error counts as off);
   - `readManifest()` is not null.
2. **Selection order**:
   - `_global` always first.
   - Then at most **one agency** slice. The agency names are normalized (lowercase, `(),.` stripped, "department of" and "of the" removed), split into tokens of 3+ characters, and scored as intersection / smaller set size. The best match must score **≥ 0.5**.
   - Then **NAICS**: an exact 6-digit match. Otherwise up to **two** slices sharing the 4-digit prefix. Codes shorter than 4 digits are ignored.
3. **Budget**: `TOKEN_CAP = 12_000` estimated tokens. It walks in order and **stops at the first slice that would overflow**. The first slice is always kept even if it alone is over the cap. In effect NAICS is trimmed first, then agency.
4. Bodies that fail to read or fail the checksum are skipped. If none load, it returns null.
5. The output string starts with `# Federal Contracting Context (Winners Intel)` and an explanation that these are stats, not the solicitation. If the manifest is older than **21 days**, a staleness banner is added. Slices are joined with `\n---\n\n`.
6. It returns `sliceKeys`, `contentSha256` (of the full context), `totalEstimatedTokens` and `manifestGeneratedAt`.

**Where the output is used.** The only consumer is `POST /api/proposal-assist/:opportunityId/draft` (`backend/src/routes/proposalAssist.ts`):
- When the context is non-null, an `LLM_INFERENCE` audit event is written (`entityType: 'PROPOSAL_DRAFT'`, with slice keys, the sha256 and the manifest time).
- The context is passed to `generateProposalDraft()` (`backend/src/services/proposalDraftService.ts`), which **appends** it after `DRAFT_SYSTEM_PROMPT`. Code comment: prepending made the LLM open with statistics.
- Log fields `winnersIntelApplied` and `winnersIntelSliceCount` are emitted.

The resolver's header comment says sliceKeys are "written to ComplianceLog". The code actually writes them to the audit event via `logAudit`.

---

## 5. Gating and schedule

| Control | Where | Default |
|---|---|---|
| `ENABLE_WINNERS_INTEL` | Read directly from `process.env` in the worker, the resolver and `jobHealth.ts`. Not in `config.ts`. | Off. The worker logs "dormant" and returns null; `server.ts` only wires observability and shutdown when the worker is non-null. |
| `ConsultingFirm.winnersIntelOptIn` | `prisma/schema.prisma` | `false`. The schema comment says "explicit ADMIN action enables it". **No route or UI sets this field**; it can only be changed directly in the database. |
| Schedule | `SCHEDULE = '0 4 * * 0'` (Sundays 04:00 UTC), queue `winners-intel-refresh`, job `weekly-refresh`, keeps 20 completed and 20 failed jobs | |
| Health | `jobHealth.ts`: `expectEveryHours: 170` when enabled | |
| Manual run | `triggerWinnersIntelRefresh()` (still respects the flag), or `npx ts-node scripts/triggerWinnersIntelRefresh.ts` from `backend/` (forces the flag on) | |
| `USASPENDING_BASE_URL` | All three pull modules | `https://api.usaspending.gov/api/v2` |

The SCW features (`subcontracting-workflow.md`) read the same staging tables but do **not** check `ENABLE_WINNERS_INTEL` or the opt-in. Without a refresh they simply find no rows.

---

## 6. Phase labels in code

| Label | Meaning in code | Status |
|---|---|---|
| Phase 2B.2 | The prime pull + persist commit ("Subaward pull + recompete heuristic + batch pruning are intentionally out of scope for Phase 2B.2 — they ship in 2B.2c and 2B.2d") | Built |
| 2B.2c | **(inferred)** Subaward pull | Built (now per-prime, labelled "Agency Phase A") |
| 2B.2d | **(inferred)** Recompete heuristic and/or batch pruning | **Not built.** Nothing sets `isRecompete`, and there is no pruning code. |
| Phase 2B.5 | Set-aside-filtered pull (`awardEnrichment.ts`: "the set-aside-filtered pull in Phase 2B.5") | **Removed** 2026-05-26 (the API ignores the filter) |
| Phase 2B.6 | Per-award detail enrichment via `/awards/<id>/` (UEI, set-aside, competition) | **Built** and runs on every refresh for the top 500 |
| Agency Phase A | Subaward persistence for the Agency View | Built |
| Phase 2C | "SCW Phase 2C activation", from the trigger script header | **(inferred)** The ops step of turning Winners Intel on so SCW has data |

**Stale text to know about.** `render.ts` still says "Future Phase 2B.5 per-award enrichment will populate UEIs" and prints "_(see Winners Intel Phase 2B.5)._" in the not-available set-aside message. Per-award enrichment is now Phase 2B.6 and already runs. That message only appears when set-aside data is ≥99.5% `OPEN`, which is likely for slices where enrichment did not reach (only the top 500 awards are enriched) **(inferred)**.

**Deferred (not built):**
- Per-award enrichment beyond the top 500.
- Rich subaward fields via `/api/v2/subaward/{id}/` or the BigQuery `gcp-public-data:usaspending` mirror.
- Restoring the set-aside-filter loop "if USAspending fixes the filter".
- The recompete heuristic.
- Batch pruning (the schema says "Pruning keeps the most recent 4 refreshBatchIds on disk"; no code does this).
- A dedicated storage volume and path (`sliceWriter.ts`: "post-launch infra polish").

---

## 7. Known gaps

1. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **Local-disk slices** (see 2.6). This is the biggest operational risk on Render.
2. ✅ **Fixed 2026-11-04 (B26).** Was: **The opt-in has no UI or API.** Enabling a firm means a direct database update.
3. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **Staging tables grow without bound.** There is no pruning. Distill only reads the current batch, but SCW and the Agency View read every row, including rows from older batches that were not re-pulled.
4. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **The schema comment is wrong about the path.** It says slices live under `data/winners/`. Code writes `uploads/winners/`.
5. **Set-aside and competition data are sparse** outside the top 500 enriched awards. Subaward set-aside, size and NAICS are always empty.
6. **Coverage is biased.** About 22.5K rows per refresh at most, alternating highest and lowest dollar per window. Not a random sample.
7. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **Agency matching is fuzzy** (token overlap ≥ 0.5). There are no tests for the resolver, distill, render or slice writer. Only the NAICS/PSC extractors are tested.
8. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **The audit row depends on a firm named like "Bytes Platform"** existing. If it is missing, the refresh audit is silently skipped.
9. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **Slices that fall out of the top 30 agencies or top 400 NAICS stay on disk** but are not in the new manifest, so they are unused. They are not deleted.
10. **The token estimate is `chars/4`.** The 12K cap is approximate (code comment: ±15%).
