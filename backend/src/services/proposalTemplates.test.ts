// Proposal templates: the solicitation's format rules, each template's layout,
// page limits, and the PDF / Word files made from it.
import { describe, it, expect } from 'vitest'
import { readFormat, STANDARD_FORMAT } from './proposalFormat'
import { layoutProposal, checkPageLimits, TEMPLATES, type DocumentFacts } from './proposalTemplates'
import { renderPdf, renderDocx } from './proposalRender'

const facts = (over: Partial<DocumentFacts> = {}): DocumentFacts => ({
  opportunity: { title: 'Roof Replacement', agency: 'GSA', solicitationNumber: 'SOL-9', responseDeadline: new Date('2026-12-07T19:00:00Z'), noticeType: 'Solicitation' },
  proposalTitle: 'Roof Replacement',
  company: { name: 'Acme Roofing', uei: 'ABCDEF123456', cage: null, naicsCodes: ['238160'], setAsides: ['small business'], address: '1 Main St, Austin, TX 78701', phone: null, email: 'bids@acme.test', website: null, contact: 'Pat Lee' },
  sections: [{ title: 'Technical Approach', text: 'We replace roofs.' }, { title: 'Past Performance', text: 'VA roof, 2025.' }],
  requirements: [],
  price: { scenario: 'Base', total: 140000, detail: { labor: [{ category: 'Roofer', hours: 1000, rate: 100, amount: 100000 }], other: [], totals: [['Direct labor', 100000], ['Fee', 10000]] } },
  ...over,
})

describe('readFormat', () => {
  it("takes the solicitation's font, size, margins, spacing and page limits, saying where each came from", () => {
    const f = readFormat([
      'Proposals shall use 11-point Arial font with one-inch margins, single-spaced.',
      'The technical volume shall not exceed 15 pages. The past performance volume is limited to five (5) pages.',
      'The price volume has no page limit.',
    ])
    expect(f).toMatchObject({ font: 'Arial', pdfFont: 'Helvetica', fontSize: 11, marginsIn: 1, lineSpacing: 1 })
    expect(f.pageLimits.map((l) => [l.volume, l.pages])).toEqual([['technical', 15], ['pastPerformance', 5]])
    expect(f.sources.map((s) => s.rule)).toEqual(expect.arrayContaining(['Font: Arial', 'Font size: 11 pt', 'Margins: 1 inch', 'Page limit (technical): 15']))
  })
  it('keeps the standard format when the solicitation says nothing, and ignores placeholders', () => {
    const f = readFormat(['[EVIDENCE_NEEDED: Full text of Section L — page limits, fonts]', 'Submit by email.'])
    expect(f).toMatchObject({ ...STANDARD_FORMAT, pageLimits: [], sources: [] })
  })
  it('reads a whole-proposal limit and a "N-page limit" wording', () => {
    expect(readFormat(['The entire proposal shall not exceed 30 pages.']).pageLimits).toMatchObject([{ volume: 'total', pages: 30 }])
    expect(readFormat(['Capability statements have a 10-page limit.']).pageLimits).toMatchObject([{ volume: 'capability', pages: 10 }])
  })
})

describe('layoutProposal', () => {
  const fmt = readFormat([])
  it('lays out every template, with template 1 as the full three-volume proposal', () => {
    const parts = (key: (typeof TEMPLATES)[number]['key']) => layoutProposal(facts(), key, fmt).parts.map((p) => p.key)
    expect(parts('FULL_PROPOSAL')).toEqual(['cover', 'letter', 'technical', 'pastPerformance', 'price'])
    expect(parts('COMMERCIAL')).toEqual(['cover', 'letter', 'technical', 'price'])
    expect(parts('RFQ_QUOTE')).toEqual(['letter', 'price', 'technical'])
    expect(parts('SOURCES_SOUGHT')).toEqual(['capability'])
    expect(parts('GSA_EBUY')).toEqual(['letter', 'technical', 'price'])
  })
  it('puts past performance in its own volume, and marks what is missing', () => {
    const doc = layoutProposal(facts(), 'FULL_PROPOSAL', fmt)
    const tech = JSON.stringify(doc.parts.find((p) => p.key === 'technical'))
    expect(tech).toContain('Technical Approach')
    expect(tech).not.toContain('VA roof')
    expect(JSON.stringify(doc.parts.find((p) => p.key === 'pastPerformance'))).toContain('VA roof')
    expect(JSON.stringify(doc.parts.find((p) => p.key === 'cover'))).toContain('[CAGE CODE REQUIRED]')
  })
  it('shows only the total price when rates are hidden, and no price in a sources-sought response', () => {
    const doc = layoutProposal(facts({ price: { scenario: 'Base', total: 140000, detail: null } }), 'FULL_PROPOSAL', fmt)
    const price = JSON.stringify(doc.parts.find((p) => p.key === 'price'))
    expect(price).toContain('$140,000.00')
    expect(price).not.toContain('Roofer')
    expect(JSON.stringify(layoutProposal(facts(), 'SOURCES_SOUGHT', fmt))).not.toContain('$140,000')
  })
})

describe('rendering and page limits', () => {
  it('renders the PDF and Word file in the format, counting each part\'s pages against its limit', async () => {
    const long = { title: 'Technical Approach', text: Array.from({ length: 400 }, (_, i) => `Line ${i} of the technical approach.`).join('\n') }
    const fmt = readFormat(['The technical volume shall not exceed 2 pages.', 'Use 12-point Times New Roman.'])
    const doc = layoutProposal(facts({ sections: [long] }), 'FULL_PROPOSAL', fmt)
    const { pdf, pageCounts, totalPages } = await renderPdf(doc)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pageCounts.cover).toBe(1)
    expect(pageCounts.technical).toBeGreaterThan(2)
    expect(totalPages).toBe(Object.values(pageCounts).reduce((a, b) => a + b, 0))
    expect(checkPageLimits(doc, pageCounts).find((c) => c.part === 'technical')).toMatchObject({ limit: 2, over: true })
    const docx = await renderDocx(doc)
    expect(docx.subarray(0, 2).toString()).toBe('PK') // a .docx is a zip
  })
})
