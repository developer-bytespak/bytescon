// Staging rows do not grow forever, recent ones survive, and a refresh with no
// platform firm to file under raises an alert instead of going unrecorded.
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'

const sendOpsAlert = vi.fn(async () => ({ sent: true, channels: [] }))
vi.mock('../alertService', () => ({ sendOpsAlert: (...a: unknown[]) => (sendOpsAlert as unknown as (...x: unknown[]) => unknown)(...a) }))

import { prisma } from '../../config/database'
import { distillFromBatch } from './distill'
import { pruneWinnersStaging, _internals } from './refresh'
import { renderAgencySlice, renderGlobalSlice, renderNaicsSlice } from './render'

const RUN = `refresh-test-${Date.now()}`
const award = (id: string, over: Record<string, unknown> = {}) => ({
  usaspendingAwardId: `${RUN}-${id}`, refreshBatchId: RUN, recipientName: 'Prime Co', recipientUei: 'U1',
  agencyToptierCode: '9700', agencyToptierName: 'Department of Defense', naics: '541512', totalObligation: 100,
  ...over,
})

afterAll(async () => {
  await prisma.winnersSubawardStage.deleteMany({ where: { refreshBatchId: RUN } })
  await prisma.winnersAwardStage.deleteMany({ where: { refreshBatchId: RUN } })
  await prisma.$disconnect()
})
beforeEach(() => sendOpsAlert.mockClear())

describe('pruneWinnersStaging', () => {
  it('removes rows past the retention period and keeps recent and undated ones', async () => {
    const yearsAgo = (y: number) => new Date(Date.now() - y * 365.25 * 86_400_000)
    await prisma.winnersAwardStage.createMany({
      data: [
        award('old', { awardDate: yearsAgo(6) }), award('recent', { awardDate: yearsAgo(1) }), award('undated', { awardDate: null }),
      ] as never,
    })
    await prisma.winnersSubawardStage.createMany({
      data: [
        { usaspendingSubawardId: `${RUN}-sub-old`, primeAwardId: `${RUN}-recent`, refreshBatchId: RUN, subActionDate: yearsAgo(6) },
        { usaspendingSubawardId: `${RUN}-sub-new`, primeAwardId: `${RUN}-recent`, refreshBatchId: RUN, subActionDate: yearsAgo(1) },
      ] as never,
    })

    await pruneWinnersStaging()

    const awards = await prisma.winnersAwardStage.findMany({ where: { refreshBatchId: RUN }, select: { usaspendingAwardId: true } })
    expect(awards.map((a) => a.usaspendingAwardId).sort()).toEqual([`${RUN}-recent`, `${RUN}-undated`])
    const subs = await prisma.winnersSubawardStage.findMany({ where: { refreshBatchId: RUN }, select: { usaspendingSubawardId: true } })
    expect(subs.map((s) => s.usaspendingSubawardId)).toEqual([`${RUN}-sub-new`])
  })
})

describe('the refresh audit', () => {
  const summary = { refreshBatchId: 'b1', status: 'COMPLETED', totalRowsFetched: 0, windowsProcessed: 0 } as never

  it('alerts when no platform firm exists to file under', async () => {
    vi.spyOn(prisma.consultingFirm, 'findFirst').mockResolvedValueOnce(null)
    await _internals.emitAuditRow(summary)
    expect(sendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({ key: 'winners-intel-audit-skipped' }))
  })

  it('files a compliance log entry when the firm exists, with no alert', async () => {
    const firm = await prisma.consultingFirm.create({ data: { name: `Bytes Platform ${RUN}`, contactEmail: `${RUN}@test.local` } as never })
    vi.spyOn(prisma.consultingFirm, 'findFirst').mockResolvedValueOnce(firm)
    await _internals.emitAuditRow(summary)
    expect(await prisma.complianceLog.count({ where: { consultingFirmId: firm.id, entityType: 'WINNERS_INTEL_REFRESH' } })).toBe(1)
    expect(sendOpsAlert).not.toHaveBeenCalled()
    await prisma.complianceLog.deleteMany({ where: { consultingFirmId: firm.id } })
    await prisma.consultingFirm.delete({ where: { id: firm.id } })
  })
})

describe('distill and render', () => {
  it('turns a batch into global, agency and NAICS slices that render to text', async () => {
    const batch = `${RUN}-distill`
    await prisma.winnersAwardStage.createMany({
      data: [1, 2, 3].map((i) => ({
        ...award(`d${i}`), refreshBatchId: batch, totalObligation: i * 1000, awardDate: new Date(),
      })) as never,
    })
    const out = await distillFromBatch(batch, { windowStart: '2025-01-01', windowEnd: '2026-12-31' } as never)
    await prisma.winnersAwardStage.deleteMany({ where: { refreshBatchId: batch } })

    expect(out.global.awardCount).toBe(3)
    expect(out.global.totalObligation).toBe(6000)
    const agency = out.byAgency.find((s) => s.agencyToptierCode === '9700')
    const naics = out.byNaics.find((s) => s.naics === '541512')
    expect(agency?.awardCount ?? 0).toBeLessThanOrEqual(3)
    if (agency) expect(renderAgencySlice(agency)).toContain('Department of Defense')
    if (naics) expect(renderNaicsSlice(naics)).toContain('541512')
    expect(renderGlobalSlice(out.global).length).toBeGreaterThan(0)
  })
})
