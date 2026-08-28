// =============================================================
// §7.5 — Partner performance, against a real database.
//
// The matrix that matters: no evidence, one engagement, below/at/above the
// minimum sample, all on time, partial late, a rejection, an unattributed
// deliverable, a rerun, a new period, a genuine decline, and a decline the
// policy correctly refuses to call.
//
// Two rules are asserted everywhere: a rate always shows its denominator, and
// a sample below the minimum yields INSUFFICIENT_DATA rather than a number a
// reader would treat as a grade.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '../../../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, type TestFirm } from '../../../test-utils/testClient'
import {
  computePartnerPerformance,
  assessPerformanceDecline,
  persistPartnerPerformance,
  findPriorPeriod,
  summarisePerformance,
  MINIMUM_SAMPLE_SIZE,
  SUFFICIENT_SAMPLE_SIZE,
  DECLINE_THRESHOLD_PCT,
  DECLINE_LABEL,
  type PartnerPerformanceComputation,
} from './partnerPerformance'

const DAY = 86_400_000
const PERIOD_START = new Date('2026-01-01T00:00:00.000Z')
const PERIOD_END = new Date('2026-06-30T00:00:00.000Z')
const MID = new Date('2026-03-01T00:00:00.000Z')

let firmA: TestFirm
let firmB: TestFirm
let contractId = ''
let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Partner Performance Firm A' })
  firmB = await createTestFirm({ name: 'Partner Performance Firm B' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  for (const id of [firmA.id, firmB.id]) {
    await prisma.partnerPerformanceRecord.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contractDeliverable.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contract.deleteMany({ where: { consultingFirmId: id } })
    await prisma.partner.deleteMany({ where: { consultingFirmId: id } })
  }
  const contract = await prisma.contract.create({
    data: {
      consultingFirmId: firmA.id, contractNumber: uniq('S7-TEAM-QA-C'),
      title: 'S7-TEAM-QA contract', status: 'ACTIVE',
    },
  })
  contractId = contract.id
})

async function makePartner(firmId: string, name = 'S7-TEAM-QA Partner') {
  return prisma.partner.create({
    data: { consultingFirmId: firmId, name, uei: uniq('UEI'), capabilities: ['cyber'], isActive: true },
  })
}

/** One attributed deliverable. `onTime`/`accepted` may be left undecided. */
async function makeDeliverable(args: {
  firmId: string
  partnerId: string | null
  contractId: string
  onTime?: boolean | null
  accepted?: boolean | null
  dueDate?: Date
}) {
  const due = args.dueDate ?? MID
  const submission =
    args.onTime === null || args.onTime === undefined
      ? null
      : new Date(due.getTime() + (args.onTime ? -DAY : DAY))
  return prisma.contractDeliverable.create({
    data: {
      consultingFirmId: args.firmId,
      contractId: args.contractId,
      partnerId: args.partnerId,
      name: uniq('S7-TEAM-QA deliverable'),
      dueDate: due,
      submissionDate: submission,
      status: args.accepted === true ? 'ACCEPTED' : args.accepted === false ? 'REJECTED' : 'SUBMITTED',
      acceptanceStatus: args.accepted === true ? 'ACCEPTED' : args.accepted === false ? 'REJECTED' : null,
    },
  })
}

const compute = (partnerId: string, firmId = firmA.id) =>
  computePartnerPerformance({ consultingFirmId: firmId, partnerId, periodStart: PERIOD_START, periodEnd: PERIOD_END })

// -------------------------------------------------------------

describe('evidence attribution', () => {
  it('returns INSUFFICIENT_DATA when no deliverable is attributed', async () => {
    const partner = await makePartner(firmA.id)
    const result = (await compute(partner.id))!
    expect(result.sampleSize).toBe(0)
    expect(result.dataSufficiency).toBe('INSUFFICIENT_DATA')
    expect(result.limitations.join(' ')).toContain('No deliverable in this period is attributed')
  })

  it('never counts an unattributed contract deliverable', async () => {
    const partner = await makePartner(firmA.id)
    for (let i = 0; i < 8; i += 1) {
      await makeDeliverable({ firmId: firmA.id, partnerId: null, contractId, onTime: false, accepted: false })
    }
    const result = (await compute(partner.id))!
    expect(result.sampleSize).toBe(0)
    expect(result.deliverablesLate).toBe(0)
  })

  it('says plainly that no record is not the same as poor performance', async () => {
    expect(summarisePerformance(null).detail).toContain('not the same as poor performance')
  })

  it('returns null for a partner belonging to another firm', async () => {
    const partnerB = await makePartner(firmB.id)
    expect(await compute(partnerB.id, firmA.id)).toBeNull()
  })

  it('never reads another firm\'s attributed deliverable', async () => {
    const partnerA = await makePartner(firmA.id)
    const contractB = await prisma.contract.create({
      data: { consultingFirmId: firmB.id, contractNumber: uniq('B'), title: 'B', status: 'ACTIVE' },
    })
    for (let i = 0; i < 8; i += 1) {
      await makeDeliverable({ firmId: firmB.id, partnerId: partnerA.id, contractId: contractB.id, onTime: true, accepted: true })
    }
    const result = (await compute(partnerA.id))!
    expect(result.sampleSize).toBe(0)
  })
})

describe('sample size', () => {
  async function withDeliverables(count: number, onTime = true) {
    const partner = await makePartner(firmA.id)
    for (let i = 0; i < count; i += 1) {
      await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime, accepted: true })
    }
    return { partner, result: (await compute(partner.id))! }
  }

  it('one engagement is below the minimum', async () => {
    const { result } = await withDeliverables(1)
    expect(result.sampleSize).toBe(1)
    expect(result.dataSufficiency).toBe('INSUFFICIENT_DATA')
  })

  it('one below the minimum is still INSUFFICIENT_DATA', async () => {
    const { result } = await withDeliverables(MINIMUM_SAMPLE_SIZE - 1)
    expect(result.dataSufficiency).toBe('INSUFFICIENT_DATA')
  })

  it('exactly the minimum becomes PARTIAL', async () => {
    const { result } = await withDeliverables(MINIMUM_SAMPLE_SIZE)
    expect(result.dataSufficiency).toBe('PARTIAL')
  })

  it('at the sufficient threshold it becomes SUFFICIENT', async () => {
    const { result } = await withDeliverables(SUFFICIENT_SAMPLE_SIZE)
    expect(result.dataSufficiency).toBe('SUFFICIENT')
  })

  it('states the sample explicitly when below the minimum', async () => {
    const { result } = await withDeliverables(2)
    expect(result.limitations.join(' ')).toContain(`minimum ${MINIMUM_SAMPLE_SIZE}`)
  })
})

describe('rates always carry their denominator', () => {
  it('reports all on time as a fraction, not a bare percentage', async () => {
    const partner = await makePartner(firmA.id)
    for (let i = 0; i < 10; i += 1) {
      await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: true, accepted: true })
    }
    const result = (await compute(partner.id))!
    expect(result.metrics.onTimeRate).toEqual({ numerator: 10, denominator: 10, percent: 100 })
  })

  it('reports partial lateness with both numbers', async () => {
    const partner = await makePartner(firmA.id)
    for (let i = 0; i < 8; i += 1) {
      await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: true, accepted: true })
    }
    for (let i = 0; i < 2; i += 1) {
      await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: false, accepted: true })
    }
    const result = (await compute(partner.id))!
    expect(result.metrics.onTimeRate).toEqual({ numerator: 8, denominator: 10, percent: 80 })
    expect(result.deliverablesLate).toBe(2)
  })

  it('counts a rejection as an issue and reports the acceptance denominator', async () => {
    const partner = await makePartner(firmA.id)
    for (let i = 0; i < 9; i += 1) {
      await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: true, accepted: true })
    }
    await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: true, accepted: false })
    const result = (await compute(partner.id))!
    expect(result.deliverablesRejected).toBe(1)
    expect(result.issuesRaised).toBe(1)
    expect(result.issueSeverityCounts).toEqual({ REJECTION: 1 })
    expect(result.metrics.acceptanceRate).toEqual({ numerator: 9, denominator: 10, percent: 90 })
  })

  it('excludes a deliverable with no submission from the on-time denominator rather than calling it late', async () => {
    const partner = await makePartner(firmA.id)
    for (let i = 0; i < 6; i += 1) {
      await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: true, accepted: true })
    }
    await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: null, accepted: null })
    const result = (await compute(partner.id))!
    expect(result.metrics.onTimeRate.denominator).toBe(6)
    expect(result.deliverablesLate).toBe(0)
    expect(result.limitations.join(' ')).toContain('excluded from that denominator rather than counted as late')
  })

  it('returns a null percent rather than 0% when the denominator is zero', async () => {
    const partner = await makePartner(firmA.id)
    await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: null, accepted: null })
    const result = (await compute(partner.id))!
    expect(result.metrics.onTimeRate.percent).toBeNull()
    expect(result.metrics.acceptanceRate.percent).toBeNull()
  })

  it('counts distinct contracts as engagements', async () => {
    const partner = await makePartner(firmA.id)
    const second = await prisma.contract.create({
      data: { consultingFirmId: firmA.id, contractNumber: uniq('C2'), title: 'second', status: 'ACTIVE' },
    })
    await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: true, accepted: true })
    await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId: second.id, onTime: true, accepted: true })
    const result = (await compute(partner.id))!
    expect(result.engagementCount).toBe(2)
  })
})

describe('persistence', () => {
  async function persistFor(count: number, onTime = true) {
    const partner = await makePartner(firmA.id)
    for (let i = 0; i < count; i += 1) {
      await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime, accepted: true })
    }
    const computation = (await compute(partner.id))!
    const decline = assessPerformanceDecline(computation, null)
    return { partner, ...(await persistPartnerPerformance({ consultingFirmId: firmA.id, computation, decline })) }
  }

  it('stores the record with its counts', async () => {
    const { record } = await persistFor(10)
    expect(record.sampleSize).toBe(10)
    expect(record.deliverablesOnTime).toBe(10)
    expect(record.methodVersion).toBe('teaming-performance-v1')
  })

  it('reports no change when the same data is recomputed', async () => {
    const { partner } = await persistFor(10)
    const computation = (await compute(partner.id))!
    const again = await persistPartnerPerformance({
      consultingFirmId: firmA.id, computation, decline: assessPerformanceDecline(computation, null),
    })
    expect(again.changed).toBe(false)
    expect(await prisma.partnerPerformanceRecord.count({ where: { partnerId: partner.id } })).toBe(1)
  })

  it('creates a separate record for a new period', async () => {
    const { partner } = await persistFor(10)
    const later = await computePartnerPerformance({
      consultingFirmId: firmA.id, partnerId: partner.id,
      periodStart: new Date('2026-07-01T00:00:00.000Z'), periodEnd: new Date('2026-12-31T00:00:00.000Z'),
    })
    await persistPartnerPerformance({
      consultingFirmId: firmA.id, computation: later!, decline: assessPerformanceDecline(later!, null),
    })
    expect(await prisma.partnerPerformanceRecord.count({ where: { partnerId: partner.id } })).toBe(2)
  })

  it('never overwrites a human note or a human verification', async () => {
    const { partner, record } = await persistFor(10)
    await prisma.partnerPerformanceRecord.update({
      where: { id: record.id },
      data: { isHumanVerified: true, humanNotes: 'Reviewed by the capture lead.' },
    })

    const computation = (await compute(partner.id))!
    await persistPartnerPerformance({
      consultingFirmId: firmA.id, computation, decline: assessPerformanceDecline(computation, null),
    })

    const after = await prisma.partnerPerformanceRecord.findUniqueOrThrow({ where: { id: record.id } })
    expect(after.isHumanVerified).toBe(true)
    expect(after.humanNotes).toBe('Reviewed by the capture lead.')
  })

  it('records how the figures were attributed', async () => {
    const { record } = await persistFor(10)
    expect(JSON.stringify(record.evidence)).toContain('Unattributed contract work is never counted')
    expect(record.evidenceRecordIds).toHaveLength(10)
  })
})

describe('the decline policy is deliberately hard to trigger', () => {
  const computation = (over: Partial<PartnerPerformanceComputation> = {}): PartnerPerformanceComputation => ({
    partnerId: 'p1', partnerName: 'P', periodStart: PERIOD_START, periodEnd: PERIOD_END,
    engagementCount: 1, deliverablesDue: 10, deliverablesOnTime: 6, deliverablesLate: 4,
    deliverablesAccepted: 10, deliverablesRejected: 0, issuesRaised: 0, issueSeverityCounts: {},
    sampleSize: 10, dataSufficiency: 'SUFFICIENT',
    metrics: {
      onTimeRate: { numerator: 6, denominator: 10, percent: 60 },
      acceptanceRate: { numerator: 10, denominator: 10, percent: 100 },
      rejectionRate: { numerator: 0, denominator: 10, percent: 0 },
      issueRate: { numerator: 0, denominator: 10, percent: 0 },
    },
    evidenceRecordIds: [], limitations: [],
    ...over,
  })

  const prior = (percent: number, sampleSize = 10) => ({
    sampleSize,
    computedMetrics: {
      onTimeRate: { numerator: Math.round((percent / 100) * sampleSize), denominator: sampleSize, percent },
      acceptanceRate: { numerator: sampleSize, denominator: sampleSize, percent: 100 },
    } as never,
  })

  it('reports no decline without a prior period', () => {
    const d = assessPerformanceDecline(computation(), null)
    expect(d.declined).toBe(false)
    expect(d.reason).toContain('No comparable prior period')
  })

  it('reports no decline when the current sample is too small', () => {
    const d = assessPerformanceDecline(
      computation({ sampleSize: 2, dataSufficiency: 'INSUFFICIENT_DATA' }),
      prior(100),
    )
    expect(d.declined).toBe(false)
    expect(d.reason).toContain('does not have enough attributed deliverables to judge')
  })

  it('reports no decline when the prior sample is too small', () => {
    const d = assessPerformanceDecline(computation(), prior(100, MINIMUM_SAMPLE_SIZE - 1))
    expect(d.declined).toBe(false)
    expect(d.reason).toContain('prior period does not have enough')
  })

  it('reports no decline for a drop under the threshold', () => {
    const d = assessPerformanceDecline(computation(), prior(60 + DECLINE_THRESHOLD_PCT - 1))
    expect(d.declined).toBe(false)
    expect(d.reason).toContain('No metric fell far enough')
  })

  it('reports a decline at exactly the threshold', () => {
    const d = assessPerformanceDecline(computation(), prior(60 + DECLINE_THRESHOLD_PCT))
    expect(d.declined).toBe(true)
    expect(d.metric).toBe('onTimeRate')
    expect(d.deltaPct).toBe(DECLINE_THRESHOLD_PCT)
  })

  it('shows both samples and both percentages in the reason', () => {
    const d = assessPerformanceDecline(computation(), prior(95))
    expect(d.declined).toBe(true)
    expect(d.reason).toContain('95%')
    expect(d.reason).toContain('60%')
    expect(d.reason).toContain('10 and 10 attributed deliverable(s)')
  })

  it('calls the finding a measurement, not a judgement of the partner', () => {
    const d = assessPerformanceDecline(computation(), prior(95))
    expect(d.reason).toContain('not a judgement of the partner')
  })

  it('never derives a decline from a single failed deliverable', () => {
    const single = computation({
      sampleSize: 1, deliverablesDue: 1, deliverablesOnTime: 0, deliverablesLate: 1,
      dataSufficiency: 'INSUFFICIENT_DATA',
      metrics: {
        onTimeRate: { numerator: 0, denominator: 1, percent: 0 },
        acceptanceRate: { numerator: 0, denominator: 1, percent: 0 },
        rejectionRate: { numerator: 1, denominator: 1, percent: 100 },
        issueRate: { numerator: 1, denominator: 1, percent: 100 },
      },
    })
    expect(assessPerformanceDecline(single, prior(100)).declined).toBe(false)
  })

  it('stores the derived label only when the policy fired', async () => {
    const partner = await makePartner(firmA.id)
    for (let i = 0; i < 10; i += 1) {
      await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: i < 6, accepted: true })
    }
    const current = (await compute(partner.id))!
    const withDecline = await persistPartnerPerformance({
      consultingFirmId: firmA.id, computation: current, decline: assessPerformanceDecline(current, prior(95)),
    })
    expect(withDecline.record.derivedLabel).toBe(DECLINE_LABEL)

    const without = await persistPartnerPerformance({
      consultingFirmId: firmA.id, computation: current, decline: assessPerformanceDecline(current, null),
    })
    expect(without.record.derivedLabel).toBeNull()
  })

  it('never records a subjective judgement label', async () => {
    const partner = await makePartner(firmA.id)
    for (let i = 0; i < 10; i += 1) {
      await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: false, accepted: false })
    }
    const current = (await compute(partner.id))!
    const { record } = await persistPartnerPerformance({
      consultingFirmId: firmA.id, computation: current, decline: assessPerformanceDecline(current, prior(100)),
    })
    for (const banned of ['GOOD_PARTNER', 'BAD_PARTNER', 'PREFERRED', 'DO_NOT_USE']) {
      expect(record.derivedLabel, banned).not.toBe(banned)
    }
  })
})

describe('prior period lookup', () => {
  it('finds only a period that ended before this one began, in the same firm', async () => {
    const partner = await makePartner(firmA.id)
    await prisma.partnerPerformanceRecord.create({
      data: {
        consultingFirmId: firmA.id, partnerId: partner.id,
        periodStart: new Date('2025-07-01T00:00:00.000Z'), periodEnd: new Date('2025-12-31T00:00:00.000Z'),
        sampleSize: 12,
      },
    })
    const found = await findPriorPeriod(firmA.id, partner.id, PERIOD_START)
    expect(found?.sampleSize).toBe(12)
    expect(await findPriorPeriod(firmB.id, partner.id, PERIOD_START)).toBeNull()
  })
})

describe('the summary refuses to imply a grade', () => {
  it('shows counts without a rate below the minimum sample', async () => {
    const partner = await makePartner(firmA.id)
    for (let i = 0; i < 3; i += 1) {
      await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: true, accepted: true })
    }
    const computation = (await compute(partner.id))!
    const { record } = await persistPartnerPerformance({
      consultingFirmId: firmA.id, computation, decline: assessPerformanceDecline(computation, null),
    })
    const summary = summarisePerformance(record)
    expect(summary.onTime).toContain('below the minimum sample — no rate stated')
    expect(summary.detail).toContain(`below the minimum sample of ${MINIMUM_SAMPLE_SIZE}`)
  })

  it('shows the fraction and the percentage once the sample supports it', async () => {
    const partner = await makePartner(firmA.id)
    for (let i = 0; i < 10; i += 1) {
      await makeDeliverable({ firmId: firmA.id, partnerId: partner.id, contractId, onTime: i < 8, accepted: true })
    }
    const computation = (await compute(partner.id))!
    const { record } = await persistPartnerPerformance({
      consultingFirmId: firmA.id, computation, decline: assessPerformanceDecline(computation, null),
    })
    expect(summarisePerformance(record).onTime).toBe('8 of 10 (80%)')
  })
})
