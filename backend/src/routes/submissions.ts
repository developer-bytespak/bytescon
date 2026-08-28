// =============================================================
// Submission Records Routes
// =============================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { config } from '../config/config';
import { authenticateJWT } from '../middleware/auth';
import { requireActiveBase } from '../middleware/addonGate'
import { requireRole } from '../middleware/auth';
import { enforceTenantScope, getTenantId } from '../middleware/tenant';
import { AuthenticatedRequest } from '../types';
import { NotFoundError, ValidationError } from '../utils/errors';
import { evaluateOnTime, enforceAndLogPenalty } from '../engines/penaltyEngine';
import { recalculateClientStats } from '../services/performanceStats';
import {
  autoCaptureFromWonSubmission,
  retractAutoCapturedRecord,
} from '../services/pastPerformanceService';
import {
  isSubmissionBlocked,
  transitionSubmissionStatus,
  isValidTransition,
  recordComplianceEvent,
  ComplianceStatus,
} from '../services/complianceStateMachine';
import { logger } from '../utils/logger';
import { logAudit } from '../services/auditService';
import { emitSubmissionOutcomeRecorded, isOutcomeChange } from '../services/agents/intelligence/intelligenceEvents';

const router = Router();
router.use(authenticateJWT, enforceTenantScope);
router.use(requireActiveBase);

const CreateSubmissionSchema = z.object({
  clientCompanyId: z.string().uuid(),
  opportunityId: z.string().uuid(),
  submittedAt: z.string().datetime().transform((s) => new Date(s)),
  notes: z.string().optional(),
});

const StatusTransitionSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'BLOCKED', 'REJECTED']),
  reason: z.string().optional(),
});

/**
 * POST /api/submissions
 */
router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const body = CreateSubmissionSchema.parse(req.body);

    const [client, opportunity] = await Promise.all([
      prisma.clientCompany.findFirst({
        where: { id: body.clientCompanyId, consultingFirmId },
      }),
      prisma.opportunity.findFirst({
        where: { id: body.opportunityId, consultingFirmId },
        select: { id: true, responseDeadline: true, estimatedValue: true, title: true },
      }),
    ]);

    if (!client) throw new NotFoundError('ClientCompany');
    if (!opportunity) throw new NotFoundError('Opportunity');

    // Compliance gate: reject if the BidDecision for this pair is BLOCKED
    const gate = await isSubmissionBlocked(body.opportunityId, body.clientCompanyId);
    if (gate.blocked) {
      return res.status(422).json({
        success: false,
        error: 'Submission blocked by compliance review',
        code: 'COMPLIANCE_BLOCKED',
        detail: gate.reason,
      });
    }

    const wasOnTime = evaluateOnTime(body.submittedAt, opportunity.responseDeadline);

    const submission = await prisma.$transaction(async (tx) => {
      const record = await tx.submissionRecord.create({
        data: {
          consultingFirmId,
          clientCompanyId: body.clientCompanyId,
          opportunityId: body.opportunityId,
          submittedById: req.user?.userId || '',
          submittedAt: body.submittedAt,
          wasOnTime,
          penaltyAmount: 0,
          notes: body.notes,
          status: 'PENDING',
        },
      });

      // Section 4 #4: audit the submission creation (atomic with the insert).
      await recordComplianceEvent(tx, {
        entityType: 'SUBMISSION',
        entityId: record.id,
        toStatus: record.status ?? 'PENDING',
        consultingFirmId,
        triggeredBy: req.user?.userId,
        reason: 'Submission logged',
        dedupeOn: 'entity-creation',
      });

      if (!wasOnTime) {
        const penaltyResult = await enforceAndLogPenalty({
          consultingFirmId,
          clientCompanyId: body.clientCompanyId,
          submissionRecordId: record.id,
          estimatedValue: opportunity.estimatedValue ? Number(opportunity.estimatedValue) : null,
          tx,
        });

        if (penaltyResult.amount > 0) {
          await tx.submissionRecord.update({
            where: { id: record.id },
            data: { penaltyAmount: penaltyResult.amount },
          });
          return { ...record, penaltyAmount: penaltyResult.amount };
        }
      }

      return record;
    });

    recalculateClientStats(body.clientCompanyId, consultingFirmId).catch((err) => {
      logger.error('Stats recalculation failed', { error: err });
    });

    logger.info('Submission logged', {
      submissionId: submission.id,
      wasOnTime,
      penaltyAmount: submission.penaltyAmount,
    });

    res.status(201).json({
      success: true,
      data: {
        ...submission,
        wasOnTime,
        lateMessage: !wasOnTime
          ? `Submission was ${Math.ceil(
              (body.submittedAt.getTime() - opportunity.responseDeadline.getTime()) /
                (1000 * 60 * 60 * 24)
            )} day(s) late`
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/submissions
 */
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const { clientCompanyId, opportunityId, wasOnTime, page = '1', limit = '20' } = req.query;

    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);

    const where: any = { consultingFirmId };
    if (clientCompanyId) where.clientCompanyId = clientCompanyId;
    if (opportunityId) where.opportunityId = opportunityId;
    if (wasOnTime !== undefined) where.wasOnTime = wasOnTime === 'true';

    const [submissions, total] = await Promise.all([
      prisma.submissionRecord.findMany({
        where,
        include: {
          clientCompany: { select: { id: true, name: true } },
          opportunity: {
            select: { id: true, title: true, agency: true, responseDeadline: true },
          },
          submittedBy: { select: { id: true, firstName: true, lastName: true } },
          financialPenalties: true,
        },
        orderBy: { submittedAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.submissionRecord.count({ where }),
    ]);

    res.json({
      success: true,
      data: submissions,
      meta: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/submissions/pending-outcomes
 * FIX-1 flywheel: pursued bids whose opportunity deadline has passed but whose
 * WON/LOST outcome has not been recorded yet — the nudge list + the capture-rate
 * fuel gauge. Real outcomes are the label source calibration needs.
 * (Defined before /:id so "pending-outcomes" isn't captured as an id.)
 */
router.get('/pending-outcomes', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const now = new Date();
    const deadlinePassed = { opportunity: { responseDeadline: { lt: now } } };

    const [pending, withOutcome, total] = await Promise.all([
      prisma.submissionRecord.findMany({
        where: { consultingFirmId, outcome: null, ...deadlinePassed },
        select: {
          id: true,
          submittedAt: true,
          createdAt: true,
          clientCompany: { select: { id: true, name: true } },
          opportunity: { select: { id: true, title: true, agency: true, responseDeadline: true } },
        },
        orderBy: { opportunity: { responseDeadline: 'asc' } },
        take: 200,
      }),
      prisma.submissionRecord.count({ where: { consultingFirmId, outcome: { not: null }, ...deadlinePassed } }),
      prisma.submissionRecord.count({ where: { consultingFirmId, ...deadlinePassed } }),
    ]);

    // Capture rate = the fuel gauge for the calibration flywheel.
    const captureRatePct = total > 0 ? Math.round((withOutcome / total) * 100) : null;

    res.json({
      success: true,
      data: pending,
      meta: { pendingCount: pending.length, withOutcome, total, captureRatePct },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/submissions/:id
 */
router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const submission = await prisma.submissionRecord.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: {
        clientCompany: true,
        opportunity: true,
        submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        financialPenalties: true,
      },
    });

    if (!submission) throw new NotFoundError('SubmissionRecord');
    res.json({ success: true, data: submission });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/submissions/:id/status  (ADMIN only)
 * Manually transition a submission's compliance status.
 */
router.patch(
  '/:id/status',
  requireRole('ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req);
      const { status, reason } = StatusTransitionSchema.parse(req.body);

      const result = await transitionSubmissionStatus({
        submissionId: req.params.id,
        toStatus: status as ComplianceStatus,
        consultingFirmId,
        triggeredBy: req.user?.userId,
        reason,
      });

      if (!result.success) {
        return res.status(422).json({
          success: false,
          error: result.error,
          code: 'INVALID_TRANSITION',
        });
      }

      res.json({ success: true, data: { id: req.params.id, status } });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/submissions/:id/outcome  (ADMIN only)
 * Record the post-evaluation result of a submission. Drives win-rate
 * KPIs and provides labels for the calibration backtest's real-bid
 * source. Idempotent — re-recording overwrites prior outcome.
 */
const OutcomeSchema = z.object({
  outcome: z.enum(['WON', 'LOST', 'NO_AWARD', 'WITHDRAWN']),
  notes: z.string().max(2000).optional(),
});

router.patch(
  '/:id/outcome',
  requireRole('ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req);
      // Use safeParse + explicit ValidationError so the global handler
      // returns 422 instead of treating raw ZodError as 500.
      const parsed = OutcomeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.errors[0]?.message ?? 'Invalid outcome payload');
      }
      const { outcome, notes } = parsed.data;

      const submission = await prisma.submissionRecord.findFirst({
        where: { id: req.params.id, consultingFirmId },
        select: { id: true, clientCompanyId: true, opportunityId: true, outcome: true },
      });
      if (!submission) throw new NotFoundError('Submission record');

      // Atomic first-outcome claim: the conditional updateMany means exactly
      // ONE concurrent request can transition outcome from null, so the
      // config-gated token reward below can never double-grant. (The pre-read
      // `submission.outcome` alone was a read-then-grant race: two tabs both
      // observed null and both received the reward.)
      const outcomeData = {
        outcome,
        outcomeRecordedAt: new Date(),
        outcomeNotes: notes ?? null,
      };
      const outcomeSelect = { id: true, outcome: true, outcomeRecordedAt: true, clientCompanyId: true } as const;
      // §7.9 — the outcome write and SUBMISSION_OUTCOME_RECORDED share one
      // transaction, so a rolled-back write emits nothing. The atomic
      // first-outcome claim below is unchanged; it still guarantees exactly one
      // concurrent request transitions outcome from null.
      const { isFirstOutcome, updated } = await prisma.$transaction(async (tx) => {
        const firstClaim = await tx.submissionRecord.updateMany({
          where: { id: req.params.id, consultingFirmId, outcome: null },
          data: outcomeData,
        });
        const claimedFirst = firstClaim.count === 1;
        const row = claimedFirst
          ? await tx.submissionRecord.findFirstOrThrow({
              where: { id: req.params.id, consultingFirmId },
              select: outcomeSelect,
            })
          : await tx.submissionRecord.update({
              where: { id: req.params.id },
              data: outcomeData,
              select: outcomeSelect,
            });
        // Only a genuine change to the recorded result is new information. A
        // notes-only re-save of the same outcome emits nothing.
        if (isOutcomeChange(submission.outcome ?? null, outcome)) {
          await emitSubmissionOutcomeRecorded(tx, {
            consultingFirmId,
            submissionRecordId: row.id,
            opportunityId: submission.opportunityId,
            fromOutcome: submission.outcome ?? null,
            toOutcome: outcome,
            recordedByUserId: req.user?.userId ?? null,
          });
        }
        return { isFirstOutcome: claimedFirst, updated: row };
      });

      void logAudit({
        consultingFirmId,
        actorUserId: req.user?.userId ?? null,
        action: 'UPDATE',
        entityType: 'SubmissionRecord',
        entityId: updated.id,
        rationale: `Outcome ${submission.outcome ?? 'unset'} → ${outcome}${notes ? `: ${notes.slice(0, 200)}` : ''}`,
        sourceIp: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });

      // Recalculate the client's win-rate KPIs now that outcome changed.
      try {
        await recalculateClientStats(updated.clientCompanyId, consultingFirmId);
      } catch (statsErr) {
        logger.warn('PerformanceStats recalc failed after outcome change', {
          submissionId: updated.id,
          error: (statsErr as Error).message,
        });
      }

      // Past-performance reconciliation (going-forward only; best-effort —
      // never blocks the request). Auto-capture fires only on a genuine
      // transition INTO won, not on notes-only re-saves of an already-WON
      // submission. Correcting a prior WON to a non-win retracts (deactivates)
      // the record it created so a lost bid is never citable as a win.
      const wasWon = submission.outcome === 'WON';
      try {
        if (outcome === 'WON' && !wasWon) {
          const opportunity = await prisma.opportunity.findFirst({
            where: { id: submission.opportunityId, consultingFirmId },
            select: {
              id: true,
              samNoticeId: true,
              title: true,
              agency: true,
              subagency: true,
              naicsCode: true,
              estimatedValue: true,
              description: true,
            },
          });
          if (opportunity) {
            await autoCaptureFromWonSubmission({
              submissionRecordId: updated.id,
              consultingFirmId,
              clientCompanyId: updated.clientCompanyId,
              opportunity,
            });
          }
        } else if (outcome !== 'WON' && wasWon) {
          await retractAutoCapturedRecord(updated.id, consultingFirmId);
        }
      } catch (ppErr) {
        logger.warn('Past-performance reconciliation failed after outcome change', {
          submissionId: updated.id,
          error: (ppErr as Error).message,
        });
      }

      // FIX-1 incentive: reward the FIRST outcome logged per submission (no
      // prior outcome → recorded now), config-gated (default 0 = off). Fuels the
      // real-outcome flywheel calibration depends on. Best-effort; never blocks.
      // isFirstOutcome comes from the atomic claim above, not the pre-read.
      if (isFirstOutcome && config.scoring.outcomeLoggingRewardTokens > 0) {
        await prisma.consultingFirm
          .update({
            where: { id: consultingFirmId },
            data: { proposalTokens: { increment: config.scoring.outcomeLoggingRewardTokens } },
          })
          .catch((e) => logger.warn('Outcome-logging reward grant failed', { error: (e as Error).message }));
      }

      res.json({
        success: true,
        data: {
          id: updated.id,
          outcome: updated.outcome,
          outcomeRecordedAt: updated.outcomeRecordedAt,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
