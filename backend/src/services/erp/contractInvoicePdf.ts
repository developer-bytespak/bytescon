// =============================================================
// §8.2.4 — Contract invoice PDF.
//
// A GOVERNMENT invoice, which is a different document from the platform's own
// subscription invoice in `invoicePdfBuilder.ts`. That one bills a firm for
// using Bytescon. This one bills an agency against a contract, so it must
// carry the contract number, the period of performance and — the part that
// decides whether it gets paid — the CLIN each line bills against.
//
// The CLIN breakdown is repeated as its own summary block because that is the
// figure a contracting officer reconciles against their obligation, and asking
// them to add up line items by hand is how an invoice comes back rejected.
//
// Every figure is passed in already computed. Nothing is recalculated here: a
// renderer that does arithmetic is a second source of truth for the same
// numbers, and the two drift.
// =============================================================
import PDFDocument from 'pdfkit'

const WHITE = '#ffffff'
const TEXT = '#1a202c'
const MID_GRAY = '#4a5568'
const LIGHT_GRAY = '#e2e8f0'
const ZEBRA = '#f7f8fa'
const NAVY = '#0A1F44'
const GOLD = '#C9A227'

const PAGE_MARGIN = 54
/** Reserved for the footer rule and its text, so no row is drawn over it. */
const FOOTER_RESERVE = 76

export interface ContractInvoicePdfInput {
  invoiceNumber: string
  status: string
  invoiceDate: Date | null
  dueDate: Date | null
  periodStart: Date | null
  periodEnd: Date | null
  customerName: string | null
  notes: string | null
  subtotal: number
  adjustments: number
  taxAmount: number
  total: number
  amountPaid: number
  outstanding: number
  contract: {
    contractNumber: string
    title: string
    agency: string | null
    contractType: string | null
  }
  firm: {
    name: string
    displayName: string | null
    primaryColor: string | null
    secondaryColor: string | null
  }
  lines: Array<{
    clinNumber: string | null
    kind: string
    description: string
    quantity: number | null
    rate: number | null
    amount: number
  }>
  /** Pre-summed per CLIN, in the order the contract defines them. */
  clinTotals: Array<{ clinNumber: string; amount: number }>
}

const usd = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

const day = (d: Date | null) =>
  d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

/**
 * A colour PDFKit will actually paint.
 *
 * PDFKit ignores a value it cannot parse rather than throwing, so a firm that
 * saved a malformed brand colour would get an UNPAINTED band — and then white
 * header text on white paper. Anything that is not a six-digit hex falls back
 * to the platform navy, so the band and the ink chosen for it always agree.
 */
function safeColor(value: string | null, fallback: string): string {
  const v = (value ?? '').trim()
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback
}

/**
 * Ink that stays readable on a given fill.
 *
 * The band is painted in the firm's own primary colour, and a firm may pick a
 * light one — the platform's default brand is gold. Assuming a dark band and
 * hard-coding white text made the firm name invisible on exactly that default,
 * so the ink is chosen from the fill rather than assumed.
 *
 * sRGB relative luminance, per WCAG.
 */
function inkOn(hex: string): { strong: string; soft: string } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return luminance > 0.45
    ? { strong: '#12203a', soft: '#3c4a63' }
    : { strong: WHITE, soft: '#c9d3e6' }
}

/** Paid is settled, voided is withdrawn, anything else is still in flight. */
function statusColor(status: string): string {
  if (status === 'PAID') return '#15803D'
  if (status === 'VOIDED') return '#71717a'
  if (status === 'OVERDUE') return '#B91C1C'
  return '#D97706'
}

export function buildContractInvoicePdf(input: ContractInvoicePdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'LETTER', bufferPages: true })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const primary = safeColor(input.firm.primaryColor, NAVY)
    const secondary = safeColor(input.firm.secondaryColor, GOLD)
    const right = doc.page.width - PAGE_MARGIN
    const width = right - PAGE_MARGIN
    const ink = inkOn(primary)

    // ── Header band ─────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 104).fill(primary)
    doc.rect(0, 104, doc.page.width, 3).fill(secondary)

    doc.font('Helvetica').fontSize(8).fillColor(ink.soft)
      .text('INVOICE', PAGE_MARGIN, 30, { characterSpacing: 3 })
    doc.font('Helvetica-Bold').fontSize(21).fillColor(ink.strong)
      .text(input.invoiceNumber, PAGE_MARGIN, 44)
    doc.font('Helvetica').fontSize(9).fillColor(ink.soft)
      .text(input.firm.displayName || input.firm.name, PAGE_MARGIN, 74)

    // Sized to the longest status the model actually produces
    // (PARTIALLY_PAID), not to a guess that a shorter one happened to fit.
    doc.font('Helvetica-Bold').fontSize(9)
    const pillW = Math.max(96, doc.widthOfString(input.status, { characterSpacing: 1 }) + 22)
    doc.roundedRect(right - pillW, 44, pillW, 24, 4)
      .fillAndStroke(statusColor(input.status), ink.strong)
    doc.fillColor(WHITE)
      .text(input.status, right - pillW, 51, {
        width: pillW, align: 'center', characterSpacing: 1, lineBreak: false,
      })

    // ── Contract identity ───────────────────────────────────────
    // Above the money, because an invoice that cannot be matched to a contract
    // is not a slow payment — it is a rejected one.
    let y = 126
    const field = (label: string, value: string, x: number, w: number) => {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(MID_GRAY)
        .text(label, x, y, { characterSpacing: 1, width: w })
      doc.font('Helvetica').fontSize(10).fillColor(TEXT)
        .text(value, x, y + 11, { width: w, ellipsis: true, height: 24 })
    }
    const col = (width - 24) / 2

    field('CONTRACT NUMBER', input.contract.contractNumber, PAGE_MARGIN, col)
    field('BILL TO', input.customerName || input.contract.agency || '—', PAGE_MARGIN + col + 24, col)
    y += 40
    field('CONTRACT TITLE', input.contract.title, PAGE_MARGIN, col)
    field('CONTRACT TYPE', input.contract.contractType || '—', PAGE_MARGIN + col + 24, col)
    y += 40
    const period = input.periodStart || input.periodEnd
      ? `${day(input.periodStart)} – ${day(input.periodEnd)}`
      : 'Not recorded'
    field('PERIOD OF PERFORMANCE', period, PAGE_MARGIN, col)
    field('INVOICE DATE / DUE', `${day(input.invoiceDate)}  ·  due ${day(input.dueDate)}`, PAGE_MARGIN + col + 24, col)
    y += 44

    // ── Line items ──────────────────────────────────────────────
    const CLIN_W = 62
    const KIND_W = 88
    const QTY_W = 46
    const RATE_W = 60
    const AMT_W = 76
    const DESC_W = width - CLIN_W - KIND_W - QTY_W - RATE_W - AMT_W - 24
    const xClin = PAGE_MARGIN + 6
    const xKind = xClin + CLIN_W
    const xDesc = xKind + KIND_W
    const xQty = xDesc + DESC_W
    const xRate = xQty + QTY_W + 6
    const xAmt = right - AMT_W - 6

    const header = () => {
      doc.rect(PAGE_MARGIN, y, width, 24).fill(primary)
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(ink.strong)
      doc.text('CLIN', xClin, y + 8.5, { width: CLIN_W, characterSpacing: 0.8 })
      doc.text('TYPE', xKind, y + 8.5, { width: KIND_W, characterSpacing: 0.8 })
      doc.text('DESCRIPTION', xDesc, y + 8.5, { width: DESC_W, characterSpacing: 0.8 })
      doc.text('QTY', xQty, y + 8.5, { width: QTY_W, align: 'right', characterSpacing: 0.8 })
      doc.text('RATE', xRate, y + 8.5, { width: RATE_W, align: 'right', characterSpacing: 0.8 })
      doc.text('AMOUNT', xAmt, y + 8.5, { width: AMT_W, align: 'right', characterSpacing: 0.8 })
      y += 24
    }
    header()

    input.lines.forEach((l, i) => {
      doc.font('Helvetica').fontSize(8.5)
      const descHeight = doc.heightOfString(l.description, { width: DESC_W })
      const rowH = Math.max(20, descHeight + 10)

      if (y + rowH > doc.page.height - FOOTER_RESERVE) {
        doc.addPage()
        y = PAGE_MARGIN
        header()
      }
      if (i % 2 === 0) doc.rect(PAGE_MARGIN, y, width, rowH).fill(ZEBRA)

      doc.font('Helvetica').fontSize(8.5).fillColor(TEXT)
      // An unattributed line prints "—" rather than blank: a gap a reader can
      // see is a question they can ask, an empty cell reads as an oversight.
      // Neither may wrap: the row is only as tall as its description, so a
      // second line here would be drawn over the row beneath it.
      doc.text(l.clinNumber ?? '—', xClin, y + 6, { width: CLIN_W, lineBreak: false, ellipsis: true })
      doc.fillColor(MID_GRAY).text(l.kind, xKind, y + 6, { width: KIND_W, lineBreak: false, ellipsis: true })
      doc.fillColor(TEXT).text(l.description, xDesc, y + 6, { width: DESC_W })
      doc.text(l.quantity != null ? l.quantity.toFixed(2) : '', xQty, y + 6, { width: QTY_W, align: 'right' })
      doc.text(l.rate != null ? l.rate.toFixed(2) : '', xRate, y + 6, { width: RATE_W, align: 'right' })
      doc.text(usd(l.amount), xAmt, y + 6, { width: AMT_W, align: 'right' })
      y += rowH
    })

    doc.rect(PAGE_MARGIN, y, width, 1).fill(LIGHT_GRAY)
    y += 16

    // ── Totals, with the CLIN summary beside them ───────────────
    const blockTop = y
    let clinBlockHeight = 0
    if (input.clinTotals.length > 0) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MID_GRAY)
        .text('BILLED BY CLIN', PAGE_MARGIN, y, { characterSpacing: 1 })
      let cy = y + 14
      for (const c of input.clinTotals) {
        doc.font('Helvetica').fontSize(9).fillColor(TEXT)
          .text(c.clinNumber, PAGE_MARGIN, cy, { width: 120 })
          .text(usd(c.amount), PAGE_MARGIN + 120, cy, { width: 90, align: 'right' })
        cy += 15
      }

      // This block will not equal the subtotal whenever a line carries no CLIN
      // — a fee spans the invoice and belongs to none of them. Left unexplained,
      // that difference is the first thing a contracting officer queries, so it
      // is named here rather than left for them to find.
      const attributed = input.clinTotals.reduce((sum, c) => sum + c.amount, 0)
      const unattributed = input.subtotal - attributed
      if (Math.abs(unattributed) >= 0.01) {
        doc.font('Helvetica').fontSize(7.5).fillColor(MID_GRAY)
          .text(`Not attributable to a CLIN: ${usd(unattributed)}`, PAGE_MARGIN, cy + 3, { width: 210 })
        cy += 16
      }
      clinBlockHeight = cy - y
    }

    let ty = blockTop
    const totalsW = 240
    const totalsX = right - totalsW
    const totalRow = (label: string, value: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5)
        .fillColor(bold ? TEXT : MID_GRAY)
        .text(label, totalsX, ty, { width: totalsW - AMT_W - 8, align: 'right' })
        .text(value, right - AMT_W, ty, { width: AMT_W, align: 'right' })
      ty += 16
    }
    totalRow('Subtotal', usd(input.subtotal))
    if (input.adjustments !== 0) totalRow('Adjustments', usd(input.adjustments))
    if (input.taxAmount !== 0) totalRow('Tax', usd(input.taxAmount))
    totalRow('Total', usd(input.total), true)
    totalRow('Paid to date', usd(input.amountPaid))

    ty += 6
    doc.roundedRect(totalsX, ty, totalsW, 30, 3).fill(primary)
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ink.strong)
      .text('AMOUNT DUE', totalsX + 12, ty + 10, { width: totalsW - AMT_W - 20, align: 'right', characterSpacing: 1 })
      .text(usd(input.outstanding), right - AMT_W - 12, ty + 10, { width: AMT_W, align: 'right' })
    ty += 46

    y = Math.max(ty, blockTop + clinBlockHeight + 12)

    if (input.notes && input.notes.trim()) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MID_GRAY)
        .text('NOTES', PAGE_MARGIN, y, { characterSpacing: 1 })
      doc.font('Helvetica').fontSize(9).fillColor(TEXT)
        .text(input.notes.trim(), PAGE_MARGIN, y + 12, { width: width, lineGap: 1.5 })
    }

    // ── Footer on every page ────────────────────────────────────
    // Says what the document is not. A PDF that looks filed, but was never
    // transmitted anywhere, is the one misunderstanding this feature can cause.
    const range = doc.bufferedPageRange()
    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p)
      // Writing into the bottom margin makes PDFKit start a new page, which is
      // how a two-page invoice acquired four blank ones. The footer is the last
      // thing drawn on a finished page, so the margin has nothing left to protect.
      doc.page.margins.bottom = 0
      const fy = doc.page.height - 54
      doc.rect(PAGE_MARGIN, fy - 10, width, 1).fill(LIGHT_GRAY)
      doc.font('Helvetica').fontSize(7).fillColor(MID_GRAY)
        .text(
          'Prepared from approved timesheets and approved costs. Each line shows the CLIN it was recorded against. '
          + 'This is a printable copy — it has not been transmitted to any government billing system.',
          PAGE_MARGIN, fy, { width: width - 60 },
        )
      doc.text(`${p - range.start + 1} / ${range.count}`, right - 54, fy, { width: 54, align: 'right' })
    }

    doc.end()
  })
}
