# Fix: the remaining review bugs

**Bugs:** B9–B12, B15, B17–B22, B24–B26 in [14-review-bugs-improvements-competitors.md](14-review-bugs-improvements-competitors.md)
**Status:** ✅ **Done** (2026-11-04). B1, B2 and B16 stay open; see §3.

---

## 1. What was wrong and what changed

| Bug | What people saw | Change |
|-----|-----------------|--------|
| **B9** | A deliverable rejected a second time, or a pursuit moved back, never reached the agents | Event keys for deliverables, pursuits and outcomes include the record's version from just before the change, so a genuine repeat fires |
| **B10** | A retried request started extra agent runs | Bid decision, section approval and time entry keys use that same version instead of the clock, so a duplicate is dropped |
| **B11** | Proposal and Pricing re-checked the whole firm after an extraction or amendment | New `services/agents/triggerEntities.ts` recognises the real entity types. Every lookup is firm-scoped, which also closes a Pricing amendment lookup that had no firm filter |
| **B12** | The owner firm could hit plan limits with every feature unlocked | `getFirmPlan` treats owner and lifetime firms as unlimited, even with a Subscription row |
| **B15** | Flow-down clauses could never reach partners | A purchase order on the contract's Purchasing tab has **Share with subcontractor / Stop sharing**. The partner portal lists shared clauses with an **Acknowledge** button |
| **B17** | With the calibration setting on, scores could be adjusted twice (setting is off today) | The engine returns the raw score. It's calibrated once: when a stored score is read, or for live decisions and client match emails |
| **B18** | Score explanations all said "neutral" | `deriveFactors` reads what the scoring worker records. Each factor shows its score, weight and effect against a neutral input |
| **B19** | New firm holidays ignored until a restart | The working calendar cache lasts 5 minutes |
| **B20** | Deadlines after about 8 pm Eastern counted a working day late | A moment in time counts as its US Eastern date. A date with no time stays on the date it names |
| **B21** | The partner contract picker stopped at 100 contracts | It reads every page |
| **B22** | Agency cards counted offices they didn't list | The API returns every spelling merged into a card, and the card lists offices under any of them |
| **B24** | Every 8(a) set-aside was blocked for every client | New client fields **8(a)** and **8(a) Program Term End** (also `eight_a` in CSV import). The gate, match score, set-aside view and proposal context follow them |
| **B25** | The subcontracting filter offered Closed and Awarded, which no lead ever has | It offers Open, Saved and Dismissed |
| **B26** | Winners Intel could only be switched on in the database | `GET/PUT /api/firm/winners-intel` and an admin setting, recorded in the audit log. The setting only appears when the platform switch `ENABLE_WINNERS_INTEL` is on |

### Worth checking in your own data
- **8(a) is off for every existing client until someone ticks it.** Those clients stay blocked on 8(a) notices, as before.
- **8(a) scores:** a small business with no 8(a) status no longer gets the small "partial" boost on 8(a) notices. Match
  scoring now gives full credit only to 8(a) participants.
- **Eastern time (B20):** every firm uses US Eastern for this, because federal deadlines do. There's no per-firm setting.
- **Sharing a clause** (B15) counts as a review of that clause, so it updates the reviewer and review time.

## 2. Verification results (2026-11-04)

| Check | Result |
|-------|--------|
| New tests | ✅ `eventKeys`, `workingDaysEastern`, `workingCalendarRefresh`, `tierGate.ownerPlan`, `eightA`, `probabilityEngine.calibration`, `scoreExplanationFactors`, `remainingBugs`, plus additions to the contract, pursuit and partner-portal tests. Frontend: `SubcontractingPage`, `Crm.agencyOffices`, `crmApi.contractOptions`, `PartnerPortal`, `ContractErpTabs` |
| Tests catch regressions | ✅ Breaking 11 of the fixes on purpose (B9, B10, B11 twice, B12, B17, B18, B19, B20, B22, B24) made tests fail. Code restored |
| Full suites | ✅ Backend 4,486/4,486; frontend 867/867 (Node 24) |
| Type-check, frontend lint | ✅ clean; 238 warnings (limit 241) |
| Migration | ✅ `20261104120000_client_eight_a` adds two columns; existing rows are unchanged |

**In the running app (local):**

| Check | Result |
|-------|--------|
| Deliverable submitted and rejected twice | ✅ 2 rejected and 2 submitted events (was 1 and 1) |
| Offices under "LIVECHECK Dept" and "LIVECHECK DEPT" | ✅ One card, 2 offices, both spellings returned |
| New client with 8(a) | ✅ Saved; the 8(a) badge shows on its page |
| Winners Intel | ✅ Switches on and off; setting shows in Settings |
| Subcontracting filter | ✅ Open, Saved, Dismissed |

The test data was removed afterwards.

**Not run end to end:**
- B15's partner screen and sharing button are covered by component and route tests, not clicked in a browser.
- B17 can't be seen in the app while the calibration setting is off. It's covered by a test only.
- B21 is covered by a test, not by a firm with over 100 contracts.

### Left as it is
- `SUBCONTRACT_MILESTONE_DUE` still fires once per goal and risk state, on purpose: a goal that stays at risk shouldn't
  fire every day. A goal that recovers and becomes at risk again doesn't fire a second time.
- A scored opportunity match stores the raw win probability, which is what the read-time calibration expects.

## 3. Still open

| Bug | Why | What's needed |
|-----|-----|---------------|
| **B1** Lost uploads | The code is done; it needs a bucket | Owner task T1 (doc 10 §3) |
| **B2** Free server sleeps | Needs a paid plan | Owner task T3 (doc 10 §3) |
| **B16** Security settings that fail quietly | Needs a decision, below | Owner |

**The decision for B16:** there are two parts.
1. **If Redis goes down,** should sign-outs and rate limits **block people** (safer, but a Redis outage locks everyone
   out) or **let people through** (today's behaviour)? Since B4 and B7, deactivation and role changes no longer depend on
   Redis, so this now only affects password-reset sign-outs and rate limits. **Recommendation:** keep letting people
   through, alert on it, and move rate limits to shared Redis.
2. **If the encryption key is missing,** should the app **refuse to start** instead of storing secrets as plain text?
   **Recommendation:** yes, but only after T12 confirms `FIELD_ENCRYPTION_KEY` is set in production. Otherwise this
   change would stop production from starting.
