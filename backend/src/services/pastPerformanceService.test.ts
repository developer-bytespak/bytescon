// =============================================================
// pastPerformanceService — unit tests
//
// Covers: CPARS→score mapping, opportunity-relevance matching
// (NAICS exact / group / sector / agency, format-tolerant), the
// relevance aggregate used by scoring, and the create-only,
// idempotent auto-capture from a WON submission.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted so these fns exist before the hoisted vi.mock factory runs.
const { findUnique, create, findMany, update, updateMany } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
}))

vi.mock('../config/database', () => ({
  prisma: {
    pastPerformanceRecord: { findUnique, create, findMany, update, updateMany },
  },
}))
vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  cparsRatingToScore,
  isRecordRelevant,
  getRelevantPastPerformance,
  getRelevantPastPerformanceCached,
  getRelevantPastPerformanceRecords,
  autoCaptureFromWonSubmission,
  retractAutoCapturedRecord,
} from './pastPerformanceService'

beforeEach(() => {
  findUnique.mockReset()
  create.mockReset()
  findMany.mockReset()
  update.mockReset()
  updateMany.mockReset()
})

describe('cparsRatingToScore', () => {
  it('maps ratings to a monotonic 0-100 scale with SATISFACTORY at the 50 baseline', () => {
    expect(cparsRatingToScore('EXCEPTIONAL')).toBe(100)
    expect(cparsRatingToScore('VERY_GOOD')).toBe(80)
    expect(cparsRatingToScore('SATISFACTORY')).toBe(50)
    expect(cparsRatingToScore('MARGINAL')).toBe(30)
    expect(cparsRatingToScore('UNSATISFACTORY')).toBe(10)
  })

  it('returns null for unknown / missing ratings', () => {
    expect(cparsRatingToScore(null)).toBeNull()
    expect(cparsRatingToScore(undefined)).toBeNull()
    expect(cparsRatingToScore('GREAT')).toBeNull()
  })
})

describe('isRecordRelevant', () => {
  const rec = (relevanceTags: string[], customerAgency: string | null = null) => ({
    relevanceTags,
    customerAgency,
  })

  it('matches on an exact NAICS tag', () => {
    expect(isRecordRelevant(rec(['541512']), { naicsCode: '541512' })).toBe(true)
  })

  it('matches on the 4-digit NAICS group', () => {
    expect(isRecordRelevant(rec(['541519']), { naicsCode: '541512' })).toBe(true)
  })

  it('matches on the 2-digit sector', () => {
    expect(isRecordRelevant(rec(['541330']), { naicsCode: '541512' })).toBe(true)
  })

  it('is tolerant of formatting in tags and the opportunity NAICS', () => {
    expect(isRecordRelevant(rec(['54-1512']), { naicsCode: '541512' })).toBe(true)
  })

  it('matches on agency when NAICS does not', () => {
    expect(
      isRecordRelevant(rec(['111110'], 'Department of Veterans Affairs'), {
        naicsCode: '541512',
        agency: 'department of veterans affairs',
      })
    ).toBe(true)
  })

  it('does not match an unrelated NAICS sector and agency', () => {
    expect(
      isRecordRelevant(rec(['111110'], 'USDA'), { naicsCode: '541512', agency: 'GSA' })
    ).toBe(false)
  })

  it('ignores PSC-like short numeric tags (no cross-namespace false match)', () => {
    // PSC "5410" shares leading "54" with NAICS 541512 but is only 4 digits,
    // so it must NOT be treated as a NAICS and must not match.
    expect(isRecordRelevant(rec(['5410']), { naicsCode: '541512' })).toBe(false)
    expect(isRecordRelevant(rec(['425']), { naicsCode: '423110' })).toBe(false)
  })
})

describe('getRelevantPastPerformance', () => {
  it('counts only relevant records and averages CPARS over rated matches', async () => {
    findMany.mockResolvedValue([
      { relevanceTags: ['541512'], customerAgency: 'GSA', cparsRating: 'EXCEPTIONAL' }, // match, 100
      { relevanceTags: ['541519'], customerAgency: null, cparsRating: null }, // match, unrated
      { relevanceTags: ['111110'], customerAgency: 'USDA', cparsRating: 'VERY_GOOD' }, // no match
    ])

    const out = await getRelevantPastPerformance('firm1', 'client1', {
      naicsCode: '541512',
      agency: 'GSA',
    })

    expect(out.matchedCount).toBe(2)
    expect(out.avgCparsScore).toBe(100) // only the rated match contributes
  })

  it('returns matchedCount 0 / null average when nothing is relevant', async () => {
    findMany.mockResolvedValue([
      { relevanceTags: ['111110'], customerAgency: 'USDA', cparsRating: 'EXCEPTIONAL' },
    ])
    const out = await getRelevantPastPerformance('firm1', null, { naicsCode: '541512' })
    expect(out.matchedCount).toBe(0)
    expect(out.avgCparsScore).toBeNull()
  })
})

describe('autoCaptureFromWonSubmission', () => {
  const opportunity = {
    id: 'opp-1234567890',
    samNoticeId: 'NOTICE123',
    title: 'IT Support Services',
    agency: 'General Services Administration',
    subagency: 'FAS',
    naicsCode: '541512',
    psc: 'D399',
    estimatedValue: 1_500_000,
    description: 'Provide enterprise IT support.',
  }

  it('creates a record (create-only) when none exists, deriving fields from the opportunity', async () => {
    findUnique.mockResolvedValue(null)
    create.mockResolvedValue({ id: 'pp-1' })

    await autoCaptureFromWonSubmission({
      submissionRecordId: 'sub-1',
      consultingFirmId: 'firm-1',
      clientCompanyId: 'client-1',
      opportunity,
    })

    expect(create).toHaveBeenCalledTimes(1)
    const data = create.mock.calls[0][0].data
    expect(data.sourceSubmissionRecordId).toBe('sub-1')
    expect(data.contractNumber).toBe('SAM-NOTICE123')
    expect(data.customerName).toBe('General Services Administration')
    expect(data.customerAgency).toBe('FAS')
    // Only NAICS seeds relevanceTags; PSC is excluded to avoid false matches.
    expect(data.relevanceTags).toEqual(['541512'])
    expect(data.totalValue).toBe('1500000')
  })

  it('is idempotent — does not create or touch an existing active record', async () => {
    findUnique.mockResolvedValue({ id: 'pp-existing', isCurrent: true })

    await autoCaptureFromWonSubmission({
      submissionRecordId: 'sub-1',
      consultingFirmId: 'firm-1',
      clientCompanyId: 'client-1',
      opportunity,
    })

    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('reactivates a retracted record on re-WON instead of duplicating', async () => {
    findUnique.mockResolvedValue({ id: 'pp-existing', isCurrent: false })
    update.mockResolvedValue({ id: 'pp-existing' })

    await autoCaptureFromWonSubmission({
      submissionRecordId: 'sub-1',
      consultingFirmId: 'firm-1',
      clientCompanyId: 'client-1',
      opportunity,
    })

    expect(create).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { id: 'pp-existing' },
      data: { isCurrent: true },
    })
  })

  it('falls back to a WON- contract number when the opportunity has no SAM notice id', async () => {
    findUnique.mockResolvedValue(null)
    create.mockResolvedValue({ id: 'pp-2' })

    await autoCaptureFromWonSubmission({
      submissionRecordId: 'sub-2',
      consultingFirmId: 'firm-1',
      clientCompanyId: 'client-1',
      opportunity: { ...opportunity, samNoticeId: null },
    })

    const data = create.mock.calls[0][0].data
    expect(data.contractNumber).toBe('WON-opp-1234')
  })
})

describe('retractAutoCapturedRecord', () => {
  it('deactivates the auto-captured record for the submission, tenant-scoped', async () => {
    updateMany.mockResolvedValue({ count: 1 })

    await retractAutoCapturedRecord('sub-1', 'firm-1')

    expect(updateMany).toHaveBeenCalledTimes(1)
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: { sourceSubmissionRecordId: 'sub-1', consultingFirmId: 'firm-1', isCurrent: true },
      data: { isCurrent: false },
    })
  })

  it('is a no-op (no throw) when there is nothing to retract', async () => {
    updateMany.mockResolvedValue({ count: 0 })
    await expect(retractAutoCapturedRecord('sub-x', 'firm-1')).resolves.toBeUndefined()
  })
})

describe('getRelevantPastPerformanceCached', () => {
  it("fetches a client's records once across multiple opportunities (N×M → ~M)", async () => {
    findMany.mockResolvedValue([
      { relevanceTags: ['541512'], customerAgency: 'GSA', cparsRating: 'EXCEPTIONAL' },
      { relevanceTags: ['111110'], customerAgency: 'USDA', cparsRating: 'VERY_GOOD' },
    ])
    const cache = new Map()
    const a = await getRelevantPastPerformanceCached('firm-1', 'client-1', { naicsCode: '541512' }, cache)
    const b = await getRelevantPastPerformanceCached('firm-1', 'client-1', { naicsCode: '111110' }, cache)

    expect(findMany).toHaveBeenCalledTimes(1) // deduped: one read for the client
    expect(a.matchedCount).toBe(1) // only the 541512 record is relevant to opp A
    expect(b.matchedCount).toBe(1) // only the 111110 record is relevant to opp B
  })

  it('keeps separate cache entries per client', async () => {
    findMany.mockResolvedValue([])
    const cache = new Map()
    await getRelevantPastPerformanceCached('firm-1', 'client-1', { naicsCode: '1' }, cache)
    await getRelevantPastPerformanceCached('firm-1', 'client-2', { naicsCode: '1' }, cache)
    expect(findMany).toHaveBeenCalledTimes(2) // distinct clients → distinct reads
  })

  it('evicts a rejected read so the next pair retries (no cache poisoning)', async () => {
    findMany
      .mockRejectedValueOnce(new Error('transient db'))
      .mockResolvedValue([{ relevanceTags: ['541512'], customerAgency: null, cparsRating: 'EXCEPTIONAL' }])
    const cache = new Map()
    // First read fails and must NOT leave a poisoned (rejected) entry behind.
    await expect(
      getRelevantPastPerformanceCached('firm-1', 'client-1', { naicsCode: '541512' }, cache)
    ).rejects.toThrow('transient db')
    // Next pair for the same client re-fetches and succeeds.
    const out = await getRelevantPastPerformanceCached('firm-1', 'client-1', { naicsCode: '541512' }, cache)
    expect(findMany).toHaveBeenCalledTimes(2)
    expect(out.matchedCount).toBe(1)
  })

  it('uses a tenant-scoped key (same client id under a different firm is a distinct entry)', async () => {
    findMany.mockResolvedValue([])
    const cache = new Map()
    await getRelevantPastPerformanceCached('firm-A', 'client-1', { naicsCode: '1' }, cache)
    await getRelevantPastPerformanceCached('firm-B', 'client-1', { naicsCode: '1' }, cache)
    expect(findMany).toHaveBeenCalledTimes(2) // different firms → no cross-tenant cache hit
  })

  it('shares one in-flight read for concurrent calls on the same client', async () => {
    findMany.mockResolvedValue([{ relevanceTags: ['541512'], customerAgency: null, cparsRating: null }])
    const cache = new Map()
    // Fire both before awaiting — the Promise-in-cache must coalesce them.
    const [a, b] = await Promise.all([
      getRelevantPastPerformanceCached('firm-1', 'client-1', { naicsCode: '541512' }, cache),
      getRelevantPastPerformanceCached('firm-1', 'client-1', { naicsCode: '541512' }, cache),
    ])
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(a.matchedCount).toBe(1)
    expect(b.matchedCount).toBe(1)
  })
})

describe('getRelevantPastPerformanceRecords', () => {
  const opp = { naicsCode: '541512' }
  const rec = (o: Record<string, unknown>) => ({
    contractNumber: '?',
    customerName: '?',
    customerAgency: null,
    contractType: null,
    totalValue: null,
    periodOfPerformanceStart: null,
    periodOfPerformanceEnd: null,
    cparsRating: null,
    scopeSummary: '',
    relevanceTags: [],
    ...o,
  })

  it('orders relevant-first, then by CPARS, then recency', async () => {
    findMany.mockResolvedValue([
      rec({ contractNumber: 'A', relevanceTags: ['541512'], cparsRating: 'SATISFACTORY', periodOfPerformanceEnd: new Date('2020-01-01') }),
      rec({ contractNumber: 'B', relevanceTags: ['111110'], cparsRating: 'EXCEPTIONAL', periodOfPerformanceEnd: new Date('2023-01-01') }),
      rec({ contractNumber: 'C', relevanceTags: ['541519'], cparsRating: 'EXCEPTIONAL', periodOfPerformanceEnd: new Date('2021-01-01') }),
    ])
    const out = await getRelevantPastPerformanceRecords('firm-1', 'client-1', opp)
    expect(out.map((r) => r.contractNumber)).toEqual(['C', 'A', 'B'])
    expect(out[0].relevant).toBe(true)
    expect(out[2].relevant).toBe(false)
  })

  it('caps at the limit', async () => {
    findMany.mockResolvedValue([
      rec({ contractNumber: 'A', relevanceTags: ['541512'] }),
      rec({ contractNumber: 'B', relevanceTags: ['541512'] }),
      rec({ contractNumber: 'C', relevanceTags: ['541512'] }),
    ])
    const out = await getRelevantPastPerformanceRecords('firm-1', 'client-1', opp, 2)
    expect(out).toHaveLength(2)
  })

  it('scopes to firm-level records (clientCompanyId IS NULL) when null is passed', async () => {
    findMany.mockResolvedValue([])
    await getRelevantPastPerformanceRecords('firm-1', null, opp)
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      consultingFirmId: 'firm-1',
      isCurrent: true,
      clientCompanyId: null,
    })
  })

  it('scopes to a specific client when an id is passed', async () => {
    findMany.mockResolvedValue([])
    await getRelevantPastPerformanceRecords('firm-1', 'client-1', opp)
    expect(findMany.mock.calls[0][0].where).toMatchObject({ clientCompanyId: 'client-1' })
  })
})
