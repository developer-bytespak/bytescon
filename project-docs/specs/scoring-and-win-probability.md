# Scoring and Win Probability

Purpose: describe how Bytescon decides whether a client may bid on a federal opportunity, how good a fit it is, how likely the client is to win, and whether it should bid.

Status: as-built spec reconstructed from code on 2026-11-03; original spec lost. If this and the code disagree, the code wins.

The original design docs (`PROMPT.md`, `docs/WHO_WINS_MODEL.md`, `FIXES.md`) are referenced throughout the code comments but are not in the repository. Section references such as "§6.2B" or "FIX-1" in code comments point at those lost documents. Statements marked **(inferred)** are reasoned from the code but not confirmed by it.

---

## 1. Simple version

When a new government contract notice arrives, Bytescon first checks whether each client is even allowed to bid. For example, a contract reserved for veteran-owned businesses is closed to a client without that certification. For clients that pass, it scores two things out of 100: how well the client can do the work (fit) and how attractive the contract is (market). Those two scores give a recommendation: bid as the main contractor, bid as a subcontractor, or don't bid. Separately, a statistical model estimates the chance of winning, using about nine signals such as industry-code match, how strong the current contract holder is, and how crowded the competition is. Because that chance is not yet proven against real wins and losses, customers mostly see a coarse "Strong / Moderate / Weak fit" label rather than an exact percentage. The percentage is only adjusted ("calibrated") when there is enough real outcome data to show that the adjustment makes it more accurate.

---

## 2. Pipeline overview

The system has **two scoring paths** that produce **two different probability numbers**. Developers often confuse them, so keep them apart:

- **Path A, opportunity-level score** (`workers/scoringWorker.ts`). For every opportunity it scores every active client of the firm and keeps the **best** client's probability. The result is written to `Opportunity.probabilityScore` (0–1), `Opportunity.scoreBreakdown`, `Opportunity.expectedValue`.
- **Path B, per-client bid decision** (`services/decisionEngine.ts` `evaluateBidDecision`). This path runs the gate, fit, market, probability, Bayesian and layer steps and the decision resolver for one (opportunity, client) pair. The result is written to `BidDecision` (`winProbability`, `fitScore`, `marketScore`, `recommendation`, `explanationJson`, financials) plus a `BidDecisionHistory` row.

```
                         Opportunity (SAM notice + USAspending enrichment)
                                         |
         +-------------------------------+--------------------------------+
         |  PATH A  scoringWorker (per opp, all clients, keep MAX)        |
         |                                                                |
         |  incumbentDetector (text)  competitiveDensity  agencyProfiler  |
         |  deadline urgency                                              |
         |        \__________________ 9 features ________________/       |
         |                 probabilityEngine.scoreOpportunityForClient    |
         |                 z = weighted mean (absent features dropped     |
         |                     if PROBABILITY_RENORMALIZE_ABSENT)         |
         |                 p = 1/(1+e^-(6z-3))                            |
         |                 calibrateProbability()  <-- global curve, only |
         |                     if ENABLE_PROBABILITY_CALIBRATION          |
         |                 [Who-Wins prior blend, if WHO_WINS_PRIOR_ENABLED]
         |                 -> Opportunity.probabilityScore (max over clients)
         +----------------------------------------------------------------+
                                         |
         +----------------------------------------------------------------+
         |  PATH B  decisionEngine.evaluateBidDecision (per opp x client) |
         |                                                                |
         |  1. Compliance gate  -> INELIGIBLE => NO_BID, stop             |
         |  2. Fit score 0-100  (fitScoring)                              |
         |  3. Market score 0-100 (marketScoring)                         |
         |  4. Probability (same engine as path A, fewer inputs)          |
         |     -> recompete boost -> Bayesian Beta-Binomial shrinkage     |
         |     -> penalty drag -> set-aside layer (+credible interval)    |
         |  5. Decision resolver (gate, fit, market) -> BID_PRIME /       |
         |     BID_SUB / NO_BID, + confidence modifier on probability     |
         |  6. Financial model (EV, ROI, lifetime value)                  |
         |     -> BidDecision + BidDecisionHistory                        |
         +----------------------------------------------------------------+
                                         |
              Read-time resolution (never re-scores, reads stored numbers)
                                         |
   winProbability.resolveStoredProbability(Opportunity.probabilityScore)
      -> RAW | CALIBRATED | FALLBACK  (global isotonic/Platt curve, strict guards)
   scoreExplanation.explainScore
      -> tenant Platt calibration if ACTIVE and not stale (wins over global)
      -> factor list + Wilson confidence interval + plain-language text
   portfolioValue.computePortfolio
      -> value x final probability per opportunity, with interval band
   pricingSensitivity / capabilityGap / evidenceStats (side analyses)
   utils/scoreTier -> STRONG / MODERATE / WEAK / UNSCORED (customer surface)
```

Human decision: `services/qualificationDecision.ts` and `services/scorecardScoring.ts` run a separate, human-scored Bid/No-Bid scorecard. It does not consume any of the numbers above (section 4.14).

Workers that drive scoring:

| Worker | Schedule | What it does |
|---|---|---|
| `workers/scoringWorker.ts` | on-demand (BullMQ queue `opportunity-scoring`), `attempts: 3`, exponential backoff 5000 ms, concurrency 10 | Path A for one opportunity. `enqueueAllOpportunitiesForScoring` queues up to 500 `ACTIVE`, `isScored: false` opportunities per firm, and skips firms with no active clients. |
| `workers/recalibrationWorker.ts` | cron `0 2 * * *` (02:00 UTC) | Despite the name it does **not** fit any calibration. It refreshes NAICS density and agency profiles (batches of 5, 1500 ms sleep), sets `isScored=false` on every ACTIVE opportunity of every active firm, and re-queues them for Path A. |
| `workers/portfolioScoringWorker.ts` | cron `0 8,20 * * *`, plus on-demand (priority 1, deduplicated per firm), concurrency 1 | Runs `runPortfolioEvaluation` (Path B for every pair). |
| `workers/section6Worker.ts` (milestone reminders job) | (see that worker) | Calls `markStaleCalibrations()` to mark aged tenant calibrations STALE. |
| `server.ts` boot (~line 504) | at startup | `refreshCalibrationCache()` loads the global curve into memory, non-fatal on failure. |

---

## 3. Component reference

All paths below are relative to `backend/src/` unless stated.

### 3.1 Compliance gate (Layer 1): `engines/complianceGate.ts`

**Purpose:** hard eligibility filter. Returns `ELIGIBLE`, `CONDITIONAL` (can bid but needs corrective actions) or `INELIGIBLE` (legally cannot bid).

**Inputs:** client `{sdvosb, wosb, hubzone, smallBusiness, naicsCodes, samRegStatus, samRegExpiry}`, opportunity `{setAsideType, naicsCode}`. The set-aside is upper-cased and `-`/spaces become `_`. A missing set-aside becomes `NONE`.

**Hard blockers (INELIGIBLE):**
- `SDVOSB` set-aside and client not SDVOSB.
- `WOSB` or `EDWOSB` and client not WOSB.
- `HUBZONE` and client not HUBZone.
- `SBA_8A` or `8A`: blocked unless the client has `eightA` set (added 2026-11-04, B24).
- NAICS sector mismatch: the client has at least one NAICS and the opportunity has one, but no client code shares the first 2 digits.

**Soft conditions (CONDITIONAL), checked only when there are no blockers:**
- NAICS shares the sector (2 digits) but not the subsector (4 digits), or shares the subsector but is not an exact match.
- `SMALL_BUSINESS` / `TOTAL_SMALL_BUSINESS` set-aside and client not small business.
- `samRegStatus` present and not `active` (case-insensitive).
- SAM registration expired, or expiring in fewer than 30 days.

**Output:** `{gate, blockers[], conditions[], requiredActions[]}`.

**Edge cases:**
- A client with **no** NAICS codes skips both NAICS checks, so it is not blocked on NAICS.
- `VOSB` set-asides are not checked here.

### 3.2 Fit score (Layer 2): `engines/fitScoring.ts`

**Purpose:** 0–100 measure of whether the client can execute this contract.

**Formula** (`computeFitScore`, lines 191–198): `total = round(clamp(naicsDepth*0.25 + pastPerformance*0.20 + capacityFit*0.20 + resourceReadiness*0.15 + geographicFit*0.10 + financialStrength*0.10))`. The breakdown is rounded per factor.

| Factor | Rule (exact values) |
|---|---|
| naicsDepth (25%) | Client has no codes: 0. Exact match: 100. Same first 4 digits: 60. Same first 2: 30. Otherwise 0. |
| pastPerformance (20%) | No stats: 40. Stats but zero decided and zero submitted: 35. Otherwise 35, plus `winRate*60` (or +20 if no decided bids), plus `completionRate*0.4*40`. Flag-gated relevant past performance (only when `RELEVANT_PAST_PERFORMANCE_ENABLED`; see `decisionEngine.ts` 206–220) adds `((avgCpars-50)/50)*20` and `(min(matched,3)/3)*10`. Clamped 0–100. The code comment calls this "CALIBRATION-SENSITIVE — must be backtested before the flag is enabled". |
| capacityFit (20%) | No estimated value: 50. `ratio = value / (historicalAvgAward or 500000)`. 0.5–2.0: 100. 0.25–<0.5: 75. >2–5: 65. >5–10: 40. >10: 20. Otherwise (below 0.25): 50. |
| resourceReadiness (15%) | Days to deadline: >45: 100, >30: 90, >20: 75, >14: 60, >7: 40, >3: 20, otherwise 5. |
| geographicFit (10%) | Missing state or place of performance: 65. POP contains NATIONWIDE, NATIONAL, CONUS, REMOTE or N/A: 80. POP contains the client state: 100. Both in the DC cluster `[DC, VA, MD, PA, DE, WV, NJ]`: 75. Otherwise 40. |
| financialStrength (10%) | No stats: 60. Total penalties 0: 100. <5000: 85. <25000: 70. <100000: 50. Otherwise 30. |

Tests: `engines/fitScoring.test.ts`.

### 3.3 Market score (Layer 3): `engines/marketScoring.ts`

**Purpose:** 0–100 opportunity attractiveness, independent of the client except for the agency-alignment factor.

**Formula** (lines 181–187): `round(clamp(competitionDensity*0.30 + incumbentStrength*0.25 + contractValueFit*0.20 + agencyBuyingPatterns*0.15 + timingAdvantage*0.10))`.

| Factor | Rule |
|---|---|
| competitionDensity (30%) | If `offersReceived` (FPDS bidders on this solicitation) is known: ≤1: 95, ≤2: 88, ≤3: 80, ≤5: 70, ≤8: 58, ≤12: 45, ≤20: 30, otherwise 15. Else if `competitionCount` (distinct historical winners) is known, it is scored as market fragmentation: ≤1: 50, ≤3: 55, ≤8: 62, otherwise 67. Else 55. |
| incumbentStrength (25%) | `incumbentProbability` null: 60 if recompete, otherwise 50. Otherwise <0.15: 95, <0.30: 85, <0.45: 72, <0.60: 55, <0.75: 38, otherwise 22. Plus 12 if recompete and incumbent probability <0.65. |
| contractValueFit (20%) | Uses `estimatedValue ?? historicalAvgAward`. None: 50. 500K–5M: 95. >5M–15M: 85. >15M–30M: 65. >30M–50M: 45. >50M: 25. 150K–<500K: 75. Otherwise 55. |
| agencyBuyingPatterns (15%) | No rates: 50. SDVOSB client with an SDVOSB rate: >0.15: 95, >0.10: 82, >0.05: 68, otherwise 45. Small business, WOSB or HUBZone client with a small-business rate: >0.35: 90, >0.25: 75, >0.15: 60, otherwise 40. Otherwise `40 + rate*100`. |
| timingAdvantage (10%) | Notice type contains "sources sought" or "request for information": 85. "presolicitation": 72. "solicitation": 55. "award": 30. "sole source" or "j&a": 15. Otherwise 50. Plus 10 on recompete. |

**Why** (lines 32–40): bidder count and distinct-winner count need different curves. The earlier code applied the bidder curve to both, which "wrongly scored healthy, fragmented markets as 'highly contested' (15)".

**Edge case:** the `if/else` order in `scoreTimingAdvantage` means "presolicitation" is caught before "solicitation". "Sole source" is only reached if none of the earlier substrings matched.

Tests: `engines/marketScoring.test.ts`.

### 3.4 Decision resolver: `engines/decisionResolver.ts`

**Purpose:** turn gate, fit and market into `BID_PRIME`, `BID_SUB` or `NO_BID`, plus a risk score and an additive probability modifier.

| Condition (after penalty) | Result | confidenceModifier | riskScore |
|---|---|---|---|
| gate INELIGIBLE | NO_BID | 0 | 100 |
| adjFit ≥ 65 and adjMarket ≥ 60 | BID_PRIME | +0.03 if adjFit ≥ 80 and adjMarket ≥ 75, otherwise 0 | base + 15 if adjFit < 75, + 10 if adjMarket < 70 |
| adjFit ≥ 40 and adjMarket ≥ 40 | BID_SUB | −0.05 | base + 25 |
| otherwise | NO_BID | 0 | base + 40 |

- `penalty = 5` when the gate is CONDITIONAL, else 0. It is subtracted from **both** fit and market.
- Base risk is 35 for CONDITIONAL and 10 for ELIGIBLE. Risk is clamped to 0–100.

**Edge case:** the NO_BID rationale lists reasons using the **unadjusted** scores (`fitScore < 40`, `marketScore < 40`). A CONDITIONAL pair with fit 42 (adjusted 37) therefore gets NO_BID with an empty reason list.

Tests: `engines/decisionResolver.test.ts`.

### 3.5 Win-probability engine: `engines/probabilityEngine.ts`

**Purpose:** a 9-factor logistic model. Comments elsewhere still say "7-factor", which is stale naming.

**Weights** (lines 15–25; a module-load check and a per-call check both throw if they do not sum to 1.0 within 0.001):

| Feature | Weight | How computed (in `scoreOpportunityForClient`) | Default when input missing |
|---|---|---|---|
| naicsOverlapScore | 0.24 | `computeNaicsOverlap`: digits only. Exact: 1.0. Same 4 digits: 0.6. Same 2 digits: 0.3. Otherwise 0. | 0 |
| incumbentWeaknessScore | 0.19 | `1 - incumbentProbability`, plus bonus: competitors ≥5: +0.1, ≥3: +0.05, ≤1: −0.1. Clamped. | 0.5 |
| documentAlignmentScore | 0.16 | `documentIntelScore` passed through | 0.5 |
| agencyAlignmentScore | 0.12 | SDVOSB client with an agency SDVOSB rate: `clamp(0.3 + rate*2)`. Otherwise the supplied value. | 0.5 |
| awardSizeFitScore | 0.09 | `computeAwardSizeFit(value, 100000, 10000000)`: within range: 1.0. Below: `value/min*0.8`. Above: `max/value*0.7`. | 0.5 |
| competitionDensityScore | 0.08 | `densityScore` if given, else `clamp(1 - competitors/20)` | 0.5 |
| agencyHistoryScore | 0.07 | from `agencyProfiler` | 0.5 |
| historicalDistribution | 0.03 | caller supplies `min(historicalAwardCount/1000, 0.8)` | 0.3 |
| deadlineUrgencyScore | 0.02 | `computeDeadlineUrgency`: <0 days: 0. <5: 0.1. <14: 0.5. <42: 1.0. <90: 0.7. <180: 0.5. Otherwise 0.3. | 0.5 |

`competitors = offersReceived ?? competitionCount`.

**Probability:**

```
z = Σ w_k·f_k / Σ w_k          (over non-absent features; denominator = 1.0 when nothing is absent)
p_raw = 1 / (1 + e^-(6·z − 3))     SCALE = 6.0, BIAS = −3.0  (lines 119–123)
p = calibrateProbability(p_raw)    (global curve, no-op unless flag on; line 257)
expectedValue = p × estimatedValue (0 if no value)
```

Range: z=0 gives about 0.0474. z=1 gives about 0.9526. `absentFeatureRenormalization.test.ts` asserts both bounds.

**Absent-feature renormalization** (lines 360–388, flag `PROBABILITY_RENORMALIZE_ABSENT`):
- With the flag on, features with no source data are dropped from both the numerator and the denominator.
- A feature is **absent** when its input is null or undefined. `naicsOverlapScore` is absent only when the opportunity has no usable NAICS, or the client has none. `hasUsableNaics` requires at least 2 digits and not all zeros, which rejects the legacy `"000000"` placeholder. A real non-matching NAICS (score 0) is evidence and stays in.
- An explicitly supplied 0 is never treated as absent.
- If every feature is absent, z = 0 and p is about 0.047, which is the model prior. This is deliberately not a FAILED result, because the scoring worker retries FAILED jobs and would loop forever on an unscoreable record (lines 92–98).
- Why: with the flag off, a bare SAM notice scored exactly 0.3092 (or 0.4081 with a 2-digit sector match) regardless of fit (`config.ts` comment; the test reproduces both constants).

**Failure contract** ("P1-1"):
- A non-finite probability or a thrown error returns `{status: 'FAILED', failureReason}` with **no** numeric fields.
- Out-of-range features are clamped to [0, 1] with a warning.
- Callers must skip FAILED results and never persist a number for them.

**`explainFeatures`** returns rows `{factor, label, score, weight, contribution = weight*score, pct}` sorted by contribution. These rows drive the ScoreBreakdown UI and the client portal.

Tests: `engines/probabilityEngine.test.ts`, `engines/absentFeatureRenormalization.test.ts`.

### 3.6 Feature providers

**`engines/competitiveDensity.ts`**
- `refreshNaicsDensity`: refreshed when older than 72 h. Calls USAspending `spending_by_award` from 2021-01-01, award types A–D, top 100 by amount, and stores average and median bidders (default average 5.0 when no counts), small-business rate and SDVOSB rate.
- `getDensityScore`: no `offersReceived` or no density row gives `{score: 0.5, densityRatio: null}`. Otherwise `ratio = offers/avgBidders` and `score = clamp(0.75 − (ratio − 0.5)*0.35, 0.05, 0.95)`.
- A DB error **throws** ("P1-2: never fabricate 0.5").

**`engines/agencyProfiler.ts`**
- Profiles are refreshed when older than 168 h.
- `getAgencyHistoryScore` is a weighted average: `smallBizRate*0.6`, plus `rate*0.8` for each certification the client holds (SDVOSB, WOSB, HUBZone), divided by the total weight and clamped to [0.05, 0.95].
- No profile gives 0.5. A DB error throws.
- `classifySetAside` normalizes USAspending set-aside strings into SDVOSB, EIGHT_A, HUBZONE, WOSB, SB or NONE. Unknown non-empty strings map to SB.

**`engines/incumbentDetector.ts`**
- Regex over the title and description: 4 STRONG patterns (recompete, follow-on, bridge contract, transition…) and 9 SOFT patterns.
- `detected = strong≥1 or soft≥2`. `strong = strong≥1 or soft≥3`. `confidence = min(1, strong*0.35 + soft*0.15)`.
- `inferredProbability`: not detected: 0.25 (empty text: 0.3). Strong: `min(0.90, 0.65 + conf*0.25)`. Otherwise `min(0.70, 0.40 + conf*0.25)`.
- The scoring worker uses it **only** when `incumbentProbability` is null and the detector fires, and it persists the inferred value back onto the opportunity.

**`engines/deadlinePriority.ts`** (UI triage only, not used in the probability): RED ≤7 days ("EXPIRED" if ≤0), YELLOW ≤20, GREEN >20.

### 3.7 Path A orchestration: `workers/scoringWorker.ts`

For each active client of the firm (lines 114–211):
1. `getAgencyHistoryScore` per client type.
2. `scoreOpportunityForClient` with `incumbentProbability` (text-inferred if needed), `historicalDistribution` (**null** when there is no award count, so it can be absent), `documentIntelScore`, `agencyHistoryScore`, `deadlineUrgencyScore`, `densityScore`.
3. Skip FAILED results. If every client fails, throw so BullMQ retries; never persist a fabricated score.
4. Optional Who-Wins blend (section 6.4).
5. Keep the client with the highest final probability.

Persist (lines 219–233):
- `probabilityScore = round4(best)` on a 0–1 scale.
- `expectedValue`, `isScored: true`, `deadlineUrgencyScore`, `densityRatio`.
- `scoreBreakdown = {factorContributions, formula: 'P(win) = 1 / (1 + e^-(6Z - 3))', rawZ, rawScore, probability, naicsSignal, matchedClientId, generatedAt, marketBasePrior?}`.

**Important:**
- `Opportunity.probabilityScore` is the max over all of the firm's clients. `routes/clientPortal.ts` deliberately never shows it to a client and uses that client's own `BidDecision` instead, because `scoreBreakdown` names `matchedClientId`.
- In this path `getDensityScore` and `getAgencyHistoryScore` return 0.5 (not null) when data is missing, and deadline urgency is always computed. These three features are therefore **never** absent here, even with renormalization on. This follows directly from the code. Whether it was intended is an open question.

### 3.8 Path B orchestration: `services/decisionEngine.ts` `evaluateBidDecision`

The steps run in this order (line numbers refer to that file):
1. Load the opportunity (`OPPORTUNITY_SCORING_SELECT`) and the client with `performanceStats`, or use `preloaded` rows. Throw if the client is inactive or belongs to another firm.
2. **Compliance gate.** If INELIGIBLE, upsert BidDecision with `NO_BID`, `fitScore: null`, `marketScore: null`, `winProbability: 0`, `complianceStatus: BLOCKED`, `riskScore: 100`, write history, and return (131–198).
3. **Fit score.** `relevantPastPerformance` is used only with the flag on; a lookup failure is logged and ignored.
4. **Market score.**
5. **Probability:**
   - `scoreOpportunityForClient` without agencyHistory, deadlineUrgency or density inputs, so those features use their defaults or count as absent.
   - `historicalDistribution` defaults to **0.3** here (not null), unlike Path A.
   - FAILED: **throw** "Decision aborted" (302–306).
6. **NAICS flag.** With no NAICS signal, a flag is added whose text still says "~26%". That text is stale relative to the actual engine (see section 10).
7. **Recompete boost** (326–338). If `recompeteFlag`:
   - incumbent probability <0.4: `p = min(p*1.15, 0.90)`.
   - <0.65: `min(p*1.08, 0.90)`.
   - otherwise, including null: `min(p*1.08, 0.90)`.
8. **Bayesian Beta-Binomial shrinkage** (344–400), only if the client has `totalWon + totalLost > 0`:
   - `k = BAYESIAN_PRIOR_STRENGTH = 10`.
   - `α = p*k + won`, `β = (1−p)*k + lost`, `p = α/(α+β)`.
   - Penalty drag: `p *= exp(−totalPenalties / 200000)` (`PENALTY_DRAG_HALF_LIFE`).
   - A non-finite result becomes 0.01. Clamped to [0.01, 0.95].
9. **Additive layers** (`services/probabilityLayers.ts`, 406–421):
   - Set-aside boost: FULL ×1.05 (SDVOSB/SDVOSBC/VSA with SDVOSB cert; WOSB; HZC; SBA/SBP with small business). PARTIAL ×1.02 (EDWOSB with WOSB cert; 8A/8AN with small business). No match or open: ×1.0.
   - Clamp to [0.01, 0.95].
   - 95% credible interval by normal approximation to Beta(α, β), Z = 1.96, only when α and β exist. Exposure only; it does not move the point estimate.
   - Env toggles `ENABLE_PROBABILITY_LAYER_SETASIDE` and `ENABLE_PROBABILITY_LAYER_CREDIBLE_INTERVAL`, both default on.
10. **Decision resolver.** `p = clamp(p + confidenceModifier, 0.01, 0.95)` (435). `complianceStatus` is PENDING if CONDITIONAL, otherwise APPROVED.
11. **Financials** (443–465):

| Item | Formula or constant |
|---|---|
| `estimatedValue` | `estValue \|\| 100000` |
| `OPTION_YEAR_FACTOR` | 2.5 |
| `SUB_REVENUE_SHARE` | 0.30 (BID_SUB only) |
| `TIME_TO_AWARD_DISCOUNT` | `1/1.08^(9/12)` |
| Proposal cost | `(BID_SUB ? 6000 : 15000) + value*0.005` |
| `expectedValue` | `p × effectiveValue × discount` |
| `netExpectedValue` | `expectedValue − proposalCost` |
| `roiRatio` | `net / cost` |
| `lifetimeValue` | `round(value*2.5)` |
| `expectedLifetimeValue` | `round(p × lifetime × discount)` |

Why the fixed proposal-cost base (step 11): "a flat percentage of contract value made estimatedValue cancel out of roiRatio".

12. **Flags:**
    - deadline <3 days: "Critical", <7: "High", <20: "Moderate".
    - competitionCount >10 and offersReceived >10 each add a flag.
13. **Persist.** Upsert `BidDecision` on `(opportunityId, clientCompanyId)` and fire a `BidDecisionHistory` write without awaiting it. `explanationJson` holds the full 3-layer breakdown, `featureBreakdown`, `rawProbabilityScore`, `setAsideMatch`, `credibleInterval`, flags and financials.

**Batch runner** (`services/portfolioDecisionEngine.ts`):
- Opportunities: ACTIVE, `isScored`, `probabilityScore > 0`, deadline not passed, ordered by `probabilityScore desc`, capped at `PORTFOLIO_SCORING_CAP` (default 1000, minimum 50).
- All active clients. Pairs with a BidDecision updated within 24 h are skipped.
- Concurrency 5. Failures are isolated per pair, and one shared past-performance cache is used per run (`portfolioDecisionEngine.test.ts`).

### 3.9 Matching v2 (relevance score, not probability): `engines/matchingV2.ts`

**Purpose:** the operator-facing match score in `services/opportunityMatcher.ts` when `MATCHING_V2_ENABLED`. Win probability and EV still come from the probability engine.

**Formula:**
- `total = round(100 × Σ w·raw / Σ w)` over dimensions **present** for the pair. 0 if none are present.
- Weights come from config (defaults below) and need not sum to 1.

| Dimension | Present when | Raw score |
|---|---|---|
| naics (0.35) | Client has a usable code and the opportunity has a usable NAICS (rejects blank and exactly `000000`) | Best over all client codes. Exact: 1.0. 5-digit prefix: 0.85. 4: 0.6. 3: 0.45. 2: 0.3. |
| psc (0.25) | Both sides have a PSC | Exact: 1.0. Same first 2 chars: 0.5. |
| awardSize (0.15) | Estimated value not null | Ratio to `historicalAvgAward` (or 500000). 0.5–2: 1.0. 0.25–0.5: 0.75. 2–5: 0.65. 5–10: 0.4. >10: 0.2. Otherwise 0.6. |
| geography (0.10) | Client state and POP both known | Same rules as fit geography, on a 0–1 scale (0.8 / 1.0 / 0.75 / 0.4) |
| pastPerformance (0.10) | `won+lost+submitted > 0` | `0.7*winRate + 0.3*completion` (winRate 0.5 if none decided) |
| setAsideAlignment (0.05) | Set-aside present and not NONE | Matching cert: 1.0, otherwise 0.2. Substring rules: SDVOSB/VOSB need sdvosb, HUBZONE, WOSB, 8A/SMALL_BUSINESS need smallBusiness. |

**Matcher gating** (`opportunityMatcher.ts`):
- Both paths first require a **2-digit NAICS overlap**.
- v2 drops only `total <= 0`.
- Legacy drops `probability < 0.15` and uses `round(probability*100)` as the match score.

Tests: `engines/matchingV2.test.ts`. AC1–AC4 are acceptance criteria from the lost task spec.

### 3.10 Score explanation: `services/scoring/scoreExplanation.ts`

`explainScore` (model version `section6-scoring-v1`):
1. Normalize the stored probability: values >1 are divided by 100.
2. Global resolution with `resolveStoredProbability`.
3. If an ACTIVE, non-stale tenant calibration exists, `finalScore = round(applyPlatt(rawProb, tenant)*100)` and `applied = 'TENANT'`. This replaces the global result; the two are never stacked.
4. Factor list over 8 inputs (`naicsCode, agency, setAsideType, estimatedValue, responseDeadline, competitionCount, incumbentProbability, historicalAwardCount`):
   - A missing input is `ABSENT` and "excluded … rather than counted as zero".
   - A contribution is shown only if `scoreBreakdown` recorded a numeric value under that key.
   - Direction: POSITIVE if >0.5 points, NEGATIVE if <−0.5, otherwise NEUTRAL.
5. Wilson interval (section 4.4) with `trainingSimilarity` 0.7 if the opportunity is enriched, otherwise 0.35.
6. Plain-language text. It always ends with "This is a decision-support estimate … It is not a prediction of the award."

Served at `GET /api/scoring-intel/score/:opportunityId` (`routes/scoringIntel.ts`).

### 3.11 Evidence statistics: `services/scoring/evidenceStats.ts`

**Incumbent retention** (`computeRetention`):
- Group awards by contract number.
- Only contract numbers seen at least twice whose **first** holder is the incumbent count.
- The last holder is the incumbent: retained. Different: lost.
- Fewer than 3 such re-competes (`MIN_SAMPLE_FOR_RATE`): `retentionRate = null`, basis INSUFFICIENT_DATA.
- Otherwise basis OBSERVED_AWARD_SHARE. Confidence is PROBABLE at ≥8 (`MIN_SAMPLE_FOR_PROBABLE`), otherwise AMBIGUOUS.
- Window 5 years. Limits: 300 incumbents, 20000 awards.

**Competitor stats** (`computeCompetitorStat`):
- ≥3 confirmed bids: CONFIRMED_WIN_RATE.
- Else pool ≥3 and awards >0: OBSERVED_AWARD_SHARE.
- Else awards >0: HISTORICAL_AWARD_FREQUENCY.
- Else INSUFFICIENT_DATA.
- `refreshCompetitorStats` hard-codes confirmed `{wins: 0, losses: 0}` because "the platform does not currently capture who else bid". CONFIRMED_WIN_RATE is therefore currently unreachable in production.
- `BASIS_LABELS` holds the exact UI strings, e.g. "Observed award share", "Bid-participation data unavailable".

### 3.12 Pricing sensitivity: `services/scoring/pricingSensitivity.ts`

Read-only price-to-probability curve (`price-position-logit-v1`):
- `position = (price − benchmark)/benchmark`.
- `p(position) = σ(logit(p_base) − 2.2·(position − position_base))`, with `DEFAULT_PRICE_ELASTICITY = 2.2`.
- Clamped to [0.0001, 0.9999]. The base probability is clamped to [0.001, 0.999].
- Benchmark hierarchy: `Opportunity.estimatedValue`, then median of at least 3 AwardHistory amounts, then the linked forecast value.
- No scenarios, or no or non-positive benchmark: INSUFFICIENT_DATA, with no price effect implied.
- Validity is CALIBRATED only when the tenant sample count is ≥30 (`MIN_SAMPLES_FOR_CALIBRATED`), otherwise `UNVALIDATED_SCENARIO_ANALYSIS`.
- `isMonotonic` is verified, not assumed. It never writes to pricing scenarios.

### 3.13 Capability gap: `services/scoring/capabilityGap.ts`

- Gaps come from `discovery/matchRefresh` and `setAsideEligibility`.
- Partner `gapCloseScore = round(closes / (closes + remaining) * 100)`. Only partners scoring >0 are kept, top 10 of up to 200.
- Certifications are credited only if they are explicitly on the partner record. Vehicle gaps are always "not tracked".
- Recommendations only: it never creates a TeamingArrangement.
- It emits a capability-gap event only when the gap set got worse.

### 3.14 Human Bid/No-Bid scorecard: `services/scorecardScoring.ts`, `services/qualificationDecision.ts`

- Integer arithmetic. Active weights must total exactly 100.
- `totalScore = round(Σ score·weight / 100)`.
- Recommendation (`scorecard-v1`): REVIEW_REQUIRED if any required criterion is unscored. Otherwise BID ≥70, CONDITIONAL ≥50, NO_BID <50.
- Default criteria weights: capability_fit 20, competition 12, capacity 12, relationship 12, past_performance 12, eligibility 12, timeline 8, strategic_value 8, pricing 4.
- `recordQualificationDecision` requires a human `actorUserId`, a complete scorecard, and an override reason when the decision differs from the recommendation. REVIEW_REQUIRED or no recommendation means every decision counts as an override.
- BID moves the pursuit to CAPTURE and NO_BID to NO_BID, when the transition is legal.
- "The agent never imports this module."

### 3.15 Customer-facing tier: `utils/scoreTier.ts` (mirrored in `frontend/src/utils/fitTier.ts`)

- STRONG ≥0.55, MODERATE ≥0.30, otherwise WEAK. Null or NaN gives UNSCORED. Input is clamped to [0, 1].
- The code labels the thresholds "Provisional".
- The client portal (`routes/clientPortal.ts`) computes the tier from **that client's** `BidDecision.winProbability`. It shows the number only if `SHOW_NUMERIC_FIT_SCORE` is on, via `fitDisplay`: "Strong fit · 72/100".
- Naming trap: the portal's "Fit" is the win **probability** tier, not `BidDecision.fitScore` (section 3.2).

### 3.16 Portfolio expected value: `services/scoring/portfolioValue.ts`

**Unit:** one row per **opportunity** (ACTIVE, non-demo, deadline ≥ now, up to 2000), never per pursuit.

**Value hierarchy** (`VALUE_SOURCE_ORDER`): CONTRACT_CEILING, then CONTRACT_FUNDED, OPPORTUNITY_ESTIMATE, OPPORTUNITY_RANGE_MIDPOINT, FORECAST_ESTIMATE.

**Probability:**
- Stored score (>1 is divided by 100).
- Tenant Platt if ACTIVE and not stale, otherwise `resolveStoredProbability(...).finalScore/100`.

**Exclusions** (reported, never counted as zero): rows with no value, or with probability ≤0.

**Interval:** Wilson with `dataCompleteness 1` and `trainingSimilarity 0.6`.

**Expected value:** `value × p`. Lower and upper EV use the interval.

**Other outputs:**
- High value, high uncertainty: top quartile by value with no interval or an interval wider than 0.3, top 10.
- Agency HHI: ≥0.25 "Highly concentrated", ≥0.15 "Moderately", otherwise "Well diversified".
- Capacity conflict: at least 3 deadlines in one week (default `capacityConflictThreshold`).
- Upcoming deadlines: next 15.

---

## 4. Calibration

There are **three** separate calibration mechanisms plus two kinds of interval. They have different guards.

### 4.1 Global calibration (platform-wide curve)

**Fitting:**
- Every `v2-permutation` backtest run fits both an isotonic PAV curve (`services/isotonicCalibration.ts`) and Platt parameters (`services/plattCalibration.ts`) on its in-scope predictions (`historicalBacktest.ts` 477–480).
- Both fitters return null below 20 points. Platt also returns null on a single-class dataset.
- Platt: gradient descent on cross-entropy over `logit(p)`. Starts at A=1, B=0. `maxIter` 1000, `lr` 0.05, halved whenever the loss rises. Stops when `lr < 1e-10` or the gradient norm is below 1e-6. EPS 1e-7.
- Isotonic: stack-based PAV. Linear interpolation between breakpoints, flat extrapolation.
- Both store `preBrier` and `postBrier`, measured on the **same** training set.

**Loading:** `services/calibrationCache.ts` `refreshCalibrationCache()`.
- Picks the most recent `BacktestRun` with `methodVersion = 'v2-permutation'`, `status = 'COMPLETE'` and a non-null curve, into process memory.
- Runs at boot and on `POST /api/admin/backtest/calibration/refresh`.
- `CALIBRATION_METHOD=isotonic|platt` selects the method (default isotonic).
- v1-synthetic curves are excluded: "biased negative distributions would miscalibrate real production scores".

**Applied in two places with different guards:**

| Where | Function | Guards |
|---|---|---|
| Inside the engine, on every score (Path A, Path B, backtest) | `calibrateProbability` (calibrationCache.ts 169–184) | Flag `ENABLE_PROBABILITY_CALIBRATION` on, the selected method has params, and `postBrier < preBrier`. No sample-size or staleness check. |
| At read time on a stored score | `winProbability.resolveWinProbability` | All 7 rules below |

**Activation rules in `services/winProbability.ts`** (header lines 10–17, logic 90–124). Each rule maps to a result label:

1. Flag off: **RAW**, reason `CALIBRATION_DISABLED` (curve present) or `NO_CALIBRATION`.
2. No params: **RAW**, reason `NO_CALIBRATION`. `dataSufficiency` is NONE.
3. `methodVersion !== 'v2-permutation'`: **FALLBACK** `INCOMPATIBLE_VERSION`.
4. Invalid params. Isotonic needs at least 2 points, equal lengths, all finite, and xs and ys non-decreasing. Platt needs finite A and B. Fails as **FALLBACK** `INVALID_PARAMS`.
5. `sampleSize < CALIBRATION_MIN_SAMPLE` (default 50): **FALLBACK** `INSUFFICIENT_SAMPLE`.
6. Age > `CALIBRATION_MAX_AGE_DAYS` (default 180) or unknown: **FALLBACK** `STALE`.
7. `postBrier >= preBrier`: **FALLBACK** `NO_BRIER_IMPROVEMENT`.
8. Otherwise **CALIBRATED**. The curve is applied once to the clamped raw value.

Output: `{rawScore, finalScore}` as 0–100 integers, plus `scoreType`, `changed`, `method`, `methodVersion`, `sampleSize`, `lastFittedAt`, `reason`, `dataSufficiency`. Served by `GET /api/opportunities/:id/win-probability`, which returns `scored: false` with null scores if the opportunity has not been scored.

Admin status (`GET /api/admin/backtest/calibration/status`, via `calibrationStatus.ts`):
- `fitted` means a curve or Platt params exist.
- `applied` means fitted **and** the flag is on.
- `active` is kept for backward compatibility and equals `applied`.

### 4.2 Tenant calibration: `services/scoring/tenantCalibration.ts`

**Method:** Platt, method version `tenant-platt-v1`, fitted on the firm's **own verified outcomes**.

**Samples** (`collectOutcomeSamples`, 3-year window, up to 5000 rows each):
- `SubmissionRecord.outcome` WON/LOST, labelled HUMAN_CONFIRMED.
- A non-DRAFT, non-CANCELLED `Contract` against an opportunity counts as a win, labelled SYSTEM_DERIVED, unless a submission sample already exists for that opportunity.
- Demo opportunities are skipped.
- `predicted` is the opportunity's stored `probabilityScore`, normalized to 0–1.

**Activation rule** (`fitTenantCalibration`). All of these must hold:

1. At least 30 samples (`DEFAULT_MIN_SAMPLE`, overridable per call). Otherwise state DRAFT is returned and **nothing is persisted**.
2. Both outcome classes present. Otherwise REJECTED.
3. If there are at least 50 samples (`MIN_SAMPLES_FOR_HOLDOUT`), a deterministic holdout is used. A sample is in the holdout when the first 4 bytes of `sha256(sampleId)` / 0xffffffff < 0.3 (`HOLDOUT_FRACTION`). The split must leave at least 10 train and 5 holdout, and the training split must have both classes.
4. `fitPlatt` succeeds with finite A and B.
5. `baselineBrier − calibratedBrier ≥ 0.001` (`MIN_BRIER_IMPROVEMENT`) on the holdout. Below 50 samples it is measured on the training set and the reason text says so. A tie does not activate.

**If the bar is met:**
- A row is created (state EVALUATED) and immediately `activateCalibration`'d.
- In one transaction the previous ACTIVE becomes ROLLED_BACK, the new row becomes ACTIVE with `rolledBackFromId`, and `CALIBRATION_UPDATED` is emitted.

**If not:** the row is persisted as REJECTED with `rejectionReason`, and the previously active calibration keeps running.

**Other behaviour:**
- Every sample used is upserted into `CalibrationSample`, unique on (firm, opportunity, source), with an `isHoldout` flag.
- Manual activation: `POST /api/scoring-intel/calibration/:id/activate` refuses REJECTED rows.
- Rollback: `POST /api/scoring-intel/calibration/rollback` restores `rolledBackFromId`, or simply deactivates if there is none.
- Staleness: `stalenessDays` default 180, measured from `activatedAt`. `getActiveTenantCalibration` returns `isStale`, and callers fall back. `markStaleCalibrations` (section6Worker) sets the state to STALE.
- Master flag: with `ENABLE_PROBABILITY_CALIBRATION` off, `getActiveTenantCalibration` returns null, so the tenant calibration is never applied.

**Precedence:** tenant wins over global and replaces it (`scoreExplanation.ts` 205–214, `portfolioValue.ts` 240–244). It is applied to the stored probability, not to a globally re-resolved one.

### 4.3 Bayesian per-client shrinkage (Path B only)

This is also called "calibration" in the code ("Bayesian calibrated: …"): a Beta-Binomial with prior strength k = 10 (section 3.8 step 8). It is not a curve and is always on for clients with decided bids.

### 4.4 Intervals

| Interval | Where | Method | When shown |
|---|---|---|---|
| Credible interval | `probabilityLayers.credibleInterval95`, stored in `BidDecision.explanationJson.credibleInterval` | Normal approximation to Beta(α, β), ±1.96·sd, clamped to [0, 1] | Only when the client has decided bids |
| Confidence interval | `services/scoring/confidenceInterval.ts` (`wilson-bin-v1`) | Wilson 95% (z = 1.959963985) on the tenant's 10 equal-width calibration bins; the half-widths are re-anchored on the point estimate | Only when the matching bin has at least 8 samples (`MIN_BIN_SAMPLES`), otherwise the exact label `INSUFFICIENT DATA — INTERVAL NOT AVAILABLE` |

Confidence state for the Wilson interval:
- Starts as HIGH if the tenant has at least 100 samples and the bin at least 25, MEDIUM if at least 30 tenant samples, otherwise LOW.
- Completeness <0.8 downgrades HIGH to MEDIUM. Completeness <0.5 sets LOW.
- Similarity <0.5 downgrades HIGH to MEDIUM. Similarity <0.25 sets LOW.

### 4.5 Labels

`ScoreType` (`winProbability.ts`) has three values:

| Label | Meaning |
|---|---|
| `RAW` | No calibration was attempted (flag off or nothing fitted) |
| `CALIBRATED` | A curve passed every guard and was applied once |
| `FALLBACK` | A curve exists and the flag is on, but a guard failed, so the raw score is shown with `reason` |

`scoreExplanation` reuses these values and adds `calibration.applied ∈ {TENANT, GLOBAL, NONE}`. The qualification recommendation schema stores `probabilityMode` as "RAW | CALIBRATED | FALLBACK — the canonical winProbability vocabulary" (schema.prisma ~6659).

---

## 5. Prisma models (backend/prisma/schema.prisma)

| Model | Role |
|---|---|
| `Opportunity.probabilityScore Float @default(0)`, `scoreBreakdown Json?`, `deadlineUrgencyScore`, `densityRatio`, `isScored` | Path A output. The scoring worker writes it on a 0–1 scale. The schema comment near line 6659 calls it a "0–100 score". Several readers defensively treat >1 as legacy 0–100. |
| `BidDecision` (~line 1077) | Path B output. Unique (opportunityId, clientCompanyId). `fitScore`/`marketScore` 0–100, `winProbability` 0–1, `riskScore`, `complianceGate`, `explanationJson`, Decimal financials. |
| `BidDecisionHistory` | Audit snapshot per evaluation |
| `BacktestRun` (~2028) / `BacktestPrediction` (~2152) | Backtest runs, metrics, `calibrationCurve` JSON, `plattA/B/PreBrier/PostBrier`, per-prediction rows |
| `TenantCalibration` (~5097) | Versioned tenant Platt model. `state ∈ CalibrationState {DRAFT, EVALUATED, ACTIVE, REJECTED, ROLLED_BACK, STALE}`, metrics vs baseline, `rolledBackFromId`, `stalenessDays` default 180, `minSampleSize` default 30 |
| `CalibrationSample` (~5143) | Verified outcome samples. `verification ∈ {UNVERIFIED, HUMAN_CONFIRMED, SYSTEM_DERIVED}`. Unique (firm, opportunity, outcomeSource). |
| `PublicAwardTraining` (~3646) | Who-Wins corpus of competed USAspending awards. `awardKey` = `agencyCode:piid` (unique); `offersReceived` winsorized to [1, 50] |
| `PublicWinPrior` (~3681) | Segment priors per `(modelVersion, segmentLevel, naicsPrefix, setAsideBucket)`. "shrunkMeanInvOffers … USE THIS" |
| `WhoWinsModel` (~3706) | Conditional-logit coefficients, feature stats, training config, `evalReport`. `status`: CANDIDATE, ACTIVE or ARCHIVED |
| `Scorecard` / `ScorecardCriterion` / `ScorecardDecision` (~1200–1290) | Human scorecard, criteria, decision history. `ScorecardRecommendation {BID, NO_BID, CONDITIONAL, REVIEW_REQUIRED}` |
| `IncumbentRetentionStat`, `CompetitorAwardStat` | Evidence aggregates. `RateBasis`, `EvidenceConfidence` |
| `PricingSensitivityAnalysis`, `CapabilityGapAssessment` | Side-analysis outputs |
| `NaicsCompetitiveDensity`, `AgencyAwardProfile` | Feature caches |

---

## 6. Who-Wins model (public-label win prior)

**Purpose:** the heuristic engine is not calibrated on real outcomes. Who-Wins provides a level that *is* calibrated by construction, built from public award data: every award has exactly one winner.

### 6.1 Data: `services/whoWins/trainingIngest.ts`

- Source: USAspending `POST /api/v2/download/awards/`, the advanced-search async CSV.
  - Do **not** switch to `/bulk_download/awards/`. It "SILENTLY DROPS a naics filter".
  - The request is aborted if the echoed `naics_codes` filter is missing.
- NAICS universe (`resolveNaicsUniverse`): every client code plus every opportunity code, platform-wide, keeping only valid 6-digit codes in sectors 11–92.
- Chunking: batches of 25 NAICS × each fiscal year.
  - Covered chunks are skipped unless `WHO_WINS_FORCE_REFETCH=true`.
  - 2 retries with a cool-off (`WHO_WINS_COOLOFF_MS`, default 300000) on transient errors.
  - Spacing between chunks: `WHO_WINS_CHUNK_SPACING_MS`, default 15000.
  - Polling timeout 30 min.
- Row filter (`parseRow`): `extent_competed_code ∈ {A, D, E, F, CDO}`, 6-digit NAICS, 12-character UEI, a PIID, obligated amount ≥ 10000 (default `minObligated`), FY 2000–2100. Offers are winsorized to [1, 50], or null.
- Inserted with `createMany` and `skipDuplicates`, keyed by `awardKey`.

### 6.2 Priors: `services/whoWins/priorBuilder.ts`

- Segments are (GLOBAL, NAICS2, NAICS4, NAICS6) × set-aside bucket (`setAside.ts`: NONE, SMALL_BUSINESS, SDVOSB, WOSB, HUBZONE, SBA_8A, OTHER), plus an `ANY` bucket.
- Base rate: **mean of `1/(K+1)`** over awards with known offers K. This is the "ENTRANT frame": the client joins the observed field, which caps the rate at 0.5.
  - The file header, the `PublicWinPrior` schema comment and the `whoWins.test.ts` test title still say E[1/K]. The code uses `1/(K+1)` (lines 115–122).
- Shrinkage is top-down: `shrunk = (n·obs + m·parent)/(n + m)` with `m = DEFAULT_PSEUDO_COUNT = 25`.
  - Parent order: same bucket one level up, then the ANY bucket, then GLOBAL/ANY.
  - Root fallbacks: mean-inverse 0.33, incumbency 0.5.
- Incumbency share: an award is an incumbent win if its UEI or parent UEI won earlier in the same NAICS4.
- Lookup ladder (`lookupPrior`): NAICS6, NAICS4, NAICS2, GLOBAL, each trying the specific bucket and then ANY.

### 6.3 Training and evaluation: `services/whoWins/whoWinsTrainer.ts`, `conditionalLogit.ts`

**Model:** conditional logit (McFadden) over candidate sets of {winner + 9 uniformly sampled other winners from the same NAICS4}.

**Features** (`FEATURE_NAMES`), all strictly time-filtered (`countBefore` is strict):

| Feature | Definition |
|---|---|
| `experienceSegment` | `log1p(prior awards in this NAICS4)` |
| `experienceAgency` | `log1p(prior awards at this agency)` |
| `recency` | `exp(−months since last NAICS4 award / 24)` |
| `sizeAlignment` | `−\|log(median of last ≤25 prior amounts) − log(amount)\|`, clamped to [−3, 0] |
| `setAsideFit` | `log1p(prior awards in this bucket)` |

A recipient with no history gets `[0, 0, 0, −3, 0]`.

**`DEFAULT_TRAINING_CONFIG`:** negativesPerAward 9, seed 20260702, trainMaxFy 2024, minSegmentWinners 10, maxGroups 60000, l2 1e-3.

**Fit:**
- Features are standardized on train moments.
- Full-batch gradient ascent with `learningRate` 0.5 and up to 200 epochs.
- `nonNegative: true` (projected β ≥ 0) because "collinear +/− splits would read as 'experience hurts you'".
- Converges when `|ΔLL| < 1e-7·groups`.
- Throws if there are fewer than 500 awards or fewer than 200 training groups.
- Candidate pools use the train window only. Groups are down-sampled deterministically by stride when they exceed `maxGroups`.

**Out-of-time evaluation** on FY > trainMaxFy:
- top-1 accuracy, mean reciprocal rank, pairwise AUC.
- Baselines: random `1/(negatives+1)`, and experience-only top-1 and MRR.
- Prior stability on NAICS4×bucket segments with at least 30 test awards: MSE of the train-shrunk prior vs the realized test mean, against a climatology MSE. Skill score = `1 − prior/clim`.
- Note that this stability check uses `1/K`, not the `1/(K+1)` used by the persisted priors (see section 10).

**Output:**
- A `WhoWinsModel` row with status CANDIDATE.
- `trainingConfig` also stores `segmentMeanUtility` (per-NAICS4 mean winner utility) and `globalMeanUtility`.
- `activateModel` archives any ACTIVE row and activates the new one.

**Build script:** `backend/prisma/scripts/buildWhoWins.ts`, run with `docker exec bytescon_backend npx ts-node prisma/scripts/buildWhoWins.ts`.

| Env var | Effect |
|---|---|
| `WHO_WINS_SKIP_INGEST` | Skip the ingest step |
| `WHO_WINS_INGEST_ONLY` | Stop after ingest |
| `WHO_WINS_FY_START` / `WHO_WINS_FY_END` | Fiscal-year range, default 2022..2026 |
| `WHO_WINS_NAICS` | Explicit NAICS list |
| `WHO_WINS_MAX_GROUPS` | Override `maxGroups` |
| `WHO_WINS_ACTIVATE` | **Activates by default**; set `false` to keep the model as CANDIDATE |

The version string is `v1-YYYY-MM-DD-HH-MM`. Activation alone changes no customer number, because blending is separately flag-gated. Status is visible at `GET /api/admin/backtest/who-wins/status`.

### 6.4 Runtime use: `services/whoWins/publicWinPrior.ts`

**`getPublicWinPrior`:**
1. Find the ACTIVE model. Model and segment lookups are cached for 10 minutes (`CACHE_TTL_MS`).
2. Look up the segment prior and set `pBase = clamp(shrunkMeanInvOffers, 0.02, 0.9)`.
3. Compute the relative-strength adjustment:
   - Client with a valid 12-character UEI: load up to 2000 of its public awards and compute features with the training code. The opportunity's agency is matched by exact case-insensitive `agencyName`; no match leaves the agency feature at 0.
   - `adjustmentOdds = exp(clamp(clientU − refU, −ln 3, ln 3))`, so the odds stay in [1/3, 3] (`ODDS_CLAMP = 3`).
   - `refU` = the segment's NAICS4 mean winner utility, else the global mean.
   - Client without a UEI: the zero-history feature vector `[0, 0, 0, −3, 0]` is used against the same reference.
4. `pWin = clamp(σ(logit(pBase) + ln(adjustmentOdds)), 0.01, 0.95)`.
5. Any error, or no model or segment, returns null ("feature unavailable", never 0).

**Blend** (`blendWithPrior`, used only in Path A when `WHO_WINS_PRIOR_ENABLED`):
- `p = σ(w·logit(prior) + (1 − w)·logit(heuristic))`, with both inputs clamped to [0.02, 0.98].
- `w = WHO_WINS_PRIOR_WEIGHT`, default 0.75. Per the config comment, w should be re-fit by stacking once at least 100 real WON/LOST outcomes exist.
- The result is persisted under `scoreBreakdown.marketBasePrior`.

Path B (BidDecision) does **not** use the Who-Wins prior.

Tests: `services/whoWins/whoWins.test.ts` (needs a DB) covers CSV parsing, bucketing, shrinkage, the blend, leakage, logit coefficient recovery and the end-to-end flow on a synthetic corpus.

---

## 7. Backtesting and metrics

**Service:** `services/backtest/historicalBacktest.ts` `runBacktest`.

| Parameter | Default | Route clamp (`routes/backtest.ts`) |
|---|---|---|
| sampleSize | 1000 | 50–2000 |
| yearsBack | 5 | 1–10 |
| K = predictionsPerAward | 4, clamped 1–10 | not exposed by the route |
| methodVersion | `v2-permutation` | `v1-synthetic` or `v2-permutation` |
| cutoffDate | none | ISO date |

**Steps:**
1. Sample awards uniformly at random from `public_award_training` (`ORDER BY random()`). Fall back to USAspending live search only if the corpus cannot fill the sample.
2. Resolve each winner's profile through the SAM entity lookup. A miss falls back to an `{naics: [award NAICS], smallBiz: true}` profile.
3. Build predictions per award: 1 positive (winner vs own award) plus K−1 negatives.
   - **v1-synthetic** (`buildSyntheticNegatives`): up to 3 mutated profiles (wrong sector `XX9999`, flipped size class, inverted set-aside flags).
   - **v2-permutation:** other sampled winners' real profiles against this award (`pickPermutationPartners`, Fisher-Yates).
4. Score with `scoreOpportunityForClient` passing **no** historical signals ("would create time leakage"). FAILED results are excluded.
5. Persist all predictions. Metrics use only awards on or after `cutoffDate`.

**Metrics** (`services/backtest/metrics.ts`):

| Metric | Definition |
|---|---|
| Brier | Plus Murphy decomposition (reliability, resolution, uncertainty) over 10 equal-width bins |
| Log loss | Predictions clamped at 1e-15 |
| ROC AUC | Mann-Whitney with average ranks; null if single-class |
| ECE | Default **equal-mass** 10 bins with ties kept together ("PROMPT.md §6.3"); `'equal-width'` available |
| Calibration bins | 10 deciles |
| `factorMeans` | Per-feature mean over winners |

**Calibration fit:** isotonic and Platt are fitted **only for v2-permutation** runs.

**Routes** (`/api/admin/backtest`, firm ADMIN **and** platform operator — `requirePlatformAdmin`, `PLATFORM_ADMIN_EMAILS`; B8, 2026-11-04):

| Route | Purpose |
|---|---|
| `POST /run` | Synchronous, 30-minute timeout |
| `GET /runs` | Last 25 runs |
| `GET /runs/:id` | Run detail plus the 20 lowest-probability predictions |
| `POST /calibration/refresh` | Reload the global curve into memory |
| `GET /calibration/status` | Fitted / applied status |
| `GET /who-wins/status` | Who-Wins model and corpus status |

Who-Wins has its own separate out-of-time evaluation (section 6.3).

---

## 8. Feature flags and defaults

Defined in `config/config.ts` unless noted. `optionalBool` accepts `1`, `true` or `yes`. The `MATCHING_V2_ENABLED` and `PROBABILITY_RENORMALIZE_ABSENT` checks accept only `'1'`.

| Flag | Default | Effect |
|---|---|---|
| `MATCHING_V2_ENABLED` | `'1'` in dev, `'0'` in production | Operator match score uses matchingV2 instead of `probability*100` |
| `MATCHING_W_NAICS` / `_PSC` / `_AWARD_SIZE` / `_GEOGRAPHY` / `_PAST_PERFORMANCE` / `_SET_ASIDE` | 0.35 / 0.25 / 0.15 / 0.1 / 0.1 / 0.05 | matchingV2 dimension weights; they need not sum to 1 |
| `PROBABILITY_RENORMALIZE_ABSENT` | `'1'` in dev, `'0'` in production | Drop absent features from the z-score. Config comment: "MOVES A CUSTOMER-FACING NUMBER … sample-test ~8 opportunities and then re-score the tenant" |
| `ENABLE_PROBABILITY_CALIBRATION` | off (read straight from `process.env` in `calibrationCache.ts`, `winProbability.ts`, `tenantCalibration.ts`, `routes/backtest.ts`; accepts only `'1'` or `'true'`) | Master switch for global **and** tenant calibration |
| `CALIBRATION_METHOD` | `isotonic` (env, `calibrationCache.ts`) | `platt` selects Platt. Any other value means isotonic |
| `CALIBRATION_MIN_SAMPLE` | 50 (env, `winProbability.ts`) | Read-time global guard |
| `CALIBRATION_MAX_AGE_DAYS` | 180 (env, `winProbability.ts`) | Read-time global guard |
| `SHOW_NUMERIC_FIT_SCORE` | false | Client portal shows "Tier · NN/100" instead of the tier only |
| `RELEVANT_PAST_PERFORMANCE_ENABLED` | false | Fit past-performance blend. Config says to run a calibration backtest first, and to hoist the per-client fetch first (perf) |
| `WHO_WINS_PRIOR_ENABLED` | false | Blend the Who-Wins prior into Path A |
| `WHO_WINS_PRIOR_WEIGHT` | 0.75 | Blend weight on the prior's logit |
| `OUTCOME_LOGGING_REWARD_TOKENS` | 0 | Proposal tokens granted the first time a submission outcome is logged (`routes/submissions.ts`), to grow calibration labels |
| `ENABLE_PROBABILITY_LAYER_SETASIDE` | on (env, `probabilityLayers.ts`) | Path B set-aside multiplier |
| `ENABLE_PROBABILITY_LAYER_CREDIBLE_INTERVAL` | on (env) | Path B credible interval |
| `PORTFOLIO_SCORING_CAP` | 1000, minimum 50 (env) | Opportunities per portfolio run |
| `WHO_WINS_FORCE_REFETCH`, `WHO_WINS_CHUNK_SPACING_MS` (15000), `WHO_WINS_COOLOFF_MS` (300000), `USASPENDING_BASE_URL` | see section 6.1 | Ingest behaviour |

---

## 9. Invariants (do not break)

| # | Rule | Enforced by |
|---|---|---|
| 1 | Probability weights sum to 1.0 (±0.001); the module throws otherwise | `probabilityEngine.ts` 28–31 and 227–230 |
| 2 | A failed probability compute never yields a number: `FAILED` has no numeric fields; callers skip it or throw; the scoring worker refuses to persist when every client failed; the backtest excludes it | `probabilityEngine.test.ts` ("returns FAILED (no fabricated number)", "FAILED result exposes no numeric score fields"), `scoringWorker.ts` 151–217, `decisionEngine.ts` 302–306, `portfolioDecisionEngine.test.ts` |
| 3 | DB errors in feature providers throw; only genuine no-data returns the neutral 0.5 | `competitiveDensity.test.ts`, `agencyProfiler.test.ts` ("THROWS on a DB/query error — never fabricates a 0.5") |
| 4 | Missing data is absent, not zero; an explicit 0 and a real NAICS mismatch stay as evidence; all-absent gives the model prior, not FAILED | `absentFeatureRenormalization.test.ts` |
| 5 | Turning renormalization on does not change a fully-enriched pair | `absentFeatureRenormalization.test.ts` ("keeps a fully-enriched pair identical under both flag states") |
| 6 | Read-time calibration is applied exactly once, to the raw input, and is deterministic | `winProbability.test.ts` ("does not double-apply", "is deterministic"); `scoreExplanation.ts` header; `qualificationAgentHandler.ts` ~465. But see section 10 item 1. |
| 7 | Tenant calibration and global calibration are never stacked; tenant wins | `scoreExplanation.ts` 205–214, `portfolioValue.ts` 240–244 |
| 8 | A calibration is activated only if it beats the uncalibrated baseline (global: `postBrier < preBrier`; tenant: by ≥0.001 on the holdout). Fitting alone is not enough, and a REJECTED tenant calibration cannot be force-activated | `calibrationCache.ts` `curveImproves`, `winProbability.test.ts` (NO_BRIER_IMPROVEMENT), `tenantCalibration.ts` `meetsBar`, `routes/scoringIntel.ts` activate route |
| 9 | Only v2-permutation backtests produce production curves | `historicalBacktest.ts` 477–480, `calibrationCache.ts` query, `winProbability.ts` `COMPATIBLE_METHOD_VERSION` |
| 10 | With `ENABLE_PROBABILITY_CALIBRATION` off, nothing is calibrated (global or tenant) | `calibrateProbability`, `resolveWinProbability`, `getActiveTenantCalibration`; `calibrationStatus.test.ts` ("fitted, NOT applied") |
| 11 | Award share is never labelled a win rate; CONFIRMED_WIN_RATE requires ≥3 real bids; every rate carries its denominator; below 3 observations the rate is null | `evidenceStats.test.ts` ("NEVER reports a win rate when no bid-participation data exists", "never describes an award-derived figure as a win rate", "always carries a denominator") |
| 12 | The numeric fit score is hidden from customers by default; the honest surface is the tier plus factor breakdown | `SHOW_NUMERIC_FIT_SCORE` default false, `utils/scoreTier.ts` header, `frontend/src/utils/fitTier.ts` `fitDisplay`, `scoreTier.test.ts` |
| 13 | A client never sees another client's score: the portal uses that client's own BidDecision, never `Opportunity.probabilityScore` or `scoreBreakdown`; a missing score is `null` ("not yet scored"), never 0 ("Weak") | `routes/clientPortal.ts` `clientOwnScore` and its comments (~36–60, ~276, ~396–405) |
| 14 | No interval is shown when the bin has fewer than 8 samples; the exact label is rendered | `confidenceInterval.test.ts` ("returns no interval and the exact required label") |
| 15 | Pricing curve is monotonic non-increasing, never shows 0% or 100%, and is labelled UNVALIDATED_SCENARIO_ANALYSIS below 30 samples | `pricingSensitivity.test.ts` |
| 16 | Portfolio counts each opportunity once and excludes (never zeroes) rows with no value or probability | `portfolioValue.ts` header and 227–237 |
| 17 | Only a human can record a qualification decision; an override needs a reason | `qualificationDecision.ts` 81–115 |
| 18 | Scorecard weights sum to exactly 100 and the arithmetic is integer and deterministic | `scorecardScoring.test.ts` |
| 19 | Who-Wins features use only history strictly before the award; evaluation is out-of-time; the logit is sign-constrained | `whoWins.test.ts` (leakage guard, nonNegative projection), `whoWinsTrainer.ts` |
| 20 | Who-Wins adjustment odds stay in [1/3, 3] and pWin in [0.01, 0.95]; a missing prior is null, never 0 | `publicWinPrior.ts`, `whoWins.test.ts` |
| 21 | Path B probability stays in [0.01, 0.95] after every stage | `decisionEngine.ts` 396 and 435; `probabilityLayers.test.ts` ("clamps … [0.01, 0.95]") |
| 22 | INELIGIBLE is always NO_BID with risk 100 | `decisionResolver.test.ts` |

---

## 10. Known gaps and open questions

1. ✅ **Fixed 2026-11-04 (B17):** `computeProbability` now returns the raw score; calibration happens at `resolveStoredProbability`, or `decisionEngine` / client match emails for live results. Was: **possible double calibration when `ENABLE_PROBABILITY_CALIBRATION` is on.**
   - `computeProbability` already calls `calibrateProbability` (probabilityEngine.ts 257) before Path A persists `Opportunity.probabilityScore`.
   - `resolveStoredProbability` then treats that stored value as RAW ("never a pre-calibrated value", winProbability.ts 145–147) and may apply the curve again.
   - Tenant Platt is also fitted on, and applied to, that stored value.
   - The backtest scores through the same engine, so with the flag on, curves would be fitted on already-calibrated predictions.
   - Path A may also include the Who-Wins blend.
   - The flag is off by default, so this is latent. The `winProbability.test.ts` "no double calibration" test only covers the resolver in isolation.
2. ✅ **Schema comment corrected 2026-11-04.** **Probability scale is inconsistent.**
   - The scoring worker writes 0–1.
   - The schema comment (~6659) says 0–100.
   - **Fixed 2026-11-03:** `qualificationAgentHandler.ts` used to divide `probabilityScore` by 100 unconditionally, so a real 0–1 score of 0.8 was read as 0.8% (its tests seeded 0–100 values and hid it). It now uses `toProbabilityFraction` (>1 → /100), with a regression test that stores 0.8.
   - `tenantCalibration.normalizeProbability`, `portfolioValue` and `pricingSensitivity` defensively treat >1 as legacy 0–100.
3. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **Two calibration guard sets.** The hot-path `calibrateProbability` checks only the flag and Brier improvement. The read-time resolver also checks sample size (50) and age (180 days). A curve could be applied at scoring time but reported as FALLBACK at read time.
4. ✅ **Inputs fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)); post-processing is owner decision D6.** **Path A vs Path B diverge.** They feed different inputs (`historicalDistribution` null vs 0.3; Path B passes no agency-history, deadline or density inputs) and different post-processing (Path B has recompete, Bayesian, set-aside and modifier steps; Path A has the Who-Wins blend). The tier in the client portal comes from Path B; opportunity lists and sorting come from Path A.
5. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **Renormalization is partly ineffective in Path A.** `getDensityScore` and `getAgencyHistoryScore` return 0.5 instead of null on no-data, and deadline urgency is always set, so these three features are never absent in the worker path.
6. ✅ **Fixed 2026-11-04 (B18):** `deriveFactors` reads `factorContributions`. Was: **`scoreExplanation.deriveFactors` keys don't match what the engine writes.** It looks for numeric values under `naicsCode`, `agency`, etc. in `scoreBreakdown`, but the worker writes `factorContributions` keyed by `naicsOverlapScore` etc. Present factors therefore always come out as NEUTRAL with no contribution **(inferred from key names)**.
7. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **Stale wording in code:**
   - "7-factor" in decisionEngine and probabilityLayers; the engine has 9 factors.
   - "~26%" base-rate flag text (decisionEngine.ts 321); the engine floor is about 4.7%, and the documented flag-off constant is 0.3092.
   - "E[1/K]" in the priorBuilder header, schema and test title, but the code uses `1/(K+1)`.
   - The comment in `probabilityLayers.ts` refers to "decisionEngine.ts line 318", which has moved.
8. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **Who-Wins prior-stability eval uses `1/K` while persisted priors use `1/(K+1)`**, so the skill score does not evaluate the prior actually served.
9. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **`PENALTY_DRAG_HALF_LIFE = 200000` is not a half-life.** `exp(−x/200000)` reaches 0.5 at about 138,629, not 200,000. The comment calls it a heuristic to revisit after 100+ decisions.
10. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **Decision resolver** NO_BID rationale can be empty for CONDITIONAL pairs (section 3.4).
11. ✅ 8(a) fixed 2026-11-04 (B24: `ClientCompany.eightA`). ✅ VOSB fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)): a condition to confirm, as clients have no VOSB-only field.
12. **The name "recalibrationWorker" is misleading.** It re-scores; it does not fit calibration. The `tenantCalibration.ts` comment that "the nightly recalibration worker produces DRAFT rows" does not match any code found; no scheduled job calls `fitTenantCalibration`. Tenant fits happen only through `POST /api/scoring-intel/calibration/fit`.
13. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **`GET /api/admin/backtest/runs/:id`** "mispredictions" are the 20 lowest-probability predictions **including negatives**, although the comment describes them as winners.
14. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **`pricingSensitivity` uses the total `CalibrationSample` count** as "verified pricing outcome(s)". These samples are not pricing-specific.
15. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **`portfolioValue`** says value types are "never summed across incompatible types", yet `totalNominalValue` and `weightedExpectedValue` sum all rows; `byValueType` is reported alongside.
16. **Not a bug ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **The 2-digit NAICS pre-filter** in `opportunityMatcher` applies even with matching v2, so the "adjacent NAICS never zeroed" behaviour holds only within a sector.
17. ✅ **Fixed 2026-11-04 ([doc 27](../27-spec-gap-bugs-fixed.md)).** Was: **NAICS placeholder checks differ.** `matchingV2.isUsableNaics` rejects only exactly `000000`; `probabilityEngine.hasUsableNaics` rejects any all-zero code or fewer than 2 digits.
18. **Tier thresholds are provisional** (0.55 / 0.30), and `scoreTier.ts` says the earlier calibration "collapsed real scores to ~0 and is disabled". The threshold for turning on `SHOW_NUMERIC_FIT_SCORE` ("after the calibration backtest passes") is not defined numerically anywhere in code.
19. **Missing source docs** (`PROMPT.md`, `docs/WHO_WINS_MODEL.md`, `FIXES.md`, `.claude/rules/rules.md`): rationale for many constants (logistic bias −3 and scale 6, the weights, k = 10, the elasticity 2.2) is not recoverable beyond the short code comments.

---

## 11. Change checklist

Before changing anything in this area:

1. **Run the tests:** `cd backend && npm test` (Vitest; needs Postgres and Redis). At minimum run:
   - `src/engines/*.test.ts`
   - `src/services/winProbability.test.ts`, `probabilityLayers.test.ts`, `plattCalibration.test.ts`, `isotonicCalibration.test.ts`, `calibrationStatus.test.ts`, `scorecardScoring.test.ts`, `portfolioDecisionEngine.test.ts`
   - `src/services/scoring/*.test.ts`, `src/services/backtest/*.test.ts`, `src/services/whoWins/whoWins.test.ts` (DB), `src/utils/scoreTier.test.ts`
2. **Type-check:** `cd backend && npm run build` (tsc).
3. **Probability weights:** keep the sum at 1.0, update `FACTOR_LABELS`, and expect the fingerprint and monotonicity tests in `probabilityEngine.test.ts` to need review. The "0.3092 / 0.4081" constants in `absentFeatureRenormalization.test.ts` encode the flag-off arithmetic.
4. **Customer-visible numbers:** if `probabilityScore`, `winProbability`, tier thresholds or renormalization change, follow the config guidance: sample-test about 8 opportunities, then re-score the tenant. Re-scoring happens when `recalibrationWorker` runs at 02:00 UTC, or via the scoring queue. Update `frontend/src/utils/fitTier.ts` together with `backend/src/utils/scoreTier.ts`.
5. **Calibration:**
   - Run a v2-permutation backtest (`POST /api/admin/backtest/run`).
   - Compare `preBrier`/`postBrier`, ECE and AUC.
   - `POST /calibration/refresh`, then confirm `GET /calibration/status` shows `fitted` vs `applied` as expected.
   - Resolve section 10 items 1–3 before turning `ENABLE_PROBABILITY_CALIBRATION` on.
6. **Flag-gated features** (`RELEVANT_PAST_PERFORMANCE_ENABLED`, `WHO_WINS_PRIOR_ENABLED`, `SHOW_NUMERIC_FIT_SCORE`, `MATCHING_V2_ENABLED` and `PROBABILITY_RENORMALIZE_ABSENT` in production): run a backtest or review the Who-Wins out-of-time eval report first, as the config comments require.
7. **Who-Wins:**
   - Run `buildWhoWins.ts` with `WHO_WINS_ACTIVATE=false` first.
   - Read the eval report: top-1 must beat random and experience-only, and the skill score should be >0.
   - Then activate.
   - Keep the feature definitions in `candidateFeatures` identical between training and runtime; `publicWinPrior` reuses them.
8. **Tenant scoping:** every query must filter by `consultingFirmId`, and client-portal routes must use only the client's own BidDecision (invariant 13).
9. **Never persist a fabricated number:** keep the FAILED and null paths (invariants 2–4) and the exclusion behaviour in the portfolio, intervals and evidence stats.
10. **Labels:** keep `RAW`/`CALIBRATED`/`FALLBACK`, `BASIS_LABELS`, `INTERVAL_UNAVAILABLE_LABEL` and `UNVALIDATED_SCENARIO_ANALYSIS` verbatim; the UI and tests depend on the exact strings.
11. **Update this spec** when behaviour changes.
