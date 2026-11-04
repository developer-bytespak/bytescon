# Agent Runtime and Domain-Agent Policies (Section 7, as built)

**Purpose.** This spec describes the shared AI-agent runtime in `backend/src/services/agents/` and the policies of the nine domain agents that run on it. It replaces the lost design spec (PROMPT.md "Section 7", §7.0–7.9). Read it before you change an agent, add one, or change the runtime.

**Status: as-built spec reconstructed from code on 2026-11-03; original spec lost. If this and the code disagree, the code wins.**

Conventions used here:
- Paths are relative to `backend/src/` unless stated otherwise.
- `§7.x` labels are the slice numbers that still appear in code comments.
- **(inferred)** marks a claim that follows from the code but was not confirmed by running it or by a test.
- Titles, thresholds, event names and constant names are copied from code. Where a value is a constant, the constant name is given so you can grep for it.

---

## 1. Simple version

Bytescon has nine background "agents". Each one watches one part of a federal contractor's business (finding opportunities, bid/no-bid, compliance, proposals, pricing, teaming partners, contract administration, finance, win/loss intelligence) and writes a status report for people to read. They all share one runtime: a single BullMQ queue that starts agents on a timetable (cron), when something happens in the app (an event), or when an admin presses "run". An agent never makes a human decision. It writes reports ("artifacts"), raises flags ("escalations") and sends in-app notices. The only business records it creates are drafts and derived numbers, such as a DRAFT invoice or recomputed pricing totals. Only Proposal and Teaming can call an AI model, and only when a provider is configured and the token budget allows. The other seven are fully deterministic.

---

## 2. Data model (Prisma)

Defined in `backend/prisma/schema.prisma`.

| Model | Role | Key constraints |
|---|---|---|
| `AgentSchedule` | Per-tenant, per-agent state: enabled flag, cron or interval, timezone, autonomy, retry and timeout settings, token budget and period usage, failure counters | `@@unique([consultingFirmId, agentKey])`. Defaults: `isEnabled false`, `scheduleType CRON`, `timezone "UTC"`, `maxAttempts 3`, `timeoutMs 600000`, `autonomyLevel PROPOSE` |
| `AgentRun` | One execution | `idempotencyKey @unique`. Default `status QUEUED`, `attempt 1`. Records tokens, cost, `inputSnapshot` and `inputHash`, `warnings[]`, `limitations[]` |
| `AgentArtifact` | Structured output of a run | `isHumanVerified`, `supersededByArtifactId`, `supersededAt`, `sourceEntityType` / `sourceEntityId` |
| `AgentEscalation` | A decision the agent refused to make alone | `dedupeKey @unique`. Default `status OPEN`, `severity MEDIUM` |
| `AgentEvent` | Transactional outbox row | `dedupeKey @unique`. Default `status PENDING`, `attempt 0`, `maxAttempts 3` |
| `AgentNotificationPreference` | Per-user, per-agent notification settings | `@@unique([userId, agentKey])` |

Enums:

| Enum | Values |
|---|---|
| `AgentKey` | OPPORTUNITY, QUALIFICATION, COMPLIANCE, PROPOSAL, PRICING, TEAMING, CONTRACT_ADMINISTRATION, FINANCE, INTELLIGENCE, INTERNAL_DIAGNOSTIC |
| `AgentTriggerType` | MANUAL, SCHEDULE, EVENT, RETRY |
| `AgentRunStatus` | QUEUED, RUNNING, WAITING_FOR_REVIEW, COMPLETED, FAILED, CANCELLED, TIMED_OUT, SKIPPED |
| `AgentAutonomyLevel` | OBSERVE, PROPOSE, ACT_WITH_GUARDRAILS |
| `AgentConfidenceState` | HIGH, MEDIUM, LOW, INSUFFICIENT_DATA |
| `AgentDataSufficiency` | SUFFICIENT, PARTIAL, INSUFFICIENT |
| `AgentArtifactType` | OPPORTUNITY_BRIEF, QUALIFICATION_BRIEF, COMPLIANCE_STATUS, PROPOSAL_STATUS, PRICING_ASSESSMENT, TEAMING_PLAN, CONTRACT_HEALTH, FINANCE_STATUS, PORTFOLIO_INTELLIGENCE, RUNTIME_DIAGNOSTIC |
| `AgentEscalationSeverity` | INFO, LOW, MEDIUM, HIGH, CRITICAL |
| `AgentEscalationStatus` | OPEN, ACKNOWLEDGED, RESOLVED, DISMISSED |
| `AgentEventStatus` | PENDING, PROCESSING, PROCESSED, FAILED, DEAD_LETTER |
| `AgentScheduleType` | CRON, INTERVAL, MANUAL_ONLY |

The following schema fields are stored but **never read by runtime code**:
- `AgentSchedule.costBudgetUsd`
- `AgentRun.handlerVersion`
- `AgentNotificationPreference.emailEnabled`, `digestMode` and `timezone`
- `AgentEventStatus.FAILED`. The outbox only uses PENDING, PROCESSING, PROCESSED and DEAD_LETTER.

See §9 for these gaps.

---

## 3. Runtime

### 3.1 Components

| File | Responsibility |
|---|---|
| `services/agents/types.ts` | Handler contract (`AgentHandler`, `AgentExecutionContext`, `AgentHandlerResult`), `DOMAIN_AGENT_KEYS`, `INTERNAL_AGENT_KEY`, `DEFAULT_AUTONOMY_LEVEL = 'PROPOSE'` |
| `services/agents/registry.ts` | Code-level registry `AGENT_REGISTRY`. It is deliberately not a DB table. Also `agentsSubscribedTo(eventType)` |
| `services/agents/runService.ts` | Idempotency keys, `createRun`, `claimRunForExecution`, `heartbeatRun`, `finalizeRun`, `requeueForRetry`, `cancelRun` |
| `services/agents/runStateMachine.ts` | Allowed run transitions |
| `services/agents/dispatch.ts` | `dispatchAgentRun`, the single execution path |
| `services/agents/scheduler.ts` | `runAgentScheduler`, `computeNextRunAt`, `upsertSchedule`, `recordScheduleOutcome` |
| `services/agents/outbox.ts` | `emitAgentEvent`, `claimEvents`, `processOutbox`, `releaseStuckEvents` |
| `services/agents/budget.ts` | `createBudgetGuard`, `resolveSchedulePeriodUsage`, `recordScheduleUsage` |
| `services/agents/escalations.ts` | `persistEscalations`, `transitionEscalation`, `countOpenEscalations` |
| `services/agents/artifacts.ts` | `persistArtifacts`, `verifyArtifact`, `carryForwardSections` |
| `services/agents/safeActions.ts` | `SAFE_ACTION_REGISTRY`, `canApplyAction`, `partitionAppliedActions` |
| `services/agents/reaper.ts` | `reapStaleAgentRuns` |
| `services/agents/notifications.ts` | `notifyAgentOutcome`, preference defaults |
| `services/agents/metrics.ts` | Prometheus counters, gauges and histograms |
| `services/agents/workingCalendar.ts` | `buildWorkingCalendar`: US federal holidays plus firm `HolidayCalendarEntry` rows, cached per firm and year |
| `services/agents/handlers/internalDiagnostic.ts` | `INTERNAL_DIAGNOSTIC` handler. Its mode is set by `triggerEntityType='DIAGNOSTIC_MODE'` and `triggerEntityId` ∈ `succeed \| fail \| timeout \| escalate \| budget \| review \| skip` |
| `workers/agentWorker.ts` | The one queue `agent-runtime` and the one Worker |

**One queue, one worker.** `agentWorker.ts` creates `new Queue('agent-runtime')` with these default job options:
- `attempts: 3`
- `backoff: { type: 'exponential', delay: 30_000 }`
- `removeOnComplete: 50`, `removeOnFail: 50`

The Worker has `concurrency: 3`. It handles three named jobs:

| Job | Trigger | What it does |
|---|---|---|
| `dispatch` | Enqueued per run (payload `{ runId }`, jobId `run:${runId}`) | Calls `dispatchAgentRun` |
| `tick` | Repeatable, `'* * * * *'` | `runAgentScheduler(now)`, then `processOutbox(WORKER_ID, 20, now)`, then enqueues the scheduler's new run ids. If the outbox created runs, it also enqueues up to 100 QUEUED `EVENT` runs found globally |
| `reaper` | Repeatable, `'*/5 * * * *'` | `reapStaleAgentRuns(now)` and `releaseStuckEvents(5 * 60_000, now)` |

The housekeeping jobs (`tick`, `reaper`) have a `HOUSEKEEPING_TIMEOUT_MS = 5 * 60 * 1000` ceiling.

### 3.2 Registry fields and shared defaults

`AgentDefinition` fields:
- `key`, `name`, `description`
- `implemented`, `plannedSlice`, `defaultEnabled`
- `supportedTriggers`, `defaultCronExpression`, `defaultAutonomyLevel`
- `requiresLlm`, `noLlmBehaviour`
- `maxRuntimeMs`, `defaultMaxAttempts`, `backoffMs`, `defaultTokenBudget`
- `supportedArtifactTypes`, `subscribedEventTypes`, `allowlistedActionKeys`
- `handler`, `internal`

The shared `base` object in `registry.ts` sets:
- `implemented: false`, `defaultEnabled: false`
- `supportedTriggers: ['MANUAL','SCHEDULE','EVENT','RETRY']`
- `defaultAutonomyLevel: 'PROPOSE'`
- `maxRuntimeMs: 10 min`, `defaultMaxAttempts: 3`, `backoffMs: 30_000`
- `handler: null`

Two caveats:
- `backoffMs` is **not read** by the runtime. Retry backoff comes from the BullMQ queue options.
- `RETRY` is declared on every agent, but **no code path creates a run with `triggerType: 'RETRY'`**. A retry reuses the same run row with `attempt + 1`.

Summary of all nine domain agents (full detail in §4):

| Agent | Slice | Cron (`defaultCronExpression`) | Max runtime | Token budget | Artifact |
|---|---|---|---|---|---|
| OPPORTUNITY | 7.2 | `0 */2 * * *` | 10 min | 0 | OPPORTUNITY_BRIEF |
| QUALIFICATION | 7.4 | `0 */6 * * *` | 10 min | 0 | QUALIFICATION_BRIEF |
| COMPLIANCE | 7.3 | `0 */6 * * *` | 10 min | 100_000 | COMPLIANCE_STATUS |
| PROPOSAL | 7.7 | `0 */6 * * *` | 20 min | 300_000 | PROPOSAL_STATUS |
| PRICING | 7.6 | `0 */12 * * *` | 10 min | 0 | PRICING_ASSESSMENT |
| TEAMING | 7.5 | `0 3 * * *` | 10 min | 80_000 | TEAMING_PLAN |
| CONTRACT_ADMINISTRATION | 7.1 | `0 7 * * *` | 10 min | 0 | CONTRACT_HEALTH |
| FINANCE | 7.8 | `0 8 * * *` | 10 min | 0 | FINANCE_STATUS |
| INTELLIGENCE | 7.9 | `0 5 * * 1` | 10 min | 0 | PORTFOLIO_INTELLIGENCE |
| INTERNAL_DIAGNOSTIC (internal) | 7.0 | `null` | 30 s | 1_000 | RUNTIME_DIAGNOSTIC |

For every one of the nine:
- `implemented: true`, `defaultEnabled: false`, `requiresLlm: false`
- `defaultAutonomyLevel: 'PROPOSE'`
- `allowlistedActionKeys: []`

The internal agent's allowlist is `['diagnostic.noop']`. It is filtered out of every product API response (`publicAgentDefinitions()`; `requireAgentKey` in `routes/agents.ts` rejects it).

Crons are evaluated in the schedule's `timezone`, which defaults to `'UTC'`.

### 3.3 Run lifecycle and state machine

`runStateMachine.ts`:

| From | Allowed to |
|---|---|
| QUEUED | RUNNING, CANCELLED, SKIPPED, FAILED |
| RUNNING | COMPLETED, FAILED, TIMED_OUT, CANCELLED, WAITING_FOR_REVIEW, SKIPPED, QUEUED |
| WAITING_FOR_REVIEW | COMPLETED, CANCELLED |
| COMPLETED, FAILED, CANCELLED, TIMED_OUT, SKIPPED | (none; these are terminal) |

Rules:
- `TERMINAL_RUN_STATUSES = COMPLETED, FAILED, CANCELLED, TIMED_OUT, SKIPPED`. Terminal runs are immutable. `finalizeRun` returns `null` (a silent no-op) if the run is already terminal, so a late timeout loses safely to a recorded completion.
- `assertRunTransition` throws `ValidationError` on an illegal move. A same-state "transition" is a no-op.
- `QUEUED → FAILED` exists so that pre-execution validation, such as a tenant mismatch, can refuse a run outright.
- `RUNNING → QUEUED` is the only backwards edge. It is used only by `requeueForRetry`, and only while `attempt < maxAttempts`.
- Every status write is a compare-and-set: `updateMany` guarded on the current status.

How each transition is reached:

| Transition | Code path |
|---|---|
| QUEUED → RUNNING | `claimRunForExecution`: `updateMany where {id, status:'QUEUED'}`, sets `startedAt`, `heartbeatAt`, `progressStage:'starting'` |
| QUEUED → SKIPPED | dispatch: agent not implemented (`errorCode NOT_IMPLEMENTED`), or a SCHEDULE run whose schedule is disabled (`errorCode DISABLED`) |
| QUEUED → FAILED | dispatch: schedule belongs to another firm (`errorCode TENANT_MISMATCH`) |
| RUNNING → COMPLETED / FAILED / WAITING_FOR_REVIEW / SKIPPED | Handler returns `result.status` (`AgentHandlerStatus`) |
| RUNNING → FAILED | Budget exhaustion (`AGENT_BUDGET_EXHAUSTED`), or a handler error after retries are spent (`HANDLER_ERROR`) |
| RUNNING → TIMED_OUT | Handler exceeded `timeoutMs` (`errorCode TIMEOUT`), or the reaper (`STALE_NO_HEARTBEAT`) |
| RUNNING → QUEUED | `requeueForRetry` |
| QUEUED / RUNNING / WAITING_FOR_REVIEW → CANCELLED | `cancelRun` (admin endpoint). A running handler sees the abort through the 1-second cancellation poll |

No product code moves `WAITING_FOR_REVIEW → COMPLETED`. Only the diagnostic handler's `review` mode produces WAITING_FOR_REVIEW. See §9.

### 3.4 Triggers and idempotency keys

```
buildRunIdempotencyKey = sha256(`${agentKey}:${consultingFirmId}:${trigger}:${discriminator}`)
```

| Trigger | Created by | Discriminator | Effect | Settings used |
|---|---|---|---|---|
| SCHEDULE | `runAgentScheduler` | `scheduleDiscriminator(dueAt)` = `dueAt.toISOString().slice(0,16)` (minute bucket) | Two scheduler passes for the same due minute produce one run | The schedule's `autonomyLevel`, `maxAttempts`, `timeoutMs`; `scheduleId` set |
| EVENT | `processOutbox` | `event.id` | One run per (agent, event), forever. Replaying an event is a no-op. Created **only** when the firm's schedule row exists, `isEnabled` is true and `scheduleType` is not `MANUAL_ONLY` (`acceptsEventRuns`) | The schedule's `autonomyLevel`, `maxAttempts`, `timeoutMs`; `scheduleId` set; `triggerEntityType/Id` copied from the event |
| MANUAL | `POST /api/agents/runs` (ADMIN) | `idempotencyToken` from the body, or `${Date.now()}-${userId}` | A double-submitted button with the same token makes one run | The firm's schedule row if one exists, otherwise registry defaults; `scheduleId` set when a schedule exists |
| RETRY | Nothing | — | Enum value only | — |

Other behaviour:
- `createRun` never throws on a duplicate. On Prisma `P2002` it returns `{ run: existing, created: false }`.
- A manual run is enqueued immediately. Scheduler and event runs are enqueued by the `tick` job.
- The manual endpoint accepts optional `triggerEntityType` and `triggerEntityId`, so an admin can target a single entity. It also ignores any `consultingFirmId` in the body (`routes/section7Authorization.audit.test.ts`).

### 3.5 Scheduler

`runAgentScheduler(now, batchSize = 100, scope = {})` performs one pass. One poll covers every tenant. There are no per-tenant BullMQ repeatables.

**1. Find due schedules.** The query is:
- `isEnabled: true`
- `scheduleType != MANUAL_ONLY`
- `nextRunAt <= now`
- `consecutiveFailures < MAX_CONSECUTIVE_FAILURES` (10)

Results are ordered by `nextRunAt asc` and limited to `batchSize`.

**2. For each due schedule, in order:**
1. **Advance the cursor first** (`lastRunAt = now`, `nextRunAt = computeNextRunAt(schedule, now)`), so a crash cannot cause a tight re-fire loop.
2. If the agent is not implemented, count it as `skippedUnimplemented` and create no run.
3. Otherwise call `createRun` with `triggerType: 'SCHEDULE'` and the minute-bucketed key.

**3. Error handling.** A per-schedule error increments `consecutiveFailures`, sets `lastFailureAt` and `lastFailureMessage` (truncated to 500 characters), and does not abort the batch.

**`computeNextRunAt` rules:**

| Schedule | Result |
|---|---|
| `MANUAL_ONLY` | `null` |
| `INTERVAL` | `from + intervalMinutes`, or `null` if `intervalMinutes <= 0` |
| `CRON` | Next occurrence in `timezone` via `cron-parser` `parseExpression` |
| Invalid cron expression | `null` (the schedule never auto-runs; it does not "run constantly") |

**`upsertSchedule`** (called by `PUT /api/agents/schedules/:agentKey`, ADMIN only):
- Merges the patch with the existing row, then with registry defaults (`cronExpression` defaults to `def.defaultCronExpression`).
- A disabled schedule gets `nextRunAt = null`.
- Writes audit `AGENT_SCHEDULE_CHANGED`.

The route refuses to enable an unimplemented agent, rejects an invalid cron expression, and requires `intervalMinutes` for `INTERVAL`. Its Zod limits are:
- `intervalMinutes` 1–10080
- `maxAttempts` 1–10
- `timeoutMs` 1000–3_600_000
- `tokenBudget` 0–10_000_000 or null

`recordScheduleOutcome` exists but is **never called**. As a result `lastSuccessfulRunAt` is never set, and `consecutiveFailures` rises only from scheduler-side errors, never from failed runs. See §9.

### 3.6 Transactional outbox

**Emit.** `emitAgentEvent(args, tx = prisma)`:
- **Always pass the business transaction's `tx`.** The event then exists if and only if the business write commits.
- It inserts with `createMany({ skipDuplicates: true })` (`INSERT … ON CONFLICT DO NOTHING`). A duplicate therefore cannot abort the caller's transaction with Postgres `25P02`.
- The default `dedupeKey` is `sha256(`${firmId}:${eventType}:${entityType ?? '-'}:${entityId ?? '-'}`)`. Every domain emitter passes its own key (see §5).
- New rows get `availableAt = now` (unless passed) and `maxAttempts = DEFAULT_EVENT_MAX_ATTEMPTS` (3).
- Returns `{ eventId, created }`.

**Claim.** `claimEvents(workerId, limit = 20, now, scope)`:
- Selects PENDING rows with `availableAt <= now`, ordered by `createdAt asc`.
- Claims each row with a compare-and-set `updateMany where {id, status:'PENDING'}` → `PROCESSING`, setting `claimedAt` and `claimedBy` and incrementing `attempt`.

**Process.** `processOutbox(workerId, limit = 20, now, scope)` handles each claimed event:
1. `subscribers = agentsSubscribedTo(event.eventType)`. This returns only agents with `implemented && handler !== null`.
2. **No subscribers:** mark the event `PROCESSED`. This is normal, not an error.
3. **Subscribers present:** load the firm's `AgentSchedule` rows for the subscribers. Call `createRun` (EVENT trigger) only for agents that pass `acceptsEventRuns` (row exists, `isEnabled`, not `MANUAL_ONLY`); the others count as `notEnabledSkipped`. Then mark the event `PROCESSED` and write audit `AGENT_EVENT_PROCESSED` ("fanned out to N of M subscribed agent(s)").

An event becomes `PROCESSED` only after every subscriber has a run row.

**On error during fan-out:**
- If `event.attempt >= event.maxAttempts`, the event goes to `DEAD_LETTER`.
- Otherwise it returns to `PENDING` with `availableAt = now + 60_000 * attempt` (linear backoff) and the claim is cleared.
- `lastError` keeps the first 1000 characters.

Metrics: `bytescon_agent_events_processed_total{status}`.

**Release.** `releaseStuckEvents(staleAfterMs = 5 min)` returns `PROCESSING` rows whose `claimedAt` is older than the cutoff to `PENDING`. It runs from the reaper job.

The `scope.consultingFirmId` parameter (on the outbox and the scheduler) exists only so parallel test suites can isolate tenants. Production scans every tenant.

### 3.7 Dispatch: steps in order

`dispatchAgentRun(runId)` in `dispatch.ts`. The order is deliberate. The file header gives it as:

`validate -> claim (compare-and-set) -> execute under timeout -> persist artifacts -> persist escalations -> record usage -> audit -> notify -> finalize`

As implemented:

1. **Load the run.** Missing → returns `MISSING`.
2. **Validate the registry entry.** Not implemented or no handler → `SKIPPED`, `NOT_IMPLEMENTED`, with confidence `INSUFFICIENT_DATA`.
3. **Validate tenant and enabled state.**
   - If `run.scheduleId` is set and the schedule's firm differs → `FAILED`, `TENANT_MISMATCH`.
   - For an EVENT run with no `scheduleId` (queued before opt-in was enforced), the schedule is looked up by `(consultingFirmId, agentKey)`.
   - If an EVENT run fails `acceptsEventRuns`, or a SCHEDULE run's schedule is disabled → `SKIPPED`, `DISABLED`. So switching an agent off also stops runs already queued. MANUAL runs are not gated.
4. **Claim** (`claimRunForExecution`). If another worker won, return `NOT_CLAIMABLE` without error. Then increment metrics `agent_runs_started` and `agent_runs_active`, and write audit `AGENT_RUN_STARTED`.
5. **Set up controls.**
   - `timeoutMs = run.timeoutMs || def.maxRuntimeMs`.
   - A watchdog `setTimeout` aborts the `AbortController`.
   - A 1-second poll aborts if the row became `CANCELLED` or `TIMED_OUT`.
6. **Build the budget guard.**
   - `runTokenBudget = def.defaultTokenBudget ?? DEFAULT_RUN_TOKEN_BUDGET (200_000)`.
   - Schedule budget and usage come from `resolveSchedulePeriodUsage(schedule.id)` (the schedule resolved above).
7. **Build the context `ctx`:**
   - Identity, trigger and entity
   - `autonomyLevel`, `attempt`, `deadlineAt`, `signal`
   - `log`, `heartbeat(pct, stage)`, `budget`
   - `audit(action, entityType, entityId, rationale)`, written with the run's `initiatedByUserId`
   - `canApply(actionKey)`
8. **Execute** `runWithTimeout(def.handler(ctx), timeoutMs, controller)`. A handler that ignores the abort signal still loses the race.
9. **Success path** (`finishSuccessfully`):
   1. `partitionAppliedActions`. Any action the handler reports as applied that the autonomy policy does not permit is downgraded, with a warning that it was "recorded as a proposal instead".
   2. `persistArtifacts`. Audit `AGENT_ARTIFACT_CREATED` if any were created. A warning is added if human-verified artifacts were skipped.
   3. `persistEscalations`. Audit `AGENT_ESCALATED` for each newly created escalation, plus metric `agent_escalations_created`. A warning is added for each escalation suppressed because a human had already resolved it.
   4. Audit `AGENT_ACTION_PROPOSED` for each proposed action and `AGENT_ACTION_APPLIED` for each permitted applied action.
   5. `finalizeRun` with the handler's status, summary, confidence, sufficiency, warnings, limitations, `inputSnapshot`, `inputHash` and token usage.
   6. Audit `AGENT_RUN_COMPLETED` or `AGENT_RUN_FAILED`.
   7. Notify:
      - If an escalation was **created**, send an `ESCALATION` notification for the first one, titled `${agentName}: ${title}`.
      - Otherwise, if the run is COMPLETED, send a `SUCCESS` notification, `${agentName} completed`.
      - A run that was cancelled mid-flight sends nothing.
10. **Error path** (`finishWithError`):
    - **`AgentBudgetExhaustedError`:**
      - Metric `agent_budget_blocks{scope}`.
      - Escalation: severity **HIGH**, title `'Agent AI budget exhausted'`, dedupeHint `budget-exhausted:${scope}`.
      - Run → `FAILED`, `AGENT_BUDGET_EXHAUSTED`.
      - `FAILURE` notification, `'Agent stopped: AI budget exhausted'`.
    - **Timeout** (`AgentTimeoutError`):
      - Run → `TIMED_OUT`; audit `AGENT_RUN_TIMED_OUT`.
      - Escalation: severity **MEDIUM**, title `'Agent run timed out'`, dedupeHint `timeout:${agentKey}`.
      - `FAILURE` notification.
    - **Other error:** `requeueForRetry`.
      - If allowed (`attempt < maxAttempts`), throw `AgentRetryableError`. The run stays QUEUED and BullMQ retries the job.
      - Otherwise: `FAILED`, `HANDLER_ERROR`; audit `AGENT_RUN_FAILED`; `FAILURE` notification `'Agent run failed'`.
11. **Finally** (always runs):
    - Clear the timers; decrement `agent_runs_active`.
    - Accrue token and cost metrics.
    - `recordScheduleUsage(scheduleId, tokens, cost)`.
    - Observe duration; increment `agent_runs_finished{status}`.

Artifacts and escalations are persisted **before** the final status write. A crash between those steps leaves the run RUNNING, so the reaper finds it rather than leaving a COMPLETED run with missing output.

### 3.8 Timeouts, heartbeat and reaper

- **Per-run timeout:** `run.timeoutMs`, taken from the schedule, the manual-run settings, or `def.maxRuntimeMs`.
- **Heartbeat:** `ctx.heartbeat(progressPercent, stage)` updates `heartbeatAt`, `progressPercent` (clamped 0–100) and `progressStage`, but only while the run is RUNNING.
  - Handlers use stage strings such as `assessed n/m`. Several declare `*_PHASES` arrays but do not send phase names; see §4.
- **Reaper:** `reapStaleAgentRuns(now, batchSize = 100)`:
  - Scans RUNNING runs.
  - A run is stale when `now − (heartbeatAt ?? startedAt ?? createdAt) > max(timeoutMs, 1000) × HEARTBEAT_GRACE_MULTIPLIER (2)`.
  - A stale run gets a compare-and-set update to `TIMED_OUT`, `errorCode 'STALE_NO_HEARTBEAT'`, `outputSummary 'Terminated by the stale-run reaper.'`.
  - Then: audit `AGENT_RUN_TIMED_OUT`; escalation severity **HIGH**, title `'Agent run abandoned'`, dedupeHint `stale-run:${agentKey}` (so one per agent, not per run).
  - Ops alert key `'agent-stale-runs'` (throttled by `alertService`); metric `agent_stale_runs_reaped`.
- The reaper does **not** scan `QUEUED` or `WAITING_FOR_REVIEW` runs.

### 3.9 Retries and backoff

| Layer | Mechanism |
|---|---|
| Run | `requeueForRetry`: RUNNING → QUEUED, `attempt + 1`, `progressStage 'retry-queued'`, refused once `attempt >= maxAttempts` |
| BullMQ job | Queue defaults `attempts: 3`, `backoff exponential 30_000 ms`. The thrown `AgentRetryableError` makes BullMQ retry the same `dispatch` job, and the worker logs it at `warn` |
| Outbox event | Linear `60_000 × attempt` ms, then `DEAD_LETTER` after `maxAttempts` (3) |
| Schedule | `MAX_CONSECUTIVE_FAILURES = 10` stops the scheduler from picking the schedule up |

A schedule may set `maxAttempts` up to 10, but the BullMQ job allows only 3 attempts. **(inferred)** A run whose `maxAttempts > 3` can therefore be left QUEUED once BullMQ gives up. The `tick` job only re-enqueues QUEUED **EVENT** runs, and only in a pass where the outbox created new runs. See §9.

### 3.10 Budgets

`createBudgetGuard` checks **three ceilings, cheapest first**, before any provider call:

1. **RUN:** `used + estimatedTokens > runTokenBudget`. The run budget is `def.defaultTokenBudget`, or `DEFAULT_RUN_TOKEN_BUDGET = 200_000` when that is null.
2. **SCHEDULE:** `scheduleTokensUsed + projected > schedule.tokenBudget`. Applies only when the run has a `scheduleId` and the schedule's `tokenBudget` is non-null.
3. **TENANT_PLAN:** `checkAiCallLimit(firmId)` from `middleware/tierGate`.
   - If the plan check itself throws, it is logged and the call is **allowed**. The two token ceilings remain the binding control.

Behaviour:
- `budget.check(n)` is non-mutating.
- `budget.generate(req, { task, useCache, estimatedTokens })` checks first. If refused, it throws `AgentBudgetExhaustedError(reason, scope)` **before** calling `generateWithRouter`. If allowed, it calls the provider and accrues `inputTokens`, `outputTokens` and `estimatedCostUsd`.
- `estimateTokens(req) = ceil((systemPrompt.length + userPrompt.length) / 4) + (maxTokens ?? 1024)`.
- **Period rollover.** `resolveSchedulePeriodUsage` resets `tokensUsedThisPeriod` and `costUsedThisPeriodUsd` when `budgetPeriodStartedAt` is 30 or more days old.
- **Accrual.** `recordScheduleUsage` adds usage to the schedule after every run that consumed something.
- **Event runs** are linked to the firm's schedule, so the SCHEDULE ceiling applies and their usage is accrued (fixed 2026-11-04, B6).
- `costBudgetUsd` is never enforced.

### 3.11 Escalations

**Severity rank** (`SEVERITY_RANK`): INFO 0 < LOW 1 < MEDIUM 2 < HIGH 3 < CRITICAL 4.

**Dedupe key:** `${consultingFirmId}:${agentKey}:${dedupeHint}`, stored in a UNIQUE column. Handlers must make `dedupeHint` entity-stable.

**`persistEscalations` rules:**
- **Never reopen a resolved item.** If the existing row is `RESOLVED` or `DISMISSED`, the new sighting is suppressed (counted as `suppressedResolved`, surfaced as a run warning). An agent never undoes a human decision.
- **Refresh an open item.** If the existing row is `OPEN` or `ACKNOWLEDGED`, refresh `runId`, `reason`, `recommendedAction` and `dueAt`.
  - **Severity is upgrade-only:** it changes only if the new rank is higher.
  - The title is **not** updated.
  - No new notification is sent: the run sees `wasCreated: false`, and notification dedupe keys on the escalation id.
- **Otherwise create** an `OPEN` row.
- A concurrent insert (`P2002`) is counted as a refresh.
- **Escalations are not filtered by autonomy level.** They are persisted even under `OBSERVE`. See §3.13 and §9.

**Human transitions** (`transitionEscalation`, ADMIN endpoints `POST /api/agents/escalations/:id/{acknowledge|resolve|dismiss}`):

| Transition | Allowed from | Records |
|---|---|---|
| ACKNOWLEDGE | OPEN | `acknowledgedAt`, `acknowledgedByUserId` |
| RESOLVE | OPEN, ACKNOWLEDGED | `resolvedAt`, `resolvedByUserId`, `resolution` |
| DISMISS | OPEN, ACKNOWLEDGED | `resolvedAt`, `resolvedByUserId`, `resolution` |

- Resolving or dismissing from OPEN also stamps the implicit acknowledgement.
- `RESOLVED` and `DISMISSED` are final.

**Runtime-raised escalations** (in addition to each agent's own, §4):

| Title | Severity | dedupeHint | Raised by |
|---|---|---|---|
| `Agent AI budget exhausted` | HIGH | `budget-exhausted:${scope}` | dispatch |
| `Agent run timed out` | MEDIUM | `timeout:${agentKey}` | dispatch |
| `Agent run abandoned` | HIGH | `stale-run:${agentKey}` | reaper |

### 3.12 Artifacts

**`persistArtifacts`**, for each proposed artifact:

1. **Retry safety.** If an artifact with the same `(runId, artifactType, sourceEntityType, sourceEntityId)` already exists, skip it (`duplicatesIgnored`).
2. **Supersede, in one transaction.** If `supersedeKey || sourceEntityId` is set:
   - Find live priors: same firm, agent and `artifactType`, same `sourceEntityType` and `sourceEntityId`, `supersededByArtifactId: null`.
   - Create the new row (`confidenceState` defaults to `MEDIUM`).
   - Set `supersededByArtifactId` and `supersededAt` on every prior that is **not** `isHumanVerified`.
3. **Human-verified artifacts are never superseded or overwritten.** They are counted in `skippedVerified`, and the run gets a warning. As a result, two live artifacts can coexist for one subject: the verified one and the new one.
4. A per-artifact error is logged and does not fail the run.

Two consequences:
- **Supersede matching uses `sourceEntityType` and `sourceEntityId`, not `supersedeKey`.** `supersedeKey` only switches superseding on; its value is never stored or compared. Two artifacts with different `supersedeKey`s but the same source entity supersede each other.
- **Firm-wide artifacts and per-entity artifacts are separate live rows.** Agents that use `sourceEntityType 'ConsultingFirm'` keep one live firm-wide artifact. Agents that use per-entity subjects keep one per entity.

**`verifyArtifact`.** `POST /api/agents/artifacts/:id/verify` (ADMIN) sets `isHumanVerified = true`, `verifiedByUserId` and `verifiedAt`. It works only once, on a still-unverified row.

**`carryForwardSections`** is new. It exists because an event-scoped run skips phases a full sweep performs, yet files its status under the same subject, so it supersedes the full sweep's artifact. Without it, an `INVOICE_PAID` run would replace real timekeeping and rate-variance results with empty defaults.

- **Signature:** `carryForwardSections({ consultingFirmId, agentKey, artifactType, sourceEntityType, sourceEntityId, status, keys })`.
- **Behaviour:**
  - `keys` should be the status sections whose owning phase did **not** run.
  - Reads the latest live (non-superseded) artifact for the subject.
  - Copies each `prior[key]` that is not `undefined` into `status`.
  - Returns the keys actually carried.
  - Empty `keys` → no DB query.
  - No prior artifact → nothing is carried.
- **Contract for callers.** Call it after building the status and **before** hashing it, and add a limitation listing the carried keys. Both current callers use this text: `Carried forward from the last full run (not re-checked by this event run): …`
- **Used by:** FINANCE (`finance/financeAgentHandler.ts`) and INTELLIGENCE (`intelligence/intelligenceAgentHandler.ts`) only. The other seven do not call it; see §9.
- **Tests:** `artifacts.unit.test.ts` (`describe('carryForwardSections')`) and `finance/financeAgent.integration.test.ts` › "keeps the full sweep's readiness when an INVOICE_PAID event run skips it".

### 3.13 Autonomy levels and the safe-action registry

From `safeActions.ts`:

| Level | Meaning (header comment) |
|---|---|
| `OBSERVE` | "compute, persist artifacts, notify. NO business writes." |
| `PROPOSE` (default) | "the above, plus proposed actions and escalations. Still NO silent judgement-based business writes." |
| `ACT_WITH_GUARDRAILS` | "may execute ONLY explicitly allowlisted action keys." |

`canApplyAction(agentKey, level, actionKey)` is true only when all three hold:
1. `level === 'ACT_WITH_GUARDRAILS'`
2. `actionKey` is in `def.allowlistedActionKeys`
3. `actionKey` is in `SAFE_ACTION_REGISTRY` for that agent

Both lists must agree, so a typo in either fails closed.

`SAFE_ACTION_REGISTRY` contains one entry: `diagnostic.noop` for `INTERNAL_DIAGNOSTIC`, with reversibility note "No state is written, so there is nothing to reverse." **ACT_WITH_GUARDRAILS therefore currently permits nothing for any domain agent.**

`isReadOnlyAutonomy(level)` is true for OBSERVE and PROPOSE.

**How handlers actually use autonomy.** Every domain handler computes `mayAct = ctx.autonomyLevel !== 'OBSERVE'`. Under OBSERVE that suppresses notifications and some writes, as listed per agent. Escalations and several derived-record writes still happen under OBSERVE, which contradicts the header comment; see §9.

The non-allowlisted writes agents make (DRAFT invoices, derived totals, recommendations, skeleton sections and so on) are **not** routed through `canApply`. They are bounded instead by the static forbidden-write matrix (§6), by tests, and by `mayAct`.

### 3.14 Notifications

`notifications.ts` routes everything through the existing `notifyUser` (`UserNotification`). There is no second feed.

**Default when a user has no preference row** (`DEFAULT_AGENT_NOTIFICATION_PREFERENCE`):

| Setting | Default |
|---|---|
| `inAppEnabled` | true |
| `emailEnabled` | false |
| `minimumSeverity` | `MEDIUM` |
| `notifyOnSuccess` | false |
| `notifyOnFailure` | true |
| `notifyOnEscalation` | true |
| `digestMode` | false |

**`shouldNotify` rules:**
- `inAppEnabled` false → never notify.
- SUCCESS → `notifyOnSuccess`.
- FAILURE → `notifyOnFailure`.
- ESCALATION → requires `notifyOnEscalation` and `rank(severity) >= rank(minimumSeverity)`.

**Recipients:** active `ADMIN` users of the firm, plus `assignedToUserId` if one is set. CONSULTANT users are not notified by default.

**Notification types:** `AGENT_ESCALATION`, `AGENT_RUN_FAILED`, `AGENT_RUN_COMPLETED`.

**Dedupe keys:**
- Escalation: `agent:${agentKey}:escalation:${escalationId}:${userId}`
- Otherwise: `agent:${agentKey}:run:${runId}:${kind}:${userId}`

**Links:** `/agents/escalations?focus=${id}` or `/agents/runs/${runId}`.

**Failure handling:** a notification failure is logged and never changes the run outcome.

**What is not wired:** `emailEnabled`, `digestMode` and `timezone` are saved by `PUT /api/agents/notification-preferences/:agentKey` but are not acted on.

Agents also call `notifyUser` directly for domain notices, listed per agent in §4. Those calls do not go through these preferences.

### 3.15 Metrics

All metrics are registered on the existing `config/observability.ts` registry. Labels are bounded: tenant and run ids are **never** labels.

| Metric | Type | Labels |
|---|---|---|
| `bytescon_agent_runs_started_total` | Counter | agent, trigger |
| `bytescon_agent_runs_finished_total` | Counter | agent, status |
| `bytescon_agent_run_duration_seconds` | Histogram, buckets 0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600 | agent, status |
| `bytescon_agent_runs_active` | Gauge | agent |
| `bytescon_agent_escalations_created_total` | Counter (refreshes not counted) | agent, severity |
| `bytescon_agent_tokens_total` | Counter | agent, direction |
| `bytescon_agent_estimated_cost_usd_total` | Counter | agent |
| `bytescon_agent_budget_blocks_total` | Counter | agent, scope |
| `bytescon_agent_events_processed_total` | Counter | status |
| `bytescon_agent_stale_runs_reaped_total` | Counter | agent |

### 3.16 HTTP surface

All routes are under `/api`. Every router applies `authenticateJWT` and `enforceTenantScope`. `enforceTenantScope` makes CONSULTANT read-only platform-wide (any non-GET returns 403); this is a documented platform contract.

**`/api/agents`** (`routes/agents.ts`; also behind `requireActiveBase`):

| Method | Path | Role |
|---|---|---|
| GET | `/definitions`, `/overview` | any |
| GET | `/schedules`, `/schedules/:agentKey` | any |
| PUT | `/schedules/:agentKey` | ADMIN |
| GET | `/runs`, `/runs/:id` | any (the detail view includes audit events) |
| POST | `/runs` | ADMIN (manual run) |
| POST | `/runs/:id/cancel` | ADMIN |
| GET | `/artifacts`, `/artifacts/:id` | any |
| POST | `/artifacts/:id/verify` | ADMIN |
| GET | `/escalations`, `/escalations/:id` | any |
| POST | `/escalations/:id/{acknowledge,resolve,dismiss}` | ADMIN |
| GET | `/notification-preferences` | any |
| PUT | `/notification-preferences/:agentKey` | non-GET, so CONSULTANT is blocked by tenant scope |

**Per-agent read surfaces:**

| Mount | File | Endpoints |
|---|---|---|
| `/api/agents/opportunity` | `routes/opportunityAgent.ts` | GET `/latest`, `/feedback`, `/feedback/:id`; POST `/feedback/:id/apply` and `/feedback/:id/revert` (ADMIN, human acts) |
| `/api/agents/compliance` | `routes/complianceAgent.ts` | GET `/latest`, `/opportunity/:opportunityId`, `/bonding`; POST/PUT bonding (ADMIN) |
| `/api/agents/qualification` | `routes/qualificationAgent.ts` | GET `/:pursuitId`, `/:pursuitId/history`; POST `/recommendation/:id/accept` and `/reject` (ADMIN) |
| `/api/agents/teaming` | `routes/teamingAgent.ts` | GET `/plan/:pursuitId`, `/goals`, `/performance`; POST and PATCH goals (ADMIN) |
| `/api/agents/pricing` | `routes/pricingAgent.ts` | GET `/assessment/:workspaceId`, `/cohort/:cohortId` |
| `/api/agents/proposal` | `routes/proposalAgent.ts` | GET `/status/:proposalId`, `/library`; POST library create, version, approve and archive (ADMIN) |
| `/api/agents/finance` | `routes/financeAgent.ts` | GET `/status`, `/readiness`, `/cash-flow`, `/actual-rates`; POST `/actual-rates` and `/actual-rates/:id/verify` (ADMIN) |
| `/api/agents/intelligence` | `routes/intelligenceAgent.ts` | GET `/portfolio`, `/segments`, `/recommendations`; POST `/recommendations/:id/dismiss` (ADMIN), `/recommendations/:id/acknowledge` |
| `/api/contract-health` | `routes/contractHealth.ts` | GET `/portfolio`, `/:contractId` (read-only, serves the latest live `CONTRACT_HEALTH` artifact and `CONTRACT_POLICY_DOC`) |

The human-act endpoints above are where people make the decisions that agents may not. Authorization and IDOR are enforced by `routes/section7Authorization.audit.test.ts`.

---

## 4. The nine agents

Every agent shares these properties:
- One handler and one artifact family.
- Disabled by default; `PROPOSE` by default; empty allowlist.
- It returns artifacts and escalations, and the runtime persists them.
- `mayAct = ctx.autonomyLevel !== 'OBSERVE'` gates its notifications.
- Escalations are **not** gated by autonomy, in any agent.

"Phases" are the handler's `*_PHASES` array. Several handlers gate only some phases in code; the gaps are noted.

### 4.1 Opportunity Agent (`OPPORTUNITY`, §7.2)

**Configuration**
- **Cron:** `0 */2 * * *`
- **Subscribed events:** `SOURCE_SYNC_COMPLETED`, `FIRM_CAPABILITY_CHANGED`, `MONITORING_PROFILE_SAVED`, `PURSUIT_STAGE_CHANGED`
- **Artifact:** `OPPORTUNITY_BRIEF`, one per firm:
  - title `Opportunity brief — ${YYYY-MM-DD}`
  - `sourceEntityType 'ConsultingFirm'`, `supersedeKey opportunity-brief:${firmId}`
  - confidence `MEDIUM` if any source is failing, otherwise `HIGH`
  - The run is `FAILED` only if no brief could be built.
- **LLM:** none. Token budget 0. Tests assert `generateWithRouter` is never called and no `ApiUsageLog` row is written.

**Phases** (`OPPORTUNITY_PHASES`, `opportunity/opportunityAgentHandler.ts`):

`LOAD_CONTEXT, CHECK_SOURCE_HEALTH, PROCESS_CHANGED_OPPORTUNITIES, CLASSIFY_NOTICES, REFRESH_CAPABILITY_MATCHES, REFRESH_ELIGIBILITY, REFRESH_RECOMPETES, EVALUATE_MONITORING_PROFILES, ANALYZE_PURSUIT_FEEDBACK, BUILD_OPPORTUNITY_BRIEF, CREATE_ESCALATIONS, COMPLETE`

The heartbeat stage is the phase name.

**Event runs** (`phasesForRun(triggerEntityType)`). Every run includes `LOAD_CONTEXT, CHECK_SOURCE_HEALTH, BUILD_OPPORTUNITY_BRIEF, CREATE_ESCALATIONS, COMPLETE`, plus the phases below:

| Trigger entity (event) | Phases added |
|---|---|
| `FirmCapability` (FIRM_CAPABILITY_CHANGED) | `REFRESH_CAPABILITY_MATCHES, REFRESH_ELIGIBILITY` |
| `SavedMonitoringProfile` (MONITORING_PROFILE_SAVED) | `EVALUATE_MONITORING_PROFILES` |
| `BidPursuit` (PURSUIT_STAGE_CHANGED) | `ANALYZE_PURSUIT_FEEDBACK` |
| `OpportunitySourceConfig` (SOURCE_SYNC_COMPLETED) | `PROCESS_CHANGED_OPPORTUNITIES, CLASSIFY_NOTICES, REFRESH_CAPABILITY_MATCHES, REFRESH_ELIGIBILITY, EVALUATE_MONITORING_PROFILES`. Skips recompetes and pursuit feedback |
| none (schedule or manual) | All phases |

**Scope**
- Narrowed only for:
  - CLASSIFY_NOTICES on a source-sync run (`sourceConfigId = triggerEntityId`)
  - EVALUATE_MONITORING_PROFILES on a profile run (only that profile; ignores the `nextEvaluationAt` cadence)
- Match refresh, pursuit learning, the brief and source health always run tenant-wide.
- `PROCESS_CHANGED_OPPORTUNITIES` has no step of its own; it is handled in the same block as `CLASSIFY_NOTICES`.
- `carryForwardSections` is not called. An event run supersedes the firm brief with a partial one, for example `pursuitLearning.status: 'NOT_ANALYSED'` (§9).

**Reads**
- `opportunity`, `savedMonitoringProfile`, `recompeteSignal`, `agencyForecast`, `opportunitySourceConfig`, `bidPursuit`, `clientOpportunityDecline`, `pursuitFeedbackSignal`
- Services: `classifyNotice`, `refreshFirmMatches`, `detectRecompetes`, `linkForecastsToSolicitations`, `evaluateProfile`, `deriveFreshness`, `analysePursuitFeedback`, `resolveEffectiveWeights`

**Writes**
- `opportunity.update { presolicitationKind }`, only when the classification changed.
- `pursuitFeedbackSignal.create`:
  - status `PROPOSED` or `INSUFFICIENT_DATA`
  - idempotent on `consultingFirmId_inputHash`
  - a new PROPOSED signal supersedes older PROPOSED ones (`status SUPERSEDED`)
- Through delegated services:
  - `OpportunityMatch` rows, plus the `OPPORTUNITY_MATCH_HIGH` emission inside `services/discovery/matchRefresh.ts`
  - `RecompeteSignal` rows and forecast-link state
  - `MonitoringProfileAlert` rows and their notifications. Profile evaluation and notification run only when `mayAct`.

**Escalations**

| Title | Severity | Condition | dedupeHint |
|---|---|---|---|
| `Opportunity source failing: ${source.displayName}` | HIGH | `consecutiveFailures >= SOURCE_FAILURE_ESCALATION_THRESHOLD` (5) | `opportunity-source-failing:${sourceConfigId}` |
| `Opportunity source stale: ${source.displayName}` | MEDIUM | `STALE` (per the source's `stalenessHours`) or `NEVER_SYNCED` | `opportunity-source-stale:${sourceConfigId}` |
| `Pursuit-preference adjustment proposed` | INFO | A new PROPOSED learning signal. Needs sample ≥ `MIN_FEEDBACK_SAMPLE_SIZE` (20) and each class ≥ `MIN_FEEDBACK_CLASS_SIZE` (3) | `pursuit-feedback-proposed:${signalId}` |
| `Critical match closing in ${n} working day(s): ${title}` | CRITICAL if ≤ 2 working days (inline literal), else HIGH | `matchScore >= CRITICAL_MATCH_SCORE` (85), `workingDaysToDeadline <= CRITICAL_DEADLINE_WORKING_DAYS` (5), not `NOT_ELIGIBLE` | `opportunity-critical-deadline:${opportunityId}` |

NOT_CONFIGURED sources are never escalated.

**Policy constants** (`opportunity/policy.ts`):

| Constant | Value |
|---|---|
| `PURSUIT_ALGORITHM_VERSION` | `'pursuit-feedback-v1'` |
| `MIN_FEEDBACK_SAMPLE_SIZE` | 20 |
| `MIN_FEEDBACK_CLASS_SIZE` | 3 |
| `MAX_WEIGHT_ADJUSTMENT_PCT` | 0.25 |
| `CONFIDENCE_MEDIUM_SAMPLE` | 30 |
| `CONFIDENCE_HIGH_SAMPLE` | 60 |
| `MAX_FEEDBACK_RECORDS` | 1000 |
| `MAX_OPPORTUNITIES_PER_RUN` | 200 |
| `HIGH_MATCH_SCORE` | 70 |
| `CRITICAL_MATCH_SCORE` | 85 |
| `SOURCE_FAILURE_ESCALATION_THRESHOLD` | 5 |
| `CRITICAL_DEADLINE_WORKING_DAYS` | 5 |
| `BRIEF_SECTION_LIMIT` | 25 |
| `LIVE_OPPORTUNITY_STATUSES` | `['ACTIVE']` |

Constants outside policy.ts:
- In the handler: `CHANGE_WINDOW_HOURS = 48` and the profile `take: 50`.
- In `pursuitFeedback.ts`:
  - `PURSUED_STAGES = QUALIFICATION, CAPTURE, PROPOSAL, SUBMITTED, AWARDED, LOST`
  - `IGNORED_STAGES = NO_BID`
  - `NEUTRAL_STAGES = IDENTIFIED, ARCHIVED`
  - A `PASSED` decline counts as "ignored" only when `source === USER`; `AUTO_EXPIRED` is excluded.

**Must NEVER**
- Apply a learned weighting. Applying is the human endpoint `POST /feedback/:id/apply`.
- Remove a human-applied adjustment.
- Verify a capability.
- Accept a re-compete signal.
- Confirm a forecast link.
- Record a bid decision or create or alter a pursuit.
- Touch a MANUAL-origin opportunity's protected data.
- Trigger a source sync. Section 6's `SOURCE_SYNC_JOB` is the single owner.
- Notify or evaluate profiles under OBSERVE.

Enforced by `opportunity/opportunityAgent.integration.test.ts` › "human control is never bypassed" and by `opportunity/pursuitFeedback.unit.test.ts`.

### 4.2 Qualification Agent (`QUALIFICATION`, §7.4)

**Configuration**
- **Cron:** `0 */6 * * *`
- **Subscribed events:** `OPPORTUNITY_MATCH_HIGH`, `PURSUIT_STAGE_CHANGED`, `EXTRACTION_COMPLETED`, `AMENDMENT_RECORDED`
- **Artifact:** `QUALIFICATION_BRIEF`, one per pursuit:
  - title `Qualification brief — ${opportunityTitle}`
  - `sourceEntityType 'BidPursuit'`, `supersedeKey qualification-brief:${pursuitId}`
- **LLM:** none. Token budget 0. The narrative comes from a template renderer (`recommendationNarrative.ts`).

**Phases** (`QUALIFICATION_PHASES`):

`LOAD_PURSUIT, LOAD_OPPORTUNITY_MATCH, LOAD_CAPABILITY, LOAD_CAPACITY, LOAD_PAST_PERFORMANCE, LOAD_INCUMBENT_EVIDENCE, LOAD_COMPETITOR_EVIDENCE, LOAD_COMPLIANCE_CONTEXT, COMPUTE_SCORECARD, COMPUTE_WIN_PROBABILITY, COMPUTE_CONFIDENCE, COMPUTE_CAPABILITY_GAPS, CHECK_PRICING_EVIDENCE, EVALUATE_BORDERLINE_POLICY, BUILD_RECOMMENDATION, CREATE_ESCALATION, BUILD_QUALIFICATION_BRIEF, COMPLETE`

- `phasesForRun` returns **all phases for every trigger**. Triggers change scope, not depth.
- The phase names are decorative. The heartbeat stage is `qualified ${n}/${m}`.

**Scope**
- **Sweep:** pursuits with `pipelineStage in QUALIFIABLE_STAGES` (`IDENTIFIED, QUALIFICATION, CAPTURE, PROPOSAL`), take `MAX_PURSUITS_PER_SWEEP` (25).
- **Targeted:** resolves `BidPursuit` / `Opportunity` / `SolicitationExtractionJob` / `AmendmentRevision` to one tenant-verified pursuit.
- **A target that does not resolve never falls back to a sweep.** The run is SKIPPED instead.

**Reads**
- `bidPursuit`, `opportunityMatch`, `scorecard`, `submissionRecord` (WON/LOST), `qualificationRecommendation`, `gateReview`
- Evidence: `awardHistory`, `incumbentRetentionStat`, `competitorAwardStat`, `firmCapability`, `pastPerformanceRecord`, `pricingSensitivityAnalysis`
- The newest live `COMPLIANCE_STATUS` artifact (see §9 for the subject mismatch)

**Writes**
- `qualificationRecommendation.create`:
  - fields: `version + 1`, `status 'ACTIVE'`, `inputHash`, `algorithmVersion 'qualification-v1'`
  - the previous ACTIVE row becomes `SUPERSEDED`
  - skipped when `pursuitId_inputHash` already exists
- `gateReview.create`, only when `mayAct` and the recommendation is borderline, and no review with the same name is open:
  - name `Qualification review — borderline (v${version})`
  - `stage 'QUALIFICATION'`, `status 'NOT_STARTED'`
  - The agent never completes the review.
- `notifyUser`:
  - type `QUALIFICATION_DECISION`, title `Qualification recommendation: ${result}`
  - dedupe `qualification-recommendation:${id}`
  - only when `mayAct`, a new version was created, and the pursuit has an owner
- The proposed priority is stored on the recommendation. `BidPursuit.priority` is never written.

**Borderline policy** (`qualification/borderlinePolicy.ts`, version `qualification-borderline-v1`):

| Constant | Value |
|---|---|
| `DECISION_BOUNDARY` | `CONDITIONAL_THRESHOLD` = 50 (`scorecardScoring.ts:26`; `BID_THRESHOLD` = 70 at line 25) |
| `BORDERLINE_BAND` | 10, giving `BORDERLINE_LOWER` 40 and `BORDERLINE_UPPER` 60 |
| `MAX_USEFUL_INTERVAL_WIDTH` | 40 |
| `STRONG_BID_PROBABILITY` | 70 |
| `STRONG_NO_BID_PROBABILITY` | 25 |
| `LATE_STAGE_PURSUIT_STAGES` | `['CAPTURE','PROPOSAL','SUBMITTED']` |

Outcome rules, in order:
1. **INSUFFICIENT_DATA** (not borderline) when there is no probability or sufficiency is `NONE`.
2. **BORDERLINE_REVIEW** if any of:
   - 40 ≤ p ≤ 60
   - no interval, or the interval straddles 50
   - interval width > 40
   - a CRITICAL or MAJOR gap
   - capacity `OVER_CAPACITY` or `INSUFFICIENT_DATA`
   - compliance blockers or human-review items
   - INSUFFICIENT data together with `INSUFFICIENT_DATA` confidence
3. **BID** if p > 50. STRONG if p ≥ 70 and confidence is not LOW.
4. **NO_BID** otherwise. STRONG if p ≤ 25 and confidence is not LOW.

**Escalations**

| Title | Severity | Condition | dedupeHint |
|---|---|---|---|
| `Borderline qualification: ${title}` | HIGH (assigned to the owner) | borderline | `qualification-borderline:${pursuitId}:v${version}` |
| `Capacity conflict: ${title}` | MEDIUM | `OVER_CAPACITY` (active pursuits ≥ capacity) | `qualification-capacity:${pursuitId}` |
| `Critical capability gap: ${title}` | HIGH | Gap severity CRITICAL | `qualification-capability:${pursuitId}` |
| `Qualification contradicts pursuit stage: ${title}` | HIGH | Late stage, and NO_BID, a compliance blocker, or a CRITICAL gap | `qualification-stage-contradiction:${pursuitId}:v${version}` |
| `Compliance blocker on a qualifying pursuit: ${title}` | HIGH | Compliance blockers > 0 | `qualification-compliance:${pursuitId}` |

Escalations are raised under OBSERVE too. The test `still escalates under OBSERVE, because an escalation is how a human is told` asserts this deliberately.

**Must NEVER**
- Write a `BidDecision`, a Scorecard decision, or a `ScorecardDecision` row. It does not import `recordQualificationDecision`.
- Approve or reject a `GateReview`.
- Change a pursuit's stage or priority.
- Override a human rationale.
- Invent an incumbent.
- Call an award share a win rate.
- Convert insufficient data into a no-bid.

Enforced by:
- `qualification/qualificationAgent.integration.test.ts` › "the agent never records a decision"
- `qualification/recommendationNarrative.test.ts`
- `qualification/borderlinePolicy.test.ts`

### 4.3 Compliance Agent (`COMPLIANCE`, §7.3)

**Configuration**
- **Cron:** `0 */6 * * *`
- **Subscribed events:** `SOLICITATION_DOCUMENT_ADDED`, `EXTRACTION_COMPLETED`, `AMENDMENT_RECORDED`, `PURSUIT_STAGE_CHANGED`
- **Artifact:** `COMPLIANCE_STATUS`:
  - title `Compliance status — ${YYYY-MM-DD}`
  - supersedeKey `compliance-status:${subject.id}`
  - Subject (`statusSubject`):
    - no trigger entity → `ConsultingFirm`
    - exactly one opportunity in scope → `Opportunity`
    - otherwise → the trigger entity
- **LLM:** none in its own directory. Token budget 100_000 (registry) on behalf of the reused Section 6 extraction (`LLM_DELEGATED`). The agent re-exports `AMENDMENT_CHANGE_SUMMARY_SYSTEM_PROMPT` by reference only.
  - With no provider: full function, plus a per-opportunity limitation that no AI-enhanced extraction is recorded.

**Phases** (`COMPLIANCE_PHASES`):

`LOAD_CONTEXT, CHECK_REGISTRATION, CHECK_CERTIFICATIONS, CHECK_INSURANCE, CHECK_BONDING, CHECK_DOCUMENT_EXPIRY, PROCESS_SOLICITATIONS, RUN_EXTRACTION, CHECK_EXTRACTION_STATUS, DERIVE_LM_COVERAGE, CHECK_CLAUSE_OBLIGATIONS, CHECK_AMENDMENT_IMPACTS, RUN_PRE_SUBMISSION_CHECKS, BUILD_COMPLIANCE_STATUS, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE`

**Event runs.** CLOSING = `BUILD_COMPLIANCE_STATUS, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE`.

| Trigger entity (event) | Phases |
|---|---|
| `OpportunityDocument` (SOLICITATION_DOCUMENT_ADDED) | `LOAD_CONTEXT, PROCESS_SOLICITATIONS, RUN_EXTRACTION, CHECK_EXTRACTION_STATUS, DERIVE_LM_COVERAGE, CHECK_CLAUSE_OBLIGATIONS` + CLOSING |
| `SolicitationExtractionJob` (EXTRACTION_COMPLETED) | `LOAD_CONTEXT, PROCESS_SOLICITATIONS, CHECK_EXTRACTION_STATUS, DERIVE_LM_COVERAGE, CHECK_CLAUSE_OBLIGATIONS, RUN_PRE_SUBMISSION_CHECKS` + CLOSING. **No RUN_EXTRACTION**: this is the loop guard |
| `AmendmentRevision` (AMENDMENT_RECORDED) | `LOAD_CONTEXT, PROCESS_SOLICITATIONS, CHECK_AMENDMENT_IMPACTS, DERIVE_LM_COVERAGE, CHECK_CLAUSE_OBLIGATIONS` + CLOSING |
| `BidPursuit` (PURSUIT_STAGE_CHANGED) | `LOAD_CONTEXT, PROCESS_SOLICITATIONS, CHECK_EXTRACTION_STATUS, DERIVE_LM_COVERAGE, CHECK_CLAUSE_OBLIGATIONS, CHECK_AMENDMENT_IMPACTS, RUN_PRE_SUBMISSION_CHECKS` + CLOSING |
| none (schedule or manual) | All phases **except** `RUN_EXTRACTION`. Extraction never runs on a schedule |

Every event run skips `CHECK_REGISTRATION, CHECK_CERTIFICATIONS, CHECK_INSURANCE, CHECK_BONDING, CHECK_DOCUMENT_EXPIRY`.

**Scope**
- **Targeted:** one tenant-verified opportunity. There is no tenant fallback.
- **Sweep:** `isDemo: false` opportunities with a pursuit in `ACTIVE_PURSUIT_STAGES`, ordered by `responseDeadline asc`, take `MAX_OPPORTUNITIES_PER_SWEEP` (50).

**Reads**
- `complianceMatrix`, `matrixRequirement`, `solicitationExtractionJob`, `clauseObligation`, `opportunityDocument`, `proposalSubmission`, `submissionValidationCheck`
- Registration family: `registrationProfile`, `certification`, `insurancePolicy`, `bondingCapacity`
- Amendment check: `amendmentRevision`, `amendmentImpact`, `sectionLmMapping`

**Writes**
- **Extraction.** Only on an `OpportunityDocument` trigger **and** `mayAct`. It calls the canonical `runExtraction`, which is idempotent on a SHA-256 of the document text. It is skipped if the legacy pipeline already produced requirements for that document.
- **Event.** On SUCCEEDED or PARTIAL it emits `EXTRACTION_COMPLETED` through `emitExtractionCompleted`, in its own `$transaction`. This is the allowed self-emission.
- **Nothing else.** `registrationWatch.ts` and `amendmentRecheck.ts` are read-only.
- **No notifications.** `CREATE_NOTIFICATIONS` sends nothing; the outcome note is "owner notifications handled by the canonical reminder paths".

**Escalations**

| Title | Severity | Condition | dedupeHint |
|---|---|---|---|
| `SAM registration has expired` | CRITICAL | `classifyExpiry(samExpiryDate) === 'EXPIRED'` | `compliance-sam_expiry:expired` |
| `SAM registration expires in ${samDays} day(s)` | HIGH if ≤ 7 days (inline), else MEDIUM | `0 <= samDays <= SAM_EXPIRY_ESCALATION_DAYS` (30) | `compliance-sam_expiry:expiring` |
| `Certification expired: ${cert.name}` | HIGH | Certification EXPIRED | `compliance-cert_expiry:${certId}:expired` |
| `Insurance expired: ${policy.policyType}` | MEDIUM | Policy EXPIRED | `compliance-insurance_expiry:${policyId}:expired` |
| `Surety bonding capacity has expired` | MEDIUM | Bonding EXPIRED | `compliance-bonding:${recordId ?? 'none'}:expired` |
| `Solicitation extraction failed after ${attempt} attempt(s)` | HIGH | Latest job `FAILED && attempt >= maxAttempts` | `compliance-extraction-failed:${jobId}` |
| `Certification expires before the deadline: ${cert.name}` | HIGH | `expiryDate < responseDeadline`. Sweep runs only | `compliance-cert-before-deadline:${certId}:${opportunityId}` |
| `Amendment ${revisionNo} issued ${n} working day(s) before the deadline` | CRITICAL if ≤ 2 working days (inline), else HIGH | `workingDaysToDeadline <= AMENDMENT_DEADLINE_WORKING_DAYS` (5) | `compliance-amendment-deadline:${revisionId}` |
| `Amendment ${revisionNo} conflicts with ${n} human-verified record(s)` | HIGH | conflicts > 0 | `compliance-amendment-conflict:${revisionId}` |
| `Compliance blocked` / `Compliance human review required` (built as `Compliance ${overallStatus…}`) | CRITICAL / HIGH | Overall status BLOCKED / HUMAN_REVIEW_REQUIRED | `compliance-overall:${firmId}` (one per firm) |

An incomplete mandatory requirement is a blocker when `workingDaysToDeadline <= MANDATORY_GAP_BLOCKER_WORKING_DAYS` (10). Otherwise it needs attention.

**Policy constants** (`compliance/policy.ts`):

| Constant | Value |
|---|---|
| `SAM_EXPIRY_ESCALATION_DAYS` | 30 |
| `AMENDMENT_DEADLINE_WORKING_DAYS` | 5 |
| `MANDATORY_GAP_BLOCKER_WORKING_DAYS` | 10 |
| `MAX_OPPORTUNITIES_PER_SWEEP` | 50 |
| `STATUS_SECTION_LIMIT` | 25 |
| `ACTIVE_PURSUIT_STAGES` | `['QUALIFICATION','CAPTURE','PROPOSAL','SUBMITTED']` |
| `PRE_SUBMISSION_STAGES` | `['PROPOSAL','SUBMITTED']` (unused by the handler) |
| `TERMINAL_PURSUIT_STAGES` | `['AWARDED','LOST','NO_BID','ARCHIVED']` (unused) |
| `STATUS_RANK` | COMPLIANT_CURRENT 0, INSUFFICIENT_DATA 1, ATTENTION_REQUIRED 2, HUMAN_REVIEW_REQUIRED 3, BLOCKED 4 |
| `FLOW_DOWN_REVIEW_WORDING` | `'Potential flow-down identified — legal review required before relying on this classification.'` |

Overall status precedence (`deriveOverallStatus`): blockers → human review → attention → insufficient data → COMPLIANT_CURRENT.

**Must NEVER**
- Verify a requirement.
- Approve a clause or clear `legalReviewRequired`.
- Accept an ambiguous L/M mapping.
- Acknowledge an amendment.
- Change registration, certification, insurance or bonding records.
- Waive a submission blocker or write a submission validation pass.
- Record a bid decision.
- Run extraction on a schedule or on an `EXTRACTION_COMPLETED` run.
- Extract a document twice.
- Call a firm COMPLIANT merely because extraction finished.
- Define or append to a prompt.

Enforced by:
- `compliance/complianceAgent.integration.test.ts` › "human control is never bypassed"
- `compliance/promptIntegrity.test.ts`
- `compliance/statusSubject.unit.test.ts` (`never files an event run under the firm`)

### 4.4 Proposal Agent (`PROPOSAL`, §7.7)

**Configuration**
- **Cron:** `0 */6 * * *`
- **Max runtime:** 20 min
- **Subscribed events:** `BID_DECISION_RECORDED`, `EXTRACTION_COMPLETED`, `PROPOSAL_SECTION_APPROVED`, `AMENDMENT_RECORDED`, `CAPABILITY_NARRATIVE_APPROVED`
- **Artifact:** `PROPOSAL_STATUS`, one per proposal:
  - title `Proposal status — ${proposal.title}`
  - `sourceEntityType 'Proposal'`, `supersedeKey proposal-status:${proposalId}`
  - confidence MEDIUM if any requirement is unmapped, otherwise HIGH
  - `adherence` is hard-coded `{ score: null, state: 'INSUFFICIENT_DATA' }`

**Phases** (`PROPOSAL_PHASES`):

`LOAD_PROPOSAL_CONTEXT, LOAD_REQUIREMENTS, LOAD_LM_MAPPINGS, BUILD_OR_REFRESH_OUTLINE, LOAD_CAPABILITY_LIBRARY, LOAD_PAST_PERFORMANCE, PREPARE_SECTION_DRAFTS, PROPOSE_PAST_PERFORMANCE, RUN_COMPLIANCE_CROSSCHECK, CHECK_REVIEW_CYCLES, SEND_REVIEW_REMINDERS, RUN_PRE_SUBMISSION_VALIDATION, COMPUTE_ADHERENCE, BUILD_PROPOSAL_STATUS, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE`

The heartbeat stage is `assessed n/m`.

**Event runs**

| Trigger entity (event) | Phases | Skipped |
|---|---|---|
| `ProposalSection` (PROPOSAL_SECTION_APPROVED) | `LOAD_PROPOSAL_CONTEXT, LOAD_REQUIREMENTS, BUILD_OR_REFRESH_OUTLINE, RUN_COMPLIANCE_CROSSCHECK, CHECK_REVIEW_CYCLES, COMPUTE_ADHERENCE, BUILD_PROPOSAL_STATUS, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE` | LM mappings, capability library, past performance, drafting, reminders, pre-submission. "A human approval refreshes coverage and review state, and drafts nothing." |
| `CapabilityNarrative` (CAPABILITY_NARRATIVE_APPROVED) | `LOAD_PROPOSAL_CONTEXT, LOAD_REQUIREMENTS, BUILD_OR_REFRESH_OUTLINE, LOAD_CAPABILITY_LIBRARY, PREPARE_SECTION_DRAFTS, BUILD_PROPOSAL_STATUS, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE` | Cross-check, review cycles, reminders, past performance, adherence |
| Anything else | All 17 | — |

Only `BUILD_OR_REFRESH_OUTLINE` (skeleton creation), `PREPARE_SECTION_DRAFTS`, `PROPOSE_PAST_PERFORMANCE`, `RUN_COMPLIANCE_CROSSCHECK`, `CHECK_REVIEW_CYCLES` and `SEND_REVIEW_REMINDERS` are actually gated in code.

**Scope.** Only proposals with `status 'ACTIVE'`.
- `ProposalSection`, `BidPursuit`, `Opportunity` → the ACTIVE proposals on that opportunity.
- Other targets sweep the tenant: take `MAX_PROPOSALS_PER_SWEEP` (10).
- Empty scope → SKIPPED.
- `BID_DECISION_RECORDED`: the decision value (BID or NO_BID) is **not read** (§9).
- The handler matches `'ExtractionJob'` and `'Amendment'`, but those events carry `'SolicitationExtractionJob'` and `'AmendmentRevision'`, so they fall through to a tenant sweep (§9).

**Reads**
- `proposal`, `proposalSection`, `proposalSectionVersion`, `bidPursuit`, `complianceMatrix`, `matrixRequirement`, `sectionLmMapping`
- `capabilityNarrative` (ACTIVE, with APPROVED versions only)
- `proposalKeyPersonnel` → personnel with VERIFIED qualifications and APPROVED resumes
- `pastPerformanceRecord`, `pastPerformanceSelection`, `reviewCycle`, `agentArtifact`
- Services: `isLlmProviderConfigured`, `scoreRelevance` (the §5 engine)

**Writes.** All are gated by `mayAct`.

| Write | Detail |
|---|---|
| `proposalSection.create` (skeleton) | `status 'OUTLINE'`, `isAiGenerated: true`. Only for DETERMINISTIC_FALLBACK outline items with mandatory requirements. No content is stored |
| AI draft (`persistDraftVersion`, one transaction) | `proposalSectionVersion.create { source: 'AI', isAiGenerated: true }` and `proposalSection.update { draft, status: OUTLINE → 'DRAFTING' otherwise unchanged, generationStatus 'COMPLETED', generationError: <fingerprint> }`. Never on a section in `LOCKED_SECTION_STATUSES = ['APPROVED']` |
| `reviewCycle.create { status: 'OPEN' }` | The next cycle in `CYCLE_ORDER = PINK, RED, GOLD, WHITE`, only when every existing cycle is closed |
| `pastPerformanceSelection.upsert` | Relevance score and explanation, `scoreMethod 'DETERMINISTIC'`. **Never `isSelected`** |
| `notifyUser` | type `PROPOSAL_REVIEW`, title `Proposal review reminder — ${title}`, dedupe `proposal-review-reminder:${sectionId}:${audience}:${afterWorkingDays}`, with `:${adminId}` appended for the admin rung |

**LLM.** Guard: `useLlm = isLlmProviderConfigured(firm) && (await ctx.budget.check(1)).allowed`. Calls go through `ctx.budget.generate`. Prompts live in `proposal/proposalPrompts.ts` and are hash-pinned by `proposalPrompts.exactness.test.ts`.

| Call | Prompt constant | Estimate / `maxTokens` | Task |
|---|---|---|---|
| `draftSection` | `PROPOSAL_SECTION_DRAFT_SYSTEM_PROMPT` | `EST_SECTION_TOKENS` 6_000 / 6000, temperature 0.2 | `PROPOSAL_DRAFT` |
| `adaptPastPerformance` | `PAST_PERFORMANCE_ADAPTATION_SYSTEM_PROMPT` (the §7 one, not the §5 one) | 3_000 / 3000 | `PROPOSAL_DRAFT` (never called by the handler) |
| `runCrossCheck` | `PROPOSAL_COMPLIANCE_CROSSCHECK_SYSTEM_PROMPT` | 4_000 / 4000, temperature 0 | `COMPLIANCE_MATRIX` |

- Every AI output is prefixed with `AI_DRAFT_LABEL = 'AI-GENERATED DRAFT — REQUIRES HUMAN REVIEW'`.
- **With no provider:** `NO_PROVIDER_LIMITATION = 'AI drafting unavailable — no provider configured'`. The deterministic skeleton (for example `'[OUTLINE ONLY — NO NARRATIVE HAS BEEN DRAFTED FOR THIS SECTION]'`) is used and is not persisted.
- **On budget exhaustion inside drafting:** `BUDGET_EXHAUSTED: ${reason} The deterministic skeleton was used instead.`
- At most `MAX_SECTIONS_DRAFTED_PER_RUN` (5) drafts per run.
- A section is skipped if its stored fingerprint matches.

**Escalations.** `nearDeadline = 0 <= workingDaysToDeadline <= PROPOSAL_RISK_WORKING_DAYS` (10).

| Title | Severity | Condition | dedupeHint |
|---|---|---|---|
| `Mandatory requirements unmapped near submission — ${title}` | HIGH | Unmapped > 0 and near deadline | `proposal-unmapped:${proposalId}:${unmappedCount}` |
| `SOURCE_MATERIAL_REQUIRED near submission — ${title}` | MEDIUM | Sections needing source material > 0 and near deadline | `proposal-source-required:${proposalId}:${count}` |
| `${cycleType} review cycle has stalled — ${title}` | MEDIUM | Open longer than `CYCLE_STALL_WORKING_DAYS` (10) | `proposal-cycle-stalled:${cycleId}` |
| `REVIEWER_ASSIGNMENT_REQUIRED — ${section} — ${title}` | HIGH within 10 working days of the deadline, else MEDIUM | Section `IN_REVIEW` with no reviewer | `proposal-reviewer-required:${sectionId}` |
| `Review overdue after the full reminder ladder — ${section} — ${title}` | MEDIUM | `workingDaysInReview >= 8` | `proposal-review-overdue:${sectionId}` |

**Other constants**

| Constant | Value |
|---|---|
| `REMINDER_LADDER` | `[{2,'REVIEWER'},{5,'OWNER'},{8,'ADMIN'}]` |
| `REVIEW_OVERDUE_WORKING_DAYS` | 3 |
| `HIGH_CONFIDENCE_MAPPING` | 0.7 |
| `MIN_RELEVANCE_SCORE` | 10 |
| `MAX_SOURCES_PER_SECTION` | 6 |
| `MAX_PAST_PERFORMANCE_CANDIDATES` | 5 |

**Must NEVER**
- Write an approved section version, or promote a draft to APPROVED.
- Approve a section review, a review cycle or a colour team.
- Satisfy an attestation.
- Waive a compliance blocker.
- Mark a requirement verified.
- Select final past performance.
- Submit a proposal.
- Rewrite human-approved text.
- Pick a reviewer.
- Quote DRAFT or ARCHIVED capability versions, unapproved resumes or unverified qualifications.
- Import the §5 prompt of the same name.

Enforced by:
- `proposal/proposalAgent.integration.test.ts` › "the agent approves nothing, at either autonomy level"
- `proposal/proposalAgentEvents.test.ts`
- `proposal/proposalPrompts.exactness.test.ts`
- `proposal/personnelEvidence.integration.test.ts`

### 4.5 Pricing Agent (`PRICING`, §7.6)

**Configuration**
- **Cron:** `0 */12 * * *`
- **Subscribed events:** `BID_DECISION_RECORDED`, `PRICING_SCENARIO_CHANGED`, `AMENDMENT_RECORDED`, `INDIRECT_RATE_CHANGED`
- **Artifact:** `PRICING_ASSESSMENT`, one per workspace:
  - title `Pricing assessment — ${workspace.title}`
  - `sourceEntityType 'PricingWorkspace'`, `supersedeKey pricing-assessment:${workspaceId}`
- **LLM:** none. "ZERO system prompts and makes ZERO LLM calls". Token budget 0.

**Phases** (`PRICING_PHASES`):

`LOAD_PRICING_WORKSPACE, LOAD_SCENARIOS, VALIDATE_RATE_STRUCTURE, RECOMPUTE_DERIVED_TOTALS, CHECK_INDIRECT_RATES, CHECK_TEMPLATE_STALENESS, REFRESH_PRICING_SENSITIVITY, BUILD_PUBLIC_AWARD_COHORT, COMPUTE_COMPETITIVE_RANGE, CHECK_AMENDMENT_IMPACT, BUILD_PRICING_ASSESSMENT, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE`

**Event runs**

| Trigger entity | Phases |
|---|---|
| `PricingTemplate` (INDIRECT_RATE_CHANGED) | `LOAD_PRICING_WORKSPACE, LOAD_SCENARIOS, CHECK_INDIRECT_RATES, CHECK_TEMPLATE_STALENESS, BUILD_PRICING_ASSESSMENT, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE`. Skips recompute, sensitivity, cohort, range and amendment |
| `Amendment` | `LOAD_PRICING_WORKSPACE, LOAD_SCENARIOS, CHECK_AMENDMENT_IMPACT, BUILD_PRICING_ASSESSMENT, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE`. **Dead branch**: AMENDMENT_RECORDED carries `'AmendmentRevision'` (§9) |
| Anything else (PricingScenario, BidPursuit, schedule) | All 14 |

`VALIDATE_RATE_STRUCTURE` and `CHECK_TEMPLATE_STALENESS` run on every trigger.

**Scope**
- Workspaces with status in `ASSESSABLE_STATUSES` (`DRAFT, IN_REVIEW, APPROVED`) and `isArchived: false`.
- `PricingScenario` → its workspace. `BidPursuit` and `Opportunity` → that opportunity's workspaces.
- Anything else sweeps the tenant: take `MAX_WORKSPACES_PER_SWEEP` (25).

**Reads**
- `pricingScenario` (with lines and rates), `pricingWorkspace`, `pricingTemplate` (active), `amendmentImpact`, `pricingReview`
- `awardHistory`: public data, **not** firm-scoped, and the only evidence model for the benchmark (`awardBenchmark.isolation.test.ts`)
- `awardBenchmarkCohort`

**Writes**

| Write | Gated by `mayAct`? | Detail |
|---|---|---|
| `pricingScenario.update` | Yes | **Derived totals only**: `totalDirectLabor, totalFringe, totalOverhead, totalOdc, totalSubcontractor, totalGA, subtotalBeforeFee, totalFee, totalPrice, calculatedAt`. Requires the scenario to be not locked (`LOCKED_STATUSES = APPROVED, REJECTED, SUPERSEDED, ARCHIVED`) and the stored total to differ |
| `awardBenchmarkCohort.create` | **No** | `algorithmVersion 'award-benchmark-v1'`. Reused when `consultingFirmId_inputHash` exists |
| `pricingSensitivityAnalysis.create` (via `runPricingSensitivity`) | **No** | — |

Notifications:
- To the owner: type `PRICING_REVIEW`, title `Pricing outside historical range — ${title}`, dedupe `pricing-out-of-range:${workspaceId}:${inputHash}`.
- To admins: title `Indirect rate differs from template — ${title}`.

**Escalations.** `nearSubmission = 0 <= workingDays <= PRICING_RISK_WORKING_DAYS` (15).

| Title | Severity | Condition | dedupeHint |
|---|---|---|---|
| `Price outside historical range near submission — ${title}` | HIGH if `EXTREME_OUTLIER`, else MEDIUM | Near submission, range BELOW / ABOVE / EXTREME | `pricing-out-of-range:${scenarioId}:${rangeState}` |
| `Required indirect rates missing — ${title}` | MEDIUM | `INCOMPLETE_RATE_STRUCTURE` (FRINGE, OVERHEAD and GA are required when labour is active) | `pricing-incomplete-rates:${scenarioId}` |
| `Benchmark data insufficient near submission — ${title}` | LOW | Near submission, range `INSUFFICIENT_DATA` | `pricing-insufficient-benchmark:${scenarioId}` |
| `Indirect rate differs from current template — ${title}` | LOW | \|scenario% − template%\| > `RATE_DRIFT_TOLERANCE_PCT` (0.01) | `pricing-rate-drift:${scenarioId}:${sorted rateType=templatePercent}` |
| `Rate template stale near submission — ${title}` | MEDIUM | Template age ≥ `TEMPLATE_STALE_DAYS` (365) and near submission | `pricing-stale-template:${workspaceId}` |
| `Amendment may affect pricing — ${title}` | MEDIUM | `PRICING_REVIEW_REQUIRED` (an impact on PRICING / PROPOSAL_SECTION / COMPLIANCE_MATRIX recorded after the last pricing review) | `pricing-amendment-review:${workspaceId}:${evidenceCount}` |

**Benchmark and range constants**

| Constant | Value |
|---|---|
| `MIN_BENCHMARK_COHORT_SIZE` | 7 |
| `STRONG_BENCHMARK_COHORT_SIZE` | 15 (≥ 15 SUFFICIENT, 7–14 PARTIAL, < 7 INSUFFICIENT_DATA) |
| `DEFAULT_LOOKBACK_MONTHS` | 60 |
| `VALUE_BAND_LOW_RATIO` / `VALUE_BAND_HIGH_RATIO` | 0.25 / 4 |
| `NON_COMPARABLE_AWARD_TYPES` | `['IDIQ','BPA','GWAC','MATOC','SATOC','IDC']` |
| `FILTER_LADDER` | `LEVEL_1_NAICS_AGENCY_SETASIDE_BAND` → `LEVEL_2_NAICS_AGENCY_BAND` → `LEVEL_3_NAICS_BAND` → `LEVEL_4_NAICS` |
| `OUTLIER_IQR_MULTIPLIER` | 3. EXTREME is outside p25 − 3·IQR or p75 + 3·IQR. p25 and p75 count as WITHIN |
| `TEMPLATE_EXPIRING_DAYS` | 300 |

**Must NEVER**
- Change a labour rate, hours, an indirect rate, an ODC or subcontract amount, or fee.
- Select the preferred scenario.
- Approve a `PricingReview`.
- Submit pricing or change workspace status.
- Rewrite an approved scenario's totals.
- Let a private price reach the public distribution.
- Use a verdict word for a range state.
- Notify INSUFFICIENT_DATA as though the price were out of range.

Enforced by:
- `pricing/pricingAgent.integration.test.ts` › "the agent changes no human pricing input, at either autonomy level"
- `pricing/awardBenchmark.isolation.test.ts`
- `pricing/competitiveRange.test.ts`

### 4.6 Teaming Agent (`TEAMING`, §7.5)

**Configuration**
- **Cron:** `0 3 * * *`. The performance window ends at the start of the ISO week, so the performance refresh is effectively weekly.
- **Subscribed events:** `BID_DECISION_RECORDED`, `CAPABILITY_GAP_DETECTED`, `PARTNER_ADDED`, `SUBCONTRACT_MILESTONE_DUE`
- **Artifact:** `TEAMING_PLAN`, one per pursuit:
  - title `Teaming plan — ${opportunityTitle}`
  - `sourceEntityType 'BidPursuit'`, `supersedeKey teaming-plan:${pursuitId}`
  - `structuredData` includes `inputHash`

**Phases** (`TEAMING_PHASES`):

`LOAD_PURSUIT, LOAD_CAPABILITY_GAPS, LOAD_PARTNER_NETWORK, FILTER_ELIGIBLE_PARTNERS, RANK_PARTNERS, CHECK_PARTNER_PERFORMANCE, CHECK_SUBCONTRACT_GOALS, CHECK_OBLIGATION_DEADLINES, PREPARE_DRAFT_OPTIONS, BUILD_TEAMING_PLAN, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE`

The heartbeat stage is `planned n/m`.

**Event runs**

| Trigger entity (event) | Phases |
|---|---|
| `SubcontractingGoal` (SUBCONTRACT_MILESTONE_DUE) | `CHECK_SUBCONTRACT_GOALS, CHECK_OBLIGATION_DEADLINES, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE`. No pursuits are planned; goals are filtered to the triggering goal |
| `Partner` (PARTNER_ADDED) | All except `CHECK_PARTNER_PERFORMANCE, CHECK_SUBCONTRACT_GOALS, CHECK_OBLIGATION_DEADLINES` |
| Anything else | All 13 |

Only `CHECK_SUBCONTRACT_GOALS` and `CHECK_PARTNER_PERFORMANCE` are gated in code.

**Scope**
- Pursuits with `pipelineStage in TEAMABLE_STAGES` (`IDENTIFIED, QUALIFICATION, CAPTURE, PROPOSAL`).
- `BidPursuit` → that pursuit. `Opportunity` → that opportunity's pursuits.
- Anything else, including `Partner`, sweeps the tenant: take `MAX_PURSUITS_PER_SWEEP` (25).
- Goals and partner performance are always tenant-wide.
- NO_BID on `BID_DECISION_RECORDED` is excluded only implicitly, because NO_BID is not a teamable stage. The decision itself is not read.

**Reads**
- `bidPursuit`, `partner` (active), `teamingArrangement`, `agentArtifact`
- `subcontractingGoal` (`ACTIVE`, `isHumanVerified: true`), `subcontractingGoalProgress`, `contract`, `contractDeliverable`, `partnerPerformanceRecord`
- Services: `assessCapabilityGaps`, `matchPartnerToOpportunity`

**Writes**

| Write | Gated by `mayAct`? | Detail |
|---|---|---|
| `subcontractingGoalProgress.upsert` | **No** | — |
| `partnerPerformanceRecord.upsert` | **No** | Sets `derivedLabel` to `'PERFORMANCE_DECLINE_DETECTED'` or null. Never `isHumanVerified` or `humanNotes` |
| Event `SUBCONTRACT_MILESTONE_DUE` via `emitSubcontractMilestoneDue` | Yes | Own transaction. Fires when the goal is AT_RISK or MISSED, or 0 ≤ working days remaining ≤ `AT_RISK_WORKING_DAYS` (20). This is the allowed self-emission, bounded by the dedupe key `subcontract-milestone:${firm}:${goalId}:${riskState}` |

Notifications (all type `TEAMING_REMINDER`):
- `Teaming plan updated — ${n} critical gap(s)`
- `Teaming draft ready for review`
- `Subcontracting goal ${riskState}`
- `Partner performance decline — ${partnerName}`

**Drafts are never persisted.** Only metadata is kept in the plan (status `DRAFT`, `executionAllowed false`, `sendAllowed false`, `humanSendRequired`).

**LLM**
- Guard: `useLlm = isLlmProviderConfigured(firm) && budget.check(1).allowed`.
- Prompts (`teaming/teamingPrompts.ts`, pinned by `teamingPrompts.exactness.test.ts`): `TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT` and `PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT`.

| Call | Estimate / `maxTokens` | Task |
|---|---|---|
| `draftAgreement` | `ESTIMATED_DRAFT_TOKENS` 4_000 / 4000, temperature 0 | `TEAMING_AGREEMENT_DRAFT` |
| `draftOutreach` | `ESTIMATED_OUTREACH_TOKENS` 1_500 / 1500 | `TEAMING_OUTREACH` |

- Drafts are produced only when a suitable partner exists and there is at least one CRITICAL gap.
- **With no provider:** deterministic templates, with the limitation `'No LLM provider is configured, so every draft was produced from the deterministic template. The template carries the same legal-review and human-send guarantees.'`
- LLM output is forced back to DRAFT, non-executable and non-sendable, with `LEGAL_REVIEW_BANNER = 'REQUIRES LEGAL REVIEW — NOT EXECUTABLE'`.

**Escalations**

| Title | Severity | Condition | dedupeHint |
|---|---|---|---|
| `Critical capability gap near submission — ${title}` | CRITICAL if ≤ 5 working days (inline), else HIGH | Unresolved CRITICAL gap and 0 ≤ working days ≤ `CRITICAL_GAP_WORKING_DAYS` (15) | `teaming-critical-gap:${pursuitId}` |
| `No suitable partner in network — ${title}` | HIGH | Critical gaps exist and no suitable partner | `teaming-no-partner:${pursuitId}` |
| `Subcontracting goal ${riskState} — ${goalType}` | CRITICAL if MISSED, else HIGH | AT_RISK or MISSED | `teaming-goal-risk:${goalId}:${riskState}` |
| `Partner performance decline — ${partnerName}` | MEDIUM | On-time or acceptance fell ≥ `DECLINE_THRESHOLD_PCT` (20) points, and the prior period has sample ≥ `MINIMUM_SAMPLE_SIZE` (5) | `teaming-performance-decline:${partnerId}:${periodEnd YYYY-MM-DD}` |

**Goal risk** (`riskFor`, `teaming/subcontractGoals.ts`). Rules apply in order:
1. Nothing remaining → ON_TRACK
2. Overdue → MISSED
3. ≤ 20 working days and attainment ratio < `AT_RISK_ATTAINMENT_RATIO` (0.75) → AT_RISK
4. Ratio < `WATCH_ATTAINMENT_RATIO` (0.9) → WATCH
5. Otherwise ON_TRACK

Missing data gives INSUFFICIENT_DATA.

**Other constants**

| Constant | Value |
|---|---|
| `MAX_PARTNER_CANDIDATES` | 10 |
| `PERFORMANCE_WINDOW_DAYS` | 90 |
| `SUFFICIENT_SAMPLE_SIZE` | 10 |
| Workshare clamp | 10–49% (inline) |
| `NO_SUITABLE_PARTNER_MESSAGE` | `'No suitable partner was found in the current partner network.'` |

**Must NEVER**
- Execute a teaming arrangement.
- Mark an agreement SIGNED or EXECUTED.
- Create a signature or an acceptance.
- Clear legal review.
- Send outreach or contact a partner. It imports no mail or messaging client.
- Record a subjective partner judgement or overwrite a human note or verification.
- Alter a BidDecision.
- Change a verified subcontracting target.
- Call a self-declared certification verified, or claim more than `POSSIBLY_ELIGIBLE`.
- Escalate a goal a person has not verified.

Enforced by:
- `teaming/teamingAgent.integration.test.ts` › "the agent executes nothing, at either autonomy level"
- `teaming/teamingDrafts.test.ts`
- `teaming/partnerPerformance.test.ts`

### 4.7 Contract Administration Agent (`CONTRACT_ADMINISTRATION`, §7.1)

**Configuration**
- **Cron:** `0 7 * * *`
- **Subscribed events:** `CONTRACT_AWARDED`, `CONTRACT_MODIFICATION_ADDED`, `DELIVERABLE_STATUS_CHANGED`, `FUNDING_TRANSACTION_ADDED`
- **Artifact:** `CONTRACT_HEALTH`, one per contract:
  - title `Contract health — ${contractNumber}`
  - `sourceEntityType 'Contract'`, `supersedeKey contract-health:${contractId}`
  - confidence LOW if INSUFFICIENT_DATA, otherwise HIGH
- **LLM:** none. Token budget 0.

**Phases.** There is **no named phase list**. The handler:
1. `resolveContracts`
2. Loads ADMIN ids
3. Per contract, `assessContract`:
   - `Promise.all` of `assessDeliverables`, `assessBurn`, `assessOptions`, `assessModifications` and `clin.count`
   - then `assessPeriodOfPerformance`, then `worstHealth`
4. `buildEscalations`
5. Builds the artifact

The heartbeat stage is `assessed n/m`.

**Event runs.** All four events run the **same full assessment** of one contract. Nothing is skipped, and the event payload is ignored. `carryForwardSections` is not needed, because the artifact is per contract and fully recomputed.

**Scope**
- `triggerEntityType 'Contract'` → that contract, verified `isArchived: false` and `status in MONITORED_CONTRACT_STATUSES` (`['ACTIVE','ON_HOLD']`).
- Otherwise a tenant sweep: `endDate asc`, take `MAX_CONTRACTS_PER_RUN` (200).
- Empty scope → SKIPPED.

**Reads**
- `contract`, `contractDeliverable`, `contractOptionPeriod`, `contractModification` (recent `MODIFICATION_RECENT_DAYS` 90, or DRAFT / RECORDED), `clin`, `user`
- Services: `loadContractBurn` (Section 5 `computeBurn`), `reminderPolicy` (`decideLevel` and related), `computeContractAfterMod` (projection only)

**Writes**
- `contractDeliverable.update { lastReminderAt, lastEscalationAt }`. Bookkeeping only; only when reminders are sent, which requires `mayAct`.
- `notifyUser`:
  - type `MILESTONE_ESCALATION` or `MILESTONE_REMINDER`
  - title `${level} · ${deliverableName}`
  - dedupe `contract-deliverable-reminder:${entityId}:${userId}:${level}:IN_APP:${YYYY-MM-DD}`

**Reminder ladder** (`decideLevel`). `DELIVERABLE_LEAD_DAYS = [14, 7, 3]`; `DELIVERABLE_ESCALATE_AFTER_HOURS = 24`.

| Condition | Level |
|---|---|
| Overdue ≥ 24 h | ESCALATED |
| Overdue < 24 h | OVERDUE |
| Due within 24 h | URGENT |
| Due within 3 days | DUE_SOON |
| Lead-day hit ≤ 7 | UPCOMING |
| Otherwise | INFORMATIONAL |

- Only items overdue or due within `DELIVERABLE_DUE_SOON_DAYS` (14) enter the ladder.
- Recipients below ESCALATED: the owner, or the reviewer if there is no owner. At ESCALATED: owner, reviewer and firm ADMINs.

**Escalations**

| Title | Severity | Condition | dedupeHint |
|---|---|---|---|
| `Contract health could not be calculated: ${contractNumber}` | MEDIUM | The per-contract assessment threw | `contract-assessment-failed:${contractId}` |
| `Deliverable overdue: ${name}` | HIGH | Overdue and level ESCALATED (≥ 24 h) | `contract-deliverable-overdue:${deliverableId}` |
| `Funding threshold reached: ${contractNumber}` | FUNDING/CEILING_CRITICAL → CRITICAL; DEPLETION_BEFORE_END → HIGH; FUNDING/CEILING_WARNING → MEDIUM | `FUNDING_WARNING_PCT` 0.9, `FUNDING_CRITICAL_PCT` 0.98 (ceiling percentages equal these) | `contract-burn:${contractId}:${state}` (a band change re-escalates) |
| `Option decision has no owner: ${label}` | HIGH | Window OPEN or PAST and contract `ownerUserId` null. OPEN = ≤ `OPTION_WINDOW_WORKING_DAYS` (30) working days | `contract-option:${optionPeriodId}:MISSING_OWNER` |
| `Period of performance closing with open deliverables: ${contractNumber}` | CRITICAL if EXPIRED, else HIGH | PoP APPROACHING_END (≤ `POP_APPROACHING_DAYS` 60), EXPIRED or OPTION_WINDOW, with open deliverables | `contract-pop-expiring:${contractId}` |
| `Unapplied modification(s): ${contractNumber}` | MEDIUM | A modification in DRAFT or RECORDED with `appliedAt` null | `contract-unapplied-mods:${contractId}` |

Option decision dates use exerciseDeadline, then decisionDate, then startDate − `OPTION_DERIVED_LEAD_DAYS` (90). A derived date is labelled `INTERNAL_RECOMMENDATION` and is never presented as contractual.

**Must NEVER**
- Accept, reject, submit or waive a deliverable.
- Exercise, decline or mark an option.
- Apply a modification.
- Close a contract or change its dates or financial values.
- Create a funding transaction.

The allowlist test asserts `canApplyAction` is false for `deliverable.accept`, `modification.apply`, `option.exercise` and `funding.adjust`.

Enforced by `contract/contractAgent.integration.test.ts` › "human control guarantees" and by `contract/contractPolicy.unit.test.ts`.

### 4.8 Finance Agent (`FINANCE`, §7.8)

**Configuration**
- **Cron:** `0 8 * * *`. The monthly billing cycle is not a second schedule. It emerges from the billing period (the last CLOSED calendar month) combined with the existing-invoice gate, so a daily sweep bills each month exactly once.
- **Subscribed events:** `INVOICE_PAID`, `TIME_ENTRY_SUBMITTED`, `CONTRACT_COST_ADDED`. `BILLING_PERIOD_CLOSED` is deliberately absent because nothing in the codebase closes a billing period; `finance/financeAgentEvents.test.ts` asserts this ("has no subscriber for BILLING_PERIOD_CLOSED, because it does not exist").
- **Artifact:** `FINANCE_STATUS`, **one per firm**:
  - title `Finance status — ${n} contract(s)`
  - `sourceEntityType 'ConsultingFirm'`, `supersedeKey finance-status:${firmId}`
  - confidence MEDIUM if more than 3 limitations, otherwise HIGH
- **LLM:** none, enforced. Token budget 0.

**Phases** (`FINANCE_PHASES`):

`LOAD_FINANCE_CONTEXT, CHECK_TIMEKEEPING, CHECK_ADJUSTMENT_TRAILS, BUILD_DRAFT_INVOICES, AGE_RECEIVABLES, CHECK_PAYMENT_STATUS, LOAD_PROVISIONAL_RATES, LOAD_ACTUAL_RATES, COMPUTE_RATE_VARIANCE, PROJECT_CASH_FLOW, BUILD_DCAA_READINESS, BUILD_FINANCE_STATUS, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE`

The actual execution order is:
1. Resolve the event type from `agentEvent` by `ctx.eventId`
2. Scope
3. BUILD_DRAFT_INVOICES
4. AGE_RECEIVABLES
5. BUILD_DCAA_READINESS
6. COMPUTE_RATE_VARIANCE
7. PROJECT_CASH_FLOW
8. Escalations
9. Notifications
10. Status
11. `carryForwardSections`
12. Hash and artifact

Heartbeats: `billed n/m`, `receivables aged`, `readiness checked`, `cash flow projected`.

**Event runs and carry-forward.** `SECTION_PHASE = { invoices: BUILD_DRAFT_INVOICES, receivables: AGE_RECEIVABLES, timekeeping: BUILD_DCAA_READINESS, indirectRates: COMPUTE_RATE_VARIANCE, cashFlow: PROJECT_CASH_FLOW }`. All event runs also include `BUILD_FINANCE_STATUS, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE`.

| Event | Phases kept | Sections computed | Sections carried forward |
|---|---|---|---|
| `TIME_ENTRY_SUBMITTED` | LOAD_FINANCE_CONTEXT, CHECK_TIMEKEEPING, CHECK_ADJUSTMENT_TRAILS, BUILD_DCAA_READINESS | timekeeping | invoices, receivables, indirectRates, cashFlow |
| `INVOICE_PAID` | LOAD_FINANCE_CONTEXT, AGE_RECEIVABLES, CHECK_PAYMENT_STATUS, PROJECT_CASH_FLOW | receivables, cashFlow | invoices, timekeeping, indirectRates |
| `CONTRACT_COST_ADDED` | LOAD_FINANCE_CONTEXT, BUILD_DRAFT_INVOICES, PROJECT_CASH_FLOW | invoices, cashFlow | receivables, timekeeping, indirectRates |
| Schedule or manual | All | All | None |

- Every event run is scoped to **one contract**, because all three emitters use entityType `'Contract'`.
- The sweep covers contracts with status in `BILLABLE_CONTRACT_STATUSES` (`['ACTIVE','ON_HOLD','COMPLETED']`), take `MAX_CONTRACTS_PER_SWEEP` (50).

**DRAFT invoice construction** (`buildDraftInvoiceForPeriod`, `finance/invoiceBuilder.ts`):
1. **Period:** `lastClosedMonth(now)`, the previous UTC calendar month.
2. **Gate:** skip if a non-`VOIDED` invoice has exactly that `periodStart` / `periodEnd`. The state becomes `EXISTING_DRAFT_COVERS_PERIOD` or `ALREADY_INVOICED`.
3. **Eligible sources:**
   - `timeEntry` with `status 'APPROVED'` (`BILLABLE_SOURCE_STATUS`), `invoicedInvoiceId: null`, work date in the period
   - `contractCost` with the same filter on incurred date
   - Nothing eligible → `NOTHING_ELIGIBLE`
4. **Limits:** under OBSERVE → `NOT_PERMITTED_AT_THIS_AUTONOMY`. At most `MAX_INVOICES_PER_RUN` (10) per run, otherwise `RUN_LIMIT_REACHED`.
5. **One transaction:**
   - `contractInvoice.create` with `status: AGENT_INVOICE_STATUS` (`'DRAFT'`), `invoiceNumber INV-00001…`, `createdByUserId: null`, and line items (LABOR / SUBCONTRACTOR / ODC)
   - Then stamp `timeEntry.updateMany` and `contractCost.updateMany` with `{ invoicedInvoiceId }`. This is the only field the agent writes on either model.
6. **Audit:** `ctx.audit('CREATE', 'ContractInvoice', …, 'DRAFT invoice … It has not been approved or submitted.')`.

**Other writes**
- `dcaaReadinessCheck.createMany`: one row per rule, only when the fingerprint changed. Not gated by `mayAct`.
- `cashFlowProjection.create`: skipped when the `inputHash` already exists. Not gated by `mayAct`.
- Notifications (type `FINANCE_ALERT`, only when `mayAct`):
  - `${n} draft invoice(s) are ready for your review`
  - `Invoice ${n} is now ${bucket} overdue`
  - `Indirect rate variance — ${rateType} ${pct}%`
  - `Timekeeping readiness gap — ${rule.title}`

**Escalations**

| Title | Severity | Condition | dedupeHint |
|---|---|---|---|
| `Outstanding receivable is more than ${ESCALATION_OVERDUE_DAYS} days overdue — ${invoiceNumber}` | HIGH | Overdue > `ESCALATION_OVERDUE_DAYS` (90). Status SUBMITTED / PARTIALLY_PAID / OVERDUE with an outstanding balance | `receivable-overdue:${invoiceId}:${bucket}` |
| `Indirect rate variance beyond ${VARIANCE_MATERIAL_PCT}% — ${rateType}` | MEDIUM | \|variance\| ≥ `VARIANCE_MATERIAL_PCT` (15). The `VARIANCE_REVIEW_PCT` (5) band notifies only | `rate-variance:${actualId}:${prov}:${act}` |
| `Timekeeping readiness — critical gap: ${rule.title}` | HIGH | FAIL on a rule in `CRITICAL_RULE_KEYS = ['NO_FUTURE_DATED_TIME','ADJUSTMENT_REASON_RECORDED']` | `readiness-critical:${ruleKey}:${first 5 record ids}` |
| `Projected negative net cash flow over ${horizonMonths} months` | MEDIUM | `PROJECTED_NEGATIVE_NET_CASH_FLOW` and data is not insufficient | `cashflow-negative:${inputHash}` |

**Other constants**
- **Ageing buckets:** CURRENT ≤ 0, D1_30, D31_60, D61_90, D91_120, D120_PLUS.
- **Readiness** (`finance/dcaaReadiness.ts`):
  - `DCAA_RULE_VERSION 'bytescon-readiness-v1'`
  - `SUBMISSION_TIMELINESS_WORKING_DAYS` 5, `READINESS_LOOKBACK_DAYS` 45
  - Rules: DAILY_TIME_COMPLETENESS, TIMELY_SUBMISSION, ADJUSTMENT_TRAIL_EXISTS, ADJUSTMENT_REASON_RECORDED, ADJUSTMENT_ACTOR_RECORDED, DIRECT_INDIRECT_SEGREGATION (always UNSUPPORTED), NO_FUTURE_DATED_TIME
- **Cash flow** (`finance/cashFlowProjection.ts`): `DEFAULT_HORIZON_MONTHS` 6, `MIN_PAYMENTS_FOR_TIMING` 6, `MIN_PAYMENTS_FOR_BANDS` 10.

**Must NEVER**
- Approve, submit or mark an invoice PAID.
- Record or initiate a payment.
- Write off a receivable.
- Alter a submitted invoice.
- Edit, approve, backdate or delete a time entry. The only allowed `timeEntry` write sets `invoicedInvoiceId`.
- Create or delete a contract cost.
- Alter a provisional or actual indirect rate.
- Contact a customer, or submit to WAWF or IPP.
- Claim "DCAA compliant", approved or certified.
- Report a "cash position".
- Invoice on `TIME_ENTRY_SUBMITTED`.

Enforced by:
- `finance/financeAgentEvents.test.ts` › "finance is deterministic by construction"
- `finance/financeAgent.integration.test.ts` › "human finance boundary"
- The section 7 acceptance forbidden-write matrix
- `section7Runtime.audit.test.ts`, which allows exactly one creation across a full nine-agent sweep: a DRAFT invoice with `approvedByUserId` and `submittedAt` null

### 4.9 Intelligence Agent (`INTELLIGENCE`, §7.9)

**Configuration**
- **Cron:** `0 5 * * 1` (weekly, Monday 05:00)
- **Subscribed events:** `SUBMISSION_OUTCOME_RECORDED`, `CONTRACT_AWARDED` (the §7.1 emitter, reused), `CALIBRATION_UPDATED`
- **Artifact:** `PORTFOLIO_INTELLIGENCE`, one per firm:
  - title `Portfolio intelligence — ${n} confirmed outcome(s)`
  - `sourceEntityType 'ConsultingFirm'`, `supersedeKey portfolio-intelligence:${firmId}`
  - confidence HIGH if the overall segment is SUFFICIENT, otherwise LOW
- **LLM:** none, enforced. Token budget 0. The plan's one optional narrative prompt "was deliberately not taken".

**Phases** (`INTELLIGENCE_PHASES`):

`LOAD_OUTCOME_HISTORY, VALIDATE_OUTCOME_EVIDENCE, BUILD_WIN_LOSS_SEGMENTS, COMPUTE_WILSON_INTERVALS, ANALYZE_AGENCY_PERFORMANCE, ANALYZE_NAICS_PERFORMANCE, ANALYZE_VEHICLE_PERFORMANCE, ANALYZE_SET_ASIDE_PERFORMANCE, ANALYZE_VALUE_BANDS, COMPUTE_TRENDS, COMPUTE_CONCENTRATION_RISK, BUILD_PUBLIC_COMPARABLE_BENCHMARK, BUILD_CAPTURE_FOCUS, BUILD_CAPABILITY_ROADMAP, BUILD_PORTFOLIO_INTELLIGENCE, CREATE_NOTIFICATIONS, CREATE_ESCALATIONS, COMPLETE`

Outcome loading, win/loss analysis and segment persistence always run.

**Event runs and carry-forward.** `SECTION_PHASE = { trends: COMPUTE_TRENDS, concentration: COMPUTE_CONCENTRATION_RISK, comparablePublicBenchmark: BUILD_PUBLIC_COMPARABLE_BENCHMARK, captureFocus: BUILD_CAPTURE_FOCUS, capabilityRoadmap: BUILD_CAPABILITY_ROADMAP }`.

| Event | Computed | Carried forward |
|---|---|---|
| `CALIBRATION_UPDATED` | segments, trends | concentration, comparablePublicBenchmark, captureFocus, capabilityRoadmap |
| `CONTRACT_AWARDED` | segments, concentration | trends, comparablePublicBenchmark, captureFocus, capabilityRoadmap |
| `SUBMISSION_OUTCOME_RECORDED`, schedule, manual | All | None |

Scope is always tenant-wide. The trigger entity is ignored.

**Reads**
- `submissionRecord` with its opportunity, `winLossSegment`, `captureRecommendation`, `capabilityGapAssessment`, `bidPursuit`, `user`
- Public `AwardHistory` via `buildAwardBenchmark`
- `BidDecision` is **deliberately not read**: a decision is not an outcome.

**Writes**
- `winLossSegment`: in one transaction, supersede the live rows, then `createMany`. Skipped when nothing changed. Runs on every run.
- `captureRecommendation`: ACTIVE rows become `SUPERSEDED`, then new rows are created `ACTIVE`. Never re-raises a hash a human DISMISSED. Full runs only.
- Notifications (type `AGENT_ESCALATION`, only when `mayAct`):
  - `${n} evidence-backed capture recommendation(s) available`
  - `Confirmed win rate is declining across consecutive quarters`

**Escalations**

| Title | Severity | Condition | dedupeHint |
|---|---|---|---|
| `Pipeline concentration above the ${CONCENTRATION_HHI_THRESHOLD} monitoring threshold` | MEDIUM | HHI ≥ `CONCENTRATION_HHI_THRESHOLD` (0.25) | `intel-concentration:${hhi}:${dominant keys}` |
| `Confirmed win rate declining across consecutive quarters` | MEDIUM | Consecutive EMA decline over ≥ `MIN_TREND_PERIODS` (3) qualifying quarters, and overall data SUFFICIENT | `intel-decline:${last 3 periods}` |

**Constants**

| Constant | Value |
|---|---|
| `MIN_WIN_LOSS_SAMPLE_SIZE` | `MIN_BIN_SAMPLES` = 8. Below this there is no win rate and no Wilson interval |
| `ANALYSIS_LOOKBACK_MONTHS` | 36 |
| `CONFIRMED_OUTCOMES` | `['WON','LOST']` |
| `NON_CONTEST_OUTCOMES` | `['NO_AWARD','WITHDRAWN']` |
| `MAX_OUTCOMES_PER_RUN` | 2000 |
| `MAX_RECOMMENDATIONS` | 10 |
| `TREND_MULTIPLIER` | IMPROVING 1.15, DECLINING 0.85 |
| `CAPACITY_MULTIPLIER` | CONSTRAINED 0.7 |
| `MIN_RECURRENCE` (roadmap) | 2 |
| `MAX_ROADMAP_ITEMS` | 10 |
| `VALUE_BANDS` | UNDER_250K, 250K_1M, 1M_5M, 5M_25M, OVER_25M |

**Must NEVER**
- Change a BidDecision, pursuit stage or priority, match weight, qualification threshold, pricing scenario or workspace, teaming arrangement, capability record or narrative, proposal content, invoice, payment, recorded outcome or calibration.
- Treat a bid decision as an outcome.
- Report 0% in place of "no data".
- Substitute public award share for the firm's win rate.
- Invent a development cost or ROI.

Enforced by:
- `intelligence/intelligenceAgentEvents.test.ts` › "intelligence is deterministic by construction"
- `intelligence/intelligenceAgent.integration.test.ts` › "advisory only"
- The acceptance forbidden-write matrix

---

## 5. Event catalogue

Every event is emitted from a `services/agents/<agent>/<agent>Events.ts` wrapper that takes a `Prisma.TransactionClient`. The wrapper is called from the business path named below, inside that path's transaction, except where noted.

Run targeting:
- `entityType` / `entityId` become the run's `triggerEntityType` / `triggerEntityId`.
- An event with no implemented subscriber is marked PROCESSED with no runs.
- **Subscribers get a run whether or not the firm enabled them** (§9).

| Event | Emitter function (file) | Called from | entityType | dedupeKey | Subscribers |
|---|---|---|---|---|---|
| `SOURCE_SYNC_COMPLETED` | `emitSourceSyncCompleted` (`opportunity/opportunityEvents.ts`) | `services/discovery/sourceSync.ts` `runSourceSync` | `OpportunitySourceConfig` | `SOURCE_SYNC_COMPLETED:${firm}:${syncRunId}` | OPPORTUNITY |
| `FIRM_CAPABILITY_CHANGED` | `emitFirmCapabilityChanged` (`opportunity/opportunityEvents.ts`) | `routes/discovery.ts` POST `/capabilities`, PUT `/capabilities/:id`, POST `/capabilities/:id/verify`, POST `/capabilities/:id/archive` | `FirmCapability` | `…:${capabilityId}:${contentHash}` (content fingerprint) | OPPORTUNITY |
| `MONITORING_PROFILE_SAVED` | `emitMonitoringProfileSaved` (`opportunity/opportunityEvents.ts`) | `routes/monitoringProfiles.ts` POST `/`, PUT `/:id`, PATCH `/:id/active` | `SavedMonitoringProfile` | `…:${profileId}:${contentHash}` | OPPORTUNITY |
| `PURSUIT_STAGE_CHANGED` | `emitPursuitStageChanged` (`opportunity/opportunityEvents.ts`) | `routes/pursuits.ts` PATCH `/:id/stage`, PATCH `/:id` (2 sites) | `BidPursuit` | `…:${pursuitId}:${from}->${to}` | OPPORTUNITY, QUALIFICATION, COMPLIANCE |
| `OPPORTUNITY_MATCH_HIGH` | `emitOpportunityMatchHigh` (`qualification/qualificationEvents.ts`) | `services/discovery/matchRefresh.ts` `persistMatch`, only on a crossing of `HIGH_MATCH_SCORE` | `Opportunity` | `…:${opportunityId}:${overallScore}` | QUALIFICATION |
| `SOLICITATION_DOCUMENT_ADDED` | `emitSolicitationDocumentAdded` (`compliance/complianceEvents.ts`) | `routes/documents.ts` POST `/upload` | `OpportunityDocument` | `…:${documentId}` | COMPLIANCE |
| `EXTRACTION_COMPLETED` | `emitExtractionCompleted` (`compliance/complianceEvents.ts`) | `routes/requirementsIntel.ts` POST `/extraction/:opportunityId`, **and** `compliance/complianceAgentHandler.ts` (self-emission, own transaction). SUCCEEDED or PARTIAL only | `SolicitationExtractionJob` | `…:${extractionJobId}:${status}` | QUALIFICATION, COMPLIANCE, PROPOSAL |
| `AMENDMENT_RECORDED` | `emitAmendmentRecorded` (`compliance/complianceEvents.ts`) | `routes/milestones.ts` POST `/amendments/:opportunityId` | `AmendmentRevision` | `…:${revisionId}` | QUALIFICATION, COMPLIANCE, PROPOSAL, PRICING |
| `BID_DECISION_RECORDED` | `emitBidDecisionRecorded` (`teaming/teamingEvents.ts`) | `services/qualificationDecision.ts` `recordQualificationDecision` (the human decision writer) | `BidPursuit` | `bid-decision:${firm}:${pursuitId}:${decision}:${Date.now()}` | PROPOSAL, PRICING, TEAMING |
| `CAPABILITY_GAP_DETECTED` | `emitCapabilityGapDetected` (`teaming/teamingEvents.ts`) | `services/scoring/capabilityGap.ts` `assessCapabilityGaps`, only when the gap set worsened (`gapSnapshotWorsened`) | `Opportunity` | `capability-gap:${firm}:${opportunityId}:${newGaps joined '\|'}` | TEAMING |
| `PARTNER_ADDED` | `emitPartnerAdded` (`teaming/teamingEvents.ts`) | `routes/teaming.ts` POST `/partners` | `Partner` | `partner-added:${firm}:${partnerId}` | TEAMING |
| `SUBCONTRACT_MILESTONE_DUE` | `emitSubcontractMilestoneDue` (`teaming/teamingEvents.ts`) | `teaming/teamingAgentHandler.ts` (self-emission, own transaction) | `SubcontractingGoal` | `subcontract-milestone:${firm}:${goalId}:${riskState}` | TEAMING |
| `PRICING_SCENARIO_CHANGED` | `emitPricingScenarioChanged` (`pricing/pricingEvents.ts`) | `routes/pricing.ts` `recomputeScenario` (the chokepoint for all scenario mutations), only on a material fingerprint change | `PricingScenario` | `pricing-scenario:${firm}:${scenarioId}:${fingerprintHash}` | PRICING |
| `INDIRECT_RATE_CHANGED` | `emitIndirectRateChanged` (`pricing/pricingEvents.ts`) | `routes/pricing.ts` PATCH `/templates/:id` | `PricingTemplate` | `indirect-rate:${firm}:${templateId}:${rateSetHash}` | PRICING |
| `PROPOSAL_SECTION_APPROVED` | `emitProposalSectionApproved` (`proposal/proposalEvents.ts`) | `routes/proposal.ts` `transitionSection`, only when `isHumanSectionApproval(from, to)` | `ProposalSection` | `proposal-section-approved:${firm}:${sectionId}:${Date.now()}` | PROPOSAL |
| `CAPABILITY_NARRATIVE_APPROVED` | `emitCapabilityNarrativeApproved` (`proposal/proposalEvents.ts`) | `routes/proposalAgent.ts` POST `/library/versions/:id/approve` | `CapabilityNarrative` | `capability-approved:${firm}:${versionId}` | PROPOSAL |
| `CONTRACT_AWARDED` | `emitContractAwarded` (`contract/contractEvents.ts`) | `routes/contractManagement.ts` POST `/` and PUT `/:id`, when status becomes `AWARDED_CONTRACT_STATUS` (`'ACTIVE'`) | `Contract` | `CONTRACT_AWARDED:${firm}:${contractId}` | CONTRACT_ADMINISTRATION, INTELLIGENCE |
| `CONTRACT_MODIFICATION_ADDED` | `emitContractModificationAdded` (`contract/contractEvents.ts`) | `routes/contractManagement.ts` POST `/:id/modifications` (`CREATED`), POST `/modifications/:modId/apply` (`APPLIED`) | `Contract` | `…:${modificationId}:${stage}` | CONTRACT_ADMINISTRATION |
| `DELIVERABLE_STATUS_CHANGED` | `emitDeliverableStatusChanged` (`contract/contractEvents.ts`) | `routes/contractManagement.ts` POST `/deliverables/:delId/{transition,submit,accept,reject}` | `Contract` | `…:${deliverableId}:${from}->${to}` | CONTRACT_ADMINISTRATION |
| `FUNDING_TRANSACTION_ADDED` | `emitFundingTransactionAdded` (`contract/contractEvents.ts`) | `routes/contractFinance.ts` POST `/:contractId/funding` | `Contract` | `…:${fundingTransactionId}` | CONTRACT_ADMINISTRATION |
| `INVOICE_PAID` | `emitInvoicePaid` (`finance/financeEvents.ts`) | `routes/contractFinance.ts` POST `/invoices/:id/payments`, only when `isInvoiceNowPaid` | `Contract` | `INVOICE_PAID:${firm}:${invoiceId}` | FINANCE |
| `TIME_ENTRY_SUBMITTED` | `emitTimeEntrySubmitted` (`finance/financeEvents.ts`) | `routes/contractFinance.ts` POST `/time/:id/submit` | `Contract` | `TIME_ENTRY_SUBMITTED:${firm}:${timeEntryId}:${Date.now()}` | FINANCE |
| `CONTRACT_COST_ADDED` | `emitContractCostAdded` (`finance/financeEvents.ts`) | `routes/contractFinance.ts` POST `/:contractId/costs` (creation only) | `Contract` | `CONTRACT_COST_ADDED:${firm}:${contractCostId}` | FINANCE |
| `SUBMISSION_OUTCOME_RECORDED` | `emitSubmissionOutcomeRecorded` (`intelligence/intelligenceEvents.ts`) | `routes/submissions.ts` PATCH `/:id/outcome`, only on a real outcome change (`isOutcomeChange`) | `SubmissionRecord` | `…:${submissionRecordId}:${toOutcome}` | INTELLIGENCE |
| `CALIBRATION_UPDATED` | `emitCalibrationUpdated` (`intelligence/intelligenceEvents.ts`) | `services/scoring/tenantCalibration.ts` `activateCalibration`, `rollbackCalibration` | `TenantCalibration` | `…:${calibrationId}:${reason}` | INTELLIGENCE |
| `RUNTIME_DIAGNOSTIC_PING` | none (test only) | — | — | — | INTERNAL_DIAGNOSTIC |

Notes on the catalogue:
- `…` means the prefix is `${EVENT_TYPE}:${consultingFirmId}`.
- `intelligence/intelligenceEvents.ts` re-declares `export const CONTRACT_AWARDED`, but it defines no emitter. `contract/contractEvents.ts` is the single emitter.
- **Self-emissions.** Exactly two exist. Both are allowlisted in `SELF_EMIT_ALLOWED` and bounded:
  - **COMPLIANCE → `EXTRACTION_COMPLETED`.** Bounded by content-idempotent extraction and by `RUN_EXTRACTION` being excluded on EXTRACTION_COMPLETED runs. The chain settles with three runs: COMPLIANCE, PROPOSAL and QUALIFICATION.
  - **TEAMING → `SUBCONTRACT_MILESTONE_DUE`.** Bounded by the timestamp-free key `goal:riskState`.

---

## 6. Invariants and the tests that enforce them

Test file abbreviations:
- **ACC** = `services/agents/section7Acceptance.audit.test.ts`
- **RT** = `services/agents/section7Runtime.audit.test.ts`
- **UNIT** = `services/agents/agentRuntime.unit.test.ts`
- **AUTH** = `routes/section7Authorization.audit.test.ts`

### Registry and structure

| # | Invariant | Enforced by |
|---|---|---|
| 1 | Exactly nine domain agents plus one internal diagnostic; no tenth | ACC "declares the nine expected domain agents and no others", "adds no tenth agent…" |
| 2 | Every domain agent is implemented with its own distinct handler | ACC "%s is implemented with a real, distinct handler", "gives every agent its own handler — no shared placeholder" |
| 3 | Every agent defaults to disabled and to `PROPOSE` | ACC "defaults every agent to disabled and to the least autonomous level"; UNIT "defaults every agent to PROPOSE autonomy", "ships every domain agent disabled by default" |
| 4 | **Allowlists are empty** for all nine; only `diagnostic.noop` exists | ACC "grants no domain agent an allowlisted action"; UNIT "registers no domain actions in the foundation slice, so ACT permits nothing for the nine" |
| 5 | Every agent declares MANUAL, SCHEDULE, EVENT and RETRY | ACC "supports the four runtime triggers on every agent" |
| 6 | No agent `requiresLlm`; each has `noLlmBehaviour` | ACC "declares no agent as requiring an LLM" |
| 7 | Non-zero token budget only for COMPLIANCE, PROPOSAL, TEAMING and INTERNAL_DIAGNOSTIC | ACC "gives a non-zero token budget only to agents that actually call a provider", "gives a token budget to exactly the agents that can consume one" |
| 8 | One artifact family per agent, never shared | ACC "artifact inventory" block |
| 9 | Exactly one queue, one Worker, one scheduler and one reaper; no per-agent infrastructure; no BullMQ import in agent dirs; exactly two repeatables (tick, reaper) | ACC "exactly one Section 7 runtime" block |
| 10 | Section 6 source sync is the only provider fetcher; no agent schedules its own sync | ACC "leaves the Section 6 source-sync job as the single owner of provider fetching" |

### Event graph

| # | Invariant | Enforced by |
|---|---|---|
| 11 | Every emitted event has exactly one emitter site and at least one subscriber; every subscribed event is emitted (except `RUNTIME_DIAGNOSTIC_PING`) | ACC "event graph" block |
| 12 | Events are emitted only from `services/agents/<agent>/*Events.ts`, never from a route or component | ACC "emits every event from an agent events module…" |
| 13 | Every emitter takes a transaction client; every emit and dedupe key is tenant-scoped | ACC "passes a transaction client to every emitter…", "scopes every event to a tenant" |
| 14 | No handler emits an event its own agent subscribes to, except the two allowlisted self-emissions | ACC "never lets an agent HANDLER emit an event that agent subscribes to" |
| 15 | Self-emitted events have no `Date.now()` in their dedupe key | ACC "keys every self-emitted event stably…" |
| 16 | Event chains terminate; one award fans out to exactly CONTRACT_ADMINISTRATION and INTELLIGENCE | RT "event chains are bounded" block |

### Outbox and lifecycle

| # | Invariant | Enforced by |
|---|---|---|
| 17 | Rollback emits nothing; a duplicate never aborts the business write; reprocessing creates no second run; one firm's event never makes another firm's run | RT "transactional outbox" block |
| 18 | A failing event goes back to PENDING with backoff, dead-letters after its attempt budget, is never PROCESSED after a failed fan-out, and recovers later | `services/agents/outboxFailure.test.ts` |
| 19 | Terminal run states are immutable; transitions follow the table | UNIT "run state machine" |
| 20 | A disabled schedule creates no run; repeat ticks do not storm; `nextRunAt` advances; a cancelled run stops before work; no run is left non-terminal after a sweep | RT "scheduler and run lifecycle"; UNIT "schedule computation", "idempotency keys" |

### Budget and autonomy

| # | Invariant | Enforced by |
|---|---|---|
| 21 | The budget guard blocks **before** the provider is invoked; run, schedule and plan ceilings are all enforced | UNIT "budget guard" ("BLOCKS an over-budget call BEFORE the provider is invoked", etc.) |
| 22 | Every agent runs with zero provider calls when none is configured | RT "%s spends nothing when no provider is configured", "makes zero provider calls across a full nine-agent sweep" |
| 23 | Below `ACT_WITH_GUARDRAILS` nothing applies; a non-allowlisted action never applies; a falsely claimed applied action is downgraded | UNIT "autonomy policy" |

### Human control

| # | Invariant | Enforced by |
|---|---|---|
| 24 | **No agent writes `bidDecision`**, or any model in its forbidden-write list (ERP, personnel, portal, SSO, integration and signature models) | ACC "human-control forbidden-write matrix" (`FORBIDDEN_WRITES`) |
| 25 | No agent creates or deletes `contractCost` | ACC "never lets an agent create or delete a contract cost" |
| 26 | No agent writes `status: 'APPROVED' \| 'SUBMITTED' \| 'PAID' \| 'EXECUTED' \| 'SIGNED' \| 'ACCEPTED' \| 'VERIFIED' \| 'CONFIRMED'` in a Prisma write | ACC "never lets an agent write an APPROVED, SUBMITTED or PAID status" |
| 27 | No agent sets a human approver or signer field to non-null | ACC "never lets an agent set a human approver or signer field" |
| 28 | A full nine-agent sweep at PROPOSE and at ACT_WITH_GUARDRAILS creates no human decision record. The only allowed creation is a DRAFT invoice. No pursuit stage or priority changes | RT "human-control master matrix" |
| 29 | Agent audit events never carry a human actor (`actorUserId` null) | RT "never attributes an agent action to a human actor" |
| 30 | No network call, email or external message from agent dirs | ACC "never reaches an external network…", "never sends an email…" |

### LLM and prompts

| # | Invariant | Enforced by |
|---|---|---|
| 31 | Only TEAMING and PROPOSAL reach `llm/llmRouter`; they check provider availability first; only they define prompts (5 constants: Teaming 2, Proposal 3), each with an exactness test; Proposal never imports the §5 prompt of the same name | ACC "LLM capability matrix", "system prompt inventory" |

### Code hygiene

| # | Invariant | Enforced by |
|---|---|---|
| 32 | **No `TODO`, `FIXME`, `XXX` or `HACK`** and no "not implemented" throws in agent dirs (`*Prompts.ts` excluded); no `console.*`; no hard-coded UUID or `S7-*-QA` id; no credentials; no `process.env` | ACC "no shipping placeholders or leaked secrets" block |
| 33 | Money agents (CONTRACT_ADMINISTRATION, PRICING, TEAMING, FINANCE, INTELLIGENCE) never `parseFloat` money and never `Math.round` an amount | ACC "Decimal discipline" block |
| 34 | Every agent can report insufficient data; never a bare `?? 0` for a rate, probability, score, percentile or confidence | ACC "insufficient data is stated, never defaulted" |

### Isolation, artifacts and API

| # | Invariant | Enforced by |
|---|---|---|
| 35 | Cross-tenant isolation for runs, artifacts, escalations and notifications; an agent refuses another firm's entity | RT "cross-tenant isolation across the whole layer"; per-agent "tenant isolation" tests |
| 36 | A repeated unchanged sweep creates no new notification or escalation and leaves exactly one live artifact per subject | RT "repeated sweeps do not spam" |
| 37 | `carryForwardSections` copies only the requested sections from the live artifact | `artifacts.unit.test.ts` |
| 38 | Notification defaults: failures and escalations on, successes off, min severity respected, idempotent, never throws, never cross-firm | `agentNotifications.test.ts`; UNIT "notification preference gating" |
| 39 | Anonymous callers are rejected; CONSULTANT reads but cannot write; no IDOR; schedules are per firm | AUTH |

---

## 7. Known gaps

### 7.1 Verified against code

1. ✅ **Fixed 2026-11-04 (B6, [doc 21](../21-agents-opt-in.md)).** Was: **event runs ignore the firm's opt-in.** This contradicted the landing page: `frontend/src/components/landing/Agents.tsx` says "Every agent is opt-in", and `Hero.tsx` says "9 … opt-in agents".
   - `outbox.ts` `processOutbox` creates an EVENT run for every agent returned by `agentsSubscribedTo(eventType)`, which filters only on `implemented && handler`.
   - `dispatch.ts` checks `schedule.isEnabled` only when `run.triggerType === 'SCHEDULE'`.
   - Result: a firm that never enabled an agent still gets its EVENT runs, with their artifacts, escalations, notifications and writes. RT "fans one award out to exactly its two subscribers and stops" runs with no schedule rows at all, which confirms this.
   - For PROPOSAL and TEAMING this also means LLM spend when a provider is configured. That contradicts "use a model only when you enable it".
2. ✅ **Fixed 2026-11-04 (B6).** Was: **event runs ignore the firm's schedule settings.**
   - EVENT runs use registry defaults (`PROPOSE` autonomy, `defaultMaxAttempts`, `maxRuntimeMs`) and carry no `scheduleId`.
   - A firm that set an agent to `OBSERVE` still gets `PROPOSE` behaviour on event runs.
   - The per-tenant schedule token budget is neither checked nor accrued for them; only the run and plan ceilings apply.
3. **Escalations are persisted under OBSERVE.**
   - The safe-action header says OBSERVE is "compute, persist artifacts, notify", and that escalations start at PROPOSE.
   - Neither dispatch nor any handler filters escalations by autonomy. Qualification asserts this deliberately.
   - Several handlers also make derived writes under OBSERVE: Pricing (cohort, sensitivity), Teaming (goal progress, performance), Finance (readiness, cash flow), Intelligence (segments, recommendations).
4. ✅ **Fixed 2026-11-04 (B10):** keys use the row's version before the change. Was: **duplicate-producing dedupe keys.** `BID_DECISION_RECORDED`, `PROPOSAL_SECTION_APPROVED` and `TIME_ENTRY_SUBMITTED` include `Date.now()`, so a retried request emits a second event and fans out new runs. The comment on `TIME_ENTRY_SUBMITTED` says "Keyed on the entry".
5. ✅ **Fixed 2026-11-04 (B11):** `triggerEntities.ts`. Was: **entity-type mismatch.** EXTRACTION_COMPLETED and AMENDMENT_RECORDED carry `'SolicitationExtractionJob'` and `'AmendmentRevision'`, but:
   - PROPOSAL matches `'ExtractionJob'` and `'Amendment'`.
   - PRICING matches `'Amendment'`, and uses an `amendment.findUnique` with no firm filter.
   - Both events therefore fall through to tenant-wide sweeps, and Pricing's amendment phase subset is dead code.
6. **`BID_DECISION_RECORDED` decision is not read** by PROPOSAL, PRICING or TEAMING. A NO_BID can trigger drafting on an ACTIVE proposal. Teaming excludes NO_BID only through the stage filter, and no test covers NO_BID.
7. **Event runs supersede firm-wide artifacts with partial data.**
   - Only FINANCE and INTELLIGENCE use `carryForwardSections`.
   - OPPORTUNITY's event runs replace the firm brief with a partial one.
   - FINANCE computes some sections for one contract but files them under the firm-wide subject. The result mixes firm-wide carried sections with single-contract computed ones, and the cash-flow projection likewise.
   - PRICING `PricingTemplate` runs skip the cohort and can raise a false `Benchmark data insufficient near submission` escalation.
8. **Subject mismatch between agents.** QUALIFICATION reads the newest live `COMPLIANCE_STATUS` of *any* subject. COMPLIANCE event runs file per Opportunity or entity, so the firm-wide sweep can be shadowed.
9. **`recordScheduleOutcome` is never called.**
   - `lastSuccessfulRunAt` is never set.
   - Failed runs never increment `consecutiveFailures`. The `MAX_CONSECUTIVE_FAILURES` (10) backoff reacts only to scheduler-side errors.
10. **`WAITING_FOR_REVIEW` has no exit except cancel.** No route completes it, and the reaper does not scan it. Only the internal diagnostic produces it.
11. **`RETRY` trigger is never used.** `backoffMs` in the registry is never read.
12. **Unenforced or unused fields:** `costBudgetUsd`, `handlerVersion`, `emailEnabled`, `digestMode`, `AgentNotificationPreference.timezone`, `AgentEventStatus.FAILED`.
13. **Supersede ignores `supersedeKey`'s value.** Matching is by `(agentKey, artifactType, sourceEntityType, sourceEntityId)`. Once a human verifies an artifact, every later run leaves both the verified and the new artifact live.
14. **Decorative phase lists.**
    - QUALIFICATION and CONTRACT_ADMINISTRATION do not gate on phases, and Contract Administration has no phase list at all.
    - In other agents many phases are labels only: Opportunity `PROCESS_CHANGED_OPPORTUNITIES`; Finance and Intelligence `CHECK_*`, `LOAD_*`, `ANALYZE_*`; Proposal `COMPUTE_ADHERENCE` (stub), `LOAD_LM_MAPPINGS` and `RUN_PRE_SUBMISSION_VALIDATION`.
    - Compliance `CREATE_NOTIFICATIONS` sends nothing.
    - Proposal never calls `adaptPastPerformance`.
15. **Comments that reference missing files.** These files do not exist:
    - `section7EventLoop.audit.test.ts`, named in an ACC comment. The bounded-chain tests live in RT.
    - `finance.noLlm.test.ts`, named in the Finance handler header.
    - `pricing.noLlm.test.ts`, named in the Pricing handler header.
16. **Compliance's 100_000-token budget is effectively unused.** `runExtraction` is not given `ctx.budget`.
17. **Pricing writes a new `AwardBenchmarkCohort` row per scenario per day.** The cache hash includes today's date.
18. **Several thresholds are inline literals.** This contradicts the policy-file headers' claim that "EVERY threshold … lives here":
    - Opportunity: ≤ 2 working days → CRITICAL
    - Compliance: SAM ≤ 7 days → HIGH; amendment ≤ 2 working days → CRITICAL
    - Teaming: ≤ 5 working days → CRITICAL; workshare clamp 10/49
    - Intelligence: concentration MODERATE band 0.15

### 7.2 Inferred (not run)

19. **(inferred)** A schedule or manual run with `maxAttempts > 3` can stay QUEUED after BullMQ's 3 job attempts are spent. The `tick` job only re-enqueues EVENT runs, and only in a pass that created runs.
20. **(inferred)** `tick` re-enqueues up to 100 QUEUED EVENT runs **globally** whenever the outbox created any run. Most are deduplicated by the BullMQ jobId `run:${runId}` while the job is retained.
21. **(inferred)** Proposal may draft each section twice before its fingerprint stabilises, because the fingerprint includes `hasExistingDraft`.
22. **(inferred)** Teaming regenerates its LLM drafts on every run with no fingerprint, then discards the bodies.

---

## 8. Checklist: how to add or change an agent

### Adding an agent

1. **Enum and artifact type.** Add the `AgentKey` and a new `AgentArtifactType` in `schema.prisma`, with a migration. One artifact family per agent; never share one.
2. **Registry entry** in `registry.ts`, spread from `base`:
   - `implemented`, `plannedSlice`
   - `defaultEnabled: false`, `defaultAutonomyLevel: 'PROPOSE'`
   - `defaultCronExpression`, `maxRuntimeMs`
   - `defaultTokenBudget` (0 unless the agent's own directory calls the router)
   - `subscribedEventTypes`
   - `allowlistedActionKeys: []`
   - `requiresLlm: false` plus an honest `noLlmBehaviour`
3. **Update the acceptance audit.** Add the key to `DOMAIN_AGENT_KEYS` (types.ts) and update `section7Acceptance.audit.test.ts`: `EXPECTED_DOMAIN_AGENTS`, `EXPECTED_ARTIFACTS`, `AGENT_DIRS`, `FORBIDDEN_WRITES`, and `LLM_CAPABLE` / `LLM_DELEGATED` if relevant. The registry-length test will fail until you do.
4. **Directory.** Create `services/agents/<dir>/` containing:
   - `<dir>AgentHandler.ts`
   - `policy.ts` with every threshold as a named exported constant (do not add inline literals)
   - `<dir>Events.ts` (the name must match `/\w+Events\.ts$/`)
   - tests
5. **Handler contract.** The handler returns `AgentHandlerResult`. It must:
   - Never touch BullMQ.
   - Check `ctx.signal` in loops.
   - Call `ctx.heartbeat` often enough that `2 × timeoutMs` is never exceeded.
   - Return `limitations` and `INSUFFICIENT_DATA` instead of default zeros.
   - Set artifact `sourceEntityType` / `sourceEntityId` to the subject (supersede matches on these) and a `supersedeKey`.
   - Give each escalation an entity-stable `dedupeHint`. Do not include counts, floats or dates unless a change should raise a new item.
6. **Scope.** A targeted run that cannot resolve its target must return SKIPPED, never fall back to a tenant sweep.
7. **Event runs that skip phases but share a subject with the full sweep** must call `carryForwardSections` before hashing, and add the carried-forward limitation (§3.12).
8. **Autonomy.** Gate notifications and business writes with `mayAct = ctx.autonomyLevel !== 'OBSERVE'`. Anything autonomous must be a key in **both** `allowlistedActionKeys` and `SAFE_ACTION_REGISTRY` (with a `reversibilityNote`) and checked with `ctx.canApply`. Today both lists are empty for domain agents, and ACC asserts that; changing it is a policy decision, not a code tweak.

### Adding or changing an event

1. Define the event constant and an `emit*` wrapper in `<dir>Events.ts`. The wrapper:
   - takes `tx: Prisma.TransactionClient`
   - includes `consultingFirmId` in both the event and the `dedupeKey`
   - uses a stable dedupe key (no `Date.now()` unless a repeat genuinely is a new fact)
   - sets `entityType` to the **exact** string handlers will match. Grep the handlers of every subscriber; this is how gap 5 in §7 happened.
2. Call the wrapper inside the business write's transaction at the single canonical chokepoint. There must be exactly one emitter site per event.
3. Add the event to each subscriber's `subscribedEventTypes`. A handler must not emit an event its own agent subscribes to unless you add it to `SELF_EMIT_ALLOWED` and prove termination in RT "event chains are bounded".
4. Remember (§7, gap 1) that subscribing currently means **every firm** gets a run, enabled or not. Make the handler safe for that, or fix the gap first.

### LLM use

- Allowed only in agents listed in `LLM_CAPABLE`.
- Call `isLlmProviderConfigured` and `ctx.budget.check` first. Call only `ctx.budget.generate`, never `generateWithRouter` directly.
- Prompt constants (`*_SYSTEM_PROMPT`) go in a `*Prompts.ts` file with a sibling `*.exactness.test.ts`. Update the prompt-count assertion in ACC.
- Provide a deterministic fallback, and label AI output as a draft requiring human review.

### Human control

- Add every model that represents a human decision to `FORBIDDEN_WRITES` for your agent.
- Never write `APPROVED`, `SUBMITTED`, `PAID`, `EXECUTED`, `SIGNED`, `ACCEPTED`, `VERIFIED` or `CONFIRMED` statuses.
- Never set `*ByUserId` approver fields.
- Never `parseFloat` or `Math.round` money; use Decimal.
- Never read `process.env`.
- Never use `console.*`, and never leave `TODO` or `FIXME`.

### Before merging

- Run the agent's tests plus `section7Acceptance.audit.test.ts`, `section7Runtime.audit.test.ts`, `agentRuntime.unit.test.ts`, `artifacts.unit.test.ts`, `outboxFailure.test.ts`, `agentNotifications.test.ts` and `routes/section7Authorization.audit.test.ts`.
- Update §4 and §5 of this document.
