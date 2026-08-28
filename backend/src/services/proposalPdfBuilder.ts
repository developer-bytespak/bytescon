import PDFDocument from 'pdfkit'
import path from 'path'
import fs from 'fs'
import { ProposalDraft } from './proposalDraftService'
import { logger } from '../utils/logger'

// =============================================================
// Default branding (Bytescon platform). Used when no per-client
// branding is supplied. Values match the historical hardcoded
// constants so existing proposals render identically when a
// caller does not pass clientBranding.
// =============================================================
const DEFAULTS = {
  primaryColor: '#1a2744',  // navy — cover band, section headers
  secondaryColor: '#c49a1a', // gold — divider lines, accent bars
  displayName: null as string | null,
  tagline: null as string | null,
  preparedByLine: 'Bytescon — AI-Powered Proposal Intelligence',
  footerAddress: null as string | null,
  logoUrl: null as string | null,
}

const DARK_GRAY = '#2d3748'
const MID_GRAY = '#4a5568'
const LIGHT_GRAY = '#e2e8f0'
const WHITE = '#ffffff'
const TEXT = '#1a202c'

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/

/**
 * Per-proposal branding overrides. Any field set to null/undefined falls back
 * to the platform default (or the supplied firm fallback for displayName /
 * tagline). Wire this from the ClientCompany branding* columns when generating
 * a proposal FOR a specific client; pass undefined for the generic platform
 * shell.
 */
export interface ProposalBranding {
  primaryColor?: string | null
  secondaryColor?: string | null
  displayName?: string | null
  tagline?: string | null
  preparedByLine?: string | null
  footerAddress?: string | null
  /**
   * Either an absolute path on disk, or a URL beginning with `/uploads/branding/`
   * (the public branding-assets mount in server.ts). Anything else is rejected
   * silently — PDFKit cannot fetch arbitrary http(s) URLs synchronously, and
   * trusting the route handler to have validated the path is safer than
   * resolving it here.
   */
  logoUrl?: string | null
}

function safeColor(value: string | null | undefined, fallback: string): string {
  if (value && HEX_COLOR.test(value)) return value
  return fallback
}

/**
 * Resolve a branding logo URL to a local file path that PDFKit can embed.
 * Returns null if the value is missing or doesn't map to a file we serve.
 */
function resolveLogoPath(logoUrl: string | null | undefined): string | null {
  if (!logoUrl) return null
  // Accept the public branding mount only; everything else must be ignored
  // (we don't fetch external URLs from the PDF pipeline — that would block
  // the request on uncontrolled IO).
  const PREFIX = '/uploads/branding/'
  if (!logoUrl.startsWith(PREFIX)) return null
  const filename = logoUrl.slice(PREFIX.length)
  // Defense-in-depth: refuse anything that looks like traversal even though
  // express.static already guards the same directory.
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null
  const abs = path.join(process.cwd(), 'uploads', 'branding', filename)
  if (!fs.existsSync(abs)) return null
  return abs
}

/**
 * FIX-6 — review status stamped on the cover. When omitted (or DRAFT) the
 * cover carries a prominent "DRAFT — AI-generated, pending human review"
 * banner; a REVIEWED stamp (only issued after a human attests) replaces it
 * with the reviewer + date. This is the visible half of the human-in-the-loop
 * control; the gate + audit trail live in the route.
 */
export interface ReviewStamp {
  status: 'DRAFT' | 'REVIEWED'
  attestedByName?: string | null
  attestedAt?: string | null
  statementVersion?: string | null
}

export function buildProposalPdf(
  draft: ProposalDraft,
  branding?: ProposalBranding,
  review?: ReviewStamp,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const PRIMARY   = safeColor(branding?.primaryColor,   DEFAULTS.primaryColor)
    const SECONDARY = safeColor(branding?.secondaryColor, DEFAULTS.secondaryColor)
    const PREPARED  = (branding?.preparedByLine && branding.preparedByLine.trim()) || DEFAULTS.preparedByLine
    const FOOTER    = branding?.footerAddress?.trim() || DEFAULTS.footerAddress
    const LOGO_PATH = resolveLogoPath(branding?.logoUrl)

    const doc = new PDFDocument({ margin: 72, size: 'LETTER', bufferPages: true })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const validSections = draft.sections.filter(s => s.content && s.content.trim().length > 10)
    const isReviewed = review?.status === 'REVIEWED'

    // ── COVER PAGE ──────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 220).fill(PRIMARY)

    // Optional logo top-left of the header band
    if (LOGO_PATH) {
      try {
        // align/valign default to anchoring at (x, y) = top-left, which is
        // what we want; explicit values are not part of PDFKit's typed options.
        doc.image(LOGO_PATH, 72, 32, { fit: [80, 80] })
      } catch (err) {
        logger.warn('Proposal PDF: logo embed failed; continuing without it', {
          logoPath: LOGO_PATH,
          error: (err as Error).message,
        })
      }
    }

    const titleX = LOGO_PATH ? 168 : 72
    const labelX = LOGO_PATH ? 168 : 72

    doc.fontSize(9).fillColor('#8899bb').font('Helvetica')
       .text('PROPOSAL RESPONSE', labelX, 45, { characterSpacing: 2 })

    doc.fontSize(22).fillColor(WHITE).font('Helvetica-Bold')
       .text(draft.opportunityTitle, titleX, 65, { width: doc.page.width - titleX - 72, lineGap: 4 })

    const titleBottom = doc.y
    doc.fontSize(13).fillColor('#aabbdd').font('Helvetica')
       .text(`Submitted to: ${draft.agency}`, titleX, Math.max(titleBottom + 12, 140))

    // Secondary-color divider line
    doc.rect(0, 220, doc.page.width, 4).fill(SECONDARY)

    // Date / classification block
    doc.rect(0, 224, doc.page.width, 56).fill('#f7f8fa')
    doc.fontSize(10).fillColor(MID_GRAY).font('Helvetica')
       .text(`Date Prepared: ${draft.preparedDate}`, 72, 240)
       .text('Classification: Proposal — Confidential', 72, 256)

    doc.rect(0, 280, doc.page.width, 4).fill(LIGHT_GRAY)

    // ── REVIEW STATUS BANNER (FIX-6 human-in-the-loop) ──────────
    // Default (no stamp) is DRAFT — a freshly AI-generated proposal is never
    // "final" until a human attests. REVIEWED is only passed by the gated
    // final-export path after an attestation is on record.
    {
      const bannerBg = isReviewed ? '#dcfce7' : '#fef3c7'   // green-100 / amber-100
      const bannerFg = isReviewed ? '#166534' : '#92400e'   // green-800 / amber-800
      doc.rect(0, 288, doc.page.width, 26).fill(bannerBg)
      doc.fontSize(8.5).fillColor(bannerFg).font('Helvetica-Bold')
      if (isReviewed) {
        const who = review?.attestedByName ? ` by ${review.attestedByName}` : ''
        const when = review?.attestedAt ? ` on ${review.attestedAt}` : ''
        doc.text(
          `HUMAN-REVIEWED — attested${who}${when}. AI-assisted draft; the attesting reviewer accepts professional responsibility for its contents.`,
          72, 295, { width: doc.page.width - 144 },
        )
      } else {
        doc.text(
          'DRAFT — AI-GENERATED, PENDING HUMAN REVIEW. NOT FOR SUBMISSION until reviewed and attested by a responsible person.',
          72, 295, { width: doc.page.width - 144 },
        )
      }
    }

    // Cover page section listing (below the header)
    doc.y = 340
    doc.fontSize(12).fillColor(PRIMARY).font('Helvetica-Bold')
       .text('PREPARED BY', 72, doc.y)
    doc.moveDown(0.4)
    doc.fontSize(10).fillColor(MID_GRAY).font('Helvetica')
       .text(PREPARED, 72, doc.y)
    doc.moveDown(2)

    doc.fontSize(10).fillColor(DARK_GRAY).font('Helvetica-Bold')
       .text('DOCUMENT CONTENTS', 72, doc.y)
    doc.moveDown(0.5)
    validSections.forEach((section, i) => {
      doc.fontSize(10).fillColor(TEXT).font('Helvetica')
         .text(`${i + 1}.  ${section.title}`, 90, doc.y)
      doc.moveDown(0.3)
    })

    // ── TABLE OF CONTENTS ───────────────────────────────────────
    doc.addPage()
    drawSectionHeader(doc, 'TABLE OF CONTENTS', PRIMARY, SECONDARY)
    doc.moveDown(0.5)

    validSections.forEach((section, i) => {
      doc.fontSize(11).fillColor(TEXT).font('Helvetica')
         .text(`${i + 1}.  ${section.title}`, 72, doc.y)
      doc.moveDown(0.5)
    })

    // ── PROPOSAL SECTIONS ────────────────────────────────────────
    validSections.forEach((section, i) => {
      doc.addPage()

      // Section header bar
      doc.rect(0, doc.page.margins.top - 10, doc.page.width, 48).fill(PRIMARY)
      doc.fontSize(8).fillColor('#8899bb').font('Helvetica')
         .text(`SECTION ${i + 1}`, 72, doc.page.margins.top - 2, { characterSpacing: 2 })

      // FIX-6 follow-up: on DRAFT renders, flag sections the LLM itself rated
      // below HIGH so the reviewer knows where to look first. Never printed on
      // the human-reviewed final — it's an internal review aid, not content
      // for the Government.
      if (!isReviewed && (section.confidence === 'LOW' || section.confidence === 'MEDIUM')) {
        const chipText = section.confidence === 'LOW'
          ? 'AI CONFIDENCE: LOW — VERIFY'
          : 'AI CONFIDENCE: MEDIUM'
        const chipColor = section.confidence === 'LOW' ? '#fca5a5' : '#fcd34d'
        doc.fontSize(7.5).fillColor(chipColor).font('Helvetica-Bold')
           .text(chipText, doc.page.width - 72 - 180, doc.page.margins.top - 2, {
             width: 180,
             align: 'right',
             lineBreak: false,
           })
      }

      doc.fontSize(16).fillColor(WHITE).font('Helvetica-Bold')
         .text(section.title.toUpperCase(), 72, doc.page.margins.top + 12)

      // Secondary accent line under header
      const headerBottom = doc.page.margins.top + 48 - 10
      doc.rect(72, headerBottom, 60, 3).fill(SECONDARY)

      doc.y = headerBottom + 16
      doc.x = 72

      // Section body text — split on double newlines for paragraph breaks
      const paragraphs = section.content.split(/\n{2,}/).filter(p => p.trim())
      paragraphs.forEach((para, pi) => {
        const lines = para.trim().split(/\n/)
        lines.forEach((line, li) => {
          doc.fontSize(10.5).fillColor(TEXT).font('Helvetica')
             .text(line.trim(), 72, doc.y, {
               width: doc.page.width - 144,
               align: 'justify',
               lineGap: 2,
             })
          if (li < lines.length - 1) doc.moveDown(0.2)
        })
        if (pi < paragraphs.length - 1) doc.moveDown(0.8)
      })
    })

    const range = doc.bufferedPageRange()
    const totalPages = range.count

    // ── FOOTER + DRAFT WATERMARK ON ALL PAGES ───────────────────
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(range.start + i)

      // PDFKit auto-adds a page whenever text lands below the bottom margin.
      // The footer sits at height-40 (inside the 72pt margin), which silently
      // pushed every footer onto its own trailing blank page — content pages
      // shipped with no footer at all. Zero the bottom margin while stamping
      // page furniture, then restore it.
      const savedBottomMargin = doc.page.margins.bottom
      doc.page.margins.bottom = 0

      // Per-page DRAFT watermark (FIX-6 follow-up): the cover banner alone
      // disappears the moment a single page is printed or screen-shared.
      // Every page of an unreviewed draft carries a diagonal translucent
      // stamp; the attested final renders without it.
      if (!isReviewed) {
        const cx = doc.page.width / 2
        const cy = doc.page.height / 2
        doc.save()
        doc.rotate(-38, { origin: [cx, cy] })
        doc.font('Helvetica-Bold').fillColor('#94a3b8').fillOpacity(0.13)
        doc.fontSize(92)
           .text('DRAFT', 0, cy - 66, { width: doc.page.width, align: 'center', lineBreak: false })
        doc.fontSize(20)
           .text('NOT FOR SUBMISSION', 0, cy + 34, { width: doc.page.width, align: 'center', lineBreak: false })
        doc.restore()
      }

      const footerY = doc.page.height - 40
      doc.rect(0, footerY - 8, doc.page.width, 1).fill(LIGHT_GRAY)
      const footerTitle = draft.opportunityTitle.length > 60
        ? draft.opportunityTitle.slice(0, 57) + '...'
        : draft.opportunityTitle
      const baseFooter = `${footerTitle} | ${draft.agency} | Page ${i + 1} of ${totalPages}`
      const footerText = FOOTER ? `${FOOTER} · ${baseFooter}` : baseFooter
      doc.fontSize(8).fillColor(MID_GRAY).font('Helvetica')
         .text(
           footerText,
           72, footerY,
           { width: doc.page.width - 144, align: 'center', lineBreak: false }
         )

      doc.page.margins.bottom = savedBottomMargin
    }

    doc.end()
  })
}

function drawSectionHeader(doc: PDFKit.PDFDocument, title: string, primary: string, secondary: string) {
  doc.fontSize(14).fillColor(primary).font('Helvetica-Bold').text(title)
  const y = doc.y + 4
  doc.rect(72, y, doc.page.width - 144, 2).fill(secondary)
  doc.y = y + 10
}
