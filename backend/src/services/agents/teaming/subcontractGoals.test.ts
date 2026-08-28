// =============================================================
// §7.5 — Subcontracting-goal attainment, against a real database.
//
// The matrix: percentage goal, amount goal, no progress, partial, exact target,
// above target, approaching deadline, at risk, missed, missing authoritative
// spend, Decimal cents, an invalid target, and an archived goal.
//
// The rule that governs all of it: missing spend data is INSUFFICIENT_DATA, not
// zero. Only a ledger that was actually read may report zero.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Prisma, type SubcontractingGoal } from '@prisma/client'
import { prisma } from '../../../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, type TestFirm } from '../../../test-utils/testClient'
import {
  loadGoalSpendEvidence,
  computeGoalAttainment,
  persistGoalProgress,
  loadActionableGoals,
  AT_RISK_WORKING_DAYS,
} from './subcontractGoals'

const DAY = 86_400_000
const NOW = new Date('2026-06-01T00:00:00.000Z')

let firmA: TestFirm
let firmB: TestFirm
let opportunityId = ''
let pursuitId = ''
let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Subcontract Goal Firm A' })
  firmB = await createTestFirm({ name: 'Subcontract Goal Firm B' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  for (const id of [firmA.id, firmB.id]) {
    await prisma.subcontractingGoalProgress.deleteMany({ where: { consultingFirmId: id } })
    await prisma.subcontractingGoal.deleteMany({ where: { consultingFirmId: id } })
    await prisma.teamingArrangement.deleteMany({ where: { consultingFirmId: id } })
    await prisma.partner.deleteMany({ where: { consultingFirmId: id } })
    await prisma.bidPursuit.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
  }
  const opp = await prisma.opportunity.create({
    data: {
      consultingFirmId: firmA.id, samNoticeId: uniq('S7-TEAM-QA'), title: 'S7-TEAM-QA goal opportunity',
      agency: 'Department of Defense', naicsCode: '541512', setAsideType: 'NONE',
      responseDeadline: new Date(NOW.getTime() + 60 * DAY), status: 'ACTIVE', isDemo: false,
    },
  })
  opportunityId = opp.id
  const pursuit = await prisma.bidPursuit.create({
    data: { consultingFirmId: firmA.id, opportunityId: opp.id, pipelineStage: 'CAPTURE', status: 'REVIEWING', priority: 'MEDIUM' },
  })
  pursuitId = pursuit.id
})

async function makeGoal(over: Partial<Prisma.SubcontractingGoalUncheckedCreateInput> = {}): Promise<SubcontractingGoal> {
  return prisma.subcontractingGoal.create({
    data: {
      consultingFirmId: firmA.id,
      pursuitId,
      opportunityId,
      goalType: 'SDVOSB',
      targetType: 'PERCENT',
      targetPercent: new Prisma.Decimal('20.00'),
      source: 'SUBCONTRACTING_PLAN',
      sourceReference: 'Plan §3.2',
      dueDate: new Date(NOW.getTime() + 60 * DAY),
      status: 'ACTIVE',
      isHumanVerified: true,
      ...over,
    },
  })
}

/** A partner whose stored evidence names the category, plus a dollar share. */
async function makeArrangement(args: { firmId: string; setAsides: string[]; dollarShare: string | null }) {
  const partner = await prisma.partner.create({
    data: {
      consultingFirmId: args.firmId, name: uniq('S7-TEAM-QA Partner'), uei: uniq('UEI'),
      primarySetAsides: args.setAsides, isActive: true,
    },
  })
  return prisma.teamingArrangement.create({
    data: {
      consultingFirmId: args.firmId,
      opportunityId,
      partnerId: partner.id,
      role: uniq('SUB'),
      arrangementType: 'TEAMING_AGREEMENT',
      dollarShare: args.dollarShare === null ? null : new Prisma.Decimal(args.dollarShare),
    },
  })
}

const attain = async (goal: SubcontractingGoal, workingDays: number | null = 40) => {
  const evidence = await loadGoalSpendEvidence(firmA.id, goal)
  return computeGoalAttainment(goal, evidence, workingDays, NOW)
}

// -------------------------------------------------------------

describe('missing spend is never treated as zero', () => {
  it('reports INSUFFICIENT_DATA when no teaming arrangement exists', async () => {
    const goal = await makeGoal()
    const a = await attain(goal)
    expect(a.dataSufficiency).toBe('INSUFFICIENT_DATA')
    expect(a.riskState).toBe('INSUFFICIENT_DATA')
    expect(a.achievedAmount).toBeNull()
    expect(a.limitations.join(' ')).toContain('reported as unknown, not as zero')
  })

  it('reports INSUFFICIENT_DATA when arrangements record no dollar share', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: null })
    const goal = await makeGoal()
    const a = await attain(goal)
    expect(a.riskState).toBe('INSUFFICIENT_DATA')
    expect(a.limitations.join(' ')).toContain('none records a dollar share')
  })

  it('reports INSUFFICIENT_DATA when the goal is linked to nothing', async () => {
    const goal = await makeGoal({ pursuitId: null, opportunityId: null, contractId: null })
    const a = await attain(goal)
    expect(a.riskState).toBe('INSUFFICIENT_DATA')
    expect(a.limitations.join(' ')).toContain('not linked to a pursuit, opportunity or contract')
  })

  it('reports a genuine zero only when a ledger was actually read', async () => {
    // Arrangements exist with amounts, but no partner holds the category.
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '100000.00' })
    const goal = await makeGoal()
    const a = await attain(goal)
    expect(a.achievedAmount?.toFixed(2)).toBe('0.00')
    expect(a.dataSufficiency).not.toBe('INSUFFICIENT_DATA')
    expect(a.limitations.join(' ')).toContain('a ledger that was actually checked')
  })
})

describe('percentage goals', () => {
  it('computes achieved, remaining and risk from Decimal amounts', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '25000.00' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '75000.00' })
    const goal = await makeGoal({ targetPercent: new Prisma.Decimal('20.00') })
    const a = await attain(goal)

    expect(a.eligibleBaseAmount?.toFixed(2)).toBe('100000.00')
    expect(a.achievedAmount?.toFixed(2)).toBe('25000.00')
    expect(a.achievedPercent?.toFixed(2)).toBe('25.00')
    expect(a.remainingPercent?.toFixed(2)).toBe('0.00')
    expect(a.riskState).toBe('ON_TRACK')
  })

  it('reports a partial shortfall as WATCH while time remains', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '10000.00' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '90000.00' })
    const goal = await makeGoal({ targetPercent: new Prisma.Decimal('20.00') })
    const a = await attain(goal, 60)
    expect(a.achievedPercent?.toFixed(2)).toBe('10.00')
    expect(a.remainingPercent?.toFixed(2)).toBe('10.00')
    expect(a.riskState).toBe('WATCH')
  })

  it('hits exactly the target and reports ON_TRACK with nothing remaining', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '20000.00' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '80000.00' })
    const goal = await makeGoal({ targetPercent: new Prisma.Decimal('20.00') })
    const a = await attain(goal)
    expect(a.achievedPercent?.toFixed(2)).toBe('20.00')
    expect(a.remainingAmount?.toFixed(2)).toBe('0.00')
    expect(a.riskState).toBe('ON_TRACK')
  })

  it('never reports a negative remainder above target', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '60000.00' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '40000.00' })
    const goal = await makeGoal({ targetPercent: new Prisma.Decimal('20.00') })
    const a = await attain(goal)
    expect(a.achievedPercent?.toFixed(2)).toBe('60.00')
    expect(a.remainingPercent?.toFixed(2)).toBe('0.00')
    expect(a.remainingAmount?.toFixed(2)).toBe('0.00')
  })

  it('preserves cents exactly, with no floating-point drift', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '3333.33' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '6666.67' })
    const goal = await makeGoal({ targetPercent: new Prisma.Decimal('33.33') })
    const a = await attain(goal)
    expect(a.eligibleBaseAmount?.toFixed(2)).toBe('10000.00')
    expect(a.achievedAmount?.toFixed(2)).toBe('3333.33')
    expect(a.achievedPercent?.toFixed(2)).toBe('33.33')
  })
})

describe('amount goals', () => {
  it('computes attainment against a dollar target', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '40000.00' })
    const goal = await makeGoal({ targetType: 'AMOUNT', targetPercent: null, targetAmount: new Prisma.Decimal('50000.00') })
    const a = await attain(goal, 60)
    expect(a.achievedAmount?.toFixed(2)).toBe('40000.00')
    expect(a.remainingAmount?.toFixed(2)).toBe('10000.00')
    expect(a.achievedPercent?.toFixed(2)).toBe('80.00')
    expect(a.riskState).toBe('WATCH')
  })

  it('needs no eligible base to measure a dollar target', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '50000.00' })
    const goal = await makeGoal({ targetType: 'AMOUNT', targetPercent: null, targetAmount: new Prisma.Decimal('50000.00') })
    const a = await attain(goal)
    expect(a.riskState).toBe('ON_TRACK')
    expect(a.remainingAmount?.toFixed(2)).toBe('0.00')
  })
})

describe('deadline risk', () => {
  it('becomes AT_RISK inside the working-day window with a real shortfall', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '5000.00' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '95000.00' })
    const goal = await makeGoal({ targetPercent: new Prisma.Decimal('20.00') })
    const a = await attain(goal, AT_RISK_WORKING_DAYS)
    expect(a.riskState).toBe('AT_RISK')
  })

  it('stays WATCH outside the window with the same shortfall', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '5000.00' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '95000.00' })
    const goal = await makeGoal({ targetPercent: new Prisma.Decimal('20.00') })
    expect((await attain(goal, AT_RISK_WORKING_DAYS + 1)).riskState).toBe('WATCH')
  })

  it('reports MISSED only once the deadline has actually passed with a shortfall', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '1000.00' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '99000.00' })
    const goal = await makeGoal({ dueDate: new Date(NOW.getTime() - DAY) })
    expect((await attain(goal, -1)).riskState).toBe('MISSED')
  })

  it('does not report MISSED after the deadline when the target was met', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '50000.00' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '50000.00' })
    const goal = await makeGoal({ dueDate: new Date(NOW.getTime() - DAY) })
    expect((await attain(goal, -1)).riskState).toBe('ON_TRACK')
  })

  it('never projects future subcontract spend to rescue a shortfall', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '1000.00' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '99000.00' })
    const goal = await makeGoal()
    const a = await attain(goal, 200)
    expect(a.achievedPercent?.toFixed(2)).toBe('1.00')
    expect(a.riskState).toBe('WATCH')
  })
})

describe('target validation', () => {
  it('refuses to measure against a zero target', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '10000.00' })
    const goal = await makeGoal({ targetPercent: new Prisma.Decimal('0.00') })
    const a = await attain(goal)
    expect(a.riskState).toBe('INSUFFICIENT_DATA')
    expect(a.limitations.join(' ')).toContain('no positive target')
  })

  it('refuses to measure a percentage goal with no target percent', async () => {
    const goal = await makeGoal({ targetPercent: null })
    expect((await attain(goal)).riskState).toBe('INSUFFICIENT_DATA')
  })

  it('refuses a percentage goal when there is no eligible base', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '0.00' })
    const goal = await makeGoal()
    const a = await attain(goal)
    expect(a.achievedPercent).toBeNull()
    expect(a.limitations.join(' ')).toContain('No eligible subcontracting base amount')
  })
})

describe('category matching uses stored evidence only', () => {
  it('counts a partner whose stored set-aside names the category', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '10000.00' })
    const goal = await makeGoal()
    expect((await attain(goal)).achievedAmount?.toFixed(2)).toBe('10000.00')
  })

  it('does not count a partner with no recorded designation', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: [], dollarShare: '10000.00' })
    const goal = await makeGoal()
    expect((await attain(goal)).achievedAmount?.toFixed(2)).toBe('0.00')
  })

  it('matches an 8(a) partner against a small-disadvantaged goal', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SBA_8A'], dollarShare: '10000.00' })
    const goal = await makeGoal({ goalType: 'SMALL_DISADVANTAGED_BUSINESS' })
    expect((await attain(goal)).achievedAmount?.toFixed(2)).toBe('10000.00')
  })
})

describe('actionable goals', () => {
  it('excludes goals a person has not verified', async () => {
    await makeGoal({ isHumanVerified: false })
    expect(await loadActionableGoals(firmA.id)).toHaveLength(0)
  })

  it('excludes archived goals', async () => {
    await makeGoal({ status: 'ARCHIVED' })
    expect(await loadActionableGoals(firmA.id)).toHaveLength(0)
  })

  it('includes an active, verified goal', async () => {
    await makeGoal()
    expect(await loadActionableGoals(firmA.id)).toHaveLength(1)
  })

  it('never returns another firm\'s goal', async () => {
    await makeGoal()
    expect(await loadActionableGoals(firmB.id)).toHaveLength(0)
  })
})

describe('progress persistence', () => {
  it('stores Decimal values exactly', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '3333.33' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '6666.67' })
    const goal = await makeGoal({ targetPercent: new Prisma.Decimal('33.33') })
    const attainment = await attain(goal)

    const { progress } = await persistGoalProgress({
      consultingFirmId: firmA.id, attainment,
      periodStart: NOW, periodEnd: new Date(NOW.getTime() + 60 * DAY),
    })
    expect(progress.achievedAmount?.toFixed(2)).toBe('3333.33')
    expect(progress.achievedPercent?.toFixed(2)).toBe('33.33')
    expect(progress.eligibleBaseAmount?.toFixed(2)).toBe('10000.00')
  })

  it('reports no change on an unchanged recompute', async () => {
    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '20000.00' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '80000.00' })
    const goal = await makeGoal()
    const period = { periodStart: NOW, periodEnd: new Date(NOW.getTime() + 60 * DAY) }

    const first = await persistGoalProgress({ consultingFirmId: firmA.id, attainment: await attain(goal), ...period })
    expect(first.changed).toBe(true)
    const second = await persistGoalProgress({ consultingFirmId: firmA.id, attainment: await attain(goal), ...period })
    expect(second.changed).toBe(false)
    expect(await prisma.subcontractingGoalProgress.count({ where: { goalId: goal.id } })).toBe(1)
  })

  it('reports a change when the risk state moves', async () => {
    const goal = await makeGoal()
    const period = { periodStart: NOW, periodEnd: new Date(NOW.getTime() + 60 * DAY) }
    await persistGoalProgress({ consultingFirmId: firmA.id, attainment: await attain(goal), ...period })

    await makeArrangement({ firmId: firmA.id, setAsides: ['SDVOSB'], dollarShare: '20000.00' })
    await makeArrangement({ firmId: firmA.id, setAsides: ['WOSB'], dollarShare: '80000.00' })
    const second = await persistGoalProgress({ consultingFirmId: firmA.id, attainment: await attain(goal), ...period })
    expect(second.changed).toBe(true)
    expect(second.progress.riskState).toBe('ON_TRACK')
  })
})

describe('tenant isolation', () => {
  it('never reads another firm\'s teaming arrangement as qualifying spend', async () => {
    // Firm B holds an arrangement against the SAME opportunity id. Only the
    // firm scope on the query keeps it out of Firm A's calculation.
    await makeArrangement({ firmId: firmB.id, setAsides: ['SDVOSB'], dollarShare: '100000.00' })
    const goal = await makeGoal()
    expect((await attain(goal)).riskState).toBe('INSUFFICIENT_DATA')
  })
})
