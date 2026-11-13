# 33 — Qualifying an opportunity (bid or no-bid)

Who this is for: founders and developers. It covers how a firm decides whether to bid: where it's done, how the scorecard is pre-filled, how consulting firms qualify per client, the "To qualify" queue, and no-bid reasons.

Code wins if it disagrees with this page. Main places:
- **Backend:**
  - `backend/src/routes/qualification.ts` (all endpoints);
  - `backend/src/services/qualificationSuggestions.ts` (suggested scores);
  - `backend/src/services/qualificationDecision.ts` (recording a decision, no-bid reasons);
  - `backend/src/services/qualificationQueue.ts` (queue and insights);
  - `backend/src/services/bidReadinessLoader.ts` (readiness for one client).
- **Frontend:**
  - `frontend/src/components/qualify/QualifyPanel.tsx`;
  - `frontend/src/components/qualify/QualifyScorecard.tsx`;
  - `frontend/src/pages/QualifyQueue.tsx`;
  - `frontend/src/pages/Qualification.tsx`.

---

## 1. Where it's done

| Place | What's there |
|---|---|
| **Opportunity page → "Qualify this opportunity"** | The whole flow: readiness check, the engine's view, the scorecard and the decision. The "Bid / No-Bid" button scrolls to it. |
| **Bid Decisions → To qualify** (`/decisions/to-qualify`) | Open notices not yet decided, best fit first, with Qualify, No-bid (with a reason) and Watch on each. |
| **Bid Decisions → AI recommendations** (`/decisions`) | The engine's recommendations, each with "Qualify for <client> →". |
| **Opportunities list** | A "Qualify" button on every row (opens the notice at `#qualify`). |
| **Pipeline → a pursuit** (`/pipeline/:id`) | The full page: the same scorecard plus reviews, gate approvals, the Qualification Agent and decision history. |

Links that open the panel use `/opportunities/:id?client=<clientCompanyId>#qualify`.

## 2. The flow

1. **Can I bid on this?** The readiness check (deadline, SAM, NAICS, set-aside, bonding), run against the records of the company that would bid (§4). Its verdict: **Not eligible** (a check failed and can't be fixed for this bid), **Fix these first** (a fixable failure), **Ready, but check these** (warnings only) or **Ready to bid**. It is advice: nothing is blocked by it. A NAICS code outside the company's own is a fixable failure on a set-aside (its size standard applies) and only a warning on a notice open to all.
2. **What we know:** the engine's AI win probability and the Bid Decisions recommendation, shown as inputs, never as the decision.
3. **Scorecard:** starts pre-filled with suggested scores (§3). A person checks each, changes any, and scores what Bytescon can't.
4. **Decision:** Bid, No-bid, Conditional or Defer.
   - **No-bid** requires a reason (§5).
   - **Differing from the recommendation** requires a reason of 20+ characters, as before.
   - **Bid** moves the pursuit to Capture and offers the proposal workspace.

## 3. Suggested scores

On "Start scorecard", each default criterion gets a suggested score and the reason, stored on the criterion (`suggestedScore`, `suggestionNote`) and copied into `score`:

| Criterion | Suggested from |
|---|---|
| Capability fit | NAICS match (exact 80, industry group 60, sector 35, none 15) + 10 per capability keyword in the notice, up to +20 |
| Eligibility | The worst of the readiness SAM and set-aside items (pass 100, warn 60, fixable fail 30, hard fail 0) |
| Past-performance relevance | Projects matching the agency, NAICS (4 digits) or capabilities: 3+ → 90, 2 → 75, 1 → 60, none relevant → 30, no projects → 0 |
| Agency relationship | Past projects for this agency: 2+ → 80, 1 → 60, none → 20 |
| Timeline | Days to the deadline: 30+ → 90, 21+ → 75, 14+ → 60, 7+ → 40, 3+ → 20, less → 5 |
| Competition | 60 ± bidders (≤3 +15, >8 −20), incumbent likely −20, set-aside you qualify for +10. No data → left empty |
| Pricing | The Pricing agent's calculations (`agents/pricing/awardBenchmark.ts`, `competitiveRange.ts`), run directly, since the agent itself is opt-in. **Priced in the Pricing workspace:** your scenario's price among comparable awards: within 80, below 60 (check margin), above 35, extreme outlier 15. **Not priced yet:** comparable awards built without the notice's estimate (centring on it would put it "in range" by construction). Estimate between the quartiles → 65, outside → 55, no estimate → 60, awards spread more than 6× between quartiles → 60 "vary too widely". Fewer than 7 awards → left empty |
| Strategic value | 50, +15 new agency for you (market entry), +5 two or more past projects there, +25 you appear to be the incumbent, +5 a recompete, +10 if the estimate is ≥50% of your annual revenue, −10 if ≤2% |
| Capacity | **Never scored**: winning work you can't staff is the costliest mistake. The note lists the facts to weigh: active contracts, other bids in Capture or Proposal, headcount |
| A firm's own criteria | Left empty |

On real SAM.gov notices, before pricing, comparable awards usually vary too widely (512 of 553 notices on a test account on 12 Nov 2026), so Pricing mostly shows a neutral 60 with that reason until you price the bid. A blank would count as 0 in the total.

Capacity is required, so a scorecard can't be decided until a person scores it.

**Suggestions stay current** (`services/qualificationRefresh.ts`). An undecided scorecard's suggestions are recomputed:
- when it is opened;
- when its notice's award history arrives (enrichment worker);
- from the **Refresh suggestions** button.

A score takes the new suggestion only if nobody changed it (still empty, or still equal to the old suggestion), so scores a person entered are kept. Decided scorecards and closed pursuits are never touched.

A blank Competition or Pricing says why: the notice has no NAICS code, its award history hasn't arrived yet, or USAspending has no comparable awards (fewer than 7 for Pricing).

### Award history (feeds Competition and Pricing)

Bidder counts, the incumbent and past award prices come from USAspending (`workers/enrichmentWorker.ts`, `services/usaSpending.ts`).
- **When it runs:** automatically after every sync (the daily one and Sync Contracts). "Get Award History" on Opportunities still fetches it on demand.
- **Throttling:** at most one notice a second, two in flight, five retries with backoff. Lookups are cached per NAICS + agency for 6 hours, and agency set-aside rates for 24 hours. Before this, a sync's worth of notices sent the same requests hundreds of times and about half failed with "socket hang up".
- **Searches USAspending can't run:** a notice without NAICS, or a 400/422 answer. These are recorded as no history instead of retried.
- **No complete profile yet:** if no client has a complete profile, a notice gets its award history but stays unscored, so completing a profile scores it.

## 4. Per client (consulting firms)

- **One scorecard per client:** each client of a consulting firm gets its own scorecard on the same pursuit (`Scorecard.clientCompanyId`, unique per pursuit and client). A contractor always qualifies its own company, with no client to pick.
- **Readiness and suggestions:** both use that client's profile. Its SAM status and NAICS come from the profile, its set-asides from the flags, and a flag that has an expiry date counts as a certification. A contractor's own company uses the firm's registration, certifications and bonding.
- **Pipeline stage:**
  - one client's Bid moves the pursuit to Capture;
  - it becomes No-bid only when every client's scorecard is No-bid;
  - the agents' "declined" check (`bidDecisionGate.declinedOpportunityIds`) follows the same rule.
- **Requests:** API calls take `?clientCompanyId=`. Without one, a consulting firm uses its only client, or a legacy scorecard. Otherwise it's refused with "Choose which client…".
- **Existing scorecards:** the migration `20261112100000_qualification_flow` assigned contractors' existing scorecards to their own company. Consulting firms' existing ones stay firm-wide ("Firm-wide (before per-client scoring)"), and new ones are never firm-wide.

## 5. No-bid reasons, quick no-bid and insights

- **Reasons:** Not eligible · Outside our capabilities · No capacity · Too competitive or strong incumbent · Not enough time · Too small / not worth it · Wrong agency, location or contract type · Other, plus an optional note (`Scorecard.noBidReason`, `noBidNote`).
- **Quick no-bid** (`POST /api/qualification/opportunity/:id/quick-no-bid`): from the queue, without scoring every criterion.
  - **Scorecard:** it is still created with suggestions so the decision has context.
  - **Flag:** the decision is marked `quickDecision`.
  - **Scope:** only no-bid can skip the scorecard; a Bid always needs it.
- **Insights** (`GET /api/qualification/insights?days=90`): the decisions in the period and the reasons for passing. They're shown at the top of the queue ("Most common reason to pass…").

## 6. The queue

`GET /api/qualification/queue` lists open notices for the bidding company:
- **Included:** active notices with a future deadline. Award notices are excluded; notices with no type are included.
- **Hidden:** notices that company has decided on; "Show decided" brings them back.
- **Sorting:** best fit first (ready, then ready-but-check, then fix-first, then not eligible; then win probability; then deadline), or deadline first.

Keyboard, on a notice title:
- **↑ / ↓** (or **j / k**) move between notices;
- **Enter** opens a notice;
- **n** opens the no-bid form;
- **w** stars the notice (Watch).

Watch uses the existing star, which pins the notice in the sidebar. Stars are kept in the browser, per person.

## 7. Not done (yet)

- **Quick mode vs full mode** as a firm setting. Reviews and gate approvals stay optional on the full page.
- **Dashboard widget** for the queue.
- **The Qualification Agent:** it still reads the most recently updated scorecard on a pursuit. For a consulting firm with several clients on one notice, its accept/reject buttons ask which client the decision is for.
