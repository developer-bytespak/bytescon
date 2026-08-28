// =============================================================
// Compliance State Machine
// Enforces valid status transitions and writes an audit log.
// =============================================================
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

export type ComplianceStatus = 'PENDING' | 'APPROVED' | 'BLOCKED' | 'REJECTED';
export type EntityType = 'SUBMISSION' | 'BID_DECISION';

// The first-class audit log (AuditEvent) is the canonical trail surfaced on
// /compliance. Compliance-status transitions predate that log, so we mirror
// each one into it — atomically, inside the caller's transaction — while
// keeping the legacy ComplianceLog write for backward compatibility.
const AUDIT_ENTITY_TYPE: Record<EntityType, string> = {
  BID_DECISION: 'BidDecision',
  SUBMISSION: 'SubmissionRecord',
};

function auditActionForStatus(toStatus: string, isCreation: boolean): string {
  if (isCreation) return 'CREATE';
  const s = toStatus.toUpperCase();
  if (s === 'GO' || s === 'APPROVED') return 'APPROVAL';
  if (s === 'NO_GO' || s === 'REJECTED' || s === 'BLOCKED') return 'REJECTION';
  return 'UPDATE';
}

function mirrorTransitionToAuditEvent(
  tx: Prisma.TransactionClient,
  params: {
    entityType: EntityType;
    entityId: string;
    toStatus: string;
    fromStatus?: string | null;
    consultingFirmId: string;
    triggeredBy?: string;
    reason?: string;
    isCreation: boolean;
  },
) {
  return tx.auditEvent.create({
    data: {
      consultingFirmId: params.consultingFirmId,
      actorUserId: params.triggeredBy ?? null,
      action: auditActionForStatus(params.toStatus, params.isCreation),
      entityType: AUDIT_ENTITY_TYPE[params.entityType],
      entityId: params.entityId,
      rationale: params.reason ?? null,
      beforeJson: params.fromStatus == null ? undefined : { status: params.fromStatus },
      afterJson: { status: params.toStatus },
    },
  });
}

/**
 * Record an audit entry for an event that is NOT a status transition — the
 * initial creation of a compliance-tracked entity, or a bid GO/NO_GO decision.
 * Section 4 #4: previously only transitions were logged, so making a decision or
 * logging a submission produced zero audit rows.
 *
 * Takes a transaction client so the audit write is atomic with the business
 * insert (they must both succeed or both roll back). Idempotent — a retried
 * create/decision does not duplicate the row:
 *   - 'entity-creation' dedupes on the first (entityId, fromStatus=null) row
 *   - 'entity-status'   dedupes on (entityId, toStatus) so re-resolving the
 *                       same GO/NO_GO is a no-op but GO→NO_GO still logs.
 */
export async function recordComplianceEvent(
  tx: Prisma.TransactionClient,
  params: {
    entityType: EntityType;
    entityId: string;
    toStatus: string;
    fromStatus?: string | null;
    consultingFirmId: string;
    triggeredBy?: string;
    reason?: string;
    dedupeOn: 'entity-creation' | 'entity-status';
  },
): Promise<void> {
  const where =
    params.dedupeOn === 'entity-status'
      ? { entityType: params.entityType, entityId: params.entityId, toStatus: params.toStatus }
      : { entityType: params.entityType, entityId: params.entityId, fromStatus: null };

  const existing = await tx.complianceLog.findFirst({ where, select: { id: true } });
  if (existing) return;

  await tx.complianceLog.create({
    data: {
      consultingFirmId: params.consultingFirmId,
      entityType: params.entityType,
      entityId: params.entityId,
      fromStatus: params.fromStatus ?? null,
      toStatus: params.toStatus,
      reason: params.reason,
      triggeredBy: params.triggeredBy,
    },
  });

  await mirrorTransitionToAuditEvent(tx, {
    entityType: params.entityType,
    entityId: params.entityId,
    toStatus: params.toStatus,
    fromStatus: params.fromStatus,
    consultingFirmId: params.consultingFirmId,
    triggeredBy: params.triggeredBy,
    reason: params.reason,
    isCreation: params.dedupeOn === 'entity-creation',
  });
}

// Valid transitions: what states can each status move to?
const ALLOWED_TRANSITIONS: Record<ComplianceStatus, ComplianceStatus[]> = {
  PENDING:  ['APPROVED', 'BLOCKED', 'REJECTED'],
  APPROVED: ['BLOCKED'],
  BLOCKED:  ['APPROVED'],
  REJECTED: [],  // terminal
};

export function isValidTransition(from: ComplianceStatus, to: ComplianceStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface TransitionResult {
  success: boolean;
  error?: string;
}

/**
 * Transition a SubmissionRecord's compliance status.
 * Validates the transition, applies it, and writes an audit log entry.
 */
export async function transitionSubmissionStatus(params: {
  submissionId: string;
  toStatus: ComplianceStatus;
  consultingFirmId: string;
  triggeredBy?: string;
  reason?: string;
}): Promise<TransitionResult> {
  const submission = await prisma.submissionRecord.findFirst({
    where: { id: params.submissionId, consultingFirmId: params.consultingFirmId },
    select: { id: true, status: true },
  });

  if (!submission) {
    return { success: false, error: 'Submission not found' };
  }

  const fromStatus = (submission.status ?? 'PENDING') as ComplianceStatus;

  if (!isValidTransition(fromStatus, params.toStatus)) {
    return {
      success: false,
      error: `Invalid transition: ${fromStatus} → ${params.toStatus}`,
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.submissionRecord.update({
      where: { id: params.submissionId },
      data: { status: params.toStatus },
    });
    await tx.complianceLog.create({
      data: {
        consultingFirmId: params.consultingFirmId,
        entityType: 'SUBMISSION',
        entityId: params.submissionId,
        fromStatus,
        toStatus: params.toStatus,
        reason: params.reason,
        triggeredBy: params.triggeredBy,
      },
    });
    await mirrorTransitionToAuditEvent(tx, {
      entityType: 'SUBMISSION',
      entityId: params.submissionId,
      toStatus: params.toStatus,
      fromStatus,
      consultingFirmId: params.consultingFirmId,
      triggeredBy: params.triggeredBy,
      reason: params.reason,
      isCreation: false,
    });
  });

  logger.info('Compliance status transitioned', {
    entityType: 'SUBMISSION',
    entityId: params.submissionId,
    fromStatus,
    toStatus: params.toStatus,
  });

  return { success: true };
}

/**
 * Transition a BidDecision's compliance status.
 * Validates the transition, applies it, and writes an audit log entry.
 */
export async function transitionBidDecisionStatus(params: {
  decisionId: string;
  toStatus: ComplianceStatus;
  consultingFirmId: string;
  triggeredBy?: string;
  reason?: string;
}): Promise<TransitionResult> {
  const decision = await prisma.bidDecision.findFirst({
    where: { id: params.decisionId, consultingFirmId: params.consultingFirmId },
    select: { id: true, complianceStatus: true },
  });

  if (!decision) {
    return { success: false, error: 'BidDecision not found' };
  }

  const fromStatus = (decision.complianceStatus ?? 'PENDING') as ComplianceStatus;

  if (!isValidTransition(fromStatus, params.toStatus)) {
    return {
      success: false,
      error: `Invalid transition: ${fromStatus} → ${params.toStatus}`,
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.bidDecision.update({
      where: { id: params.decisionId },
      data: { complianceStatus: params.toStatus },
    });
    await tx.complianceLog.create({
      data: {
        consultingFirmId: params.consultingFirmId,
        entityType: 'BID_DECISION',
        entityId: params.decisionId,
        fromStatus,
        toStatus: params.toStatus,
        reason: params.reason,
        triggeredBy: params.triggeredBy,
      },
    });
    await mirrorTransitionToAuditEvent(tx, {
      entityType: 'BID_DECISION',
      entityId: params.decisionId,
      toStatus: params.toStatus,
      fromStatus,
      consultingFirmId: params.consultingFirmId,
      triggeredBy: params.triggeredBy,
      reason: params.reason,
      isCreation: false,
    });
  });

  logger.info('Compliance status transitioned', {
    entityType: 'BID_DECISION',
    entityId: params.decisionId,
    fromStatus,
    toStatus: params.toStatus,
  });

  return { success: true };
}

/**
 * Gate check: returns true if a submission for this client+opportunity
 * should be blocked based on the active BidDecision compliance state.
 */
export async function isSubmissionBlocked(
  opportunityId: string,
  clientCompanyId: string
): Promise<{ blocked: boolean; reason?: string }> {
  const decision = await prisma.bidDecision.findUnique({
    where: { opportunityId_clientCompanyId: { opportunityId, clientCompanyId } },
    select: { complianceStatus: true, rationale: true },
  });

  if (!decision) return { blocked: false };

  if (decision.complianceStatus === 'BLOCKED') {
    return {
      blocked: true,
      reason: decision.rationale ?? 'Bid decision is blocked by compliance review',
    };
  }

  return { blocked: false };
}
