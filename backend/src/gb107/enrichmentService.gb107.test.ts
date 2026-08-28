import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { prisma } from '../config/database'
import { redis } from '../config/redis'
import { logger } from '../utils/logger'
import { GB107_STATUS, GB107_EXTRACTION_METHOD } from './types.gb107'

vi.mock('./samDescriptionClient.gb107', () => ({
  fetchNoticeDescription: vi.fn(),
  fetchNoticeLinks: vi.fn(),
}))

import { fetchNoticeDescription } from './samDescriptionClient.gb107'
import { enrichOpportunityDescription } from './enrichmentService.gb107'

const fetchMock = vi.mocked(fetchNoticeDescription)

const SOLICITATION_HTML =
  '<h2>Scope</h2><p>The contractor shall comply with FAR 52.212-1 and FAR 52.212-4.</p>' +
  '<p>DFARS 252.204-7012 applies. Award will be made on a best value basis.</p>' +
  '<p>Quotes are due no later than 3:00 PM CT. Period of performance is 12 months.</p>' +
  '<script>alert("evil")</script>'

const deps = { prisma, redis, logger }

const suffix = randomUUID().slice(0, 8)
let firmId: string
let secondFirmId: string
const todayKeys = () => {
  const day = new Date().toISOString().slice(0, 10)
  return [`gb107:sam:count:${day}`, `gb107:sam:halt:${day}`, 'gb107:sam:lastCall']
}

async function createOpportunity(samNoticeId: string | null, ownerFirmId?: string): Promise<string> {
  const opp = await prisma.opportunity.create({
    data: {
      consultingFirmId: ownerFirmId ?? firmId,
      samNoticeId,
      title: `GB107 Test Opp ${randomUUID().slice(0, 8)}`,
      agency: 'Dept of Testing',
      naicsCode: '484121',
      setAsideType: 'SDVOSB',
      description: samNoticeId
        ? `https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=${samNoticeId}`
        : null,
      postedDate: new Date(),
      responseDeadline: new Date(Date.now() + 14 * 86400000),
      status: 'ACTIVE',
      marketCategory: 'SERVICES',
    },
    select: { id: true },
  })
  return opp.id
}

beforeAll(async () => {
  process.env.SAM_GOV_API_KEY = 'test-key-gb107'
  process.env.ENRICHMENT_RATE_LIMIT_BURST_INTERVAL_MS = '0'
  const firm = await prisma.consultingFirm.create({
    data: {
      name: `GB107 Test Firm ${suffix}`,
      contactEmail: `gb107-${suffix}@example.com`,
    },
    select: { id: true },
  })
  firmId = firm.id
  const secondFirm = await prisma.consultingFirm.create({
    data: {
      name: `GB107 Sibling Firm ${suffix}`,
      contactEmail: `gb107-sibling-${suffix}@example.com`,
    },
    select: { id: true },
  })
  secondFirmId = secondFirm.id
})

afterAll(async () => {
  delete process.env.SAM_GOV_API_KEY
  delete process.env.ENRICHMENT_RATE_LIMIT_BURST_INTERVAL_MS
  await prisma.auditEvent.deleteMany({ where: { consultingFirmId: { in: [firmId, secondFirmId] } } })
  await prisma.consultingFirm.deleteMany({ where: { id: { in: [firmId, secondFirmId] } } })
  await redis.del(...todayKeys())
})

describe('GB-107 enrichment service (real DB + Redis, mocked SAM client)', () => {
  it('fetches, sanitizes, stores, extracts clauses into the matrix, audits, and invalidates the score', async () => {
    const noticeId = `notice-${suffix}-a`
    const oppId = await createOpportunity(noticeId)
    fetchMock.mockResolvedValueOnce({ ok: true, html: SOLICITATION_HTML })

    const outcome = await enrichOpportunityDescription(deps, oppId)

    expect(outcome.status).toBe(GB107_STATUS.COMPLETED)
    expect(outcome.source).toBe('api')

    const opp = await prisma.opportunity.findUnique({
      where: { id: oppId },
      select: {
        description: true,
        descriptionHtml: true,
        descriptionEnrichmentStatus: true,
        descriptionEnrichedAt: true,
        extractedClauses: true,
        isScored: true,
      },
    })
    expect(opp?.descriptionEnrichmentStatus).toBe(GB107_STATUS.COMPLETED)
    expect(opp?.descriptionEnrichedAt).toBeInstanceOf(Date)
    // The URL pointer is replaced with real solicitation text.
    expect(opp?.description).not.toMatch(/^https?:\/\//)
    expect(opp?.description).toContain('52.212-1')
    expect(opp?.descriptionHtml).not.toContain('script')
    const clauses = opp?.extractedClauses as { far: string[]; dfars: string[] }
    expect(clauses.far).toContain('52.212-1')
    expect(clauses.dfars).toContain('252.204-7012')
    expect(opp?.isScored).toBe(false)

    const matrix = await prisma.complianceMatrix.findUnique({
      where: { opportunityId: oppId },
      include: { requirements: true },
    })
    expect(matrix).not.toBeNull()
    const gb107Rows = matrix!.requirements.filter(
      (r) => r.extractionMethod === GB107_EXTRACTION_METHOD,
    )
    expect(gb107Rows.length).toBeGreaterThanOrEqual(4)
    expect(gb107Rows.some((r) => r.farReference === '52.212-1')).toBe(true)

    const audit = await prisma.auditEvent.findFirst({
      where: {
        consultingFirmId: firmId,
        entityType: 'OpportunityDescriptionEnrichment',
        entityId: oppId,
      },
    })
    expect(audit).not.toBeNull()
    const after = audit?.afterJson as { textSha256?: string }
    expect(after?.textSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is idempotent: a COMPLETED row returns without refetching', async () => {
    const noticeId = `notice-${suffix}-b`
    const oppId = await createOpportunity(noticeId)
    fetchMock.mockResolvedValueOnce({ ok: true, html: SOLICITATION_HTML })
    await enrichOpportunityDescription(deps, oppId)

    fetchMock.mockClear()
    const second = await enrichOpportunityDescription(deps, oppId)
    expect(second.status).toBe(GB107_STATUS.COMPLETED)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('copies from a sibling row with the same samNoticeId without an API call', async () => {
    const noticeId = `notice-${suffix}-c`
    const firstOpp = await createOpportunity(noticeId)
    fetchMock.mockResolvedValueOnce({ ok: true, html: SOLICITATION_HTML })
    await enrichOpportunityDescription(deps, firstOpp)

    // Same public notice ingested under a different tenant — the realistic
    // sibling shape (opportunities are unique per [consultingFirmId, samNoticeId]).
    const secondOpp = await createOpportunity(noticeId, secondFirmId)
    fetchMock.mockClear()
    const outcome = await enrichOpportunityDescription(deps, secondOpp)

    expect(outcome.status).toBe(GB107_STATUS.COMPLETED)
    expect(outcome.source).toBe('sibling-copy')
    expect(fetchMock).not.toHaveBeenCalled()

    const copied = await prisma.opportunity.findUnique({
      where: { id: secondOpp },
      select: { description: true },
    })
    expect(copied?.description).toContain('52.212-1')
  })

  it('marks NOT_FOUND terminal when SAM returns 404', async () => {
    const oppId = await createOpportunity(`notice-${suffix}-d`)
    fetchMock.mockResolvedValueOnce({
      ok: false,
      kind: 'NOT_FOUND',
      message: 'Notice not found on SAM.gov (may be archived)',
      status: 404,
    })

    const outcome = await enrichOpportunityDescription(deps, oppId)
    expect(outcome.status).toBe(GB107_STATUS.NOT_FOUND)

    const opp = await prisma.opportunity.findUnique({
      where: { id: oppId },
      select: { descriptionEnrichmentStatus: true, descriptionEnrichmentError: true },
    })
    expect(opp?.descriptionEnrichmentStatus).toBe(GB107_STATUS.NOT_FOUND)
    expect(opp?.descriptionEnrichmentError).toContain('not found')
  })

  it('restores QUEUED and halts the day when SAM rate-limits', async () => {
    const oppId = await createOpportunity(`notice-${suffix}-e`)
    fetchMock.mockResolvedValueOnce({
      ok: false,
      kind: 'RATE_LIMITED',
      message: 'SAM.gov returned 429 — quota exhausted or key rejected',
      status: 429,
    })

    const outcome = await enrichOpportunityDescription(deps, oppId)
    expect(outcome.status).toBe(GB107_STATUS.RATE_LIMITED)

    const opp = await prisma.opportunity.findUnique({
      where: { id: oppId },
      select: { descriptionEnrichmentStatus: true },
    })
    // Restored to QUEUED so it retries after the halt clears.
    expect(opp?.descriptionEnrichmentStatus).toBe(GB107_STATUS.QUEUED)

    const day = new Date().toISOString().slice(0, 10)
    expect(await redis.get(`gb107:sam:halt:${day}`)).toBe('1')
    await redis.del(`gb107:sam:halt:${day}`)
  })

  it('skips gracefully (stays QUEUED) when no SAM.gov key is configured', async () => {
    const oppId = await createOpportunity(`notice-${suffix}-f`)
    const savedKey = process.env.SAM_GOV_API_KEY
    const savedFallback = process.env.SAM_API_KEY
    delete process.env.SAM_GOV_API_KEY
    delete process.env.SAM_API_KEY
    try {
      fetchMock.mockClear()
      const outcome = await enrichOpportunityDescription(deps, oppId)
      expect(outcome.status).toBe(GB107_STATUS.QUEUED)
      expect(outcome.message).toContain('No SAM.gov API key configured')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      process.env.SAM_GOV_API_KEY = savedKey
      if (savedFallback !== undefined) process.env.SAM_API_KEY = savedFallback
    }
  })

  it('falls back to SAM_API_KEY when SAM_GOV_API_KEY is unset', async () => {
    const oppId = await createOpportunity(`notice-${suffix}-g`)
    const savedKey = process.env.SAM_GOV_API_KEY
    delete process.env.SAM_GOV_API_KEY
    process.env.SAM_API_KEY = 'fallback-key-gb107'
    try {
      fetchMock.mockResolvedValueOnce({ ok: true, html: SOLICITATION_HTML })
      const outcome = await enrichOpportunityDescription(deps, oppId)
      expect(outcome.status).toBe(GB107_STATUS.COMPLETED)
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      process.env.SAM_GOV_API_KEY = savedKey
      delete process.env.SAM_API_KEY
    }
  })

  it('fails rows that have no samNoticeId', async () => {
    const oppId = await createOpportunity(null)
    const outcome = await enrichOpportunityDescription(deps, oppId)
    expect(outcome.status).toBe(GB107_STATUS.FAILED)
    expect(outcome.message).toContain('samNoticeId')
  })
})
