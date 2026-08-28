// =============================================================
// Audit Service — first-class audit trail for every material
// action: mutations, AI inferences, decisions, exports, approvals.
// Replaces the thin ComplianceLog status-transition log.
//
// Writes are non-blocking (fire-and-forget) so audit pressure
// never slows the request path. Failures are logged, not thrown.
// =============================================================
import { prisma } from '../config/database'
import { logger } from '../utils/logger'

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'ARCHIVED'
  | 'RESTORED'
  | 'SCORECARD_RESET'
  | 'SECTION_REOPENED'
  | 'ACCESS'
  | 'LLM_INFERENCE'
  | 'DECISION_OVERRIDE'
  | 'EXPORT'
  | 'APPROVAL'
  | 'REJECTION'
  | 'LOGIN'
  | 'LOGOUT'
  | 'EMAIL_VERIFIED'
  | 'EMAIL_DELIVERY_FAILED'
  | 'AGREEMENT_ACCEPTED'
  | 'BACKGROUND_TASK_FAILED'
  | 'PROPOSAL_TOKENS_DEDUCTED'
  | 'PROPOSAL_TOKENS_GRANTED'
  // §7.0 — shared agent runtime. AuditEvent.action is a String column, so
  // extending this union needs no migration. System-triggered agent runs write
  // with actorUserId null (the model already documents null as "system /
  // scheduled actions"); manual runs keep the initiating user.
  | 'AGENT_RUN_CREATED'
  | 'AGENT_RUN_STARTED'
  | 'AGENT_RUN_COMPLETED'
  | 'AGENT_RUN_FAILED'
  | 'AGENT_RUN_CANCELLED'
  | 'AGENT_RUN_TIMED_OUT'
  | 'AGENT_ARTIFACT_CREATED'
  | 'AGENT_ESCALATED'
  | 'AGENT_ESCALATION_ACKNOWLEDGED'
  | 'AGENT_ESCALATION_RESOLVED'
  | 'AGENT_ACTION_PROPOSED'
  | 'AGENT_ACTION_APPLIED'
  | 'AGENT_EVENT_EMITTED'
  | 'AGENT_EVENT_PROCESSED'
  | 'AGENT_SCHEDULE_CHANGED'

export interface AuditLogInput {
  consultingFirmId: string
  actorUserId?: string | null
  actorRole?: string | null
  action: AuditAction
  entityType: string
  entityId?: string | null
  rationale?: string | null
  before?: unknown
  after?: unknown
  // FAR-grounded inference fields
  farContextHash?: string | null
  farClausesReferenced?: string[]
  llmProvider?: string | null
  llmModel?: string | null
  llmTask?: string | null
  promptHash?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  estimatedCostUsd?: number | null
  /**
   * §8.3 — who acted, honestly. INTERNAL_USER (default) | PARTNER_PORTAL_USER |
   * SYSTEM. An external partner action records its own id in externalActorId
   * and leaves actorUserId null, rather than borrowing an internal user id.
   */
  actorKind?: 'INTERNAL_USER' | 'PARTNER_PORTAL_USER' | 'SYSTEM' | null
  externalActorId?: string | null
  // Request context
  sourceIp?: string | null
  userAgent?: string | null
  requestId?: string | null
}

/**
 * Write an audit event. Non-blocking — caller does not await unless they
 * specifically want the write to complete before continuing.
 */
export function logAudit(input: AuditLogInput): Promise<void> {
  return prisma.auditEvent
    .create({
      data: {
        consultingFirmId: input.consultingFirmId,
        actorUserId: input.actorUserId ?? null,
        actorRole: input.actorRole ?? null,
        actorKind: input.actorKind ?? (input.actorUserId ? 'INTERNAL_USER' : undefined),
        externalActorId: input.externalActorId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        rationale: input.rationale ?? null,
        beforeJson: input.before === undefined ? undefined : (input.before as object),
        afterJson: input.after === undefined ? undefined : (input.after as object),
        farContextHash: input.farContextHash ?? null,
        farClausesReferenced: input.farClausesReferenced ?? [],
        llmProvider: input.llmProvider ?? null,
        llmModel: input.llmModel ?? null,
        llmTask: input.llmTask ?? null,
        promptHash: input.promptHash ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        estimatedCostUsd: input.estimatedCostUsd ?? null,
        sourceIp: input.sourceIp ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
      },
    })
    .then(() => undefined)
    .catch((err) => {
      // Audit failures are compliance-grade — surface at error level so they
      // page on-call rather than hide in warn-level logs. The catch ensures
      // the broader request flow continues even when the audit write fails.
      logger.error('Failed to write audit event', {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        error: (err as Error).message,
      })
    })
}

/**
 * Convenience helper: log an LLM inference. Wired by farGroundedComplete
 * so every grounded inference becomes a replayable audit row.
 */
export function logLlmInference(args: {
  consultingFirmId: string
  actorUserId?: string | null
  llmProvider: string
  llmModel: string
  llmTask: string
  promptHash: string
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
  farContextHash: string
  farClausesReferenced: string[]
  entityType?: string
  entityId?: string | null
}): Promise<void> {
  return logAudit({
    consultingFirmId: args.consultingFirmId,
    actorUserId: args.actorUserId,
    action: 'LLM_INFERENCE',
    entityType: args.entityType ?? 'AiInference',
    entityId: args.entityId ?? null,
    farContextHash: args.farContextHash,
    farClausesReferenced: args.farClausesReferenced,
    llmProvider: args.llmProvider,
    llmModel: args.llmModel,
    llmTask: args.llmTask,
    promptHash: args.promptHash,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    estimatedCostUsd: args.estimatedCostUsd,
  })
}
