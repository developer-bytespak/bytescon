# 29 — Where opportunities come from

Who this is for: founders and developers. It covers every source of contract notices the platform has, what each needs, how duplicates are handled, what was checked on 2026-11-09, candidate new sources, and the steps to add one.

Code wins if it disagrees with this page. Main places: `backend/src/services/samApi.ts`, `backend/src/services/discovery/`, `backend/src/routes/stateMunicipal.ts`, `backend/src/routes/subcontracting.ts`, `backend/src/services/demoOpportunityPool.ts`.

---

## 1. The sources we have

### SAM.gov (the main source)

| Path | When it runs | Key |
|---|---|---|
| Daily sync per firm (`opportunitySyncWorker.ts`) | 06:00 UTC, firms with at least one active client | Firm's own key from Settings, else the server's `SAM_API_KEY` |
| Sync Contracts button (`routes/jobs.ts`) | When a user presses it | Same |
| Starter board (`firstIngest.ts`) | Once, when a new firm confirms its email: up to 50 notices from the last 21 days | Same |
| Demo pool (`demoOpportunityPool.ts`) | Demo only: one shared pull, copied into accounts. See [28-demo-version.md](28-demo-version.md) | Server's `SAM_API_KEY` |

SAM.gov facts that matter:

- `offset` is a **page number** (0, 1, 2), not a record count. This was a bug until PR #11.
- Up to 1,000 records per request.
- Daily limits per key ([open.gsa.gov](https://open.gsa.gov/api/entity-api/)): 10 for a user with no SAM.gov role, 1,000 with a role or for a non-federal system account. The limit resets at 00:00 UTC (from a SAM.gov error message, 2026-11-06).
- SAM.gov doesn't report how many requests are left, so the demo pool counts its own.

### Discovery sources (`services/discovery/adapters/`)

A firm admin switches one on under **Discovery → Sources**; it then runs every hour (`section6Worker.ts`, `source-sync` job). Records go into that firm's Opportunities, each id prefixed with the source key.

| Source (key) | Needs | Notes |
|---|---|---|
| SAM.gov (`sam_gov`) | SAM key | Uses the firm's key, else the server's. Still has the record-count `offset` mistake. |
| Grants.gov (`grants_gov`) | Nothing | Grants, not contracts |
| NYC City Record (`nyc_city_record`) | Nothing | |
| LA RAMP (`la_ramp`) | Nothing | |
| Delaware bids (`delaware_bids`) | Nothing | |
| Montgomery County MD (`montgomery_county_md`) | Nothing | |
| Texas DOT lettings (`txdot_lettings`) | Nothing | |
| USAC E-Rate (`usac_erate`) | Nothing | Commercial-style buyers (schools, libraries) |
| USAC Rural Health (`usac_rural_health`) | Nothing | |
| State/local feed (`state_local`) | A feed address | Any official open-data or RSS bid feed |
| Subcontracting board (`subcontracting_board`) | A feed address | |
| Agency forecast (`agency_forecast`) | A feed address | Produces forecasts, not opportunities |
| Civilian program feed (`civilian_feed`) | A feed address | |
| Award history (`contract_awards`) | Nothing | Adds award history to existing notices; creates none |

A source with no feed address reports "not configured" and does nothing.

### State & Municipal page (`routes/stateMunicipal.ts`, `services/stateProcurementScraper.ts`)

Runs when someone presses Sync on that page. It reads 11 state portals (NY, TX, FL, VA, GA, NC, OH, IL, CA, MD, PA). FL, CA, MD and PA need portal logins. It also uses SAM.gov by state, but **only with a key saved in the firm's own Settings**; without one it falls back to USAspending. Results are stored in their own list (`StateMunicipalOpportunity`), not in Opportunities.

### Subcontracting page (`routes/subcontracting.ts`, `services/subnetScraper.ts`)

Runs when someone presses Sync. It reads SBA SubNet and SAM.gov set-asides. For SAM.gov it uses the firm's key, **else the server's `SAM_API_KEY`**: 1 to 5 requests per press. Results are stored in their own list (`SubcontractOpportunity`).

---

## 2. Duplicates

Within one source, a notice is stored once:

- Opportunities: unique per firm and notice id (`@@unique([consultingFirmId, samNoticeId])`).
- Demo pool to accounts: a notice the account already has isn't copied again.
- Subcontracting: unique per firm and the source's id.
- State & Municipal: skipped when solicitation number and state, or title, agency and state, already exist.
- Forecasts: unique per firm and the source's id.

Across sources there is **no matching**, with one exception: SAM.gov notices from the daily sync and from the Discovery SAM.gov source share the bare notice id and become one record. Everything else can appear twice:

- Discovery ids are prefixed (`grants_gov:123`), so the same contract from two feeds is two rows.
- State & Municipal and Subcontracting keep separate lists, and both also pull from SAM.gov.
- Opportunities hides state/local and grant notices unless filtered for, which hides some of the duplicates but doesn't remove them.

A future fix: match on solicitation number, falling back to title, agency and deadline; keep the first copy and link the rest to it. Merging different contracts by mistake is the risk to design against.

---

## 3. What was checked on 2026-11-09

Local: each source was called once from a development machine (SAM.gov skipped to save requests). Live: the server logs for 6–9 November.

| Source | Local | Live |
|---|---|---|
| Grants.gov | 25 open | Runs hourly; about 10,000 fetched, 2 new |
| LA RAMP | 50 open | 24 new |
| Delaware | 39 (30 open) | Runs, nothing new |
| Montgomery County MD | 23 open | 1 new |
| Texas DOT | 50 open | 19 new |
| USAC E-Rate | 1,000 | **Times out**: about 55,000 fetched, none saved |
| USAC Rural Health | 1,000 (790 open) | Not seen |
| NYC City Record | NYC's service returned 503 that day | Mostly working, 1 failure |
| State/local feed | Needs an address | Configured by some firm: 32 new |
| Civilian feed | Needs an address | Configured: 216 new |
| Agency forecast | Needs an address | Skipped every run |
| SAM.gov (Discovery) | Skipped | Not seen switched on |
| State portals | Only NY returned results (25); TX, VA, GA, NC, OH, IL returned 0 with no error; FL, CA, MD, PA need logins | No sync since 26 Oct |
| USAspending fallback | 40, but these are **past awards**, not open bids | |
| SBA SubNet | 30 | No sync since 26 Oct |

Open problems from this check:

1. USAC E-Rate times out on live every hour and saves nothing, while loading the server.
2. Ten state scrapers return nothing, silently.
3. On the demo, the Subcontracting page and the Discovery SAM.gov source can spend the server's shared SAM key, which the demo pool depends on.

---

## 4. Candidate new sources

| Source | What | Access | Effort |
|---|---|---|---|
| More state and city open-data portals | Local bids | Many publish procurement data; check each | Low: often only a feed address (Route A below) |
| SBIR.gov | Federal research solicitations | [Official API](https://www.sbir.gov/api/solicitation); SBIR.gov has warned it is under maintenance | Medium |
| UK Find a Tender | UK public contracts | [Official API](https://www.find-tender.service.gov.uk/Developer/Documentation) in OCDS format; some parts need a free key | Medium |
| Other OCDS countries | e.g. [AusTender](https://github.com/austender/austender-ocds-api), Prozorro | Same format, so one adapter can serve several | Medium, then low per country |
| EU TED, CanadaBuys, UK Contracts Finder | Notices | Believed to publish open data; **not confirmed** | Check first |
| DLA DIBBS, agency forecasts (Acquisition Gateway) | Defence buys, forecasts | **Not confirmed**; may be download or web only | Check first |
| GSA eBuy | Schedule quotes | **No public API**; only listed schedule contacts can sign in | Not suitable |
| Paid aggregators (GovWin, BidNet, GovSpend, DemandStar) | Federal, state, local | Paid licences (not checked) | Needs a contract and a terms check |

Before adding any source: use only an official API or published feed, don't scrape a site whose terms forbid it, and don't use logins we don't own for that purpose.

---

## 5. Adding a source

### Route A — no code (a published feed address)

1. Find the feed's address, e.g. a city open-data endpoint for bids.
2. As a firm admin, open **Discovery → Sources**, add a source of the matching type (state/local, subcontracting board, agency forecast or civilian program) and enter the address.
3. It syncs hourly. It shows as verified only after a run actually returns records.

### Route B — a new adapter (a new API)

1. **Check access.** Read the API docs and terms; note keys and request limits; make a few test calls.
2. **Write the adapter**: one file in `backend/src/services/discovery/adapters/` implementing `SourceAdapter` (`services/discovery/sourceAdapter.ts`): `configure()` says whether it's ready, `fetchPage()` fetches one page and maps each record to `NormalizedOpportunity` (title, agency, NAICS, deadline, value, solicitation number, link). For Socrata open-data portals, `createSocrataTenderAdapter` (`socrataTenderAdapterFactory.ts`) does most of it; `usacErateAdapter.ts` is an example.
3. **Register it** in `BUILT_IN` in `adapters/index.ts`.
4. **New category only if needed**: add it to `SourceCategory` and, if new, `OpportunitySource` in `prisma/schema.prisma`, with a migration.
5. **Keys** go in server settings and `backend/.env.example`, never in code.
6. **Tests**: saved sample responses; check paging, required fields, errors and rate limits (see `adapters.test.ts`, `tenderAdapters.test.ts`).
7. **Test locally, then live** on the owner's approval.

The sync orchestrator (`services/discovery/sourceSync.ts`) already handles paging, retries, rate-limit backoff, timeouts, resuming, run records, duplicates within the source, and the hourly schedule. An adapter doesn't reimplement any of it.

### Decide before building

- **Demo**: feed the shared pool, or each account? The pool spends the least of a limited key.
- **Duplicates**: the same contract from two sources shows twice until cross-source matching exists (section 2).
- **Limits**: give any source with a small allowance a per-day cap, as the demo pool has for SAM.gov.
