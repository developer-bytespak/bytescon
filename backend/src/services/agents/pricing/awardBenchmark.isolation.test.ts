// =============================================================
// §7.6 — THE cross-tenant proof.
//
// The claim: a benchmark is built from public federal award records only, so
// no other firm's private pricing can move it. This file proves that claim
// two ways.
//
// 1. BEHAVIOURALLY. Firm A's cohort is captured, then Firm B creates a wildly
//    different private scenario, changes it, and deletes it. Firm A's cohort
//    must be byte-identical at every step — same hash, same size, same
//    quartiles, same source list.
//
// 2. STRUCTURALLY. The benchmark module is scanned to prove it never queries a
//    private pricing model at all. A behavioural test can only prove the code
//    as written; the scan proves the code cannot quietly start reading one.
// =============================================================
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, type TestFirm } from '../../../test-utils/testClient'
import { buildAwardBenchmark, persistBenchmarkCohort, MIN_BENCHMARK_COHORT_SIZE } from './awardBenchmark'

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)
const DAY = 86_400_000
const NOW = new Date('2026-08-12T00:00:00.000Z')

let firmA: TestFirm
let firmB: TestFirm
let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

// A NAICS and agency no other fixture uses, so the public cohort is controlled.
const QA_NAICS = `98${String(process.pid).slice(-4).padStart(4, '0')}`
const QA_AGENCY = `S7-PRICE-QA Isolation Agency ${process.pid}`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Pricing Isolation Firm A' })
  firmB = await createTestFirm({ name: 'Pricing Isolation Firm B' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  for (const id of [firmA.id, firmB.id]) {
    await prisma.awardBenchmarkCohort.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingLaborLine.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingIndirectRate.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingOtherCost.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingScenario.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingWorkspace.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingTemplate.deleteMany({ where: { consultingFirmId: id } })
    await prisma.awardHistory.deleteMany({ where: { opportunity: { consultingFirmId: id } } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
  }
})

/** Controlled PUBLIC award values, owned by Firm A's opportunities. */
async function seedPublicAwards(amounts: string[]) {
  for (const amount of amounts) {
    const opp = await prisma.opportunity.create({
      data: {
        consultingFirmId: firmA.id, samNoticeId: uniq('S7-PRICE-QA-ISO'),
        title: 'S7-PRICE-QA public award source', agency: QA_AGENCY,
        naicsCode: QA_NAICS, setAsideType: 'SDVOSB',
        responseDeadline: new Date(NOW.getTime() - 400 * DAY),
        status: 'ARCHIVED', isDemo: false,
      },
    })
    await prisma.awardHistory.create({
      data: {
        opportunityId: opp.id, awardingAgency: QA_AGENCY, recipientName: uniq('R'),
        awardAmount: new Prisma.Decimal(amount), awardDate: new Date(NOW.getTime() - 180 * DAY),
        naics: QA_NAICS, awardType: 'DO', contractNumber: uniq('C'),
      },
    })
  }
}

/** A firm's PRIVATE pricing scenario at a chosen total. */
async function seedPrivateScenario(firmId: string, totalPrice: string) {
  const opp = await prisma.opportunity.create({
    data: {
      consultingFirmId: firmId, samNoticeId: uniq('S7-PRICE-QA-PRIV'),
      title: 'S7-PRICE-QA private pricing', agency: QA_AGENCY,
      naicsCode: QA_NAICS, setAsideType: 'SDVOSB',
      responseDeadline: new Date(NOW.getTime() + 30 * DAY),
      status: 'ACTIVE', isDemo: false,
    },
  })
  const workspace = await prisma.pricingWorkspace.create({
    data: { consultingFirmId: firmId, opportunityId: opp.id, title: 'S7-PRICE-QA workspace', status: 'DRAFT' },
  })
  const scenario = await prisma.pricingScenario.create({
    data: {
      consultingFirmId: firmId, workspaceId: workspace.id, name: 'Base',
      totalPrice: new Prisma.Decimal(totalPrice), totalDirectLabor: new Prisma.Decimal(totalPrice),
    },
  })
  await prisma.pricingLaborLine.create({
    data: {
      consultingFirmId: firmId, scenarioId: scenario.id, categoryName: 'Engineer',
      hours: new Prisma.Decimal('1000'), baseRate: new Prisma.Decimal(totalPrice).dividedBy(1000),
      directLaborAmount: new Prisma.Decimal(totalPrice),
    },
  })
  await prisma.pricingIndirectRate.create({
    data: {
      consultingFirmId: firmId, scenarioId: scenario.id, name: 'Fringe',
      rateType: 'FRINGE', percent: new Prisma.Decimal('30'), costBase: 'DIRECT_LABOUR',
    },
  })
  await prisma.pricingTemplate.create({
    data: {
      consultingFirmId: firmId, name: 'S7-PRICE-QA template',
      indirectRatesJson: [{ rateType: 'FRINGE', percent: 30, costBase: 'DIRECT_LABOUR' }],
    },
  })
  return { opportunity: opp, workspace, scenario }
}

const requestFor = (firmId: string, referencePrice: string) => ({
  consultingFirmId: firmId,
  opportunityId: null,
  pricingWorkspaceId: null,
  pricingScenarioId: null,
  naics: QA_NAICS,
  agency: QA_AGENCY,
  setAside: 'SDVOSB',
  referencePrice: D(referencePrice),
  now: NOW,
})

/** Everything about a cohort that could possibly have moved. */
const snapshot = (r: Awaited<ReturnType<typeof buildAwardBenchmark>>) => ({
  hash: r.inputHash,
  size: r.cohortSize,
  level: r.filterLevel,
  sources: [...r.sourceIds].sort(),
  min: r.distribution.minimum?.toFixed(2) ?? null,
  p25: r.distribution.p25?.toFixed(2) ?? null,
  median: r.distribution.median?.toFixed(2) ?? null,
  p75: r.distribution.p75?.toFixed(2) ?? null,
  max: r.distribution.maximum?.toFixed(2) ?? null,
  mean: r.distribution.mean?.toFixed(2) ?? null,
})

const PUBLIC_AMOUNTS = [
  '100000.00', '110000.00', '120000.00', '130000.00',
  '140000.00', '150000.00', '160000.00', '170000.00',
]

// -------------------------------------------------------------
// 1. Behavioural proof
// -------------------------------------------------------------

describe('another tenant\'s private pricing cannot move a benchmark', () => {
  it('is identical whether Firm B\'s scenario exists, changes, or is deleted', async () => {
    await seedPublicAwards(PUBLIC_AMOUNTS)

    // Firm A prices at 100,000. Firm B will price at 999,999 — an extreme
    // value that would visibly distort any distribution it reached.
    await seedPrivateScenario(firmA.id, '100000.00')

    const before = snapshot(await buildAwardBenchmark(requestFor(firmA.id, '100000.00')))
    expect(before.size).toBe(PUBLIC_AMOUNTS.length)
    expect(before.median).toBe('135000.00')

    // ---- Firm B's private scenario appears -------------------------
    const firmB1 = await seedPrivateScenario(firmB.id, '999999.00')
    const withFirmB = snapshot(await buildAwardBenchmark(requestFor(firmA.id, '100000.00')))
    expect(withFirmB).toEqual(before)

    // ---- Firm B changes it -----------------------------------------
    await prisma.pricingScenario.update({
      where: { id: firmB1.scenario.id },
      data: { totalPrice: new Prisma.Decimal('1.00'), totalDirectLabor: new Prisma.Decimal('1.00') },
    })
    await prisma.pricingLaborLine.updateMany({
      where: { scenarioId: firmB1.scenario.id },
      data: { baseRate: new Prisma.Decimal('0.001'), directLaborAmount: new Prisma.Decimal('1.00') },
    })
    const afterChange = snapshot(await buildAwardBenchmark(requestFor(firmA.id, '100000.00')))
    expect(afterChange).toEqual(before)

    // ---- Firm B deletes it ------------------------------------------
    await prisma.pricingLaborLine.deleteMany({ where: { scenarioId: firmB1.scenario.id } })
    await prisma.pricingIndirectRate.deleteMany({ where: { scenarioId: firmB1.scenario.id } })
    await prisma.pricingScenario.delete({ where: { id: firmB1.scenario.id } })
    await prisma.pricingWorkspace.delete({ where: { id: firmB1.workspace.id } })
    const afterDelete = snapshot(await buildAwardBenchmark(requestFor(firmA.id, '100000.00')))
    expect(afterDelete).toEqual(before)
  })

  it('produces the same cohort hash across all three states', async () => {
    await seedPublicAwards(PUBLIC_AMOUNTS)
    const first = (await buildAwardBenchmark(requestFor(firmA.id, '100000.00'))).inputHash

    const b = await seedPrivateScenario(firmB.id, '999999.00')
    expect((await buildAwardBenchmark(requestFor(firmA.id, '100000.00'))).inputHash).toBe(first)

    await prisma.pricingScenario.update({ where: { id: b.scenario.id }, data: { totalPrice: new Prisma.Decimal('42.00') } })
    expect((await buildAwardBenchmark(requestFor(firmA.id, '100000.00'))).inputHash).toBe(first)
  })

  it('never lists a private scenario id among the cohort sources', async () => {
    await seedPublicAwards(PUBLIC_AMOUNTS)
    const b = await seedPrivateScenario(firmB.id, '999999.00')
    const r = await buildAwardBenchmark(requestFor(firmA.id, '100000.00'))

    expect(r.sourceIds).not.toContain(b.scenario.id)
    expect(r.sourceIds).not.toContain(b.workspace.id)
    for (const award of r.included) {
      expect(award.awardAmount.toFixed(2)).not.toBe('999999.00')
    }
  })

  it('never lets a private price reach the distribution', async () => {
    await seedPublicAwards(PUBLIC_AMOUNTS)
    await seedPrivateScenario(firmB.id, '999999.00')
    await seedPrivateScenario(firmA.id, '888888.00')

    const r = await buildAwardBenchmark(requestFor(firmA.id, '100000.00'))
    // Even the CURRENT firm's own scenario is compared against the cohort,
    // never added to it.
    expect(r.distribution.maximum!.toFixed(2)).toBe('170000.00')
    expect(r.cohortSize).toBe(PUBLIC_AMOUNTS.length)
  })

  it('gives two firms the same public cohort, because the awards are public', async () => {
    await seedPublicAwards(PUBLIC_AMOUNTS)
    const a = snapshot(await buildAwardBenchmark(requestFor(firmA.id, '100000.00')))
    const b = snapshot(await buildAwardBenchmark(requestFor(firmB.id, '100000.00')))
    expect(b).toEqual(a)
  })

  it('scopes the CACHED cohort to the firm that requested it', async () => {
    await seedPublicAwards(PUBLIC_AMOUNTS)
    const result = await buildAwardBenchmark(requestFor(firmA.id, '100000.00'))
    await persistBenchmarkCohort({
      consultingFirmId: firmA.id, result, opportunityId: null, pricingWorkspaceId: null, pricingScenarioId: null,
    })

    expect(await prisma.awardBenchmarkCohort.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
    expect(await prisma.awardBenchmarkCohort.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })

  it('holds even when the cohort is below the minimum', async () => {
    await seedPublicAwards(['100000.00', '110000.00'])
    const before = snapshot(await buildAwardBenchmark(requestFor(firmA.id, '100000.00')))
    expect(before.size).toBeLessThan(MIN_BENCHMARK_COHORT_SIZE)

    await seedPrivateScenario(firmB.id, '105000.00')
    expect(snapshot(await buildAwardBenchmark(requestFor(firmA.id, '100000.00')))).toEqual(before)
  })
})

// -------------------------------------------------------------
// 2. Structural proof
// -------------------------------------------------------------

describe('the benchmark module cannot read private pricing', () => {
  const source = () => readFileSync(join(__dirname, 'awardBenchmark.ts'), 'utf8')

  /** Source with comments stripped, so the scan tests code and not prose. */
  const code = () =>
    source()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it.each([
    'pricingWorkspace',
    'pricingScenario',
    'pricingLaborLine',
    'pricingIndirectRate',
    'pricingOtherCost',
    'pricingTemplate',
    'contractLaborRate',
  ])('never queries prisma.%s', (model) => {
    expect(new RegExp(`prisma\\.${model}\\b`).test(code()), model).toBe(false)
  })

  it('queries exactly one evidence model — awardHistory', () => {
    const queried = [...code().matchAll(/prisma\.(\w+)\./g)].map((m) => m[1])
    expect([...new Set(queried)].sort()).toEqual(['awardBenchmarkCohort', 'awardHistory'])
  })

  it('reads the cohort cache only under an explicit firm scope', () => {
    // The cache is tenant-scoped; the evidence query deliberately is not,
    // because public awards are public.
    expect(code()).toContain('consultingFirmId_inputHash')
  })

  it('states the public-only rule in its own header', () => {
    expect(source()).toContain('PUBLIC FEDERAL AWARD RECORDS ONLY')
  })
})
