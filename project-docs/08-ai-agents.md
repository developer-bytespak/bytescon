# The 9 AI Agents

## Simple version

Bytescon has **nine robot helpers**. Each one watches one part of the job — like nine lifeguards, each watching one
part of the pool. They wake up on a **timer** or when **something happens** (for example, "a new document was uploaded").
They look at the data, write a **report**, and if something needs a human, they **raise their hand** (an *escalation*).

🛑 **They are not allowed to do important things by themselves.** They never submit a bid, sign a paper,
approve a bill, send an email to a partner, or spend money. A person always decides.

💡 Seven of the nine use **no AI at all** — they are rules and maths. Only Proposal and Teaming (and the optional
extraction inside Compliance) call an AI model, and only if the firm has an AI provider set up.

---

## The nine agents

| # | Agent | Like a… | Runs | What it watches | What it produces | What it will **never** do |
|---|-------|---------|------|-----------------|------------------|---------------------------|
| 1 | **Opportunity** | Scout | every 2 h | New notices, source health, matches, eligibility, re-competes, saved searches, pursuit feedback | Opportunity brief; "critical match closing soon" alerts | Record a bid decision, accept a re-compete, verify a capability |
| 2 | **Qualification** | Judge's assistant | every 6 h | Pursuit scorecard, win probability, capacity, gaps, compliance blockers | Bid/no-bid **recommendation**; may open a gate review | Make the bid decision itself |
| 3 | **Compliance** | Rule checker | every 6 h | Registration, certs, insurance, bonding, document expiry, extraction, L/M coverage, clauses, amendments | Compliance status; expiry and extraction alerts | Verify requirements, approve clauses, waive blockers |
| 4 | **Proposal** | Writing buddy | every 6 h (20-min limit) | Outline, approved capability text, past performance, sections, reviews | Section skeletons and AI drafts, review reminders | Approve sections, attest, submit |
| 5 | **Pricing** | Calculator | every 12 h | Rates, scenarios, templates, public award benchmarks, amendments | Pricing assessment; "price outside historical range" alerts | Change rates, hours, fee, approve pricing |
| 6 | **Teaming** | Friend finder | daily 03:00 | Capability gaps, partner network, partner performance, subcontracting goals | Teaming plan; agreement & outreach **drafts** | Sign agreements, send outreach |
| 7 | **Contract Administration** | Diary keeper | daily 07:00 | Deliverables, funding burn, options, period of performance, modifications | Contract health; overdue/funding alerts | Accept deliverables, exercise options, change funding |
| 8 | **Finance** | Bookkeeper | daily 08:00 | Timesheets, invoices, receivables, indirect rates, cash flow, DCAA rules | **Draft** invoices; DCAA readiness; cash-flow projection | Approve/submit invoices, record payments, edit time |
| 9 | **Intelligence** | Coach | weekly (Mon 05:00) | Wins/losses, awards, calibration | Win/loss segments, capture focus, capability roadmap | Anything — it's advisory only |

There is also a hidden **Internal Diagnostic** agent used to test the runtime.

## Events that wake agents up

| Agent | Woken by |
|-------|----------|
| Opportunity | source sync done, capability changed, saved search saved, pursuit stage changed |
| Qualification | high match, pursuit stage changed, extraction done, amendment recorded |
| Compliance | solicitation document added, extraction done, amendment, pursuit stage changed |
| Proposal | bid decision, extraction done, section approved, amendment, capability narrative approved |
| Pricing | bid decision, pricing scenario changed, amendment, indirect rate changed |
| Teaming | bid decision, capability gap, partner added, subcontract milestone due |
| Contract Admin | contract awarded, modification added, deliverable status changed, funding added |
| Finance | invoice paid, time entry submitted, contract cost added |
| Intelligence | submission outcome recorded, contract awarded, calibration updated |

## How a run works (step by step)

1. **Trigger** — timer, business event, or an admin clicks "Run now".
2. **Create** — a run record is made with a unique key, so the same event can't run twice.
3. **Queue** — it waits in the `agent-runtime` queue (3 at a time).
4. **Run** — the agent works, with a heartbeat and a time limit (10 min default).
5. **Save** — reports (*artifacts*), questions for humans (*escalations*), and suggested actions (*proposals*).
   A newer report replaces the older one about the same thing — unless a human has verified the older one.
6. **Tell** — notify users based on their preferences (by default: failures and escalations, not successes).
7. **Clean up** — retries on errors (3 attempts); a reaper ends runs that stop responding.

## Autonomy levels

| Level | Meaning | Used? |
|-------|---------|-------|
| OBSERVE | Only look and report | available |
| PROPOSE | Report + suggest actions + escalate | **default** |
| ACT_WITH_GUARDRAILS | Do pre-approved safe actions | effectively unused — no business action is on the safe list |

## Budgets (AI cost limits)

Checked **before** any AI call: per-run token budget → per-schedule 30-day budget → the firm's plan AI-call limit.
If any is exceeded, the run fails safely and raises a HIGH escalation.

## Where humans act

- **Agent Operations** page (`/agents`): overview, run history, escalations, schedules, notification preferences.
- **Run detail** (`/agents/runs/:id`): inputs, confidence, warnings, artifacts, token cost, audit trail.
- Agent panels appear inside the relevant screens (discovery, pipeline, proposal, pricing, finance, analytics…).

## Known gap

The website says every agent is **opt-in**. That is true for **timer** runs, but **event-triggered** runs are currently
created for every firm whether or not the agent is enabled (`backend/src/services/agents/outbox.ts` creates runs for all
subscribed agents; `dispatch.ts` only checks "enabled" for SCHEDULE runs). Most agents use no AI, so the cost impact is
small, but it contradicts the promise. Tracked in [10-status-done-and-remaining.md](10-status-done-and-remaining.md).
