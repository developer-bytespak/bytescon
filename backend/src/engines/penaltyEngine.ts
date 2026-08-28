// =============================================================
// Financial Penalty Engine
// FR-16, FR-17, FR-18: Penalty calculation and enforcement
// =============================================================
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errors';

interface PenaltyConfig {
  flatLateFee: number | null;
  penaltyPercent: number | null;
}

interface PenaltyCalculation {
  amount: number;
  penaltyType: 'FLAT_FEE' | 'PERCENTAGE';
  calculationBasis: string;
}

/**
 * Determines whether a submission was on time.
 */
export function evaluateOnTime(submittedAt: Date, responseDeadline: Date): boolean {
  return submittedAt.getTime() <= responseDeadline.getTime();
}

/**
 * Calculates penalty amount based on firm configuration.
 */
export function calculatePenalty(
  config: PenaltyConfig,
  estimatedValue: number | null
): PenaltyCalculation {
  if (config.flatLateFee != null && config.flatLateFee > 0) {
    return {
      amount: config.flatLateFee,
      penaltyType: 'FLAT_FEE',
      calculationBasis: `Flat late fee: $${config.flatLateFee.toFixed(2)}`,
    };
  }

  if (config.penaltyPercent != null && config.penaltyPercent > 0 && estimatedValue) {
    const amount = estimatedValue * config.penaltyPercent;
    return {
      amount,
      penaltyType: 'PERCENTAGE',
      calculationBasis: `${(config.penaltyPercent * 100).toFixed(2)}% of estimated value ($${estimatedValue.toLocaleString()}) = $${amount.toFixed(2)}`,
    };
  }

  return {
    amount: 0,
    penaltyType: 'FLAT_FEE',
    calculationBasis: 'No penalty configuration set for this firm',
  };
}

/**
 * Records a penalty in the database.
 */
export async function enforceAndLogPenalty(params: {
  consultingFirmId: string;
  clientCompanyId: string;
  submissionRecordId: string;
  estimatedValue: number | null | undefined;
  // When the caller is inside an interactive transaction, pass its client so the
  // penalty write participates in (and can see) that transaction. Without this
  // the penalty row was written via the global client — outside the caller's tx
  // — risking an FK-visibility failure against the not-yet-committed submission
  // record and a non-atomic orphan row if the transaction later rolls back.
  tx?: Prisma.TransactionClient;
}): Promise<{ amount: number; logged: boolean }> {
  const db = params.tx ?? prisma;
  try {
    const firm = await db.consultingFirm.findUnique({
      where: { id: params.consultingFirmId },
      select: { flatLateFee: true, penaltyPercent: true },
    });

    if (!firm) throw new AppError('Consulting firm not found', 404);

    // Convert Prisma Decimal to number safely
    const config: PenaltyConfig = {
      flatLateFee: firm.flatLateFee != null ? Number(firm.flatLateFee) : null,
      penaltyPercent: firm.penaltyPercent != null ? Number(firm.penaltyPercent) : null,
    };

    const calc = calculatePenalty(config, params.estimatedValue ?? null);

    if (calc.amount > 0) {
      await db.financialPenalty.create({
        data: {
          consultingFirmId: params.consultingFirmId,
          clientCompanyId: params.clientCompanyId,
          submissionRecordId: params.submissionRecordId,
          amount: calc.amount,
          penaltyType: 'LATE_SUBMISSION',
          reason: calc.calculationBasis,
        },
      });

      logger.info('Penalty logged', {
        submissionRecordId: params.submissionRecordId,
        amount: calc.amount,
        type: calc.penaltyType,
      });
    }

    return { amount: calc.amount, logged: calc.amount > 0 };
  } catch (err) {
    logger.error('Penalty enforcement failed', { error: err, params });
    throw err;
  }
}