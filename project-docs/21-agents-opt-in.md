# Fix: AI agents run for firms that never switched them on

**Bug:** B6 in [14-review-bugs-improvements-competitors.md](14-review-bugs-improvements-competitors.md)
**Opened:** 2026-11-04 · **Status:** ✅ **Done** (2026-11-04)

---

## 1. Findings

**Simple version:** the website says every AI agent is opt-in. Agents that start on a **schedule** did check
whether the firm had switched them on. Agents that start because **something happened**, such as an award being
recorded or a document being uploaded, did not check. They ran for every firm, at the default level, with no limit
from the firm's AI budget. So a firm that never turned agents on still got agent runs, and any AI those runs used
was paid for by Bytescon.

**Technical version:**

| # | Finding | Evidence | Effect |
|---|---------|----------|--------|
| F1 | Event runs ignore the on/off switch | `processOutbox` in `backend/src/services/agents/outbox.ts` created a run for every agent subscribed to the event type, for every firm. It never read the firm's `AgentSchedule` | Agents ran for firms that never enabled them |
| F2 | Event runs ignore the firm's level | Event runs used the agent's built-in default (`def.defaultAutonomyLevel`), not the level the firm chose | A firm that set OBSERVE got PROPOSE behaviour, e.g. reminders sent |
| F3 | Event runs bypass the firm's AI budget | Event runs had no `scheduleId`, so `resolveSchedulePeriodUsage` returned "no budget", and their usage was never added to the firm's monthly total | AI spend was uncapped per firm; only the per-run ceiling and the plan limit applied |
| F4 | Switching an agent off didn't stop queued event runs | `dispatchAgentRun` only re-checked the switch for `SCHEDULE` runs | Runs already waiting in the queue still ran |

**Already correct:**
- Agents never act on their own: they only propose, and people decide.
- Scheduled runs check the switch.
- "Run now" is a person's explicit choice, so it stays allowed.

## 2. Plan

| Area | Change |
|------|--------|
| Creating event runs | `processOutbox` loads the firm's settings for each subscribed agent. It creates a run only if the agent is switched on and not set to manual-only. Otherwise it skips the agent (counted as `notEnabledSkipped`) and still marks the event done |
| Firm's settings | Event runs take the firm's level, retries and timeout, and are linked to its settings (`scheduleId`), so the firm's AI budget applies and their usage counts toward it |
| Starting a run | `dispatchAgentRun` checks again just before the run starts. If the firm switched the agent off in the meantime, the run is skipped. Older queued event runs with no link are checked against the firm's current settings, and their AI usage counts toward its budget |
| Screen | The Agents settings page now says an agent only runs on its own after you enable it, and stops at its AI budget |
| Manual runs | Unchanged: "Run now" works whether or not the agent is switched on |

## 3. Verification results (2026-11-04)

| Check | Result |
|-------|--------|
| New tests `backend/src/services/agents/optIn.integration.test.ts` | ✅ 10/10 |
| Tests catch regressions | ✅ With the outbox check removed on purpose, 4 tests failed. With the start-of-run check removed, 2 failed. With the link to the firm's settings removed, 3 failed (level, budget block, budget usage). Code restored |
| Existing agent tests | ✅ Updated so their test firms switch the agents on first, as a real firm would. About 60 tests had been relying on the old behaviour |
| Full backend suite | ✅ 4,376/4,376 |
| Full frontend suite (Node 24) | ✅ 852/852 |
| Type-check, frontend lint | ✅ clean; 237 warnings (limit 241) |

**Live check in the running app** (admin firm, Contract Administration agent, real "contract awarded" events):

| Step | Result |
|------|--------|
| Agent never switched on; record an active contract | ✅ Event processed, **0 agent runs** |
| Switch the agent on at OBSERVE; record another contract | ✅ 1 run, **OBSERVE** level, linked to the firm's settings, completed |
| Switch the agent off; record a third contract | ✅ Event processed, **0 agent runs** |

The test contracts, runs and settings were removed afterwards.

### How to test it yourself
1. Go to **Agents → Schedules**. Make sure **Contract Administration** shows **Enable** (it's off).
2. In **Contract Management**, add a contract with status **Active**. After about a minute, **Agents → Runs**
   shows no new run.
3. Click **Enable** for Contract Administration and set it to **OBSERVE**. Add another active contract. A minute
   later, one run appears at OBSERVE.
4. Click **Disable** and add a third contract. No new run appears.

### Known, not changed
- **Dollar budgets:** the settings table has a dollar limit (`costBudgetUsd`), but nothing uses it yet. The token
  budget and the plan's AI-call limit are what actually cap spend. These now apply to event runs too.
- **Level changes for runs already queued:** a run that's already waiting keeps the level it was created with.
  Runs normally start within a minute.
