// =============================================================
// proposalPdfBuilder — render smoke tests (FIX-6 follow-up).
//
// The per-page DRAFT watermark and confidence chips are visual; these
// tests pin the structural contract: draft and reviewed renders both
// produce valid PDFs with the expected page count, and the two renders
// genuinely differ (the watermark/stamp layers are present in one and
// not the other). Content-stream text is compressed by PDFKit, so we
// assert on structure rather than extracted text.
// =============================================================
import { describe, it, expect } from 'vitest'
import { buildProposalPdf } from './proposalPdfBuilder'
import type { ProposalDraft } from './proposalDraftService'

const DRAFT: ProposalDraft = {
  opportunityTitle: 'Enterprise Logistics Support',
  agency: 'Department of Defense',
  preparedDate: 'July 1, 2026',
  sections: [
    { title: 'Executive Summary', content: 'Grounded overview paragraph. '.repeat(20), confidence: 'HIGH' },
    { title: 'Past Performance', content: 'Thin-input section needing review. '.repeat(20), confidence: 'LOW' },
  ],
}

function pageCount(pdf: Buffer): number {
  // The page-tree root carries an authoritative /Count, written uncompressed.
  const m = pdf.toString('latin1').match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/)
    ?? pdf.toString('latin1').match(/\/Count\s+(\d+)[^>]*\/Type\s*\/Pages/)
  return m ? Number(m[1]) : -1
}

describe('buildProposalPdf — draft watermark vs reviewed render', () => {
  it('renders a valid draft PDF (cover + TOC + one page per section)', async () => {
    const pdf = await buildProposalPdf(DRAFT)
    expect(pdf.slice(0, 4).toString()).toBe('%PDF')
    expect(pageCount(pdf)).toBe(4)
  })

  it('renders a valid reviewed PDF with the same page count', async () => {
    const pdf = await buildProposalPdf(DRAFT, undefined, {
      status: 'REVIEWED',
      attestedByName: 'John Gladmon',
      attestedAt: '2026-07-01',
      statementVersion: 'v1-2026-07',
    })
    expect(pdf.slice(0, 4).toString()).toBe('%PDF')
    expect(pageCount(pdf)).toBe(4)
  })

  it('draft and reviewed renders differ (watermark + stamp layers)', async () => {
    const draftPdf = await buildProposalPdf(DRAFT)
    const finalPdf = await buildProposalPdf(DRAFT, undefined, { status: 'REVIEWED' })
    expect(draftPdf.equals(finalPdf)).toBe(false)
    // The draft carries the per-page watermark layers, so it should not be
    // smaller than the reviewed render of identical content.
    expect(draftPdf.length).toBeGreaterThan(finalPdf.length)
  })

  it('tolerates sections without confidence (older drafts)', async () => {
    const pdf = await buildProposalPdf({
      ...DRAFT,
      sections: [{ title: 'Legacy Section', content: 'Written before confidence flags existed. '.repeat(10) }],
    })
    expect(pdf.slice(0, 4).toString()).toBe('%PDF')
  })
})
