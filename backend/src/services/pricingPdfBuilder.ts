import PDFDocument from 'pdfkit'

// =============================================================
// Price volume PDF — the client-facing summary of one pricing scenario:
// labour lines, indirect rates, other direct costs and the backend-computed
// totals. Numbers are rendered exactly as stored; nothing is recomputed here.
// =============================================================

const NAVY = '#1a2744'
const TEXT = '#1a202c'
const MUTED = '#4a5568'
const RULE = '#e2e8f0'

type Num = { toString(): string } | number | string | null

export interface PricingPdfInput {
  workspaceTitle: string
  scenarioName: string
  opportunityTitle: string
  agency: string | null
  clientName: string
  preparedDate: string
  laborLines: { categoryName: string; periodLabel: string | null; hours: Num; baseRate: Num; escalationPct: Num; directLaborAmount: Num }[]
  indirectRates: { name: string; rateType: string; percent: Num; costBase: string }[]
  otherCosts: { costCategory: string; description: string; quantity: Num; unitCost: Num; totalAmount: Num }[]
  totals: {
    totalDirectLabor: Num; totalFringe: Num; totalOverhead: Num; totalOdc: Num; totalSubcontractor: Num
    totalGA: Num; subtotalBeforeFee: Num; totalFee: Num; totalPrice: Num
  }
}

const money = (v: Num) => `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (v: Num) => Number(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())

export function buildPricingPdf(input: PricingPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: 'LETTER' })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const left = doc.page.margins.left
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right

    // Header band
    doc.rect(0, 0, doc.page.width, 120).fill(NAVY)
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text('Price Volume', left, 36, { width })
    doc.font('Helvetica').fontSize(11).text(input.workspaceTitle, left, 64, { width })
    doc.fontSize(9).text(`Prepared ${input.preparedDate} for ${input.clientName}`, left, 84, { width })

    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(12).text(input.opportunityTitle, left, 140, { width })
    if (input.agency) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(input.agency, { width })
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Scenario: ${input.scenarioName}`, { width })
    doc.moveDown(1)

    // Simple column table; widths are fractions of the content width.
    const table = (title: string, cols: { h: string; w: number; right?: boolean }[], rows: string[][]) => {
      if (rows.length === 0) return
      if (doc.y > doc.page.height - 160) doc.addPage()
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text(title, left, doc.y, { width })
      doc.moveDown(0.4)
      const drawRow = (cells: string[], bold: boolean) => {
        const y = doc.y
        let x = left
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(bold ? MUTED : TEXT)
        cells.forEach((cell, i) => {
          const w = cols[i].w * width
          doc.text(cell, x + 2, y, { width: w - 4, align: cols[i].right ? 'right' : 'left' })
          x += w
        })
        const h = Math.max(...cells.map((cell, i) => doc.heightOfString(cell, { width: cols[i].w * width - 4 })))
        doc.y = y + h + 4
        doc.moveTo(left, doc.y - 2).lineTo(left + width, doc.y - 2).strokeColor(RULE).lineWidth(0.5).stroke()
      }
      drawRow(cols.map((c) => c.h.toUpperCase()), true)
      for (const r of rows) {
        if (doc.y > doc.page.height - 80) doc.addPage()
        drawRow(r, false)
      }
      doc.moveDown(1)
    }

    table('Labour', [
      { h: 'Category', w: 0.3 }, { h: 'Period', w: 0.16 }, { h: 'Hours', w: 0.12, right: true },
      { h: 'Rate', w: 0.14, right: true }, { h: 'Esc %', w: 0.1, right: true }, { h: 'Amount', w: 0.18, right: true },
    ], input.laborLines.map((l) => [l.categoryName, l.periodLabel ?? '—', num(l.hours), money(l.baseRate), num(l.escalationPct), money(l.directLaborAmount)]))

    table('Indirect rates', [
      { h: 'Name', w: 0.34 }, { h: 'Type', w: 0.22 }, { h: 'Rate %', w: 0.14, right: true }, { h: 'Applied to', w: 0.3 },
    // Fee always applies to the subtotal before fee (pricingCalc ignores its base field).
    ], input.indirectRates.map((r) => [
      r.name,
      r.rateType === 'GA' ? 'G&A' : label(r.rateType),
      num(r.percent),
      r.rateType === 'FEE' ? 'Subtotal before fee' : label(r.costBase),
    ]))

    table('Other direct costs', [
      { h: 'Category', w: 0.2 }, { h: 'Description', w: 0.36 }, { h: 'Qty', w: 0.1, right: true },
      { h: 'Unit cost', w: 0.16, right: true }, { h: 'Total', w: 0.18, right: true },
    ], input.otherCosts.map((o) => [label(o.costCategory), o.description, num(o.quantity), money(o.unitCost), money(o.totalAmount)]))

    // Summary
    if (doc.y > doc.page.height - 240) doc.addPage()
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text('Price summary', left, doc.y, { width })
    doc.moveDown(0.4)
    const t = input.totals
    const summary: [string, Num][] = [
      ['Direct labour', t.totalDirectLabor], ['Fringe', t.totalFringe], ['Overhead', t.totalOverhead],
      ['Other direct costs', t.totalOdc], ['Subcontractors', t.totalSubcontractor], ['G&A', t.totalGA],
      ['Subtotal before fee', t.subtotalBeforeFee], ['Fee', t.totalFee],
    ]
    for (const [name, value] of summary) {
      const y = doc.y
      doc.font('Helvetica').fontSize(9.5).fillColor(TEXT).text(name, left, y, { width: width * 0.6 })
      doc.text(money(value), left + width * 0.6, y, { width: width * 0.4, align: 'right' })
      doc.moveDown(0.25)
    }
    doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor(NAVY).lineWidth(1).stroke()
    doc.moveDown(0.5)
    const y = doc.y
    doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Total proposed price', left, y, { width: width * 0.6 })
    doc.text(money(t.totalPrice), left + width * 0.6, y, { width: width * 0.4, align: 'right' })

    doc.end()
  })
}
