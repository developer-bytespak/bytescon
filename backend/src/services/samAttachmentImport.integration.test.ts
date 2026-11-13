// =============================================================
// Bringing a notice's solicitation documents in from SAM.gov
// (services/samAttachmentImport.ts), with SAM.gov's answers faked.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import axios from 'axios'
import { prisma } from '../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, TestFirm } from '../test-utils/testClient'

const queued: string[] = []
vi.mock('../workers/requirementExtractionWorker', () => ({ queueRequirementExtraction: async (id: string) => { queued.push(id) } }))

import { importSamAttachments, fileNameFromDisposition, safeFileName } from './samAttachmentImport'

const FILE = (id: string) => `https://sam.gov/api/prod/opps/v3/opportunities/resources/files/${id}/download?api_key=null`
const pdf = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF')
let firm: TestFirm
let other: TestFirm

const notice = (links: string[]) => prisma.opportunity.create({
  data: { consultingFirmId: firm.id, title: 'Attachment notice', agency: 'GSA', naicsCode: '238210', samNoticeId: `a-${Math.random().toString(36).slice(2)}`, resourceLinks: links, responseDeadline: new Date(Date.now() + 20 * 86_400_000) },
})

beforeAll(async () => {
  firm = await createTestFirm({ name: 'Attachment Firm' })
  other = await createTestFirm({ name: 'Other Attachment Firm' })
})
beforeEach(() => { queued.length = 0; vi.restoreAllMocks() })
afterAll(async () => {
  await cleanupFirm(firm.id)
  await cleanupFirm(other.id)
  await disconnectDb()
})

describe('importing SAM.gov attachments', () => {
  it('adds the PDF to be read, reports a restricted file, adds a Word file unread, and skips repeats', async () => {
    const o = await notice([FILE('pdf'), FILE('cui'), FILE('docx')])
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/pdf/')) return { status: 200, data: pdf, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Solicitation W912.pdf"' } }
      if (url.includes('/cui/')) return { status: 403, data: Buffer.alloc(0), headers: {} }
      return { status: 200, data: Buffer.from('PK word'), headers: { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''Pricing%20Sheet.docx" } }
    })
    const { results, queuedForReading } = await importSamAttachments(firm.id, o.id)
    expect(results.map((r) => r.outcome)).toEqual(['imported', 'restricted', 'imported'])
    expect(results[0]).toMatchObject({ fileName: 'Solicitation W912.pdf', readAutomatically: true })
    expect(results[1].message).toMatch(/upload it here/)
    expect(results[2]).toMatchObject({ fileName: 'Pricing Sheet.docx', readAutomatically: false })
    expect(queuedForReading).toBe(1)
    const docs = await prisma.opportunityDocument.findMany({ where: { opportunityId: o.id }, orderBy: { fileName: 'asc' } })
    expect(docs.map((d) => [d.fileName, d.extractionStatus])).toEqual([['Pricing Sheet.docx', 'NOT_READ'], ['Solicitation W912.pdf', 'PENDING']])
    expect(queued).toEqual([docs[1].id])
    // The same as a person's upload: the solicitation event is recorded.
    expect(await prisma.agentEvent.count({ where: { consultingFirmId: firm.id, entityId: docs[1].id } })).toBe(1)

    // Run again: nothing is added twice.
    const again = await importSamAttachments(firm.id, o.id)
    expect(again.results.filter((r) => r.outcome === 'already-added')).toHaveLength(2)
    expect(await prisma.opportunityDocument.count({ where: { opportunityId: o.id } })).toBe(2)
  })

  it('reports a file over the size limit or that fails to download, and imports nothing for another firm', async () => {
    const o = await notice([FILE('big'), FILE('down')])
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/big/')) throw Object.assign(new Error('maxContentLength size of 26214400 exceeded'), {})
      return { status: 500, data: Buffer.alloc(0), headers: {} }
    })
    const { results } = await importSamAttachments(firm.id, o.id)
    expect(results.map((r) => r.outcome)).toEqual(['too-large', 'failed'])
    expect(await importSamAttachments(other.id, o.id)).toEqual({ results: [], queuedForReading: 0 })
  })
})

describe('file names from SAM.gov', () => {
  it('reads both header forms and strips folders', () => {
    expect(fileNameFromDisposition('attachment; filename="A B.pdf"')).toBe('A B.pdf')
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''SOW%20v2.pdf")).toBe('SOW v2.pdf')
    expect(fileNameFromDisposition(null)).toBeNull()
    expect(safeFileName('../../etc/passwd', 'x')).toBe('passwd')
    expect(safeFileName(null, 'Attachment 1.pdf')).toBe('Attachment 1.pdf')
  })
})
