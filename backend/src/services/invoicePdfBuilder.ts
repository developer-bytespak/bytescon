import PDFDocument from 'pdfkit'

// Colors — match the platform's navy/gold palette
const NAVY = '#0A1F44'
const GOLD = '#C9A227'
const DARK_GRAY = '#2d3748'
const MID_GRAY = '#4a5568'
const LIGHT_GRAY = '#e2e8f0'
const WHITE = '#ffffff'
const TEXT = '#1a202c'

export interface InvoicePdfInput {
  invoiceNumber: string
  status: string
  periodStart: Date
  periodEnd: Date
  dueAt: Date
  createdAt: Date
  paidAt?: Date | null
  subtotalUsd: number
  taxUsd: number
  totalUsd: number
  notes?: string | null
  lineItems: Array<{
    description: string
    quantity: number
    unitPriceUsd: number
    totalUsd: number
  }>
  firm: {
    name: string
    displayName?: string | null
    contactEmail: string
    primaryColor?: string | null
    secondaryColor?: string | null
  }
}

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}
function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

export function buildInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72, size: 'LETTER' })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const accentPrimary = input.firm.primaryColor || NAVY
    const accentSecondary = input.firm.secondaryColor || GOLD

    // ── HEADER BAND ─────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 100).fill(accentPrimary)

    doc.fontSize(9).fillColor('#dfe5f0').font('Helvetica')
       .text('INVOICE', 72, 38, { characterSpacing: 3 })

    doc.fontSize(22).fillColor(WHITE).font('Helvetica-Bold')
       .text(input.invoiceNumber, 72, 54)

    // Status pill on the right
    const statusLabel = input.status.toUpperCase()
    const statusColor =
      input.status === 'PAID' ? '#15803D' :
      input.status === 'VOID' || input.status === 'UNCOLLECTIBLE' ? '#71717a' :
      '#D97706'
    doc.roundedRect(doc.page.width - 72 - 80, 50, 80, 26, 4).fill(statusColor)
    doc.fontSize(11).fillColor(WHITE).font('Helvetica-Bold')
       .text(statusLabel, doc.page.width - 72 - 80, 57, { width: 80, align: 'center' })

    // Gold divider line
    doc.rect(0, 100, doc.page.width, 3).fill(accentSecondary)

    // ── FROM / TO / DATES ───────────────────────────────────────
    doc.y = 130

    doc.fontSize(9).fillColor(MID_GRAY).font('Helvetica-Bold')
       .text('FROM', 72, doc.y, { characterSpacing: 1 })
    doc.fontSize(11).fillColor(TEXT).font('Helvetica-Bold')
       .text(input.firm.displayName || input.firm.name, 72, doc.y + 14)
    doc.fontSize(9).fillColor(MID_GRAY).font('Helvetica')
       .text(input.firm.contactEmail, 72, doc.y + 12)

    // Right column — dates
    const rightX = doc.page.width / 2 + 24
    let rowY = 130
    const dateRow = (label: string, value: string) => {
      doc.fontSize(8).fillColor(MID_GRAY).font('Helvetica-Bold')
         .text(label, rightX, rowY, { characterSpacing: 1 })
      doc.fontSize(11).fillColor(TEXT).font('Helvetica')
         .text(value, rightX + 110, rowY - 1)
      rowY += 18
    }
    dateRow('ISSUED', fmtDate(input.createdAt))
    dateRow('PERIOD', `${fmtDate(input.periodStart)} – ${fmtDate(input.periodEnd)}`)
    dateRow('DUE', fmtDate(input.dueAt))
    if (input.paidAt) dateRow('PAID', fmtDate(input.paidAt))

    // ── LINE ITEMS TABLE ────────────────────────────────────────
    doc.y = 240
    doc.rect(72, doc.y, doc.page.width - 144, 28).fill(accentPrimary)
    doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold')
       .text('DESCRIPTION', 84, doc.y + 9, { characterSpacing: 1 })
       .text('QTY', doc.page.width - 268, doc.y + 9, { width: 40, align: 'right', characterSpacing: 1 })
       .text('UNIT PRICE', doc.page.width - 218, doc.y + 9, { width: 70, align: 'right', characterSpacing: 1 })
       .text('AMOUNT', doc.page.width - 138, doc.y + 9, { width: 60, align: 'right', characterSpacing: 1 })

    let tableY = doc.y + 40

    input.lineItems.forEach((item, idx) => {
      if (idx % 2 === 0) {
        doc.rect(72, tableY - 6, doc.page.width - 144, 28).fill('#f7f8fa')
      }
      doc.fontSize(10).fillColor(TEXT).font('Helvetica')
         .text(item.description, 84, tableY, { width: doc.page.width - 332 })
         .text(String(item.quantity), doc.page.width - 268, tableY, { width: 40, align: 'right' })
         .text(fmt(item.unitPriceUsd), doc.page.width - 218, tableY, { width: 70, align: 'right' })
         .text(fmt(item.totalUsd), doc.page.width - 138, tableY, { width: 60, align: 'right' })
      tableY += 28
    })

    // ── TOTALS ──────────────────────────────────────────────────
    tableY += 20
    doc.rect(72, tableY, doc.page.width - 144, 1).fill(LIGHT_GRAY)
    tableY += 12

    const totalLine = (label: string, value: string, bold = false) => {
      doc.fontSize(10).fillColor(bold ? TEXT : MID_GRAY).font(bold ? 'Helvetica-Bold' : 'Helvetica')
         .text(label, doc.page.width - 268, tableY, { width: 130, align: 'right' })
         .text(value, doc.page.width - 138, tableY, { width: 60, align: 'right' })
      tableY += 18
    }
    totalLine('Subtotal', fmt(input.subtotalUsd))
    if (input.taxUsd > 0) totalLine('Tax', fmt(input.taxUsd))

    // Grand total — emphasized
    tableY += 6
    doc.rect(doc.page.width - 290, tableY - 4, 218, 32).fill(accentPrimary)
    doc.fontSize(11).fillColor(WHITE).font('Helvetica-Bold')
       .text('TOTAL DUE', doc.page.width - 268, tableY + 6, { width: 130, align: 'right', characterSpacing: 1 })
       .text(fmt(input.totalUsd), doc.page.width - 138, tableY + 5, { width: 60, align: 'right' })

    tableY += 50

    // ── NOTES ───────────────────────────────────────────────────
    if (input.notes && input.notes.trim()) {
      doc.fontSize(9).fillColor(MID_GRAY).font('Helvetica-Bold')
         .text('NOTES', 72, tableY, { characterSpacing: 1 })
      doc.fontSize(10).fillColor(DARK_GRAY).font('Helvetica')
         .text(input.notes.trim(), 72, tableY + 14, { width: doc.page.width - 144, lineGap: 2 })
    }

    // ── FOOTER ──────────────────────────────────────────────────
    doc.fontSize(8).fillColor(MID_GRAY).font('Helvetica')
       .text(
         `Generated ${fmtDate(new Date())} · Powered by Bytescon`,
         72,
         doc.page.height - 60,
         { width: doc.page.width - 144, align: 'center' }
       )

    doc.end()
  })
}
