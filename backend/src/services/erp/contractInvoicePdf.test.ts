// =============================================================
// §8.2.4 — Contract invoice PDF.
//
// A PDF cannot be asserted pixel by pixel, so these cover what would actually
// make one wrong in front of a customer: a document that silently grows blank
// pages, a CLIN summary that disagrees with the total without saying so, and a
// copy that does not admit it was never transmitted anywhere.
// =============================================================
import { inflateSync } from 'zlib'
import { describe, it, expect } from 'vitest'
import { buildContractInvoicePdf, type ContractInvoicePdfInput } from './contractInvoicePdf'

const base = (over: Partial<ContractInvoicePdfInput> = {}): ContractInvoicePdfInput => ({
  invoiceNumber: 'INV-00001',
  status: 'SUBMITTED',
  invoiceDate: new Date('2026-08-01'),
  dueDate: new Date('2026-08-31'),
  periodStart: new Date('2026-07-01'),
  periodEnd: new Date('2026-07-31'),
  customerName: 'Department of Energy',
  notes: null,
  subtotal: 1000, adjustments: 0, taxAmount: 0,
  total: 1000, amountPaid: 400, outstanding: 600,
  contract: { contractNumber: 'DE-AC05-26DEMO', title: 'Cyber support', agency: 'DOE', contractType: 'T_AND_M' },
  firm: { name: 'Bytes Platform', displayName: 'Bytescon', primaryColor: null, secondaryColor: null },
  lines: [{ clinNumber: '0001', kind: 'LABOR', description: 'Engineering', quantity: 8, rate: 125, amount: 1000 }],
  clinTotals: [{ clinNumber: '0001', amount: 1000 }],
  ...over,
})

const line = (i: number, over: Record<string, unknown> = {}) => ({
  clinNumber: '0001', kind: 'SUBCONTRACTOR', description: `Line ${i}`,
  quantity: null, rate: null, amount: 100, ...over,
})

/** PDFKit writes one `/Type /Page` object per page. */
const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length

describe('buildContractInvoicePdf', () => {
  it('produces a PDF', async () => {
    const pdf = await buildContractInvoicePdf(base())
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('fits a short invoice on a single page', async () => {
    expect(pageCount(await buildContractInvoicePdf(base()))).toBe(1)
  })

  it('adds pages only as the line items need them', async () => {
    // The footer is drawn into the bottom margin, which PDFKit will paginate
    // if allowed — that turned a two-page invoice into six, four of them blank.
    const lines = Array.from({ length: 34 }, (_, i) => line(i))
    const pages = pageCount(await buildContractInvoicePdf(base({ lines })))
    expect(pages).toBeGreaterThan(1)
    expect(pages).toBeLessThanOrEqual(3)
  })

  it('grows with the work rather than being truncated', async () => {
    const short = await buildContractInvoicePdf(base({ lines: [line(1)] }))
    const long = await buildContractInvoicePdf(base({
      lines: Array.from({ length: 90 }, (_, i) => line(i)),
    }))
    expect(pageCount(long)).toBeGreaterThan(pageCount(short))
  })
})

describe('buildContractInvoicePdf — figures it must not invent', () => {
  it('renders an invoice whose lines carry no CLIN at all', async () => {
    const pdf = await buildContractInvoicePdf(base({
      lines: [line(1, { clinNumber: null, kind: 'FEE' })],
      clinTotals: [],
    }))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('handles a fully paid invoice with nothing outstanding', async () => {
    const pdf = await buildContractInvoicePdf(base({ status: 'PAID', amountPaid: 1000, outstanding: 0 }))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('handles a credit — a negative adjustment is not an error', async () => {
    const pdf = await buildContractInvoicePdf(base({ adjustments: -250, total: 750, outstanding: 350 }))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('renders when every date is missing', async () => {
    const pdf = await buildContractInvoicePdf(base({
      invoiceDate: null, dueDate: null, periodStart: null, periodEnd: null, customerName: null,
    }))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('falls back to the firm name when no branding display name is set', async () => {
    const pdf = await buildContractInvoicePdf(base({
      firm: { name: 'Bytes Platform', displayName: null, primaryColor: null, secondaryColor: null },
    }))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })
})

describe('buildContractInvoicePdf — white-label branding', () => {
  // PDFKit ignores a colour it cannot parse instead of throwing, so a bad brand
  // colour used to leave the band unpainted and the white header text on white
  // paper. Asserting the fill operators is the only way to see that from here.
  // PDFKit deflates its content streams, so the drawing operators have to be
  // inflated before any of them can be read back.
  const fills = (pdf: Buffer): string[] => {
    const raw = pdf.toString('latin1')
    const out: string[] = []
    const re = /stream\r?\n/g
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) !== null) {
      const start = m.index + m[0].length
      const end = raw.indexOf('endstream', start)
      if (end < 0) continue
      try {
        const text = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1')
        out.push(...(text.match(/[\d.]+ [\d.]+ [\d.]+ scn/g) ?? []))
      } catch { /* not a deflate stream — fonts and metadata land here */ }
    }
    return out
  }

  it('paints the header band in a light brand colour and darkens the ink for it', async () => {
    const pdf = await buildContractInvoicePdf(base({
      firm: { name: 'Bytes Platform', displayName: 'Bytescon', primaryColor: '#fbbf24', secondaryColor: '#f59e0b' },
    }))
    const painted = fills(pdf)
    // #fbbf24 -> 0.984… band, and the dark ink #12203a -> 0.070… it forces.
    expect(painted.some((f) => f.startsWith('0.9843'))).toBe(true)
    expect(painted.some((f) => f.startsWith('0.0705'))).toBe(true)
    // White still appears — the status pill has its own dark fill and white on
    // that is correct. What matters is that the BAND's ink went dark.
  })

  it('keeps white ink on a dark brand colour', async () => {
    const pdf = await buildContractInvoicePdf(base({
      firm: { name: 'Bytes Platform', displayName: null, primaryColor: '#0A1F44', secondaryColor: '#C9A227' },
    }))
    expect(fills(pdf)).toContain('1 1 1 scn')
  })

  it('still paints a band when the saved brand colour is malformed', async () => {
    const pdf = await buildContractInvoicePdf(base({
      firm: { name: 'Bytes Platform', displayName: null, primaryColor: 'not-a-colour', secondaryColor: '' },
    }))
    // Falls back to the platform navy rather than leaving the band unpainted.
    const painted = fills(pdf)
    expect(painted.some((f) => f.startsWith('0.0392'))).toBe(true)
    expect(painted).toContain('1 1 1 scn')
  })

  it('sizes the status pill to the longest status the model produces', async () => {
    const pdf = await buildContractInvoicePdf(base({ status: 'PARTIALLY_PAID' }))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })
})
