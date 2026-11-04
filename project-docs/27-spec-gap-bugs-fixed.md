# Fix: bugs from the specs' known-gaps lists

**Status:** ✅ **Done** (2026-11-04), apart from the items in §3 and §4.
**Where they came from:** the known-gaps sections of [specs/](specs/README.md). These had not been audited when the review list ([doc 14](14-review-bugs-improvements-competitors.md)) was written.

---

## 1. What was wrong and what changed

### Agents

| What people saw | Change |
|-----------------|--------|
| A NO_BID decision was ignored, so drafting could carry on | New `services/agents/bidDecisionGate.ts`. Proposal, Pricing and Teaming skip a NO_BID or DEFERRED decision event, and leave that opportunity out of later runs. BID and CONDITIONAL carry on. A new decision lifts it |
| A paid invoice made the firm's Finance report show one contract's numbers as the firm's total | An event still bills only the named contract, but receivables, readiness and cash flow cover the whole portfolio, and other contracts' billing periods are kept |
| An event run blanked the alerts and pursuit learning in the firm's Opportunity brief | Those sections carry forward from the last full run, and the brief says so |
| A rate template change raised a false "Benchmark data insufficient" alert and blanked benchmarks | Runs that skip the benchmark raise no alert about it and keep each scenario's last benchmark |
| Qualification could read another opportunity's compliance status | It reads this opportunity's status or the firm-wide sweep, whichever is newer |
| Failed runs didn't count, and "last successful run" was never set | The final outcome of a run is recorded on its schedule. Ten final failures in a row pause the schedule, and saving its settings restarts it. Skips, cancels and an exhausted AI budget don't count as failures |
| A run allowed more than 3 attempts could stay queued forever | The queue's attempts follow the run's own limit |
| Pricing added a new benchmark row per scenario every day | A cohort's identity is its awards and filters, not the moving date window |
| Proposal drafted a section twice, and Teaming redid AI drafts on every run (wasted AI cost) | A draft existing no longer counts as a changed input. Teaming keeps its last draft records until what goes into them changes |

### Scoring

| What people saw | Change |
|-----------------|--------|
| The same opportunity could score differently on different screens | New `services/scoring/scoringInputs.ts`. The stored score and the live decision gather the same inputs |
| Missing agency history or bidder density counted as a 0.5 score | They're now reported as missing |
| A calibration curve could be used for a live decision but rejected for a stored score | Both apply the same checks: better accuracy, at least 50 samples, under 180 days old |
| The Who-Wins evaluation tested a different formula from the one used | It now uses 1/(K+1), like the stored priors |
| VOSB set-asides were ignored | A client without SDVOSB status gets a "confirm VOSB" condition. It isn't a block, because clients have no VOSB-only field |
| A NO_BID reason could be empty | It now names the low score and the compliance penalty |
| Pricing called all bid outcomes "verified pricing outcomes" | Now "recorded bid outcomes" |
| Portfolio's total mixed value types with no label | Labelled "Total nominal value (all value types)", beside the existing per-type breakdown |
| The two "unusable NAICS" checks differed | One shared check |
| The backtest's "mispredictions" included synthetic negatives | Real winners only |
| A warning said the base rate was "~26%" | The wrong number is gone. Stale comments ("7-factor", the 0–100 schema note, the half-life) are corrected |

### Subcontracting

| What people saw | Change |
|-----------------|--------|
| The server didn't enforce the review checklist on approval | Every item must come back confirmed. A second approval no longer rewrites who approved it |
| Past drafts weren't listed | The draft window lists earlier drafts for that prime, and reopens them |
| Clay was only reached when SAM.gov wasn't configured | Providers fall back in order when one finds nobody or fails. If all fail, saved contacts are kept |
| The inbox recalculated likely primes on every dashboard load | One firm's answer is shared for 5 minutes |

### Winners Intel

| What people saw | Change |
|-----------------|--------|
| Knowledge files were lost on restart | Slices and the manifest go through `fileStorage`, so they come back from the bucket. **This needs the bucket (T1), like uploads** |
| Old slices stayed forever | Slices that drop out of a refresh are deleted |
| Staging tables grew forever | Rows over 5 years old are removed after a successful refresh. Undated rows are kept |
| The refresh audit was silently skipped with no "Bytes Platform" firm | It now raises an ops alert |
| The resolver, distill, render and slice writer had no tests | They do now |

### Flaky tests

| Test | Cause | Change |
|------|-------|--------|
| Intelligence isolation | **Proven.** It reads public award data other test files add to while it runs. Adding rows mid-test reproduced the failure | Its firm uses a NAICS code nothing else touches |

## 2. Verification results (2026-11-04)

| Check | Result |
|-------|--------|
| Tests catch regressions | ✅ 33 of 33 deliberate breaks made a test fail. Code restored each time. One break showed a test wasn't checking enough, so that test was strengthened first |
| Full backend suite | ✅ 4,552/4,552 |
| Full frontend suite | ✅ 869/869 on Node 24 |
| Lint, type-check, frontend build | ✅ 238 warnings (limit 241), no errors |
| Running app (local) | ✅ Starts, sign-in works, the inbox and draft routes answer, and a repeat inbox load is served from the cache |

**Not covered by a dedicated test:** the Who-Wins evaluation change and the Portfolio label. Existing suites still pass.

**Scores will move slightly.** The live decision now uses agency history, density and deadline inputs, so client portal scores change. A stored score changes the next time it's scored, when bidder counts exist but no density row does. There are no customers yet, so nothing needs re-scoring.

## 3. Not bugs after checking

| Listed as | What the code shows |
|-----------|---------------------|
| Adjacent NAICS only works within a sector | Adjacency is defined by shared code prefixes, so a different sector scores 0 either way. The filter loses nothing |
| Supersede leaves a verified report live | Deliberate: a verified artifact is never touched. Readers take the newest |
| Compliance's AI budget is unused | Document extraction doesn't call AI. It's a limit that's never reached |
| Run re-queue covers all firms | Harmless: the job id drops duplicates, and the worker serves every firm |
| Email, digest and timezone settings do nothing | They exist in the API, but no screen shows them, so nobody can be misled. `costBudgetUsd` has no way to be set at all |
| `WAITING_FOR_REVIEW` can only be cancelled | Only the internal test agent can reach it |

## 4. Still open

**Your decisions** (doc 10 §3.3): D5 OBSERVE level, D6 scoring.

**Needs an outside data source:**
- **SDVOSB signal:** USAspending no longer gives this data. Nothing is harmed meanwhile: the signal is left out of the confidence score, and outreach never claims a prime is under pressure.
- **Subaward details** (set-aside, size, NAICS): same cause. Screens say the data is unavailable.

**Features, not bugs:** Add to Capture Plan (no capture plan exists yet), the contact switcher, subcontracting SMS and digest (R9).

**Not reproduced:** the `submissionWorkspace` deadline-reminder test. It failed once in an earlier full run and has passed since, including 2 full runs and 3 runs alone. The cause isn't known, so it stays on the list.
