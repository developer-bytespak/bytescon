// =============================================================
// §7.0 — Shared agent contract.
//
// Every one of the nine agents will be a plain async function of this shape.
// Handlers never touch BullMQ, never register a cron, never open a queue — the
// shared dispatcher owns all of that. That is the whole point of this slice:
// one runtime, nine handlers, not nine frameworks.
//
// Handlers are NOT required to use an LLM. Deterministic handlers are
// first-class and must stay that way — several planned agents (Pricing,
// Finance, Contract Administration) must remain fully auditable.
// =============================================================
import type {
  AgentKey,
  AgentTriggerType,
  AgentRunStatus,
  AgentAutonomyLevel,
  AgentConfidenceState,
  AgentDataSufficiency,
  AgentArtifactType,
  AgentEscalationSeverity,
} from '@prisma/client'
import type { LLMTask } from '../llm/llmRouter'
import type { LLMRequest, LLMResponse } from '../llm/provider.interface'

export type {
  AgentKey,
  AgentTriggerType,
  AgentRunStatus,
  AgentAutonomyLevel,
  AgentConfidenceState,
  AgentDataSufficiency,
  AgentArtifactType,
  AgentEscalationSeverity,
}

/** The nine product agents, in the proposal's order. INTERNAL_DIAGNOSTIC is excluded. */
export const DOMAIN_AGENT_KEYS: AgentKey[] = [
  'OPPORTUNITY',
  'QUALIFICATION',
  'COMPLIANCE',
  'PROPOSAL',
  'PRICING',
  'TEAMING',
  'CONTRACT_ADMINISTRATION',
  'FINANCE',
  'INTELLIGENCE',
]

/**
 * Reserved key used only to exercise the shared runtime end-to-end. It is
 * filtered out of every product-facing API response so an operator never sees
 * a fake agent in the UI.
 */
export const INTERNAL_AGENT_KEY: AgentKey = 'INTERNAL_DIAGNOSTIC'

/** Autonomy default for every agent. Never raise this implicitly. */
export const DEFAULT_AUTONOMY_LEVEL: AgentAutonomyLevel = 'PROPOSE'

// -------------------------------------------------------------
// Evidence and source attribution
// -------------------------------------------------------------

/**
 * Per-claim attribution. An agent that cannot attribute a claim must say so
 * rather than assert it — this mirrors the §6 honesty rules already shipped
 * (OpportunityMatch.evidence, ClauseObligation.evidenceText, scoreExplanation).
 */
export interface EvidenceRef {
  sourceType: string
  sourceId: string | null
  sourceLocator?: string | null
  retrievedAt: string
  note?: string
}

// -------------------------------------------------------------
// Handler output
// -------------------------------------------------------------

export interface ProposedArtifact {
  artifactType: AgentArtifactType
  title: string
  summary?: string
  structuredData: Record<string, unknown>
  evidence?: EvidenceRef[]
  sourceEntityType?: string | null
  sourceEntityId?: string | null
  confidenceState?: AgentConfidenceState
  /**
   * Stable identity of the *subject* this artifact describes. When a later run
   * produces a newer artifact with the same key, the previous one is superseded
   * rather than overwritten — never mutated once human-verified.
   */
  supersedeKey?: string
}

export interface ProposedEscalation {
  severity: AgentEscalationSeverity
  title: string
  reason: string
  recommendedAction?: string
  entityType?: string | null
  entityId?: string | null
  assignedToUserId?: string | null
  dueAt?: Date | null
  /** Appended to the runtime-generated dedupe key; keep it entity-stable. */
  dedupeHint: string
}

/**
 * An action the agent believes should happen. Under OBSERVE/PROPOSE these are
 * recorded for a human; under ACT_WITH_GUARDRAILS only explicitly allowlisted
 * action keys may execute (see safeActions.ts).
 */
export interface ProposedAction {
  actionKey: string
  description: string
  entityType?: string | null
  entityId?: string | null
  payload?: Record<string, unknown>
}

export interface AppliedAction extends ProposedAction {
  appliedAt: string
}

/** Terminal outcomes a handler may report. Never QUEUED/RUNNING. */
export type AgentHandlerStatus = Extract<
  AgentRunStatus,
  'COMPLETED' | 'FAILED' | 'WAITING_FOR_REVIEW' | 'SKIPPED'
>

export interface AgentHandlerResult {
  status: AgentHandlerStatus
  summary: string
  confidence: AgentConfidenceState
  dataSufficiency: AgentDataSufficiency
  evidence?: EvidenceRef[]
  artifacts?: ProposedArtifact[]
  proposedActions?: ProposedAction[]
  appliedActions?: AppliedAction[]
  escalations?: ProposedEscalation[]
  /** Free-form counters surfaced in the run detail UI (e.g. {scanned: 12}). */
  metrics?: Record<string, number>
  warnings?: string[]
  /** Honest statements of what the run could NOT determine. */
  limitations?: string[]
  /** Snapshot of what the handler read, for reproducibility + skip-if-unchanged. */
  inputSnapshot?: Record<string, unknown>
  inputHash?: string
  errorCode?: string
  errorMessage?: string
}

// -------------------------------------------------------------
// Budget
// -------------------------------------------------------------

export type BudgetDecision =
  | { allowed: true; remainingTokens: number | null; remainingCostUsd: number | null }
  | { allowed: false; reason: string; scope: 'RUN' | 'SCHEDULE' | 'TENANT_PLAN' }

export interface AgentBudgetGuard {
  /** Non-mutating check. Call before doing expensive work. */
  check(estimatedTokens: number): Promise<BudgetDecision>
  /**
   * Budget-guarded LLM call. Checks budget FIRST and never reaches the provider
   * when exhausted — that ordering is the whole control and is covered by test.
   */
  generate(req: LLMRequest, opts: { task: LLMTask; useCache?: boolean; estimatedTokens?: number }): Promise<LLMResponse>
  /** Tokens/cost consumed by this run so far. */
  consumed(): { tokenInput: number; tokenOutput: number; estimatedCostUsd: number }
}

/** Thrown by the budget guard instead of invoking a provider. */
export class AgentBudgetExhaustedError extends Error {
  readonly code = 'AGENT_BUDGET_EXHAUSTED'
  constructor(
    message: string,
    readonly scope: 'RUN' | 'SCHEDULE' | 'TENANT_PLAN',
  ) {
    super(message)
    this.name = 'AgentBudgetExhaustedError'
  }
}

// -------------------------------------------------------------
// Execution context
// -------------------------------------------------------------

export interface AgentExecutionContext {
  readonly agentKey: AgentKey
  readonly consultingFirmId: string
  readonly runId: string
  readonly trigger: AgentTriggerType
  readonly triggerEntityType: string | null
  readonly triggerEntityId: string | null
  readonly idempotencyKey: string
  readonly autonomyLevel: AgentAutonomyLevel
  readonly initiatedByUserId: string | null
  readonly scheduleId: string | null
  readonly eventId: string | null
  readonly attempt: number
  readonly deadlineAt: Date

  /** Aborted on cancellation request or timeout. Long loops must check it. */
  readonly signal: AbortSignal

  /** Structured logger pre-bound with runId/agentKey/firmId. Never logs PII. */
  log(message: string, meta?: Record<string, unknown>): void

  /** Persist progress + refresh the heartbeat so the reaper leaves the run alone. */
  heartbeat(progressPercent: number, stage?: string): Promise<void>

  readonly budget: AgentBudgetGuard

  /** Writes an AuditEvent scoped to this run. System runs use actorUserId null. */
  audit(action: string, entityType: string, entityId: string | null, rationale?: string): Promise<void>

  /**
   * True only when the level permits executing this specific allowlisted action.
   * Handlers must call this before any mutation; the dispatcher also enforces it.
   */
  canApply(actionKey: string): boolean
}

// -------------------------------------------------------------
// Handler + registry entry
// -------------------------------------------------------------

export type AgentHandler = (ctx: AgentExecutionContext) => Promise<AgentHandlerResult>

export interface AgentDefinition {
  key: AgentKey
  name: string
  description: string
  /**
   * FALSE until the agent's own implementation slice lands. The runtime refuses
   * to dispatch an unimplemented agent and the UI shows NOT IMPLEMENTED — never
   * a fake healthy state.
   */
  implemented: boolean
  /** Section 7 slice that will deliver (or delivered) this agent. */
  plannedSlice: string
  defaultEnabled: boolean
  supportedTriggers: AgentTriggerType[]
  /** Only meaningful once implemented. */
  defaultCronExpression: string | null
  defaultAutonomyLevel: AgentAutonomyLevel
  requiresLlm: boolean
  /** Behaviour when no LLM provider is configured. Documented per plan §3.14. */
  noLlmBehaviour: string
  maxRuntimeMs: number
  defaultMaxAttempts: number
  backoffMs: number
  defaultTokenBudget: number | null
  supportedArtifactTypes: AgentArtifactType[]
  /** Event types this agent subscribes to via the transactional outbox. */
  subscribedEventTypes: string[]
  /** Action keys this agent may ever execute under ACT_WITH_GUARDRAILS. */
  allowlistedActionKeys: string[]
  handler: AgentHandler | null
  /** Hidden from all product-facing API responses. */
  internal?: boolean
}
