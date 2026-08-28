// =============================================================
// §7.5 — Subcontracting-goal attainment.
//
// A goal is an OBLIGATION a person recorded from a solicitation, a
// subcontracting plan, a contract, or a verified manual entry. The platform
// never invents a statutory target.
//
// All arithmetic here is Decimal. Money is never a JavaScript number: a
// floating-point cent error in a reported subcontracting percentage is a
// compliance defect, not a rounding curiosity.
//
// Missing spend data means INSUFFICIENT_DATA. It never means zero. Only an
// authoritative ledger that genuinely records no qualifying subcontract spend
// may be reported as zero achievement.
// =============================================================
import { Prisma, type SubcontractingGoal, type SubcontractingGoalProgress } from '@prisma/client'
import { prisma } from '../../../config/database'

export const GOAL_METHOD_VERSION = 'teaming-goal-v1'

/** Inside this many working days of the deadline, a shortfall becomes AT_RISK. */
export const AT_RISK_WORKING_DAYS = 20

/** Attainment below this share of target, close to the deadline, is AT_RISK. */
export const AT_RISK_ATTAINMENT_RATIO = 0.75

/** Attainment below this share of target, with time left, is WATCH. */
export const WATCH_ATTAINMENT_RATIO = 0.9

export type RiskState = 'ON_TRACK' | 'WATCH' | 'AT_RISK' | 'MISSED' | 'INSUFFICIENT_DATA'
export type DataSufficiency = 'INSUFFICIENT_DATA' | 'PARTIAL' | 'SUFFICIENT'

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)
const ZERO = D(0)
const HUNDRED = D(100)

export interface GoalSpendEvidence {
  /** The base the percentage is measured against, e.g. total subcontracted value. */
  eligibleBaseAmount: Prisma.Decimal | null
  /** Qualifying spend actually recorded against this goal's category. */
  achievedAmount: Prisma.Decimal | null
  recordIds: string[]
  /** True only when an authoritative ledger was read, even if it summed to zero. */
  ledgerRead: boolean
  limitations: string[]
}

export interface GoalAttainment {
  goalId: string
  goalType: string
  targetType: 'PERCENT' | 'AMOUNT'
  targetPercent: Prisma.Decimal | null
  targetAmount: Prisma.Decimal | null
  eligibleBaseAmount: Prisma.Decimal | null
  achievedAmount: Prisma.Decimal | null
  achievedPercent: Prisma.Decimal | null
  remainingAmount: Prisma.Decimal | null
  remainingPercent: Prisma.Decimal | null
  riskState: RiskState
  dataSufficiency: DataSufficiency
  workingDaysRemaining: number | null
  evidenceRecordIds: string[]
  limitations: string[]
}

/**
 * Qualifying spend for one goal.
 *
 * Reads the authoritative teaming arrangements — `dollarShare` is the recorded
 * commitment to a partner on this pursuit. When no arrangement carries a dollar
 * figure, the honest answer is that the amount is unknown, so `achievedAmount`
 * stays null and `ledgerRead` is false.
 *
 * TENANT SCOPE: every read filters on `consultingFirmId`.
 */
export async function loadGoalSpendEvidence(
  consultingFirmId: string,
  goal: SubcontractingGoal,
): Promise<GoalSpendEvidence> {
  const limitations: string[] = []

  if (!goal.opportunityId && !goal.contractId && !goal.pursuitId) {
    limitations.push('This goal is not linked to a pursuit, opportunity or contract, so no spend ledger can be located.')
    return { eligibleBaseAmount: null, achievedAmount: null, recordIds: [], ledgerRead: false, limitations }
  }

  let opportunityId = goal.opportunityId
  if (!opportunityId && goal.pursuitId) {
    const pursuit = await prisma.bidPursuit.findFirst({
      where: { id: goal.pursuitId, consultingFirmId },
      select: { opportunityId: true },
    })
    opportunityId = pursuit?.opportunityId ?? null
  }
  if (!opportunityId && goal.contractId) {
    const contract = await prisma.contract.findFirst({
      where: { id: goal.contractId, consultingFirmId },
      select: { opportunityId: true },
    })
    opportunityId = contract?.opportunityId ?? null
  }

  if (!opportunityId) {
    limitations.push('No opportunity could be resolved for this goal, so no subcontract ledger could be read.')
    return { eligibleBaseAmount: null, achievedAmount: null, recordIds: [], ledgerRead: false, limitations }
  }

  const arrangements = await prisma.teamingArrangement.findMany({
    where: { consultingFirmId, opportunityId },
    select: {
      id: true, dollarShare: true, role: true, teamingStatus: true,
      partner: { select: { id: true, primarySetAsides: true, certifications: true } },
    },
    orderBy: { id: 'asc' },
  })

  if (arrangements.length === 0) {
    limitations.push(
      'No teaming arrangement exists for this opportunity, so there is no authoritative record of qualifying subcontract spend. This is reported as unknown, not as zero.',
    )
    return { eligibleBaseAmount: null, achievedAmount: null, recordIds: [], ledgerRead: false, limitations }
  }

  const withAmounts = arrangements.filter((a) => a.dollarShare !== null)
  if (withAmounts.length === 0) {
    limitations.push(
      `${arrangements.length} teaming arrangement(s) exist but none records a dollar share, so qualifying spend cannot be calculated.`,
    )
    return { eligibleBaseAmount: null, achievedAmount: null, recordIds: arrangements.map((a) => a.id), ledgerRead: false, limitations }
  }

  if (withAmounts.length < arrangements.length) {
    limitations.push(
      `${arrangements.length - withAmounts.length} of ${arrangements.length} teaming arrangement(s) record no dollar share and are excluded from the calculation.`,
    )
  }

  const category = goalCategoryTokens(goal)
  let base = ZERO
  let achieved = ZERO
  const recordIds: string[] = []

  for (const a of withAmounts) {
    const amount = D(a.dollarShare as Prisma.Decimal)
    base = base.plus(amount)
    recordIds.push(a.id)
    if (partnerQualifies(a.partner, category)) achieved = achieved.plus(amount)
  }

  if (goal.goalType !== 'OTHER' && achieved.equals(ZERO)) {
    limitations.push(
      `No partner on this opportunity carries a recorded ${goal.goalType} designation, so qualifying spend for this category reads as zero against a ledger that was actually checked.`,
    )
  }

  return { eligibleBaseAmount: base, achievedAmount: achieved, recordIds, ledgerRead: true, limitations }
}

/** Tokens that make a partner count toward a category. Stored evidence only. */
function goalCategoryTokens(goal: SubcontractingGoal): string[] {
  const explicit = (goal.category ?? '').trim().toUpperCase()
  const byType: Record<string, string[]> = {
    SMALL_BUSINESS: ['SMALL_BUSINESS', 'SMALL BUSINESS', 'SB'],
    SMALL_DISADVANTAGED_BUSINESS: ['SDB', 'SMALL_DISADVANTAGED_BUSINESS', '8(A)', '8A', 'SBA_8A'],
    SDVOSB: ['SDVOSB', 'SDVOB'],
    VOSB: ['VOSB'],
    WOSB: ['WOSB', 'EDWOSB'],
    HUBZONE: ['HUBZONE', 'HUB_ZONE'],
    ANC_TRIBAL: ['ANC', 'TRIBAL'],
    HBCU_MI: ['HBCU', 'MI', 'HBCU_MI'],
    OTHER: [],
  }
  const tokens = byType[goal.goalType] ?? []
  return explicit ? [...tokens, explicit] : tokens
}

/**
 * A partner counts only when its STORED set-aside or certification evidence
 * names the category. Absence of evidence is never treated as qualification.
 */
function partnerQualifies(
  partner: { primarySetAsides: string[]; certifications: string[] } | null,
  tokens: string[],
): boolean {
  if (!partner || tokens.length === 0) return false
  const held = [...partner.primarySetAsides, ...partner.certifications].map((v) => v.trim().toUpperCase())
  return tokens.some((t) => held.some((h) => h === t || h.includes(t)))
}

/**
 * Deterministic attainment and risk.
 *
 * `workingDaysRemaining` is supplied by the caller from the shared working-day
 * calendar; calendar days are never used for a deadline policy.
 */
export function computeGoalAttainment(
  goal: SubcontractingGoal,
  evidence: GoalSpendEvidence,
  workingDaysRemaining: number | null,
  now: Date,
): GoalAttainment {
  const limitations = [...evidence.limitations]
  const base: GoalAttainment = {
    goalId: goal.id,
    goalType: goal.goalType,
    targetType: goal.targetType as 'PERCENT' | 'AMOUNT',
    targetPercent: goal.targetPercent,
    targetAmount: goal.targetAmount,
    eligibleBaseAmount: evidence.eligibleBaseAmount,
    achievedAmount: evidence.achievedAmount,
    achievedPercent: null,
    remainingAmount: null,
    remainingPercent: null,
    riskState: 'INSUFFICIENT_DATA',
    dataSufficiency: 'INSUFFICIENT_DATA',
    workingDaysRemaining,
    evidenceRecordIds: evidence.recordIds,
    limitations,
  }

  // A target that is absent, zero or negative cannot be measured against.
  const targetPercent = goal.targetPercent
  const targetAmount = goal.targetAmount
  const hasUsableTarget =
    goal.targetType === 'PERCENT'
      ? targetPercent !== null && D(targetPercent).greaterThan(ZERO)
      : targetAmount !== null && D(targetAmount).greaterThan(ZERO)

  if (!hasUsableTarget) {
    limitations.push('This goal records no positive target, so attainment cannot be measured against it.')
    return base
  }

  if (!evidence.ledgerRead || evidence.achievedAmount === null) {
    limitations.push('Qualifying spend could not be read from an authoritative record, so attainment is unknown rather than zero.')
    return base
  }

  const achieved = D(evidence.achievedAmount)
  const overdue = goal.dueDate !== null && goal.dueDate.getTime() < now.getTime()

  if (goal.targetType === 'AMOUNT') {
    const target = D(targetAmount as Prisma.Decimal)
    const remaining = Prisma.Decimal.max(ZERO, target.minus(achieved))
    const attainmentRatio = achieved.dividedBy(target)
    return {
      ...base,
      achievedAmount: achieved,
      achievedPercent: target.greaterThan(ZERO) ? achieved.dividedBy(target).times(HUNDRED).toDecimalPlaces(2) : null,
      remainingAmount: remaining.toDecimalPlaces(2),
      remainingPercent: target.greaterThan(ZERO) ? remaining.dividedBy(target).times(HUNDRED).toDecimalPlaces(2) : null,
      dataSufficiency: evidence.limitations.length > 0 ? 'PARTIAL' : 'SUFFICIENT',
      riskState: riskFor(attainmentRatio, remaining, workingDaysRemaining, overdue),
      limitations,
    }
  }

  // PERCENT target — needs a base to be a percentage OF.
  const eligibleBase = evidence.eligibleBaseAmount
  if (eligibleBase === null || D(eligibleBase).lessThanOrEqualTo(ZERO)) {
    limitations.push('No eligible subcontracting base amount is recorded, so a percentage of it cannot be calculated.')
    return { ...base, achievedAmount: achieved }
  }

  const target = D(targetPercent as Prisma.Decimal)
  const baseAmount = D(eligibleBase)
  const achievedPercent = achieved.dividedBy(baseAmount).times(HUNDRED).toDecimalPlaces(2)
  const requiredAmount = baseAmount.times(target).dividedBy(HUNDRED)
  const remainingAmount = Prisma.Decimal.max(ZERO, requiredAmount.minus(achieved)).toDecimalPlaces(2)
  const remainingPercent = Prisma.Decimal.max(ZERO, target.minus(achievedPercent)).toDecimalPlaces(2)
  const attainmentRatio = target.greaterThan(ZERO) ? achievedPercent.dividedBy(target) : ZERO

  return {
    ...base,
    achievedAmount: achieved,
    achievedPercent,
    remainingAmount,
    remainingPercent,
    dataSufficiency: evidence.limitations.length > 0 ? 'PARTIAL' : 'SUFFICIENT',
    riskState: riskFor(attainmentRatio, remainingAmount, workingDaysRemaining, overdue),
    limitations,
  }
}

/**
 * The one risk rule.
 *
 * MISSED requires the deadline to have actually passed with a shortfall
 * remaining. Nothing here projects future subcontract spend.
 */
function riskFor(
  attainmentRatio: Prisma.Decimal,
  remaining: Prisma.Decimal,
  workingDaysRemaining: number | null,
  overdue: boolean,
): RiskState {
  const met = remaining.lessThanOrEqualTo(ZERO)
  if (met) return 'ON_TRACK'
  if (overdue) return 'MISSED'

  const closeToDeadline = workingDaysRemaining !== null && workingDaysRemaining <= AT_RISK_WORKING_DAYS
  if (closeToDeadline && attainmentRatio.lessThan(D(AT_RISK_ATTAINMENT_RATIO))) return 'AT_RISK'
  if (attainmentRatio.lessThan(D(WATCH_ATTAINMENT_RATIO))) return 'WATCH'
  return 'ON_TRACK'
}

/** Persist one measurement period. Returns whether anything material moved. */
export async function persistGoalProgress(args: {
  consultingFirmId: string
  attainment: GoalAttainment
  periodStart: Date
  periodEnd: Date
}): Promise<{ progress: SubcontractingGoalProgress; changed: boolean }> {
  const a = args.attainment
  const payload = {
    eligibleBaseAmount: a.eligibleBaseAmount,
    achievedAmount: a.achievedAmount,
    achievedPercent: a.achievedPercent,
    remainingAmount: a.remainingAmount,
    remainingPercent: a.remainingPercent,
    riskState: a.riskState,
    dataSufficiency: a.dataSufficiency,
    workingDaysRemaining: a.workingDaysRemaining,
    evidenceRecordIds: a.evidenceRecordIds,
    evidence: { goalType: a.goalType, targetType: a.targetType } as Prisma.InputJsonObject,
    limitations: a.limitations,
    methodVersion: GOAL_METHOD_VERSION,
    calculatedAt: new Date(),
  }

  const existing = await prisma.subcontractingGoalProgress.findUnique({
    where: { goalId_periodStart_periodEnd: { goalId: a.goalId, periodStart: args.periodStart, periodEnd: args.periodEnd } },
  })

  const sameDecimal = (x: Prisma.Decimal | null, y: Prisma.Decimal | null) =>
    x === null && y === null ? true : x !== null && y !== null ? D(x).equals(D(y)) : false

  const changed =
    !existing ||
    existing.riskState !== payload.riskState ||
    existing.dataSufficiency !== payload.dataSufficiency ||
    !sameDecimal(existing.achievedAmount, payload.achievedAmount) ||
    !sameDecimal(existing.achievedPercent, payload.achievedPercent)

  const progress = await prisma.subcontractingGoalProgress.upsert({
    where: { goalId_periodStart_periodEnd: { goalId: a.goalId, periodStart: args.periodStart, periodEnd: args.periodEnd } },
    create: {
      consultingFirmId: args.consultingFirmId,
      goalId: a.goalId,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      ...payload,
    },
    update: payload,
  })

  return { progress, changed }
}

/**
 * Goals the agent may act on.
 *
 * Only ACTIVE, human-verified goals drive escalations: an unverified draft
 * obligation must not page anybody.
 */
export async function loadActionableGoals(
  consultingFirmId: string,
  scope: { pursuitId?: string | null; contractId?: string | null } = {},
): Promise<SubcontractingGoal[]> {
  return prisma.subcontractingGoal.findMany({
    where: {
      consultingFirmId,
      status: 'ACTIVE',
      isHumanVerified: true,
      ...(scope.pursuitId ? { pursuitId: scope.pursuitId } : {}),
      ...(scope.contractId ? { contractId: scope.contractId } : {}),
    },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    take: 200,
  })
}
