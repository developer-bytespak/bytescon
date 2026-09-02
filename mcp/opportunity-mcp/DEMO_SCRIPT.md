# VETS26 Demo Script — opportunity-mcp (REAL FREIGHT DATA)

**Audience:** veteran small-business owners & federal buyers at VETS26.
**Presenter:** John (Bytes Platform — **service-disabled-veteran-owned freight brokerage**).
**Surface:** Claude Desktop, `opportunity-mcp` connected (green in the MCP menu).
**Runtime:** ~4 minutes. **Primary tool:** `search_opportunities` (tenant-scoped to Bytes Platform).

## Tool inventory (v0.3, 11 tools, what the connected server exposes)

| Tool | Demo use |
|---|---|
| `search_opportunities` | The whole scripted demo (prompts 1-4). |
| `get_opportunity_detail` | Improv: drill into any result by id. |
| `get_bid_decision` | Improv: GO/NO_GO + win probability for an opp. |
| `list_compliance_gaps` | Improv: blockers on a bid. |
| `lookup_recipient` | Improv: who actually wins these contracts (by UEI). |
| `list_clients` | Improv: the firm's client book. |
| `get_pipeline_summary` | Improv: stage counts + conversion ratios. |
| `get_market_trends` | Improv: growing/declining NAICS sectors. |
| `forecast_revenue` | Optional closer (prompt 5): Monte Carlo revenue forecast. |
| `list_set_asides` | Improv: which set-aside filters have live data (answers the "why no SDVOSB filter" question). |
| `list_agencies_by_naics` | Improv: which agencies buy NAICS 488510 / 493110. |

> **Data:** This script runs on the real freight opportunities ingested live from SAM.gov
> on 2026-05-30 (real DoD/AF/State titles, real `sam.gov/workspace/...` URLs), all
> **scored** (win probability 0.31–0.66). 32 were ingested; the **16 with already-passed
> deadlines were marked `EXPIRED`**, leaving **16 open opps** the demo draws from. These
> are **full-and-open** (`set_aside = NONE`) — typical for federal freight — so the demo
> is **keyword/NAICS-driven, NOT set-aside-filtered.** Do not filter by SDVOSB; returns 0.

---

## 0. Pre-flight (BEFORE you walk on)

```powershell
pwsh C:\Projects\Gov-ConV2\mcp\opportunity-mcp\scripts\predemo-check.ps1
```
Wait for **"DEMO READY — all five checks green."** Confirm `opportunity-mcp` shows
connected in Claude Desktop. Have this file open on a second screen.

---

## 1. The hook (say this, then type prompt 1)

> "I'm a service-disabled veteran running a freight brokerage. Watch me find my next
> federal contract by *talking* to Claude — these are **live opportunities off SAM.gov**,
> scoped to my company, and scored for how likely I am to win each one."

**Prompt 1 — live freight pipeline**
```
Show me active packing and crating opportunities for my firm, ranked by win probability.
```
*Triggers:* `search_opportunities(keyword:"packing", limit:10)`.
*Expect:* **3 open results** — Dover AFB (due 2026-06-03), McConnell AFB (06-03), and a
06-22 packing & crating contract, scored ~0.42–0.43, each a real SAM.gov link.
*Point:* "Every one of these is live on SAM.gov right now, and the score is a real
win-probability model — not a guess."

---

## 2. The urgency follow-up (reasons over the pipeline)

**Prompt 2 — deadlines**
```
Which of these closes the soonest? I don't want to miss a deadline.
```
*Expect:* Claude reasons over `response_deadline` and surfaces the nearest (the AFB
packing contracts close 2026-06-03). *Point:* "It just triaged my pipeline by deadline
— that's the difference between a search box and a capture analyst."

---

## 3. The hero moment (the broker's core code)

**Prompt 3 — drill to the top opportunity**
```
Tell me about the customs brokerage opportunity — NAICS, win probability, and when it's due.
```
*Triggers:* `search_opportunities(keyword:"customs", limit:5)` → one record.
*Expect:* **"V119 — Customs Brokerage Services for Import of Pharmaceuticals," NAICS
488510 (Freight Transportation Arrangement — the freight-broker code), win probability
~0.66 (highest in my pipeline), due 2026-06-04**, real `sam.gov/workspace/...` link.
*Land it:*
> "0.66 win probability, my exact NAICS, due in days — and I got here in three sentences.
> For a lean veteran-owned brokerage, that's the whole opportunity-research step gone."

---

## 4. Optional closer (depth of the live pipeline)

**Prompt 4 — warehousing & distribution depth**
```
What warehousing and distribution work is open for my firm?
```
*Triggers:* `search_opportunities(keyword:"distribution", limit:10)`. *Expect:* **4 open
results** — DLA Distribution + MEDLOGCO warehousing (NAICS 493110), due early June.
Reinforces the depth of the live pipeline. (NAICS **493110 is my deepest bucket — 9 open
opps**; mention you can filter by exact federal code.)

---

## 5. Optional forecast closer (new in the 11-tool suite)

**Prompt 5: revenue forecast**
```
Forecast my expected revenue from this pipeline over the next 6 months.
```
*Triggers:* `forecast_revenue(months_ahead:6)`. *Expect:* per-month expected / p10 / p50 / p90
dollars from a 1,000-run Monte Carlo over the 16 open opps. *Point:* "It is not just finding
contracts: it is telling me what this pipeline is worth, with uncertainty bands."
*Note:* numbers shift slightly between runs (it is a simulation); quote the expected value
loosely, not to the dollar. If asked about set-asides, `list_set_asides` shows live counts
per category (all 16 open opps are full-and-open, so SDVOSB shows 0, the same guardrail as
prompt filters below).

## Validated live queries (OPEN opps only, recounted 2026-05-30 — improvise safely)

> 16 of the 32 ingested opps had already-passed deadlines and were marked `EXPIRED` so
> the demo shows only **16 open opportunities** (future deadlines). Counts below reflect
> the open set.

| Prompt keyword / filter | Open results | Notes |
|---|---|---|
| `packing` | 3 | Dover/McConnell AFB packing & crating — opener |
| `crating` | 3 | overlaps packing |
| `customs` | 1 | the 0.66 hero (NAICS 488510) |
| `distribution` | 4 | DLA + MEDLOGCO warehousing — good depth beat |
| `storage` | 3 | USACE / Coast Guard / Platinum Storage |
| `warehousing` | 3 | DLA + MEDLOGCO |
| `trucking` | 1 | Commercial Trucking Solution (due 06-15) |
| NAICS `493110` | 9 | warehousing & storage — deepest bucket |
| NAICS `488991` | 4 | packing & crating |

Score range across the 16 open: **0.31–0.66** (hero `customs` = 0.66).

## Guardrails (read before presenting)

- **Always include a keyword** (the tool requires one) — use a freight noun: packing,
  crating, customs, trucking, transportation, warehouse.
- **Do NOT filter by set-aside on this data** — all are full-and-open (`NONE`), so an
  SDVOSB/8A filter returns 0. (The platform *supports* set-aside filtering — fixed in
  `bff31e1b` — it just doesn't apply to this full-and-open dataset.)
- Results are **ACTIVE opps only**, ordered by soonest deadline, capped at 50.
- If Claude says it can't reach the tool: the MCP dropped (usually Docker/Postgres went
  down). Re-run the pre-flight check — it auto-heals.

## Fallback if the live tool fails on stage
Have a screenshot of a prior successful `search_opportunities` result open in a tab:
"Here's the same query I ran this morning" — keeps the narrative intact while you reconnect.

## Demo-day prerequisites
1. **Restart `opportunity-mcp` in Claude Desktop** so it loads the rebuilt `dist` (the
   only thing the demo needs). The 32 scored opps are already in Postgres; the demo does
   not touch the backend container.

> **Do NOT rebuild the backend before the demo.** It is not in the demo path, and the
> `ncode` fix lives in the *canonical* `bytescon` clone while the running stack is
> built from `Gov-ConV2` — rebuilding now would compile old code and wipe the hot-patch.
> Reconcile the two clones first (post-demo). See [[govcon-consolidation-plan]].
