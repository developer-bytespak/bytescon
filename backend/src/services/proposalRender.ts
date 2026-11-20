// =============================================================
// Renders a proposal document (proposalTemplates.ts) as a PDF or a Word file,
// in its format: font, size, margins, line spacing, each part on new pages,
// the part's name and page numbers in the footer. The PDF render also counts
// each part's pages, so they can be checked against the solicitation's limits.
// =============================================================
import PDFDocument from 'pdfkit'
import {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, Packer, PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx'
import type { DocBlock, ProposalDocument } from './proposalTemplates'

const PDF_FONTS = {
  Times: { regular: 'Times-Roman', bold: 'Times-Bold' },
  Helvetica: { regular: 'Helvetica', bold: 'Helvetica-Bold' },
  Courier: { regular: 'Courier', bold: 'Courier-Bold' },
} as const

export interface PdfResult { pdf: Buffer; pageCounts: Record<string, number>; totalPages: number }

export function renderPdf(doc: ProposalDocument): Promise<PdfResult> {
  const f = doc.format
  const margin = f.marginsIn * 72
  const font = PDF_FONTS[f.pdfFont]
  const gap = Math.max(0, f.fontSize * (f.lineSpacing - 1) * 1.15)
  const pdf = new PDFDocument({ size: 'LETTER', margin, bufferPages: true, info: { Title: doc.title } })
  const chunks: Buffer[] = []
  pdf.on('data', (c: Buffer) => chunks.push(c))
  const width = pdf.page.width - margin * 2
  const starts: Array<{ key: string; title: string; page: number }> = []

  const text = (t: string, opts: { bold?: boolean; size?: number; align?: 'left' | 'center' | 'right' } = {}) => {
    pdf.font(opts.bold ? font.bold : font.regular).fontSize(opts.size ?? f.fontSize).fillColor('#000')
    pdf.text(t, { width, lineGap: gap, align: opts.align ?? 'left' })
  }
  const ensureRoom = (h: number) => { if (pdf.y + h > pdf.page.height - margin) pdf.addPage() }

  const table = (b: Extract<DocBlock, { kind: 'table' }>) => {
    const n = b.head.length
    const other = n > 1 ? Math.min(width * 0.18, (width * 0.55) / (n - 1)) : 0
    const widths = [width - other * (n - 1), ...Array(n - 1).fill(other)]
    const row = (cells: string[], bold: boolean) => {
      pdf.font(bold ? font.bold : font.regular).fontSize(f.fontSize - 1)
      const h = Math.max(...cells.map((c, i) => pdf.heightOfString(c || ' ', { width: widths[i] - 6 }))) + 6
      ensureRoom(h)
      const y = pdf.y
      let x = margin
      cells.forEach((c, i) => {
        pdf.text(c || '', x + 3, y + 3, { width: widths[i] - 6, align: b.numeric?.includes(i) ? 'right' : 'left' })
        x += widths[i]
      })
      pdf.moveTo(margin, y + h).lineTo(margin + width, y + h).lineWidth(0.5).strokeColor('#999').stroke()
      pdf.x = margin
      pdf.y = y + h
    }
    if (b.head.some(Boolean)) row(b.head, true)
    b.rows.forEach((r) => row(r, false))
    pdf.moveDown(0.6)
  }

  doc.parts.forEach((part, i) => {
    if (i > 0) pdf.addPage()
    starts.push({ key: part.key, title: part.title, page: pdf.bufferedPageRange().start + pdf.bufferedPageRange().count - 1 })
    // The cover leads with the proposal's title (its first heading), larger.
    if (part.key === 'cover') pdf.moveDown(4)
    else { text(part.title, { bold: true, size: f.fontSize + 4 }); pdf.moveDown(0.8) }
    for (const b of part.blocks) {
      if (b.kind === 'heading' && part.key === 'cover') { text(b.text, { bold: true, size: f.fontSize + 8, align: 'center' }); pdf.moveDown(2) }
      else if (b.kind === 'heading') { ensureRoom(f.fontSize * 3); pdf.moveDown(0.4); text(b.text, { bold: true, size: f.fontSize + 1 }); pdf.moveDown(0.3) }
      else if (b.kind === 'para') { text(b.text); pdf.moveDown(0.6) }
      else if (b.kind === 'facts') {
        for (const [k, v] of b.rows) {
          pdf.font(font.bold).fontSize(f.fontSize).text(`${k}: `, { continued: true, width, lineGap: gap })
          pdf.font(font.regular).text(v, { width, lineGap: gap })
        }
        pdf.moveDown(0.6)
      } else table(b)
    }
  })

  // Footer on every page: the part it belongs to and its page numbers.
  const range = pdf.bufferedPageRange()
  const pageCounts: Record<string, number> = {}
  starts.forEach((s, i) => { pageCounts[s.key] = (i + 1 < starts.length ? starts[i + 1].page : range.start + range.count) - s.page })
  for (let p = range.start; p < range.start + range.count; p++) {
    pdf.switchToPage(p)
    const part = [...starts].reverse().find((s) => s.page <= p)!
    const bottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    pdf.font(font.regular).fontSize(9).fillColor('#444')
      .text(`${part.title} · Page ${p - part.page + 1} of ${pageCounts[part.key]}`, margin, pdf.page.height - margin / 2 - 6, { width, align: 'center', lineBreak: false })
    pdf.page.margins.bottom = bottom
  }
  return new Promise((resolve, reject) => {
    pdf.on('end', () => resolve({ pdf: Buffer.concat(chunks), pageCounts, totalPages: range.count }))
    pdf.on('error', reject)
    pdf.end()
  })
}

export async function renderDocx(doc: ProposalDocument): Promise<Buffer> {
  const f = doc.format
  const size = f.fontSize * 2 // half-points
  const twip = (inches: number) => Math.round(inches * 1440)
  const line = Math.round(240 * f.lineSpacing)
  const run = (t: string, bold = false, sz = size) => t.split('\n').map((l, i) => new TextRun({ text: l, bold, size: sz, font: f.font, break: i > 0 ? 1 : 0 }))
  const p = (t: string, opts: { bold?: boolean; sz?: number; center?: boolean; heading?: boolean } = {}) => new Paragraph({
    children: run(t, opts.bold, opts.sz), spacing: { line, after: 120 },
    alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    ...(opts.heading ? { heading: HeadingLevel.HEADING_2 } : {}),
  })
  const border = { style: BorderStyle.SINGLE, size: 4, color: '999999' }
  const table = (b: Extract<DocBlock, { kind: 'table' }>) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [...(b.head.some(Boolean) ? [b.head] : []), ...b.rows].map((cells, r) => new TableRow({
      children: cells.map((c, i) => new TableCell({
        borders: { top: border, bottom: border, left: border, right: border },
        children: [new Paragraph({ children: run(c, r === 0 && b.head.some(Boolean), size - 2), alignment: b.numeric?.includes(i) ? AlignmentType.RIGHT : AlignmentType.LEFT })],
      })),
    })),
  })

  const document = new Document({
    title: doc.title,
    styles: { default: { document: { run: { font: f.font, size } } } },
    sections: doc.parts.map((part) => ({
      properties: { page: { size: { width: twip(8.5), height: twip(11) }, margin: { top: twip(f.marginsIn), bottom: twip(f.marginsIn), left: twip(f.marginsIn), right: twip(f.marginsIn) } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${part.title} · Page `, size: 18, font: f.font }), new TextRun({ children: [PageNumber.CURRENT], size: 18, font: f.font })] })] }) },
      children: [
        // The cover leads with the proposal's title (its first heading), larger.
        ...(part.key === 'cover' ? [] : [p(part.title, { bold: true, sz: size + 8, heading: true })]),
        ...part.blocks.flatMap((b) => {
          if (b.kind === 'heading' && part.key === 'cover') return [p(''), p(b.text, { bold: true, sz: size + 16, center: true }), p('')]
          if (b.kind === 'heading') return [p(b.text, { bold: true, sz: size + 2 })]
          if (b.kind === 'para') return [p(b.text)]
          if (b.kind === 'facts') return b.rows.map(([k, v]) => new Paragraph({ spacing: { line, after: 60 }, children: [...run(`${k}: `, true), ...run(v)] }))
          return [table(b), p('')]
        }),
      ],
    })),
  })
  return Packer.toBuffer(document)
}
