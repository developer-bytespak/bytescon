// =============================================================
// §7.0 — Agent runtime Prometheus metrics.
//
// Registered on the EXISTING registry from config/observability.ts — no second
// registry, no second /metrics endpoint.
//
// CARDINALITY RULE: labels are bounded sets only. agentKey has 10 possible
// values, status has 8, kind has 3. Tenant IDs and run IDs are NEVER labels —
// they would grow without bound and take the metrics endpoint down with them.
// =============================================================
import { Counter, Histogram, Gauge } from 'prom-client'
import { registry } from '../../config/observability'

export const agentRunsStarted = new Counter({
  name: 'bytescon_agent_runs_started_total',
  help: 'Agent runs that entered RUNNING',
  labelNames: ['agent', 'trigger'],
  registers: [registry],
})

export const agentRunsFinished = new Counter({
  name: 'bytescon_agent_runs_finished_total',
  help: 'Agent runs that reached a terminal status',
  labelNames: ['agent', 'status'],
  registers: [registry],
})

export const agentRunDuration = new Histogram({
  name: 'bytescon_agent_run_duration_seconds',
  help: 'Wall-clock duration of an agent run',
  labelNames: ['agent', 'status'],
  buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600],
  registers: [registry],
})

export const agentRunsActive = new Gauge({
  name: 'bytescon_agent_runs_active',
  help: 'Agent runs currently in RUNNING',
  labelNames: ['agent'],
  registers: [registry],
})

export const agentEscalationsCreated = new Counter({
  name: 'bytescon_agent_escalations_created_total',
  help: 'Agent escalations created (refreshes of an existing escalation are not counted)',
  labelNames: ['agent', 'severity'],
  registers: [registry],
})

export const agentTokensConsumed = new Counter({
  name: 'bytescon_agent_tokens_total',
  help: 'LLM tokens consumed by agent runs',
  labelNames: ['agent', 'direction'],
  registers: [registry],
})

export const agentEstimatedCost = new Counter({
  name: 'bytescon_agent_estimated_cost_usd_total',
  help: 'Estimated USD cost of LLM usage by agent runs',
  labelNames: ['agent'],
  registers: [registry],
})

export const agentBudgetBlocks = new Counter({
  name: 'bytescon_agent_budget_blocks_total',
  help: 'LLM calls refused by the agent budget guard before reaching a provider',
  labelNames: ['agent', 'scope'],
  registers: [registry],
})

export const agentEventsProcessed = new Counter({
  name: 'bytescon_agent_events_processed_total',
  help: 'Transactional-outbox events transitioned to a terminal status',
  labelNames: ['status'],
  registers: [registry],
})

export const agentStaleRunsReaped = new Counter({
  name: 'bytescon_agent_stale_runs_reaped_total',
  help: 'Runs force-terminated by the reaper after losing their heartbeat',
  labelNames: ['agent'],
  registers: [registry],
})
